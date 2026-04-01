# workspace-d1

## Google Zanzibar on Cloudflare D1

This pattern is Google Zanzibar — the authorization system behind Google Drive, Gmail, YouTube, and Maps — running natively on Cloudflare Workers + D1 instead of Google Spanner.

The core idea is identical:

- **Tuples** — `(subject, relation, object)` e.g. `User:alice | owner | Directory:/projects/demo`
- **Namespace model** — schema defines what relations and actions exist per resource type (`schema-fs.ts`, `schema-domain.ts`)
- **Check** — walk the tuple graph to answer "can actor X do action Y on resource Z?"
- **Parent inheritance** — owning a parent grants access to children (userset rewrite in the Zanzibar paper)

What Google added that we don't need:
- **Zookies** — consistency tokens for stale reads across global replicas. Not needed.
- **Leopard indexing** — precomputed group membership for billions of users (not needed at this scale)
- **Global Spanner replication** — Cloudflare handles this. Workers and D1 both scale out automatically.

What this adds beyond the paper:
- **`@cloudflare/shell` `onChange` hook** — automatic tuple lifecycle when files are created/deleted
- **SQL pushdown** via `@zanzojs/drizzle` — permission checks as `EXISTS` subqueries, never loading tuples into memory per request
- **Workers-native** — runs in a 128MB isolate, zero external service dependency, zero network hop on check


The library name is literally derived from it: **Zanzo**js = **Zanzi**bar.

Reference: [Google Zanzibar paper](https://research.google/pubs/zanzibar-googles-consistent-global-authorization-system/)

---

ReBAC permission API + `@cloudflare/shell` filesystem worker.

**Port:** 8787 | **Binding:** called by `workspace-d1-app` via Workers Service Binding (RPC)

## What it does

- Stores files in Cloudflare D1 (small files) or R2 (>~1.5MB, automatic spillover)
- Enforces permissions via `zanzo_tuples` D1 table — every filesystem op is permission-gated
- Handles **domain resources** (Project, CadModel, Drone, etc.) in the same tuple table — one `/check`, `/grant`, `/revoke` API for everything
- Exposes a typed RPC contract (`src/types.ts`) with zero transitive deps

## Architecture

```
workspace-d1-app (caller)
        │  Workers Service Binding — RPC, no HTTP
        ▼
WorkspaceD1 (WorkerEntrypoint)
        │
        ├── canDo() ← ZanzoEngine (schema-fs.ts + schema-domain.ts merged)
        │              queries zanzo_tuples D1 table
        │              walks parent directory paths for inheritance
        │
        └── PermissionedBackend
                │  check → delegate, no reimplemented logic
                ▼
            createWorkspaceStateBackend(workspace)   ← @cloudflare/shell
                │
                ▼
            Workspace (D1 + R2)                      ← @cloudflare/shell
```

## RPC contract

Import from `src/types.ts` — zero deps, safe to use in any Worker:

```ts
import type { WorkspaceD1RPC } from '@zanzojs/example-workspace-d1/types';
interface Env { FILES: WorkspaceD1RPC }

// Permissions
await env.FILES.grant('User:alice', 'owner', 'Directory', '/projects/demo')
await env.FILES.revoke('User:bob', 'viewer', 'File', '/demo/notes.txt')
await env.FILES.check('User:alice', 'read', 'File', '/demo/notes.txt')

// Files
await env.FILES.writeFile('/demo/notes.txt', 'hello', 'User:alice')
await env.FILES.readFile('/demo/notes.txt', 'User:alice')
await env.FILES.appendFile('/demo/log.txt', 'line\n', 'User:alice')
await env.FILES.deleteFile('/demo/notes.txt', 'User:alice')
await env.FILES.exists('/demo/notes.txt', 'User:alice')
await env.FILES.stat('/demo/notes.txt', 'User:alice')

// Directories
await env.FILES.mkdir('/demo/subdir', 'User:alice')
await env.FILES.listDir('/demo', 'User:alice')
await env.FILES.glob('demo/**', 'User:alice')
await env.FILES.deleteDir('/demo/subdir', 'User:alice')

// Copy / Move
await env.FILES.copyFile('/demo/a.txt', '/demo/b.txt', 'User:alice')
await env.FILES.moveFile('/demo/a.txt', '/demo/b.txt', 'User:alice')
await env.FILES.copyDir('/demo/src', '/demo/dst', 'User:alice')
await env.FILES.moveDir('/demo/src', '/demo/dst', 'User:alice')
```

## Permission model

Two schemas, one tuple table, one engine:

**Filesystem** (`src/schema-fs.ts`) — driven by `@cloudflare/shell`:
- Owning a `Directory` grants access to everything inside it (parent path inheritance)
- `File` and `Directory` entities with `read / write / delete / share` actions

**Domain resources** (`src/schema-domain.ts`) — your application resources:
- `Project`, `CadModel`, `Drone` with custom actions (`execute_command`, `read_telemetry`, …)
- Actors: `User:alice`, `Agent:claude-mcp`, `Service:ricos`
- Add your own entity types here — schema drives what `check()` allows

Both schemas merged via `mergeSchemas()` from `@zanzojs/core` into a single `ZanzoEngine`. Same `/grant`, `/revoke`, `/check` API for filesystem and domain resources alike:

```bash
# Filesystem
curl -X PUT /grant -d '{"subject":"User:alice","relation":"owner","type":"Directory","id":"/projects/demo"}'

# Domain resource — same API, different type
curl -X PUT /grant -d '{"subject":"Agent:claude-mcp","relation":"editor","type":"CadModel","id":"abc123"}'
curl /check?actor=Agent:claude-mcp&action=execute_command&type=CadModel&id=abc123
```

## HTTP surface (debug / curl)

```
PUT    /grant              insert a permission tuple
DELETE /revoke             remove a permission tuple
GET    /check              can actor do action on resource?
GET    /tuples             list all tuples (debug)
GET    /fs                 glob all files (debug)
```

## Dev

```bash
mise run workspace-d1-start    # start (port 8787)
mise run workspace-d1-stop     # stop
mise run workspace-d1-reset    # wipe D1 state + restart
mise run workspace-d1-logs     # tail logs
mise run workspace-d1-test     # 66 integration tests (requires workspace-d1-app-start too)
```

## Production

```bash
# 1. Create D1 database and paste the ID into wrangler.toml [env.production]
wrangler d1 create workspace-db

# 2. Enable read replication (one-time — dashboard or REST API only, no wrangler CLI support yet)
# Dashboard: Workers & Pages > D1 > your database > Settings > Enable Read Replication
# REST API:
# curl -X PUT "https://api.cloudflare.com/client/v4/accounts/{account_id}/d1/database/{database_id}" \
#   -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
#   -d '{"read_replication": {"mode": "auto"}}'

# 3. Create R2 bucket
wrangler r2 bucket create workspace-files

# 4. Apply migrations
wrangler d1 migrations apply workspace-db --env production

# 5. Deploy
wrangler deploy --env production
```

Once enabled, D1 automatically maintains read replicas in every region (ENAM, WNAM, WEUR, EEUR, APAC, OC)
and routes reads to the nearest copy. This worker uses the Sessions API (`env.DB.withSession()`) so
sequential consistency is guaranteed across replicas. No further config needed.
