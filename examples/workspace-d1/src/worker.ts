/**
 * workspace-d1 — ReBAC permission API + filesystem worker
 *
 * Uses:
 *   @cloudflare/shell       — Workspace (D1 + R2) + createWorkspaceStateBackend()
 *   @zanzojs/better-auth    — zanzoPlugin: check/grant/revoke/snapshot + Hono sub-app
 *   @zanzojs/core           — ZanzoEngine, schema, mergeSchemas
 *   drizzle-orm/d1          — D1 insert/delete for grant/revoke
 *   agents / hono-party     — ZanzoPermServer DO + WebSocket routing
 *   hono                    — HTTP routing
 *
 * Permission HTTP API (via @zanzojs/better-auth Hono sub-app at /zanzo):
 *   GET  /zanzo/check    GET  /zanzo/snapshot
 *   PUT  /zanzo/grant    DELETE /zanzo/revoke
 *
 * Filesystem HTTP API:
 *   GET/PUT/DELETE /files/*path     — read / write / delete file
 *   POST /append/*path              — append to file
 *   GET  /ls/*path                  — list directory
 *   GET  /exists/*path              — { exists: bool }
 *   GET  /stat/*path                — { stat: { type, size, mtime } }
 *   POST /mkdir/*path               — create directory
 *   DELETE /rmdir/*path             — delete directory recursively
 *   GET  /glob                      — ?pattern= glob
 *   POST /cp  /mv  /cpdir  /mvdir   — copy / move file or directory
 *   GET  /tuples                    — debug: list all tuples
 *   GET  /fs                        — debug: glob all files
 *
 * Actor is passed as ?actor=User:alice on HTTP routes.
 * For production: wire getActor to the Better Auth session instead.
 *
 * WebSocket (live permission sync):
 *   Browser connects to ws://host/parties/zanzo-perm-server/User:alice
 *   ZanzoPermServer DO sends a snapshot on connect and on every tuple change.
 */

import { WorkerEntrypoint } from 'cloudflare:workers';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { partyserverMiddleware } from 'hono-party';
import { Workspace, createWorkspaceStateBackend } from '@cloudflare/shell';
import { zanzoPlugin, createZanzoHonoApp } from '@zanzojs/better-auth';
import { engine } from './schema';
import { PermissionedBackend } from './permissioned-backend';
import { ZanzoPermServer } from './perm-server';
import type { WorkspaceD1RPC, FileStat } from './types';

export { ZanzoPermServer };

interface Env {
  DB: D1Database;
  FILES: R2Bucket;
  ZanzoPermServer: DurableObjectNamespace;
}

// ── zanzoPlugin ───────────────────────────────────────────────────────────────
// Initialised at module level — shared across requests in the same isolate.
// Captures env.DB via the request handler below (see getZanzo).

let _zanzo: ReturnType<typeof zanzoPlugin> | null = null;

function getZanzo(db: D1Database): ReturnType<typeof zanzoPlugin> {
  _zanzo ??= zanzoPlugin({
    engine,
    db,
    onTupleChange: () => {
      // PartyKit notification is handled per-request via notifyActor() below
    },
  });
  return _zanzo;
}

// ── Workspace singleton ───────────────────────────────────────────────────────

let _workspace: Workspace | null = null;
let _r2: R2Bucket | undefined;

function getWorkspace(db: D1Database, actor: string, r2?: R2Bucket): Workspace {
  if (r2) _r2 = r2;
  if (!_workspace) {
    _workspace = new Workspace({
      sql: db,
      r2: _r2,
      r2Prefix: 'workspace',
      onChange: (event) => void getZanzo(db).onWorkspaceChange(event, actor),
    });
  }
  return _workspace;
}

function getPermissionedBackend(db: D1Database, actor: string, r2?: R2Bucket): PermissionedBackend {
  const rawBackend = createWorkspaceStateBackend(getWorkspace(db, actor, r2));
  const zanzo = getZanzo(db);
  return new PermissionedBackend(rawBackend, actor, (a, action, type, path) =>
    zanzo.check(a, action, type, path),
  );
}

// ── Permission live sync ──────────────────────────────────────────────────────

