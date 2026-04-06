/**
 * zanzoPlugin — core factory for @zanzojs/better-auth.
 *
 * Creates a self-contained permission manager that:
 *   - checks permissions against D1 zanzo_tuples (with parent-path inheritance for filesystem paths)
 *   - grants/revokes tuples via raw D1
 *   - builds a snapshot (Record<ResourceID, string[]>) for O(1) client-side checks
 *   - integrates with @cloudflare/shell Workspace.onChange for automatic tuple lifecycle
 *   - exposes a Hono sub-app for HTTP/MCP access
 *
 * Usage:
 *   const zanzo = zanzoPlugin({ engine, db, resolveActor: (s) => `User:${s.user.id}` })
 *   app.route('/zanzo', zanzo.honoApp)
 *   const workspace = new Workspace({ onChange: (e) => zanzo.onWorkspaceChange(e, actor) })
 */

import type { ZanzoEngine } from '@zanzojs/core';
import { createZanzoSnapshot } from '@zanzojs/core';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface TupleChangeEvent {
  type: 'grant' | 'revoke';
  subject: string;
  relation: string;
  object: string;
}

export interface AuditEvent {
  type: 'grant' | 'revoke' | 'check' | 'snapshot';
  actor: string;
  subject?: string;
  relation?: string;
  object?: string;
  allowed?: boolean;
  timestamp: string;
}

export interface GrantOptions {
  /** ISO timestamp — tuple is ignored after this date */
  expiresAt?: Date;
}

export type CleanupMode = 'none' | 'delete';

/** Minimal WorkspaceChangeEvent shape from @cloudflare/shell */
export interface WorkspaceChangeEvent {
  type: 'create' | 'delete' | 'rename' | 'update';
  entryType: 'file' | 'directory' | 'symlink';
  path: string;
}

export interface ZanzoPluginOptions {
  /**
   * The ZanzoEngine instance initialised with your schema.
   * Used for buildDatabaseQuery() and creating fresh engine instances for snapshots.
   */
  engine: ZanzoEngine<any>;

  /**
   * D1 database binding — where zanzo_tuples lives.
   */
  db: D1Database;

  /**
   * Name of the tuples table. Default: 'zanzo_tuples'.
   */
  tableName?: string;

  /**
   * Converts a Better Auth session to an actor string.
   * Default: `User:${session.user.id}`
   * Override to support Agent:, Service: prefixes etc.
   */
  resolveActor?: (session: any) => string;

  /**
   * What to do when an actor is deleted.
   *   'none'   — leave orphaned tuples (default, safest)
   *   'delete' — DELETE WHERE subject = actor immediately
   */
  cleanup?: CleanupMode;

  /**
   * Called after every successful grant or revoke.
   * Use to trigger PartyKit / ZanzoPermServer notifications.
   */
  onTupleChange?: (event: TupleChangeEvent) => void;

  /**
   * Called after every grant, revoke, check, or snapshot.
   * Use to write to an audit log table.
   */
  onAudit?: (event: AuditEvent) => Promise<void>;
}

// ── Permission check helpers ──────────────────────────────────────────────────

/** Walk the filesystem path hierarchy for inherited directory permissions. */
export function parentPaths(path: string): string[] {
  const parts = path.split('/').filter(Boolean);
  const parents = ['/'];
  for (let i = 1; i < parts.length; i++) {
    parents.push('/' + parts.slice(0, i).join('/'));
  }
  return parents;
}

// ── Plugin factory ────────────────────────────────────────────────────────────

