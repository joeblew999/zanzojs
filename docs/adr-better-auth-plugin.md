# ADR: @zanzojs/better-auth Plugin

**Date:** 2026-04-01
**Branch:** feat/better-auth-plugin
**Status:** Draft — decisions agreed, implementation not yet started

---

## Context

`@zanzojs/core` + `@zanzojs/drizzle` provide a ReBAC engine and SQL pushdown adapter. They have no integration with Better Auth, the identity/session layer used across all our Cloudflare Workers projects.

Every project that uses both must manually:
- Extract the session from Better Auth
- Construct the actor string (`User:{id}`)
- Call `withPermissions()` or insert tuples directly

This wiring is repetitive, error-prone, and untested. The goal of `@zanzojs/better-auth` is to make this integration a first-class, tested, reusable package.

This plugin is **not plat-trunk specific**. It is a shared library for all Cloudflare Workers projects that use Better Auth + zanzojs.

---

## Full Stack

```
@cloudflare/shell  Workspace     ← files live here (D1 rows + R2 for large files)
        │  onChange hook
        ▼
@zanzojs/better-auth plugin      ← permissions live here (D1 zanzo_tuples)
        │  resolveActor
        ▼
Better Auth session               ← identity lives here
```

`@cloudflare/shell` (`Workspace`) is Cloudflare's official POSIX-like filesystem backed by D1 + R2. It has **zero built-in permissions**. `@zanzojs/better-auth` is the permission layer that plugs into it via the `onChange` hook.

The **POSIX path IS the resource identifier**. `/projects/proj123/abc.step` maps directly to the tuple `object`. No separate resource ID table needed.

---

## Decision

Build `@zanzojs/better-auth` as a Better Auth plugin that:

1. Wires Better Auth sessions to zanzojs actor strings automatically
2. Integrates with `@cloudflare/shell` `Workspace` via its `onChange` hook for automatic permission lifecycle management
3. Exposes grant/revoke/check/snapshot as Hono + OpenAPI + MCP endpoints
4. Handles tuple lifecycle (cleanup on actor/resource delete)
5. Fires hooks for downstream adapters (PartyKit) to consume

The plugin is the **authorization engine only**. Better Auth remains the single source of identity. The `zanzo_tuples` D1 table is the single source of permissions.

**Important:** `GrantBuilder`/`RevokeBuilder` from `@zanzojs/core` are **in-memory only** (for tests/seeds). All production writes use `db.insert(zanzoTuples)` + `materializeDerivedTuples()` directly.

---

## How It Works — Concrete Usage

### Setup (once, in your Worker/Agent)

```ts
import { Workspace } from '@cloudflare/shell'
import { zanzoPlugin } from '@zanzojs/better-auth'
import { schema } from './zanzo.config'
import { zanzoTuples } from './db/schema'

const zanzo = zanzoPlugin({
  engine,
  db,
  tuples: zanzoTuples,
  dialect: 'sqlite',
  cleanup: 'delete',
  resolveActor: (session) => {
    if (session.agentId)   return `Agent:${session.agentId}`
    if (session.serviceId) return `Service:${session.serviceId}`
    return `User:${session.user.id}`
  },
  onTupleChange: (event) => {
    // optional — wire to PartyKit here
  }
})

const workspace = new Workspace({
  sql: env.DB,
  r2: env.FILES,
  namespace: 'projects',
  onChange: (event) => zanzo.onWorkspaceChange(event, currentActor)
})

// Mount Hono sub-app (OpenAPI + MCP)
app.route('/zanzo', zanzo.honoApp)
```

### File upload — permissions set automatically

```ts
app.post('/projects/:projectId/files/*', async (c) => {
  const actor = resolveActor(session)               // 'User:gerard'
  const path  = `/projects/${projectId}/${filename}`

  await workspace.writeFile(path, content)
  // onChange('create', path) fires →
  //   zanzo inserts: User:gerard | owner | /projects/proj123/abc.step
  //   zanzo calls materializeDerivedTuples →
  //     inherits from Project:proj123 permissions automatically
})
```

### File read — permission check

```ts
app.get('/projects/:projectId/files/*', async (c) => {
  const actor = resolveActor(session)
  const path  = `/projects/${projectId}/${filename}`

  const allowed = await zanzo.check(actor, 'read', path)
  if (!allowed) return c.json({ error: 'Forbidden' }, 403)

  return c.json({ content: await workspace.readFile(path) })
})
```

### File delete — tuples cleaned up automatically

```ts
await workspace.rm(path)
// onChange('delete', path) fires →
//   zanzo calls revokeAll for that path →
//   all tuples for that file gone automatically
```

