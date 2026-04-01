/**
 * workspace-d1 — ReBAC permission API + filesystem worker
 *
 * Uses:
 *   @cloudflare/shell  — Workspace (D1 + R2) + createWorkspaceStateBackend()
 *   @zanzojs/core      — ReBAC schema + engine, tuple-based permission checks
 *   drizzle-orm/d1     — D1 query layer for grant/revoke/check
 *
 * RPC (Service Binding) — import WorkspaceD1RPC from types.ts, zero transitive deps:
 *   await env.FILES.grant('User:alice', 'owner', 'Directory', '/demo')
 *   await env.FILES.writeFile('/demo/notes.txt', 'hello', 'User:alice')
 *
 * HTTP (debug only):
 *   GET /check   PUT /grant   DELETE /revoke   GET /tuples   GET /fs
 */

import { WorkerEntrypoint } from 'cloudflare:workers';
import { Hono } from 'hono';
import { drizzle } from 'drizzle-orm/d1';
import { eq, and } from 'drizzle-orm';
import { Workspace, createWorkspaceStateBackend, type WorkspaceChangeEvent } from '@cloudflare/shell';
import { zanzoTuples, engine } from './schema';
import { PermissionedBackend } from './permissioned-backend';
import type { WorkspaceD1RPC, FileStat } from './types';

interface Env {
  DB: D1Database;
  FILES: R2Bucket;
}

// ── Workspace singleton ───────────────────────────────────────────────────────
// Shared across requests in the same isolate. Files <~1.5MB stay in D1;
// larger files spill to R2 automatically when r2 + r2Prefix are set.

let currentActor = 'User:system';
let sharedWorkspace: Workspace | null = null;
let r2Bucket: R2Bucket | undefined;

function getWorkspace(db: D1Database, actor: string, r2?: R2Bucket): Workspace {
  currentActor = actor;
  if (r2) r2Bucket = r2;
  if (!sharedWorkspace) {
    sharedWorkspace = new Workspace({
      sql: db,
      r2: r2Bucket,
      r2Prefix: 'workspace',
      onChange: (event) => onFsChange(db, currentActor, event),
    });
  }
  return sharedWorkspace;
}

function getPermissionedBackend(db: D1Database, actor: string, r2?: R2Bucket): PermissionedBackend {
  const rawBackend = createWorkspaceStateBackend(getWorkspace(db, actor, r2));
  return new PermissionedBackend(rawBackend, actor, (a, action, type, path) =>
    canDo(db, a, action, type, path),
  );
}

// ── onChange — auto-sync tuples on file/directory create or delete ────────────

async function onFsChange(db: D1Database, actor: string, event: WorkspaceChangeEvent): Promise<void> {
  const type   = event.entryType === 'file' ? 'File' : 'Directory';
  const object = `${type}:${event.path}`;
  const orm    = drizzle(db);

  if (event.type === 'create') {
    await orm.insert(zanzoTuples).values({ subject: actor, relation: 'owner', object }).onConflictDoNothing().run();
    console.log(`[tuples] +owner  ${actor} → ${object}`);
  }
  if (event.type === 'delete') {
    const result = await orm.delete(zanzoTuples).where(eq(zanzoTuples.object, object)).run();
    console.log(`[tuples] -${result.meta.changes} tuples removed for ${object}`);
  }
}

// ── Permission check ──────────────────────────────────────────────────────────
// Walks parent directory paths for filesystem types so owning /projects/demo
// grants access to /projects/demo/notes.txt automatically.

async function canDo(db: D1Database, actor: string, action: string, type: string, id: string): Promise<boolean> {
  const ast = engine.buildDatabaseQuery(actor, action as any, type as any);
  if (!ast || ast.conditions.length === 0) return false;

  const relations = ast.conditions.map(c => c.relation);
  const isFs      = type === 'File' || type === 'Directory';
  const objects   = isFs
    ? [`${type}:${id}`, ...parentPaths(id).map(p => `Directory:${p}`)]
    : [`${type}:${id}`];

  const row = await db.prepare(
    `SELECT 1 FROM zanzo_tuples
     WHERE subject = ?
       AND relation IN (${relations.map(() => '?').join(', ')})
       AND object  IN (${objects.map(() => '?').join(', ')})
     LIMIT 1`
  ).bind(actor, ...relations, ...objects).first();

  return row !== null;
}

function parentPaths(path: string): string[] {
  const parts   = path.split('/').filter(Boolean);
  const parents = ['/'];
  for (let i = 1; i < parts.length; i++) parents.push('/' + parts.slice(0, i).join('/'));
  return parents;
}

// ── HTTP app (debug / permission management) ──────────────────────────────────

const app = new Hono<{ Bindings: Env }>();

