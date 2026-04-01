# workspace-d1

ReBAC permission API + `@cloudflare/shell` filesystem worker.

**Port:** 8787 | **Binding:** called by `workspace-d1-app` via Workers Service Binding (RPC)

## What it does

- Stores files in Cloudflare D1 (small files) or R2 (>~1.5MB, automatic spillover)
- Enforces permissions via `zanzo_tuples` D1 table — every filesystem op is permission-gated
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

- Owning a **Directory** grants access to everything inside it (parent path inheritance)
- `File` and `Directory` entities defined in `src/schema-fs.ts`
- Domain resources (`Project`, `CadModel`, `Drone`) in `src/schema-domain.ts`
- All schemas merged into one engine via `mergeSchemas()` from `@zanzojs/core`

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

# 2. Create R2 bucket
wrangler r2 bucket create workspace-files

# 3. Apply migrations
wrangler d1 migrations apply workspace-db --env production

# 4. Deploy
wrangler deploy --env production
```