### AI agent permission check (MCP tool)

```ts
// Agent:claude-mcp calls zanzo_check MCP tool
// zanzo_check(action='read', resource='/projects/proj123/abc.step')
// Same check as a human — no special casing
```

---

## Package Structure

```
packages/
  better-auth/              ← @zanzojs/better-auth
    src/
      plugin.ts             ← Better Auth plugin definition
      hono.ts               ← Hono sub-app (OpenAPI + MCP endpoints)
      cleanup.ts            ← actor/resource cleanup helpers
      workspace.ts          ← @cloudflare/shell Workspace integration
      client.ts             ← Better Auth client plugin
      index.ts
    mise-tasks.toml         ← dev tasks for this package

.src/                       ← gitignored external research repos
  mise.toml                 ← src:clone / src:update tasks
  agents/                   ← github.com/cloudflare/agents (cloned)

Planned future packages (not built now — do not block plugin design):
  partykit/                 ← @zanzojs/partykit — real-time permission sync
```

---

## Decisions Made

### 1. Grant/Revoke Authorization

**Decision:** Only the resource owner OR anyone with `manage` permission on the resource can call grant/revoke.

**Two paths:**
- **Server-side** — direct `db.insert(zanzoTuples)` + `materializeDerivedTuples()` in Hono route handlers. Trusted code, no HTTP check needed.
- **HTTP endpoint** — `POST /zanzo/grant` and `POST /zanzo/revoke`. Plugin checks that the requester has `owner` relation or `manage` permission on the `object` before writing.

**Revoke your own access:** Not allowed. Only owner/manage can revoke any tuple, including removing yourself from a resource. One rule, no exceptions.

**Production writes:** Always use `db.insert(zanzoTuples)` + `materializeDerivedTuples()`. Never use `engine.grant()` — it is in-memory only and ephemeral in Workers.

**Options considered (for re-evaluation):**
| Option | Description | Status |
|---|---|---|
| Owner only | Only `owner` relation can grant/revoke | Rejected — too restrictive |
| Owner or manage | Owner OR anyone with `manage` permission | **Chosen** |
| Any authenticated user | Anyone can grant to resources they touch | Rejected — unsafe |
| Server-side only | No HTTP endpoints, all writes are in-code | Rejected — blocks user-driven sharing flows |
| Self-revoke allowed | Users can always remove themselves | Rejected — simpler to have one rule |

---

### 2. Actor Resolution

**Decision:** Plugin accepts a `resolveActor` function at setup time. Default is `User:{session.user.id}`.

```ts
zanzoPlugin({
  resolveActor: (session) => {
    if (session.agentId)   return `Agent:${session.agentId}`
    if (session.serviceId) return `Service:${session.serviceId}`
    return `User:${session.user.id}`
  }
})
```

The session is already resolved by Better Auth before `resolveActor` is called. The plugin returns 401 if there is no session before calling `resolveActor`.

**Why:** Projects have different actor types (humans, MCP agents, service accounts, drones). The plugin cannot know about these. The caller owns the mapping.

**Options considered (for re-evaluation):**
| Option | Description | Status |
|---|---|---|
| Hardcoded `User:` prefix | Plugin always uses `User:{id}` | Rejected — blocks agent/service use cases |
| Per-actor-type config | Plugin accepts `{ user: 'User', agent: 'Agent' }` map | Viable fallback if `resolveActor` proves complex |
| `resolveActor` function | Caller provides full mapping logic | **Chosen** — most flexible |

---

### 3. Snapshot Delivery

**Decision:** HTTP endpoint `GET /zanzo/snapshot`. Returns the current session's permission snapshot as JSON.

**Flow:**
1. Request hits `/zanzo/snapshot`
2. Plugin resolves actor from session
3. Loads actor's tuples from D1
4. Runs through engine, calls `createZanzoSnapshot()`
5. Returns `Record<ResourceID, string[]>`

**Why HTTP endpoint over SSR-embed:** Frontend framework is not yet decided. HTTP endpoint works for SPA, SSR, and PartyKit-driven re-fetch equally. SSR-embed (Next.js layout pattern) still works — caller generates snapshot server-side using the plugin helper function directly.

**PartyKit integration:** When a tuple changes (grant/revoke), plugin fires `onTupleChange` hook. PartyKit adapter listens and broadcasts to the affected user's WebSocket connection, triggering a re-fetch of `/zanzo/snapshot`. The client plugin (`authClient.zanzo.snapshot()`) handles the re-fetch.