function getActor(c: { req: { query(k: string): string | undefined } }) {
  return c.req.query('actor') ?? 'User:anonymous';
}

app.get('/check', async (c) => {
  const actor  = getActor(c);
  const action = c.req.query('action') ?? '';
  const type   = c.req.query('type')   ?? '';
  const id     = c.req.query('id')     ?? '';
  if (!action || !type || !id) return c.json({ error: 'Missing required params: action, type, id' }, 400);
  return c.json({ allowed: await canDo(c.env.DB, actor, action, type, id), actor, action, type, id });
});

app.put('/grant', async (c) => {
  const { subject, relation, type, id } = await c.req.json<{ subject: string; relation: string; type: string; id: string }>();
  const object = `${type}:${id}`;
  await drizzle(c.env.DB).insert(zanzoTuples).values({ subject, relation, object }).onConflictDoNothing().run();
  return c.json({ granted: { subject, relation, object } });
});

app.delete('/revoke', async (c) => {
  const { subject, relation, type, id } = await c.req.json<{ subject: string; relation: string; type: string; id: string }>();
  const object = `${type}:${id}`;
  const result = await drizzle(c.env.DB).delete(zanzoTuples)
    .where(and(eq(zanzoTuples.subject, subject), eq(zanzoTuples.relation, relation), eq(zanzoTuples.object, object)))
    .run();
  return c.json({ revoked: { subject, relation, object }, count: result.meta.changes });
});

app.get('/fs', async (c) => {
  return c.json(await createWorkspaceStateBackend(getWorkspace(c.env.DB, 'User:system', c.env.FILES)).glob('**/*'));
});

app.get('/tuples', async (c) => {
  return c.json(await drizzle(c.env.DB).select().from(zanzoTuples).orderBy(zanzoTuples.object).all());
});

// ── RPC entrypoint ────────────────────────────────────────────────────────────
// Callers import WorkspaceD1RPC from types.ts (zero deps) and bind via wrangler.toml:
//   [[services]]  binding = "FILES"  service = "workspace-d1"

export default class WorkspaceD1 extends WorkerEntrypoint<Env> implements WorkspaceD1RPC {
  async fetch(request: Request): Promise<Response> {
    return app.fetch(request, this.env, this.ctx);
  }

  // Convenience: returns a PermissionedBackend scoped to this request's env + actor.
  private fs(actor: string): PermissionedBackend {
    return getPermissionedBackend(this.env.DB, actor, this.env.FILES);
  }

  // ── Permissions ─────────────────────────────────────────────────────────────

  async grant(subject: string, relation: string, type: string, id: string): Promise<void> {
    await drizzle(this.env.DB).insert(zanzoTuples)
      .values({ subject, relation, object: `${type}:${id}` })
      .onConflictDoNothing().run();
  }

  async revoke(subject: string, relation: string, type: string, id: string): Promise<number> {
    const object = `${type}:${id}`;
    const result = await drizzle(this.env.DB).delete(zanzoTuples)
      .where(and(eq(zanzoTuples.subject, subject), eq(zanzoTuples.relation, relation), eq(zanzoTuples.object, object)))
      .run();
    return result.meta.changes;
  }

  check(actor: string, action: string, type: string, id: string): Promise<boolean> {
    return canDo(this.env.DB, actor, action, type, id);
  }

  // ── Read ─────────────────────────────────────────────────────────────────────

  async readFile(path: string, actor: string): Promise<string | null> {
    try {
      return await this.fs(actor).readFile(path);
    } catch (e: any) {
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

  // ── Write ────────────────────────────────────────────────────────────────────

  async writeFile(path: string, content: string, actor: string): Promise<void>  { await this.fs(actor).writeFile(path, content); }
  async appendFile(path: string, content: string, actor: string): Promise<void> { await this.fs(actor).appendFile(path, content); }
  async mkdir(path: string, actor: string): Promise<void>                        { await this.fs(actor).mkdir(path, { recursive: true }); }

  // ── Move / Copy ──────────────────────────────────────────────────────────────

  async moveFile(from: string, to: string, actor: string): Promise<void> { await this.fs(actor).mv(from, to); }
  async copyFile(from: string, to: string, actor: string): Promise<void> { await this.fs(actor).cp(from, to); }
  async moveDir(from: string, to: string, actor: string): Promise<void>  { await this.fs(actor).moveTree(from, to); }
  async copyDir(from: string, to: string, actor: string): Promise<void>  { await this.fs(actor).copyTree(from, to); }

  // ── Delete ───────────────────────────────────────────────────────────────────

  async deleteFile(path: string, actor: string): Promise<void> { await this.fs(actor).rm(path); }
  async deleteDir(path: string, actor: string): Promise<void>  { await this.fs(actor).rm(path, { recursive: true }); }
}
