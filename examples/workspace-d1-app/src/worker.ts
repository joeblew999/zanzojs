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
 *   GET    /ls/*path          — list directory
 *   GET    /files/*path       — read file
 *   PUT    /files/*path       — write file
 *   DELETE /files/*path       — delete file
 *   POST   /mv                — move/rename file  body: { from, to }
 *   POST   /cp                — copy file         body: { from, to }
 *   DELETE /rmdir/*path       — delete directory recursively
 *
 * Debug:
 *   GET    /demo              — full RPC smoke test (grant/write/check/revoke)
 *
 * Actor is passed as ?actor=User:alice on all HTTP routes.
 */

import { Hono } from 'hono';
import type { WorkspaceD1RPC } from '@zanzojs/example-workspace-d1/types';

// WorkspaceD1RPC is the single source of truth for the RPC contract.
// Defined in workspace-d1/src/types.ts, implemented by the WorkspaceD1 class.
// Zero transitive deps — importing this pulls in no drizzle, shell, or D1 types.
interface Env {
  FILES: WorkspaceD1RPC;
}

const app = new Hono<{ Bindings: Env }>();

function getActor(c: { req: { query(k: string): string | undefined } }) {
  return c.req.query('actor') ?? 'User:anonymous';
}

// ── Permission API ─────────────────────────────────────────────────────────────
// Thin proxies — no logic here, all authority in workspace-d1.

app.get('/check', async (c) => {
  const actor  = getActor(c);
  const action = c.req.query('action') ?? '';
  const type   = c.req.query('type')   ?? '';
  const id     = c.req.query('id')     ?? '';
  if (!action || !type || !id) {
    return c.json({ error: 'Missing required params: action, type, id' }, 400);
  }
  const allowed = await c.env.FILES.check(actor, action, type, id);
  return c.json({ allowed, actor, action, type, id });
});

app.put('/grant', async (c) => {
  const body = await c.req.json<{ subject: string; relation: string; type: string; id: string }>();
  await c.env.FILES.grant(body.subject, body.relation, body.type, body.id);
  return c.json({ granted: { subject: body.subject, relation: body.relation, object: `${body.type}:${body.id}` } });
});

app.delete('/revoke', async (c) => {
  const body = await c.req.json<{ subject: string; relation: string; type: string; id: string }>();
  const count = await c.env.FILES.revoke(body.subject, body.relation, body.type, body.id);
  return c.json({ revoked: { subject: body.subject, relation: body.relation, object: `${body.type}:${body.id}` }, count });
});

// ── Filesystem API ─────────────────────────────────────────────────────────────
// All calls go via RPC to workspace-d1. PermissionedBackend there enforces perms.

app.get('/exists/*', async (c) => {
  const path = '/' + c.req.path.replace(/^\/exists\/?/, '');
  const actor = getActor(c);
  try {
    const found = await c.env.FILES.exists(path, actor);
    return c.json({ path, exists: found });
  } catch (e: any) {
    if (e?.message?.startsWith('Forbidden')) return c.json({ error: e.message }, 403);
    throw e;
  }
});

app.get('/stat/*', async (c) => {
  const path = '/' + c.req.path.replace(/^\/stat\/?/, '');
  const actor = getActor(c);
  try {
    const s = await c.env.FILES.stat(path, actor);
    if (!s) return c.json({ error: 'Not found' }, 404);
    return c.json({ path, stat: s });
  } catch (e: any) {
    if (e?.message?.startsWith('Forbidden')) return c.json({ error: e.message }, 403);
    throw e;
  }
});

app.get('/glob', async (c) => {
  const pattern = c.req.query('pattern') ?? '**/*';
  const actor = getActor(c);
  try {
    const matches = await c.env.FILES.glob(pattern, actor);
    return c.json({ pattern, matches });
  } catch (e: any) {
    if (e?.message?.startsWith('Forbidden')) return c.json({ error: e.message }, 403);
    throw e;
  }
});

app.post('/append/*', async (c) => {
  const path = '/' + c.req.path.replace(/^\/append\/?/, '');
  const actor = getActor(c);
  const content = await c.req.text();
  try {
    await c.env.FILES.appendFile(path, content, actor);
    return c.json({ appended: path, bytes: content.length });
  } catch (e: any) {
    if (e?.message?.startsWith('Forbidden')) return c.json({ error: e.message }, 403);
    throw e;
  }
});

app.post('/mkdir/*', async (c) => {
  const path = '/' + c.req.path.replace(/^\/mkdir\/?/, '');
  const actor = getActor(c);
  try {
    await c.env.FILES.mkdir(path, actor);
    return c.json({ created: path });
  } catch (e: any) {
    if (e?.message?.startsWith('Forbidden')) return c.json({ error: e.message }, 403);
    throw e;
  }
});