**Options considered (for re-evaluation):**
| Option | Description | Status |
|---|---|---|
| SSR-embed only | Snapshot generated in server layout, no endpoint | Rejected — framework-specific |
| HTTP endpoint | `GET /zanzo/snapshot` | **Chosen** — framework-agnostic |
| Embedded in login response | Snapshot returned with session on login | Viable for future optimisation — snapshot goes stale anyway |
| PartyKit push | Snapshot pushed over WebSocket on change | Future — via `@zanzojs/partykit` adapter |

---

### 4. API Endpoints (OpenAPI + MCP)

**Decision:** Plugin exports a **Hono sub-app** built with `@hono/zod-openapi`. MCP tools registered via `@hono/mcp`. Mount once:

```ts
app.route('/zanzo', zanzoPlugin.honoApp)
```

| Route | MCP Tool | Who calls it |
|---|---|---|
| `GET /zanzo/snapshot` | `zanzo_snapshot` | Frontend after login, PartyKit re-fetch |
| `POST /zanzo/grant` | `zanzo_grant` | Frontend (owner/manage), AI agents, server code |
| `POST /zanzo/revoke` | `zanzo_revoke` | Frontend (owner/manage), AI agents, server code |
| `GET /zanzo/check` | `zanzo_check` | Frontend spot-checks, AI agents, other services |

All routes are Zod-validated, fully typed, and appear in OpenAPI docs automatically. AI agents (MCP) can call all four tools natively.

---

### 5. Actor Cleanup (Actor Deleted)

**Decision:** Plugin accepts a `cleanup` option. Default is `'none'`.

```ts
zanzoPlugin({
  cleanup: 'none'     // do nothing — you handle it (default, safest)
  cleanup: 'delete'   // immediately DELETE WHERE subject = actor
  cleanup: 'orphan'   // set orphaned_at timestamp, keep row
})
```

Triggered via Better Auth `after` hook on user/actor delete. Uses `resolveActor` to determine the subject prefix.

**`'orphan'` mode** requires an extra column on the tuple table:
```sql
ALTER TABLE zanzo_tuples ADD COLUMN orphaned_at TEXT; -- ISO timestamp, null = active
```
All permission checks add `WHERE orphaned_at IS NULL` when this mode is active.

**Options considered (for re-evaluation):**
| Option | Description | Status |
|---|---|---|
| `'none'` | Leave orphaned rows — you handle cleanup | **Default** |
| `'delete'` | Immediate DELETE on actor removal | Available |
| `'orphan'` | Mark with timestamp, clean up async | Available |
| Cascade delete | Also delete all resources owned by actor | Rejected — dangerous, hard to undo |
| Soft delete all actors | Always orphan, never hard delete | Viable but complex — deferred |

---

### 6. Resource Cleanup (Resource Deleted)

**Decision:** When using `@cloudflare/shell` `Workspace`, cleanup is **automatic** via the `onChange` hook. For non-Workspace resources, expose `zanzo.revokeAll({ object, tx? })` that callers must invoke manually.

**Workspace path (automatic):**
```ts
// Registered once at setup — no manual cleanup needed
const workspace = new Workspace({
  onChange: (event) => zanzo.onWorkspaceChange(event, currentActor)
})

// workspace.rm(path) → onChange('delete') → zanzo.revokeAll automatically
```

**Non-Workspace path (manual):**
```ts
// Must be called inside a transaction with the delete
await db.transaction(async (tx) => {
  await tx.delete(documents).where(eq(documents.id, id))
  await zanzo.revokeAll({ object: `Document:${id}`, tx })
})
```

**Important — `revokeAll` is not a simple DELETE WHERE object = X.**
It uses `removeDerivedTuples()` + `buildBulkDeleteCondition()` to reconstruct the derived tuple graph and delete all three columns (`subject`, `relation`, `object`) precisely. Filtering only by `object` would accidentally delete unrelated tuples. The plugin handles this correctly internally.

**`revokeAll` requires `fetchChildren`:**
Callers must provide a `fetchChildren` callback so the plugin can reconstruct the derived graph:
```ts
await zanzo.revokeAll({
  object: `Project:${id}`,
  fetchChildren: async (parentObj, rel) => {
    return (await tx.select().from(cadModels)
      .where(eq(cadModels.projectId, parentObj.split(':')[1])))
      .map(m => `CadModel:${m.id}`)
  },
  tx
})
```

**New child resources do NOT inherit automatically.**
When a new file is added to a project, `materializeDerivedTuples()` must be called explicitly. This is a known gap vs Google Drive folder inheritance. The `onChange('create')` handler in `onWorkspaceChange` handles this automatically for Workspace files.