function notifyActor(env: Env, actor: string): void {
  const id   = env.ZanzoPermServer.idFromName(actor);
  const stub = env.ZanzoPermServer.get(id);
  stub.fetch(new Request('http://do-internal/notify', {
    method: 'POST',
    headers: { 'x-partykit-room': actor },
  })).catch((e: unknown) => console.warn(`[zanzo] notifyActor(${actor}) failed:`, e));
}

// ── HTTP app ──────────────────────────────────────────────────────────────────

const app = new Hono<{ Bindings: Env }>();

app.use('*', partyserverMiddleware());

function getActor(c: { req: { query(k: string): string | undefined } }): string {
  return c.req.query('actor') ?? 'User:anonymous';
}

function pp(prefix: string, reqPath: string): string {
  return '/' + reqPath.replace(new RegExp('^/' + prefix + '/?'), '');
}

function forbid(e: unknown): never {
  const msg = (e as any)?.message ?? '';
  if (msg.startsWith('Forbidden')) throw new HTTPException(403, { message: msg });
  throw e as Error;
}

app.onError((err, c) => {
  if (err instanceof HTTPException) return c.json({ error: err.message }, err.status);
  throw err;
});

// ── Permission API (via @zanzojs/better-auth Hono sub-app) ───────────────────
// Mount at /zanzo — provides GET /zanzo/check, PUT /zanzo/grant,
// DELETE /zanzo/revoke, GET /zanzo/snapshot.
// After each mutation we also notify the affected actor's ZanzoPermServer DO.

app.use('/zanzo/*', async (c, next) => {
  // Delegate to the zanzo Hono sub-app, then notify on mutations
  await next();
  const method = c.req.method;
  if (method === 'PUT' || method === 'DELETE') {
    // Notify the subject actor after grant/revoke so their snapshot updates
    // We do best-effort: the DO notification is fire-and-forget.
    try {
      const body = await c.req.json<{ subject?: string; actor?: string }>().catch(() => ({} as { subject?: string }));
      const subject = body?.subject ?? getActor(c);
      notifyActor(c.env, subject);
    } catch { /* ignore — notification is best-effort */ }
  }
});

// Wire the zanzo Hono sub-app — reads DB from c.env.DB per request
app.route('/zanzo', new Hono<{ Bindings: Env }>()
  .get('/snapshot', async (c) => {
    const actor = getActor(c);
    const snap  = await getZanzo(c.env.DB).snapshot(actor);
    return c.json({ actor, snapshot: snap });
  })
  .get('/check', async (c) => {
    const actor  = getActor(c);
    const action = c.req.query('action') ?? '';
    const type   = c.req.query('type')   ?? '';
    const id     = c.req.query('id')     ?? '';
    if (!action || !type || !id) return c.json({ error: 'Missing required params: action, type, id' }, 400);
    const allowed = await getZanzo(c.env.DB).check(actor, action, type, id);
    return c.json({ allowed, actor, action, type, id });
  })
  .put('/grant', async (c) => {
    const { subject, relation, type, id } = await c.req.json<{ subject: string; relation: string; type: string; id: string }>();
    await getZanzo(c.env.DB).grant(subject, relation, type, id);
    notifyActor(c.env, subject);
    return c.json({ granted: { subject, relation, object: `${type}:${id}` } });
  })
  .delete('/revoke', async (c) => {
    const { subject, relation, type, id } = await c.req.json<{ subject: string; relation: string; type: string; id: string }>();
    const count = await getZanzo(c.env.DB).revoke(subject, relation, type, id);
    notifyActor(c.env, subject);
    return c.json({ revoked: { subject, relation, object: `${type}:${id}` }, count });
  })
);

// ── Keep the old /check /grant /revoke /tuples routes for test.sh compat ─────

app.get('/check', async (c) => {
  const actor  = getActor(c);
  const action = c.req.query('action') ?? '';
  const type   = c.req.query('type')   ?? '';
  const id     = c.req.query('id')     ?? '';
  if (!action || !type || !id) return c.json({ error: 'Missing required params: action, type, id' }, 400);
  return c.json({ allowed: await getZanzo(c.env.DB).check(actor, action, type, id), actor, action, type, id });
});

app.put('/grant', async (c) => {
  const { subject, relation, type, id } = await c.req.json<{ subject: string; relation: string; type: string; id: string }>();
  await getZanzo(c.env.DB).grant(subject, relation, type, id);
  notifyActor(c.env, subject);
  return c.json({ granted: { subject, relation, object: `${type}:${id}` } });
});

