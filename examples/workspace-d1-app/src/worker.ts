/**
 * workspace-d1-app
 *
 * Public HTTP surface. All filesystem and permission operations go via Workers
 * RPC to workspace-d1 (Service Binding) — no URL construction, no HTTP hop in
 * production. workspace-d1 is binding-only; this worker is the only HTTP surface.
 *
 * Permission API (proxied to workspace-d1 via RPC):
 *   PUT    /grant             — insert a tuple
 *   DELETE /revoke            — remove a tuple
 *   GET    /check             — can actor do action on resource?
 *
 * Filesystem API (proxied to workspace-d1 via RPC, PermissionedBackend enforces perms):
 *   GET    /files/*path       — read file
 *   PUT    /files/*path       — write file
 *   DELETE /files/*path       — delete file
 *   POST   /append/*path      — append to file
 *   GET    /exists/*path      — { exists: true|false }
 *   GET    /stat/*path        — { stat: { type, size, mtime } }
 *   GET    /ls/*path          — list directory entries
 *   POST   /mkdir/*path       — create directory
 *   DELETE /rmdir/*path       — delete directory recursively
 *   GET    /glob              — ?pattern= glob paths (no content gate)
 *   POST   /cp                — copy file  body: { from, to }
 *   POST   /mv                — move file  body: { from, to }
 *   POST   /cpdir             — copy dir   body: { from, to }
 *   POST   /mvdir             — move dir   body: { from, to }
 *
 * Debug:
 *   GET    /demo              — full RPC smoke test (grant/write/check/revoke)
 *
 * Actor is passed as ?actor=User:alice on all HTTP routes.
 */

import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import type { WorkspaceD1RPC } from '@zanzojs/example-workspace-d1/types';

// WorkspaceD1RPC is the single source of truth for the RPC contract.
// Defined in workspace-d1/src/types.ts, implemented by the WorkspaceD1 class.
// Zero transitive deps — importing this pulls in no drizzle, shell, or D1 types.
interface Env {
  FILES: WorkspaceD1RPC;
}

const app = new Hono<{ Bindings: Env }>();

// ── Helpers ───────────────────────────────────────────────────────────────────

// Extract /{prefix}/some/path → /some/path
function pp(prefix: string, reqPath: string): string {
  return '/' + reqPath.replace(new RegExp('^/' + prefix + '/?'), '');
}

// Re-throw PermissionedBackend 'Forbidden …' errors as Hono 403; let others bubble.
function forbid(e: unknown): never {
  const msg = (e as any)?.message ?? '';
  if (msg.startsWith('Forbidden')) throw new HTTPException(403, { message: msg });
  throw e as Error;
}

function getActor(c: { req: { query(k: string): string | undefined } }): string {
  return c.req.query('actor') ?? 'User:anonymous';
}

// Map HTTPException → JSON error response; other errors surface as 500.
app.onError((err, c) => {
  if (err instanceof HTTPException) {
    return c.json({ error: err.message }, err.status);
  }
  throw err;
});

// ── Permission API ─────────────────────────────────────────────────────────────
// Thin proxies — no logic here, all authority in workspace-d1.

app.get('/check', async (c) => {
  const actor  = getActor(c);
  const action = c.req.query('action') ?? '';
  const type   = c.req.query('type')   ?? '';
  const id     = c.req.query('id')     ?? '';
  if (!action || !type || !id) return c.json({ error: 'Missing required params: action, type, id' }, 400);
  return c.json({ allowed: await c.env.FILES.check(actor, action, type, id), actor, action, type, id });
});

app.put('/grant', async (c) => {
  const { subject, relation, type, id } = await c.req.json<{ subject: string; relation: string; type: string; id: string }>();
  await c.env.FILES.grant(subject, relation, type, id);
  return c.json({ granted: { subject, relation, object: `${type}:${id}` } });
});

app.delete('/revoke', async (c) => {
  const { subject, relation, type, id } = await c.req.json<{ subject: string; relation: string; type: string; id: string }>();
  const count = await c.env.FILES.revoke(subject, relation, type, id);
  return c.json({ revoked: { subject, relation, object: `${type}:${id}` }, count });
});

// ── Filesystem API ─────────────────────────────────────────────────────────────
// All calls go via RPC to workspace-d1. PermissionedBackend there enforces perms.
// Forbidden errors from PermissionedBackend are mapped to 403 by forbid().

app.get('/files/*', async (c) => {
  const p = pp('files', c.req.path);
  const content = await c.env.FILES.readFile(p, getActor(c)).catch(forbid);
  if (content === null) return c.json({ error: 'Not found' }, 404);
  return c.text(content);
});