**Options considered (for re-evaluation):**
| Option | Description | Status |
|---|---|---|
| Manual `revokeAll` only | Caller always handles cleanup | Viable for non-Workspace resources |
| `onChange` hook auto-cleanup | Workspace handles automatically | **Chosen for Workspace** |
| R2 Queue adapter | R2 delete → Queue → revokeAll | Future — not built now |

---

### 7. Client Plugin

**Decision:** Ship a Better Auth client plugin that adds `authClient.zanzo.snapshot()`.

```ts
// setup (once)
const authClient = createAuthClient({
  plugins: [zanzoClientPlugin()]
})

// usage
const snapshot = await authClient.zanzo.snapshot()
// feed into ZanzoProvider
```

Same HTTP call as `GET /zanzo/snapshot` underneath, but:
- Session cookie handled automatically by Better Auth client
- Fully typed
- Consistent with rest of Better Auth client API

**PartyKit re-fetch pattern:**
```ts
partySocket.onmessage = (e) => {
  if (e.data === 'permissions:changed') {
    authClient.zanzo.snapshot().then(setSnapshot)
  }
}
```

---

### 8. Expiry / Time-Limited Access

**Decision:** The grant endpoint and `zanzo.grant()` helper accept an optional `expiresAt` field.

```ts
// HTTP endpoint
POST /zanzo/grant
{ subject: 'User:max', relation: 'viewer', object: '/projects/proj123/abc.step', expiresAt: '2026-06-01T00:00:00Z' }

// Server-side helper
await zanzo.grant({ subject, relation, object, expiresAt: new Date('2026-06-01') })
```

The `@zanzojs/core` engine already supports `expiresAt` on tuples natively. The plugin just exposes it through the HTTP/MCP API.

Use cases: contractor access windows, MCP agent tokens with bounded lifetime, temporary drone operator access during a flight window.

---

### 9. Ownership Transfer

**Decision:** Dedicated `POST /zanzo/transfer` endpoint. Never do this manually — requires atomic revoke old owner + grant new owner + re-materialize derived tuples in one transaction.

```ts
POST /zanzo/transfer
{ object: '/projects/proj123/abc.step', fromSubject: 'User:gerard', toSubject: 'User:max' }
```

The plugin handles the transaction internally:
1. `removeDerivedTuples()` for old owner
2. DELETE old `owner` tuple
3. INSERT new `owner` tuple
4. `materializeDerivedTuples()` for new owner

**Without a dedicated endpoint this is risky** — callers doing it manually with two operations can leave the resource in a broken state if the second operation fails.

---

### 10. Audit Log

**Decision:** Plugin accepts an optional `onAudit` callback. Default is no logging.

```ts
zanzoPlugin({
  onAudit: async (event) => {
    // event: { type: 'grant'|'revoke'|'transfer'|'check', actor, subject, relation, object, allowed?, timestamp }
    await db.insert(zanzoAuditLog).values(event)
  }
})
```

Every grant, revoke, transfer, and check fires `onAudit`. Caller decides what to do with it — write to a separate D1 audit table, push to a logging service, etc.

**Why callback not built-in:** Different projects have different audit requirements. Some need a full audit table, some need a Cloudflare Log Push stream, some need nothing. The plugin should not impose a schema.

**Options considered (for re-evaluation):**
| Option | Description | Status |
|---|---|---|
| No audit | Plugin does nothing | Rejected — compliance requirement |
| Built-in audit table | Plugin manages `zanzo_audit_log` table | Viable — adds schema coupling |
| `onAudit` callback | Caller owns the audit destination | **Chosen** — flexible |
| `created_at`/`deleted_at` on tuples | Soft delete for point-in-time history | Viable alongside callback |

---

### 11. Inheritance Break ("Only Specific People")

**Decision:** Not implemented in the plugin. Handled at the application layer via an `inherit_permissions` flag on the resource table.

**The problem:** Once `materializeDerivedTuples()` runs for a project, all child resources inherit project-level permissions. There is no way to exempt a specific file from inheritance without explicit intervention.

**Solution:** Add `inherit_permissions BOOLEAN DEFAULT TRUE` to your resource table. Your Hono upload route checks this flag before calling `materializeDerivedTuples()`.

```ts
// Upload route
const file = await db.insert(cadModels).values({ ..., inheritPermissions: false }).returning()
await workspace.writeFile(path, content)
// onChange fires, but plugin checks inheritPermissions before materializing
```