export function zanzoPlugin(opts: ZanzoPluginOptions) {
  const {
    engine,
    db,
    tableName = 'zanzo_tuples',
    resolveActor = (s: any) => `User:${s.user.id}`,
    cleanup = 'none',
    onTupleChange,
    onAudit,
  } = opts;

  // ── Helpers ────────────────────────────────────────────────────────────────

  function audit(event: AuditEvent): void {
    if (onAudit) void onAudit(event);
  }

  // ── check ──────────────────────────────────────────────────────────────────

  async function check(
    actor: string,
    action: string,
    type: string,
    id: string,
  ): Promise<boolean> {
    const ast = engine.buildDatabaseQuery(actor, action as any, type as any);
    if (!ast || ast.conditions.length === 0) {
      audit({ type: 'check', actor, object: `${type}:${id}`, allowed: false, timestamp: new Date().toISOString() });
      return false;
    }

    const relations = ast.conditions.map((c: any) => c.relation);
    const isFs      = type === 'File' || type === 'Directory';
    const objects   = isFs
      ? [`${type}:${id}`, ...parentPaths(id).map(p => `Directory:${p}`)]
      : [`${type}:${id}`];

    const row = await db.prepare(
      `SELECT 1 FROM ${tableName}
       WHERE subject  = ?
         AND relation IN (${relations.map(() => '?').join(', ')})
         AND object   IN (${objects.map(() => '?').join(', ')})
       LIMIT 1`,
    ).bind(actor, ...relations, ...objects).first();

    const allowed = row !== null;
    audit({ type: 'check', actor, object: `${type}:${id}`, allowed, timestamp: new Date().toISOString() });
    return allowed;
  }

  // ── grant ──────────────────────────────────────────────────────────────────

  async function grant(
    subject: string,
    relation: string,
    type: string,
    id: string,
    _options?: GrantOptions,
  ): Promise<void> {
    const object = `${type}:${id}`;
    await db.prepare(
      `INSERT INTO ${tableName} (subject, relation, object)
       VALUES (?, ?, ?)
       ON CONFLICT DO NOTHING`,
    ).bind(subject, relation, object).run();

    const event: TupleChangeEvent = { type: 'grant', subject, relation, object };
    if (onTupleChange) onTupleChange(event);
    audit({ type: 'grant', actor: subject, subject, relation, object, timestamp: new Date().toISOString() });
  }

  // ── revoke ─────────────────────────────────────────────────────────────────

  async function revoke(
    subject: string,
    relation: string,
    type: string,
    id: string,
  ): Promise<number> {
    const object = `${type}:${id}`;
    const result = await db.prepare(
      `DELETE FROM ${tableName}
       WHERE subject = ? AND relation = ? AND object = ?`,
    ).bind(subject, relation, object).run();

    const count = result.meta.changes ?? 0;
    const event: TupleChangeEvent = { type: 'revoke', subject, relation, object };
    if (onTupleChange) onTupleChange(event);
    audit({ type: 'revoke', actor: subject, subject, relation, object, timestamp: new Date().toISOString() });
    return count;
  }

  // ── revokeAll — remove all tuples for a given object ──────────────────────

  async function revokeAll(object: string): Promise<number> {
    const result = await db.prepare(
      `DELETE FROM ${tableName} WHERE object = ?`,
    ).bind(object).run();
    return result.meta.changes ?? 0;
  }

  // ── revokeActor — remove all tuples where subject = actor ─────────────────

  async function revokeActor(actor: string): Promise<number> {
    const result = await db.prepare(
      `DELETE FROM ${tableName} WHERE subject = ?`,
    ).bind(actor).run();
    return result.meta.changes ?? 0;
  }

  // ── snapshot ───────────────────────────────────────────────────────────────

  async function snapshot(actor: string): Promise<Record<string, string[]>> {
    const rows = await db.prepare(`SELECT subject, relation, object FROM ${tableName}`).all<{
      subject: string; relation: string; object: string;
    }>();

    // Fresh engine instance — never share mutable state across requests
    const { ZanzoEngine } = await import('@zanzojs/core');
    const eng = new ZanzoEngine(engine.getSchema());
    eng.load(rows.results ?? []);

    const result = createZanzoSnapshot(eng, actor);
    audit({ type: 'snapshot', actor, timestamp: new Date().toISOString() });
    return result;
  }

  // ── onWorkspaceChange — @cloudflare/shell integration ─────────────────────

  async function onWorkspaceChange(event: WorkspaceChangeEvent, actor: string): Promise<void> {
    const type   = event.entryType === 'file' ? 'File' : 'Directory';
    const object = `${type}:${event.path}`;

    if (event.type === 'create') {
      await db.prepare(
        `INSERT INTO ${tableName} (subject, relation, object) VALUES (?, 'owner', ?) ON CONFLICT DO NOTHING`,
      ).bind(actor, object).run();
      if (onTupleChange) onTupleChange({ type: 'grant', subject: actor, relation: 'owner', object });
    }

    if (event.type === 'delete') {
      await db.prepare(`DELETE FROM ${tableName} WHERE object = ?`).bind(object).run();
      if (onTupleChange) onTupleChange({ type: 'revoke', subject: actor, relation: '*', object });
    }
  }

  // ── Better Auth server plugin ──────────────────────────────────────────────

  const betterAuth = {
    id: 'zanzo' as const,

    hooks: {
      after: [
        {
          // After user deletion — clean up orphaned tuples
          matcher: (ctx: any) =>
            ctx.path === '/delete-user' && cleanup === 'delete',
          handler: async (ctx: any) => {
            const actor = resolveActor(ctx.context.session);
            await revokeActor(actor);
          },
        },
      ],
    },
  };

  // ── Public API ─────────────────────────────────────────────────────────────

  return {
    check,
    grant,
    revoke,
    revokeAll,
    revokeActor,
    snapshot,
    onWorkspaceChange,
    resolveActor,
    betterAuth,
  };
}

export type ZanzoPluginInstance = ReturnType<typeof zanzoPlugin>;