app.delete('/revoke', async (c) => {
  const { subject, relation, type, id } = await c.req.json<{ subject: string; relation: string; type: string; id: string }>();
  const count = await getZanzo(c.env.DB).revoke(subject, relation, type, id);
  notifyActor(c.env, subject);
  return c.json({ revoked: { subject, relation, object: `${type}:${id}` }, count });
});

app.get('/tuples', async (c) => {
  const rows = await c.env.DB.prepare('SELECT * FROM zanzo_tuples ORDER BY object').all();
  return c.json(rows.results);
});

app.get('/fs', async (c) => {
  const backend = createWorkspaceStateBackend(getWorkspace(c.env.DB, 'User:system', c.env.FILES));
  return c.json(await backend.glob('**/*'));
});

// ── Filesystem API ────────────────────────────────────────────────────────────

app.get('/files/*', async (c) => {
  const p = pp('files', c.req.path);
  const content = await getPermissionedBackend(c.env.DB, getActor(c), c.env.FILES).readFile(p).catch(forbid);
  return c.text(content);
});

app.put('/files/*', async (c) => {
  const p = pp('files', c.req.path);
  const content = await c.req.text();
  await getPermissionedBackend(c.env.DB, getActor(c), c.env.FILES).writeFile(p, content).catch(forbid);
  notifyActor(c.env, getActor(c));
  return c.json({ written: p, bytes: content.length });
});

app.delete('/files/*', async (c) => {
  const p = pp('files', c.req.path);
  await getPermissionedBackend(c.env.DB, getActor(c), c.env.FILES).rm(p).catch(forbid);
  notifyActor(c.env, getActor(c));
  return c.json({ deleted: p });
});

app.post('/append/*', async (c) => {
  const p = pp('append', c.req.path);
  const content = await c.req.text();
  await getPermissionedBackend(c.env.DB, getActor(c), c.env.FILES).appendFile(p, content).catch(forbid);
  notifyActor(c.env, getActor(c));
  return c.json({ appended: p, bytes: content.length });
});

app.get('/exists/*', async (c) => {
  const p = pp('exists', c.req.path);
  const exists = await getPermissionedBackend(c.env.DB, getActor(c), c.env.FILES).exists(p).catch(forbid);
  return c.json({ path: p, exists });
});

app.get('/stat/*', async (c) => {
  const p = pp('stat', c.req.path);
  const s = await getPermissionedBackend(c.env.DB, getActor(c), c.env.FILES).stat(p).catch(forbid);
  if (!s) return c.json({ error: 'Not found' }, 404);
  return c.json({ path: p, stat: { type: s.type, size: s.size, mtime: s.mtime } });
});

app.get('/ls/*', async (c) => {
  const p = pp('ls', c.req.path);
  const entries = await getPermissionedBackend(c.env.DB, getActor(c), c.env.FILES).readdir(p).catch(forbid);
  return c.json({ path: p, entries });
});

app.post('/mkdir/*', async (c) => {
  const p = pp('mkdir', c.req.path);
  await getPermissionedBackend(c.env.DB, getActor(c), c.env.FILES).mkdir(p, { recursive: true }).catch(forbid);
  notifyActor(c.env, getActor(c));
  return c.json({ created: p });
});

app.delete('/rmdir/*', async (c) => {
  const p = pp('rmdir', c.req.path);
  await getPermissionedBackend(c.env.DB, getActor(c), c.env.FILES).rm(p, { recursive: true }).catch(forbid);
  notifyActor(c.env, getActor(c));
  return c.json({ deleted: p, recursive: true });
});

app.get('/glob', async (c) => {
  const pattern = c.req.query('pattern') ?? '**/*';
  const matches = await getPermissionedBackend(c.env.DB, getActor(c), c.env.FILES).glob(pattern).catch(forbid);
  return c.json({ pattern, matches });
});

app.post('/cp', async (c) => {
  const { from, to } = await c.req.json<{ from: string; to: string }>();
  await getPermissionedBackend(c.env.DB, getActor(c), c.env.FILES).cp(from, to).catch(forbid);
  notifyActor(c.env, getActor(c));
  return c.json({ copied: { from, to } });
});