**Options considered (for re-evaluation):**
| Option | Description | Status |
|---|---|---|
| Explicit deny tuples | DENY semantics in the engine | Rejected for now — complex, engine changes needed |
| `inherit_permissions` flag | App-layer flag, plugin respects it | **Chosen** — no engine changes |
| Separate entity type | `SensitiveCadModel` with no `project` relation | Viable for typed schemas |

---

## Known Gaps (vs Google Drive)

| Gap | Notes |
|---|---|
| New child auto-inheritance | Workspace `onChange('create')` handles this for files. Non-Workspace resources must call `materializeDerivedTuples()` manually on every new resource create. |
| Public/anonymous access | No `Public:anonymous` actor pattern designed yet |
| Groups | No group-level sharing — always to a specific actor |
| Pending invitations | Pre-signup tuples not designed yet |
| Move = new permissions | R2/Workspace has no move — it's COPY + DELETE. "Move" means new resource + new permissions from new parent. Old permissions are NOT transferred. |

---

## Planned Adapters (Not Built Now)

### `@zanzojs/partykit`
- Listens to `onTupleChange` hook from `@zanzojs/better-auth`
- Broadcasts `"permissions:changed"` to affected user's PartyKit room
- Client re-fetches snapshot via `authClient.zanzo.snapshot()`

**Important:** The `@zanzojs/better-auth` plugin must expose `onTupleChange` hook in a way this adapter can consume cleanly.

---

## Development Setup

### Tools

```toml
# mise.toml (to be added to repo root)
[tools]
node                   = "22"
"github:jdx/pitchfork" = "latest"
pnpm                   = "10.24.0"
```

### mise Tasks

Tasks live in `packages/better-auth/mise-tasks.toml` and are included from root `mise.toml`.

```
mise run better-auth:build       # tsup build
mise run better-auth:test        # vitest run
mise run better-auth:test:types  # vitest typecheck
mise run better-auth:dev         # wrangler dev for local D1 testing
mise run better-auth:lint        # biome lint
```

### Research repos

External repos cloned for reference — gitignored, never committed:
```
mise -C .src run src:clone    # clone all research repos
mise -C .src run src:update   # pull latest
mise -C .src run src:status   # show current HEAD of each
```

Currently cloned:
- `.src/agents` — `github.com/cloudflare/agents` (Workspace filesystem source)

### pitchfork

`pitchfork.toml` orchestrates local D1 + wrangler dev for integration testing:

```toml
[daemons.wrangler-dev]
run        = "mise run better-auth:dev"
ready_http = "http://localhost:8790/health"
retry      = true
auto       = ["start", "stop"]
```

---

## Consequences

### Positive
- `@cloudflare/shell` `Workspace` `onChange` hook makes permission lifecycle fully automatic for file resources — no manual cleanup calls
- One-line Better Auth + zanzojs wiring for all Cloudflare projects
- OpenAPI + MCP out of the box — AI agents and humans use the same API
- All three cleanup strategies available for actors — projects choose what fits
- `onTupleChange` hook decouples PartyKit adapter from plugin internals
- `onAudit` callback supports compliance requirements without imposing a schema
- Dedicated `transfer` endpoint prevents ownership transfer bugs
- Time-limited access via `expiresAt` — native engine feature, just exposed

### Negative / Risks
- `@zanzojs` upstream still immature (1 contributor, no formal releases)
- `'orphan'` cleanup mode requires a schema migration (extra column)
- Non-Workspace `revokeAll()` calls require `fetchChildren` — callers must understand the derived tuple graph
- New child resources outside Workspace must call `materializeDerivedTuples()` manually on every create
- `resolveActor` is caller's responsibility — wrong prefix = silent auth bugs
- Inheritance break is app-layer responsibility — plugin cannot enforce it

### Mitigations
- This repo is already a fork — insulated from upstream churn
- `orphaned_at` column is nullable — migration is non-breaking, backward compatible
- Workspace `onChange` hook eliminates most manual cleanup for file resources
- TypeScript will not catch wrong actor prefixes — document convention, add runtime dev-mode warning
- `fetchChildren` is already the established pattern in `@zanzojs/core` — consistent with existing API

---

## References

- Better Auth plugin API: https://www.better-auth.com/docs/concepts/plugins
- `@cloudflare/shell` Workspace: https://github.com/cloudflare/agents/tree/main/packages/shell
- `@hono/zod-openapi`: https://hono.dev/examples/zod-openapi
- `@hono/mcp`: https://hono.dev/examples/mcp
- PartyKit: https://github.com/partykit/partykit
- Cloudflare Queues: https://developers.cloudflare.com/queues/
- Upstream zanzojs: https://github.com/GonzaloJeria/zanzojs
