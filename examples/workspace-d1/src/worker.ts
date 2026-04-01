/**
 * workspace-d1 — ReBAC permission API + filesystem worker
 *
 * Uses:
 *   @cloudflare/shell  — Workspace (D1 + R2) + createWorkspaceStateBackend()
 *   @zanzojs/core      — ReBAC schema + engine, tuple-based permission checks
 *   drizzle-orm/d1     — D1 query layer for grant/revoke/check
 *
 * ── Two surfaces ──────────────────────────────────────────────────────────────
 *
 * RPC (Service Binding) — import WorkspaceD1RPC from types.ts, zero transitive deps:
 *   await env.FILES.grant('User:alice', 'owner', 'Directory', '/demo')
 *   await env.FILES.check('User:alice', 'read', 'File', '/demo/notes.txt')
 *   await env.FILES.writeFile('/demo/notes.txt', 'hello', 'User:alice')
 *
 * HTTP (curl / browser):
 *   GET    /check              — can actor do action on resource?
 *   PUT    /grant              — insert a tuple
 *   DELETE /revoke             — remove a tuple
 *   GET    /tuples             — list all tuples (debug)
 *   GET    /fs                 — glob all files (debug)
 *
 * Filesystem operations go through the WorkspaceD1RPC methods only (RPC surface).
 * PermissionedBackend (permissioned-backend.ts) wraps createWorkspaceStateBackend()
 * from @cloudflare/shell with canDo() checks before every operation.
 */

import { WorkerEntrypoint } from 'cloudflare:workers';
import { Hono } from 'hono';
import { drizzle } from 'drizzle-orm/d1';
import { eq, and } from 'drizzle-orm';
// Workspace        — D1 + R2 hybrid file store from @cloudflare/shell
// createWorkspaceStateBackend — factory: Workspace → StateBackend (40+ fs ops)
// WorkspaceChangeEvent — fired by Workspace.onChange on create/delete
import { Workspace, createWorkspaceStateBackend, type WorkspaceChangeEvent } from '@cloudflare/shell';
import { zanzoTuples, engine } from './schema';
import { PermissionedBackend } from './permissioned-backend';
import type { WorkspaceD1RPC, FileStat } from './types';

interface Env {
  DB: D1Database;
  FILES: R2Bucket;
}

// ── Workspace singleton ───────────────────────────────────────────────────────
// Shared across requests within the same isolate. Workspace manages the D1 + R2
// connection; createWorkspaceStateBackend() wraps it as a full StateBackend.

let currentActor = 'User:system';
let sharedWorkspace: Workspace | null = null;

let r2Bucket: R2Bucket | undefined;

function getWorkspace(db: D1Database, actor: string, r2?: R2Bucket): Workspace {
  currentActor = actor;
  if (r2) r2Bucket = r2;
  if (!sharedWorkspace) {
    // Workspace from @cloudflare/shell — stores files inline in D1 up to ~1.5MB,
    // then spills to R2 automatically when r2 + r2Prefix are provided.
    sharedWorkspace = new Workspace({
      sql: db,
      r2: r2Bucket,
      r2Prefix: 'workspace',
      onChange: (event) => onFsChange(db, currentActor, event),
    });
  }
  return sharedWorkspace;
}

// getPermissionedBackend — returns a PermissionedBackend for the given actor.
// Uses createWorkspaceStateBackend() from @cloudflare/shell to build the
// underlying StateBackend, then wraps it with canDo() permission checks.
function getPermissionedBackend(db: D1Database, actor: string, r2?: R2Bucket): PermissionedBackend {
  const workspace = getWorkspace(db, actor, r2);
  // createWorkspaceStateBackend — @cloudflare/shell factory:
  //   Workspace → StateBackend (readFile, writeFile, mv, cp, rm, glob, diff, …)
  const rawBackend = createWorkspaceStateBackend(workspace);
  return new PermissionedBackend(rawBackend, actor, (a, action, type, path) =>
    canDo(db, a, action, type, path),
  );
}

// ── onChange — auto-sync tuples when filesystem changes ──────────────────────
// Fired by Workspace (@cloudflare/shell) on file/directory create or delete.
// On create: grants the acting user owner on the new resource.
// On delete: removes all tuples referencing the deleted resource.