app.post('/mv', async (c) => {
  const { from, to } = await c.req.json<{ from: string; to: string }>();
  await getPermissionedBackend(c.env.DB, getActor(c), c.env.FILES).mv(from, to).catch(forbid);
  notifyActor(c.env, getActor(c));
  return c.json({ moved: { from, to } });
});

app.post('/cpdir', async (c) => {
  const { from, to } = await c.req.json<{ from: string; to: string }>();
  await getPermissionedBackend(c.env.DB, getActor(c), c.env.FILES).copyTree(from, to).catch(forbid);
  notifyActor(c.env, getActor(c));
  return c.json({ copied: { from, to } });
});

app.post('/mvdir', async (c) => {
  const { from, to } = await c.req.json<{ from: string; to: string }>();
  await getPermissionedBackend(c.env.DB, getActor(c), c.env.FILES).moveTree(from, to).catch(forbid);
  notifyActor(c.env, getActor(c));
  return c.json({ moved: { from, to } });
});

// ── RPC entrypoint ────────────────────────────────────────────────────────────

export default class WorkspaceD1 extends WorkerEntrypoint<Env> implements WorkspaceD1RPC {
  async fetch(request: Request): Promise<Response> {
    return app.fetch(request, this.env, this.ctx);
  }

  private fs(actor: string): PermissionedBackend {
    return getPermissionedBackend(this.env.DB, actor, this.env.FILES);
  }

  async grant(subject: string, relation: string, type: string, id: string): Promise<void> {
    await getZanzo(this.env.DB).grant(subject, relation, type, id);
    notifyActor(this.env, subject);
  }

  async revoke(subject: string, relation: string, type: string, id: string): Promise<number> {
    const count = await getZanzo(this.env.DB).revoke(subject, relation, type, id);
    notifyActor(this.env, subject);
    return count;
  }

  check(actor: string, action: string, type: string, id: string): Promise<boolean> {
    return getZanzo(this.env.DB).check(actor, action, type, id);
  }

  async readFile(path: string, actor: string): Promise<string | null> {
    try { return await this.fs(actor).readFile(path); }
    catch (e: any) {
      if (e?.message?.includes('not found') || e?.message?.includes('ENOENT')) return null;
      throw e;
    }
  }

  async exists(path: string, actor: string): Promise<boolean>         { return this.fs(actor).exists(path); }
  async stat(path: string, actor: string): Promise<FileStat | null>   {
    const s = await this.fs(actor).stat(path);
    return s ? { type: s.type, size: s.size, mtime: s.mtime } : null;
  }
  async listDir(path: string, actor: string): Promise<string[]>       { return this.fs(actor).readdir(path); }
  async glob(pattern: string, actor: string): Promise<string[]>       { return this.fs(actor).glob(pattern); }

  async writeFile(path: string, content: string, actor: string): Promise<void> {
    await this.fs(actor).writeFile(path, content);
    notifyActor(this.env, actor);
  }
  async appendFile(path: string, content: string, actor: string): Promise<void> {
    await this.fs(actor).appendFile(path, content);
    notifyActor(this.env, actor);
  }
  async mkdir(path: string, actor: string): Promise<void> {
    await this.fs(actor).mkdir(path, { recursive: true });
    notifyActor(this.env, actor);
  }
  async moveFile(from: string, to: string, actor: string): Promise<void> {
    await this.fs(actor).mv(from, to);
    notifyActor(this.env, actor);
  }
  async copyFile(from: string, to: string, actor: string): Promise<void> {
    await this.fs(actor).cp(from, to);
    notifyActor(this.env, actor);
  }
  async moveDir(from: string, to: string, actor: string): Promise<void> {
    await this.fs(actor).moveTree(from, to);
    notifyActor(this.env, actor);
  }
  async copyDir(from: string, to: string, actor: string): Promise<void> {
    await this.fs(actor).copyTree(from, to);
    notifyActor(this.env, actor);
  }
  async deleteFile(path: string, actor: string): Promise<void> {
    await this.fs(actor).rm(path);
    notifyActor(this.env, actor);
  }
  async deleteDir(path: string, actor: string): Promise<void> {
    await this.fs(actor).rm(path, { recursive: true });
    notifyActor(this.env, actor);
  }
}