app.post('/mvdir', async (c) => {
  const { from, to } = await c.req.json<{ from: string; to: string }>();
  const actor = getActor(c);
  try {
    await c.env.FILES.moveDir(from, to, actor);
    return c.json({ moved: { from, to } });
  } catch (e: any) {
    if (e?.message?.startsWith('Forbidden')) return c.json({ error: e.message }, 403);
    throw e;
  }
});

app.post('/cpdir', async (c) => {
  const { from, to } = await c.req.json<{ from: string; to: string }>();
  const actor = getActor(c);
  try {
    await c.env.FILES.copyDir(from, to, actor);
    return c.json({ copied: { from, to } });
  } catch (e: any) {
    if (e?.message?.startsWith('Forbidden')) return c.json({ error: e.message }, 403);
    throw e;
  }
});

app.get('/ls/*', async (c) => {
  const path = '/' + c.req.path.replace(/^\/ls\/?/, '');
  const actor = getActor(c);
  try {
    const entries = await c.env.FILES.listDir(path, actor);
    return c.json({ path, entries });
  } catch (e: any) {
    if (e?.message?.startsWith('Forbidden')) return c.json({ error: e.message }, 403);
    return c.json({ error: 'Not found' }, 404);
  }
});

app.get('/files/*', async (c) => {
  const path = '/' + c.req.path.replace(/^\/files\/?/, '');
  const actor = getActor(c);
  try {
    const content = await c.env.FILES.readFile(path, actor);
    if (content === null) return c.json({ error: 'Not found' }, 404);
    return c.text(content);
  } catch (e: any) {
    if (e?.message?.startsWith('Forbidden')) return c.json({ error: e.message }, 403);
    return c.json({ error: 'Not found' }, 404);
  }
});

app.put('/files/*', async (c) => {
  const path = '/' + c.req.path.replace(/^\/files\/?/, '');
  const actor = getActor(c);
  const content = await c.req.text();
  try {
    await c.env.FILES.writeFile(path, content, actor);
    return c.json({ written: path, bytes: content.length });
  } catch (e: any) {
    if (e?.message?.startsWith('Forbidden')) return c.json({ error: e.message }, 403);
    throw e;
  }
});

app.delete('/files/*', async (c) => {
  const path = '/' + c.req.path.replace(/^\/files\/?/, '');
  const actor = getActor(c);
  try {
    await c.env.FILES.deleteFile(path, actor);
    return c.json({ deleted: path });
  } catch (e: any) {
    if (e?.message?.startsWith('Forbidden')) return c.json({ error: e.message }, 403);
    throw e;
  }
});

app.post('/mv', async (c) => {
  const { from, to } = await c.req.json<{ from: string; to: string }>();
  const actor = getActor(c);
  try {
    await c.env.FILES.moveFile(from, to, actor);
    return c.json({ moved: { from, to } });
  } catch (e: any) {
    if (e?.message?.startsWith('Forbidden')) return c.json({ error: e.message }, 403);
    throw e;
  }
});

app.post('/cp', async (c) => {
  const { from, to } = await c.req.json<{ from: string; to: string }>();
  const actor = getActor(c);
  try {
    await c.env.FILES.copyFile(from, to, actor);
    return c.json({ copied: { from, to } });
  } catch (e: any) {
    if (e?.message?.startsWith('Forbidden')) return c.json({ error: e.message }, 403);
    throw e;
  }
});

app.delete('/rmdir/*', async (c) => {
  const path = '/' + c.req.path.replace(/^\/rmdir\/?/, '');
  const actor = getActor(c);
  try {
    await c.env.FILES.deleteDir(path, actor);
    return c.json({ deleted: path, recursive: true });
  } catch (e: any) {
    if (e?.message?.startsWith('Forbidden')) return c.json({ error: e.message }, 403);
    throw e;
  }
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

  record('check demo can read',    await files.check('User:demo',  'read', 'File', '/demo/hello.txt'));
  record('check guest denied read', await files.check('User:guest', 'read', 'File', '/demo/hello.txt'));

  await files.grant('User:guest', 'viewer', 'File', '/demo/hello.txt');
  record('grant guest viewer', 'ok');

  record('check guest can read after grant', await files.check('User:guest', 'read',  'File', '/demo/hello.txt'));
  record('check guest denied write',         await files.check('User:guest', 'write', 'File', '/demo/hello.txt'));
  record('revoke guest viewer', await files.revoke('User:guest', 'viewer', 'File', '/demo/hello.txt'));
  record('check guest denied after revoke', await files.check('User:guest', 'read', 'File', '/demo/hello.txt'));

  return c.json({ binding: 'workspace-d1', mode: 'rpc', steps });
});

export default app;