async function onFsChange(
  db: D1Database,
  actor: string,
  event: WorkspaceChangeEvent,
): Promise<void> {
  const type = event.entryType === 'file' ? 'File' : 'Directory';
  const object = `${type}:${event.path}`;
  const orm = drizzle(db);

  if (event.type === 'create') {
    await orm.insert(zanzoTuples)
      .values({ subject: actor, relation: 'owner', object })
      .onConflictDoNothing()
      .run();
    console.log(`[tuples] +owner  ${actor} → ${object}`);
  }

  if (event.type === 'delete') {
    const result = await orm.delete(zanzoTuples)
      .where(eq(zanzoTuples.object, object))
      .run();
    console.log(`[tuples] -${result.meta.changes} tuples removed for ${object}`);
  }
}

// ── Permission check ──────────────────────────────────────────────────────────
// For filesystem types (File/Directory) also checks parent directories, so
// owner of /projects grants read access to /projects/demo/notes.txt.
// Uses ZanzoEngine (from @zanzojs/core) to resolve which relations satisfy the
// requested action, then runs a single D1 query against zanzo_tuples.

async function canDo(
  db: D1Database,
  actor: string,
  action: string,
  type: string,
  id: string,
): Promise<boolean> {
  const ast = engine.buildDatabaseQuery(actor, action as any, type as any);
  if (!ast || ast.conditions.length === 0) return false;

  const relations = ast.conditions.map(c => c.relation);

  const isFilesystem = type === 'File' || type === 'Directory';
  const objects = isFilesystem
    ? [`${type}:${id}`, ...parentPaths(id).map(p => `Directory:${p}`)]
    : [`${type}:${id}`];

  const relationPlaceholders = relations.map(() => '?').join(', ');
  const objectPlaceholders   = objects.map(() => '?').join(', ');

  const row = await db.prepare(
    `SELECT 1 FROM zanzo_tuples
     WHERE subject = ?
       AND relation IN (${relationPlaceholders})
       AND object  IN (${objectPlaceholders})
     LIMIT 1`
  ).bind(actor, ...relations, ...objects).first();

  return row !== null;
}

function parentPaths(path: string): string[] {
  const parts = path.split('/').filter(Boolean);
  const parents: string[] = ['/'];
  for (let i = 1; i < parts.length; i++) {
    parents.push('/' + parts.slice(0, i).join('/'));
  }
  return parents;
}

// ── HTTP app ──────────────────────────────────────────────────────────────────
// Minimal HTTP surface: permission management (grant/revoke/check) + debug endpoints.
// Filesystem operations are RPC-only — use the WorkspaceD1RPC methods below.

const app = new Hono<{ Bindings: Env }>();

function getActor(c: { req: { query(k: string): string | undefined } }) {
  return c.req.query('actor') ?? 'User:anonymous';
}

app.get('/check', async (c) => {
  const actor  = getActor(c);
  const action = c.req.query('action') ?? '';
  const type   = c.req.query('type')   ?? '';
  const id     = c.req.query('id')     ?? '';
  if (!action || !type || !id) {
    return c.json({ error: 'Missing required params: action, type, id' }, 400);
  }
  const allowed = await canDo(c.env.DB, actor, action, type, id);
  return c.json({ allowed, actor, action, type, id });
});

app.put('/grant', async (c) => {
  const body = await c.req.json<{ subject: string; relation: string; type: string; id: string }>();
  const object = `${body.type}:${body.id}`;
  const orm = drizzle(c.env.DB);
  await orm.insert(zanzoTuples).values({ subject: body.subject, relation: body.relation, object }).onConflictDoNothing().run();
  return c.json({ granted: { subject: body.subject, relation: body.relation, object } });
});

app.delete('/revoke', async (c) => {
  const body = await c.req.json<{ subject: string; relation: string; type: string; id: string }>();
  const object = `${body.type}:${body.id}`;
  const orm = drizzle(c.env.DB);
  const result = await orm.delete(zanzoTuples)
    .where(and(eq(zanzoTuples.subject, body.subject), eq(zanzoTuples.relation, body.relation), eq(zanzoTuples.object, object)))
    .run();
  return c.json({ revoked: { subject: body.subject, relation: body.relation, object }, count: result.meta.changes });
});