app.put('/files/*', async (c) => {
  const p = pp('files', c.req.path);
  const content = await c.req.text();
  await c.env.FILES.writeFile(p, content, getActor(c)).catch(forbid);
  return c.json({ written: p, bytes: content.length });
});

app.delete('/files/*', async (c) => {
  const p = pp('files', c.req.path);
  await c.env.FILES.deleteFile(p, getActor(c)).catch(forbid);
  return c.json({ deleted: p });
});

app.post('/append/*', async (c) => {
  const p = pp('append', c.req.path);
  const content = await c.req.text();
  await c.env.FILES.appendFile(p, content, getActor(c)).catch(forbid);
  return c.json({ appended: p, bytes: content.length });
});

app.get('/exists/*', async (c) => {
  const p = pp('exists', c.req.path);
  const exists = await c.env.FILES.exists(p, getActor(c)).catch(forbid);
  return c.json({ path: p, exists });
});

app.get('/stat/*', async (c) => {
  const p = pp('stat', c.req.path);
  const s = await c.env.FILES.stat(p, getActor(c)).catch(forbid);
  if (!s) return c.json({ error: 'Not found' }, 404);
  return c.json({ path: p, stat: s });
});

app.get('/ls/*', async (c) => {
  const p = pp('ls', c.req.path);
  const entries = await c.env.FILES.listDir(p, getActor(c)).catch(forbid);
  return c.json({ path: p, entries });
});

app.post('/mkdir/*', async (c) => {
  const p = pp('mkdir', c.req.path);
  await c.env.FILES.mkdir(p, getActor(c)).catch(forbid);
  return c.json({ created: p });
});

app.delete('/rmdir/*', async (c) => {
  const p = pp('rmdir', c.req.path);
  await c.env.FILES.deleteDir(p, getActor(c)).catch(forbid);
  return c.json({ deleted: p, recursive: true });
});

app.get('/glob', async (c) => {
  const pattern = c.req.query('pattern') ?? '**/*';
  const matches = await c.env.FILES.glob(pattern, getActor(c)).catch(forbid);
  return c.json({ pattern, matches });
});

app.post('/cp', async (c) => {
  const { from, to } = await c.req.json<{ from: string; to: string }>();
  await c.env.FILES.copyFile(from, to, getActor(c)).catch(forbid);
  return c.json({ copied: { from, to } });
});

app.post('/mv', async (c) => {
  const { from, to } = await c.req.json<{ from: string; to: string }>();
  await c.env.FILES.moveFile(from, to, getActor(c)).catch(forbid);
  return c.json({ moved: { from, to } });
});

app.post('/cpdir', async (c) => {
  const { from, to } = await c.req.json<{ from: string; to: string }>();
  await c.env.FILES.copyDir(from, to, getActor(c)).catch(forbid);
  return c.json({ copied: { from, to } });
});

app.post('/mvdir', async (c) => {
  const { from, to } = await c.req.json<{ from: string; to: string }>();
  await c.env.FILES.moveDir(from, to, getActor(c)).catch(forbid);
  return c.json({ moved: { from, to } });
});

// ── Demo / smoke test ──────────────────────────────────────────────────────────
// Runs a full grant → write → check → revoke sequence via RPC and returns JSON.

app.get('/demo', async (c) => {
  const files = c.env.FILES;
  const steps: { step: string; result: unknown }[] = [];
  const record = (step: string, result: unknown) => { steps.push({ step, result }); return result; };

  await files.grant('User:demo', 'owner', 'Directory', '/demo');
  record('grant demo owner on /demo', 'ok');

  await files.writeFile('/demo/hello.txt', 'hello from caller via RPC', 'User:demo');
  record('write /demo/hello.txt', 'ok');

  record('check demo can read',     await files.check('User:demo',  'read', 'File', '/demo/hello.txt'));
  record('check guest denied read', await files.check('User:guest', 'read', 'File', '/demo/hello.txt'));

  await files.grant('User:guest', 'viewer', 'File', '/demo/hello.txt');
  record('grant guest viewer', 'ok');

  record('check guest can read after grant', await files.check('User:guest', 'read',  'File', '/demo/hello.txt'));
  record('check guest denied write',         await files.check('User:guest', 'write', 'File', '/demo/hello.txt'));
  record('revoke guest viewer',              await files.revoke('User:guest', 'viewer', 'File', '/demo/hello.txt'));
  record('check guest denied after revoke',  await files.check('User:guest', 'read', 'File', '/demo/hello.txt'));

  return c.json({ binding: 'workspace-d1', mode: 'rpc', steps });
});

export default app;