// Debug: list all files via glob (no permission check — system view)
app.get('/fs', async (c) => {
  const ws = getWorkspace(c.env.DB, 'User:system', c.env.FILES);
  const backend = createWorkspaceStateBackend(ws);
  return c.json(await backend.glob('**/*'));
});

// Debug: list all permission tuples
app.get('/tuples', async (c) => {
  const orm = drizzle(c.env.DB);
  return c.json(await orm.select().from(zanzoTuples).orderBy(zanzoTuples.object).all());
});

// ── RPC entrypoint ────────────────────────────────────────────────────────────
// Export as default so calling Workers can bind via:
//   import type { WorkspaceD1RPC } from '@zanzojs/example-workspace-d1/types';
//   interface Env { FILES: WorkspaceD1RPC }
//
// All filesystem methods use PermissionedBackend — permissions are enforced
// at the StateBackend layer, not duplicated in each method.
//
// ── RPC method coverage (test.sh) ────────────────────────────────────────────
//
//   TESTED via test.sh + workspace-d1-app HTTP surface:
//     grant, revoke, check          — permission API
//     writeFile, readFile            — basic file I/O
//     appendFile                     — append
//     exists, stat                   — metadata
//     listDir                        — directory listing (real readdir)
//     glob                           — path discovery (no permission gate by design)
//     mkdir                          — directory creation
//     deleteFile                     — file deletion
//     copyFile, moveFile             — file copy/move
//     copyDir, moveDir               — directory copy/move (copyTree/moveTree)
//     deleteDir                      — recursive directory delete
//
//   NOT TESTED (StateBackend ops available via PermissionedBackend, not in RPC contract):
//     readJson, writeJson, updateJson, queryJson   — JSON helpers
//     readFileBytes, writeFileBytes               — binary I/O
//     readlink, realpath, lstat, symlink          — symlink ops
//     find, walkTree, summarizeTree               — tree traversal
//     diff, diffContent                           — diff
//     hashFile, detectFile                        — file inspection
//     searchText, searchFiles                     — search
//     replaceInFile, replaceInFiles               — find-and-replace
//     planEdits, applyEditPlan, applyEdits        — batch edits
//     createArchive, extractArchive               — archives
//     compressFile, decompressFile                — compression
//     removeTree, resolvePath, readdirWithFileTypes
//
//   These are all available on PermissionedBackend and permission-gated correctly.
//   Add them to types.ts + worker.ts if callers need them.

export default class WorkspaceD1 extends WorkerEntrypoint<Env> implements WorkspaceD1RPC {
  /** Delegate HTTP requests to the Hono app — keeps curl/browser access working. */
  async fetch(request: Request): Promise<Response> {
    return app.fetch(request, this.env, this.ctx);
  }

  /** Insert a permission tuple. */
  async grant(subject: string, relation: string, type: string, id: string): Promise<void> {
    const object = `${type}:${id}`;
    const orm = drizzle(this.env.DB);
    await orm.insert(zanzoTuples).values({ subject, relation, object }).onConflictDoNothing().run();
  }

  /** Remove a permission tuple. Returns number of rows deleted. */
  async revoke(subject: string, relation: string, type: string, id: string): Promise<number> {
    const object = `${type}:${id}`;
    const orm = drizzle(this.env.DB);
    const result = await orm.delete(zanzoTuples)
      .where(and(eq(zanzoTuples.subject, subject), eq(zanzoTuples.relation, relation), eq(zanzoTuples.object, object)))
      .run();
    return result.meta.changes;
  }

  /** Check if actor can perform action on a resource. Type must exist in schema.ts. */
  check(actor: string, action: string, type: string, id: string): Promise<boolean> {
    return canDo(this.env.DB, actor, action, type, id);
  }

  /**
   * Write a file. Actor must have write permission on the file or a parent directory.
   * Uses PermissionedBackend → createWorkspaceStateBackend() from @cloudflare/shell.
   * Files >~1.5MB spill automatically to R2.
   */
  async writeFile(path: string, content: string, actor: string): Promise<void> {
    const fs = getPermissionedBackend(this.env.DB, actor, this.env.FILES);
    await fs.writeFile(path, content);
  }

  /**
   * Read a file. Returns null if not found. Throws if actor lacks read permission.
   * Uses PermissionedBackend → createWorkspaceStateBackend() from @cloudflare/shell.
   */
  async readFile(path: string, actor: string): Promise<string | null> {
    const fs = getPermissionedBackend(this.env.DB, actor, this.env.FILES);
    try {
      return await fs.readFile(path);
    } catch (e: any) {
      // StateBackend throws on not-found; return null to match RPC contract
      if (e?.message?.includes('not found') || e?.message?.includes('ENOENT')) return null;
      throw e;
    }
  }

  /**
   * Delete a file. Throws if actor lacks delete permission.
   * Uses PermissionedBackend → createWorkspaceStateBackend() from @cloudflare/shell.
   */
  async deleteFile(path: string, actor: string): Promise<void> {
    const fs = getPermissionedBackend(this.env.DB, actor, this.env.FILES);
    await fs.rm(path);
  }

  /**
   * Move/rename a file. Actor needs delete on src and write on dest.
   * Uses PermissionedBackend → createWorkspaceStateBackend() from @cloudflare/shell.
   */
  async moveFile(from: string, to: string, actor: string): Promise<void> {
    const fs = getPermissionedBackend(this.env.DB, actor, this.env.FILES);
    await fs.mv(from, to);
  }

  /**
   * Copy a file. Actor needs read on src and write on dest.
   * Uses PermissionedBackend → createWorkspaceStateBackend() from @cloudflare/shell.
   */
  async copyFile(from: string, to: string, actor: string): Promise<void> {
    const fs = getPermissionedBackend(this.env.DB, actor, this.env.FILES);
    await fs.cp(from, to);
  }

  /** Check if a path exists. Throws if actor lacks read permission. */
  async exists(path: string, actor: string): Promise<boolean> {
    const fs = getPermissionedBackend(this.env.DB, actor, this.env.FILES);
    return fs.exists(path);
  }

  /** Stat a path. Returns null if not found. Throws if actor lacks read permission. */
  async stat(path: string, actor: string): Promise<FileStat | null> {
    const fs = getPermissionedBackend(this.env.DB, actor, this.env.FILES);
    const s = await fs.stat(path);
    if (!s) return null;
    return { type: s.type, size: s.size, mtime: s.mtime };
  }

  /** List directory entries. Throws if actor lacks read permission on the directory. */
  async listDir(path: string, actor: string): Promise<string[]> {
    const fs = getPermissionedBackend(this.env.DB, actor, this.env.FILES);
    return fs.readdir(path);
  }

  /** Glob for files. Actor must have read on root directory. */
  async glob(pattern: string, actor: string): Promise<string[]> {
    const fs = getPermissionedBackend(this.env.DB, actor, this.env.FILES);
    return fs.glob(pattern);
  }

  /** Append to a file. Actor must have write permission. Files >~1.5MB spill to R2. */
  async appendFile(path: string, content: string, actor: string): Promise<void> {
    const fs = getPermissionedBackend(this.env.DB, actor, this.env.FILES);
    await fs.appendFile(path, content);
  }

  /** Create a directory. Actor must have write permission on the path. */
  async mkdir(path: string, actor: string): Promise<void> {
    const fs = getPermissionedBackend(this.env.DB, actor, this.env.FILES);
    await fs.mkdir(path, { recursive: true });
  }

  /** Move a directory tree. Actor needs delete on src and write on dest. */
  async moveDir(from: string, to: string, actor: string): Promise<void> {
    const fs = getPermissionedBackend(this.env.DB, actor, this.env.FILES);
    await fs.moveTree(from, to);
  }

  /** Copy a directory tree. Actor needs read on src and write on dest. */
  async copyDir(from: string, to: string, actor: string): Promise<void> {
    const fs = getPermissionedBackend(this.env.DB, actor, this.env.FILES);
    await fs.copyTree(from, to);
  }

  /** Delete a directory recursively. Throws if actor lacks delete permission. */
  async deleteDir(path: string, actor: string): Promise<void> {
    const fs = getPermissionedBackend(this.env.DB, actor, this.env.FILES);
    await fs.rm(path, { recursive: true });
  }
}
