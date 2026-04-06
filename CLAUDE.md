# CLAUDE

This is a fork of https://github.com/GonzaloJeria/zanzojs

A zero-dependency, Cloudflare Workers-native ReBAC library inspired by Google Zanzibar. Shared authorization layer for all Cloudflare Workers projects, used alongside Better Auth for identity.

## Packages

- `@zanzojs/core` — zero-dep ReBAC engine, runs on Workers/D1/Edge
- `@zanzojs/drizzle` — Drizzle ORM adapter, SQL `EXISTS` pushdown queries against D1
- `@zanzojs/react` — React context + hooks for O(1) frontend permission checks
- `@zanzojs/angular` — Angular service + signals integration
- `@zanzojs/cli` — schema scaffolding and validation
- `@zanzojs/better-auth` — Better Auth plugin: `zanzoPlugin()`, `createZanzoHonoApp()`, `zanzoClientPlugin()` (see [docs/adr-better-auth-plugin.md](docs/adr-better-auth-plugin.md))

## Examples

### `examples/workspace-d1` — reference implementation (port 8787)

ReBAC permission API + `@cloudflare/shell` filesystem worker. Single worker, single port.

- **Permissions** — `zanzoPlugin()` from `@zanzojs/better-auth`. Handles `check/grant/revoke/snapshot` with filesystem parent-path inheritance. Wired to `Workspace.onChange` for automatic tuple lifecycle on file create/delete.
- **Filesystem** — D1 + R2 via `@cloudflare/shell` `Workspace`. `PermissionedBackend` wraps `createWorkspaceStateBackend()` — checks permissions before every operation.
- **HTTP API** — `/zanzo/*` (plugin sub-app) + `/files/*`, `/ls/*`, `/exists/*`, `/stat/*`, `/glob`, `/mkdir/*`, `/append/*`, `/cp`, `/mv`, `/cpdir`, `/mvdir`, `/rmdir/*`.
- **Live sync** — `ZanzoPermServer` Durable Object. Browser connects via WebSocket; gets a fresh permission snapshot on connect and after every tuple change.
- **Schema split** — `src/schema-fs.ts` (File + Directory) + `src/schema-domain.ts` (User/Agent/Service + Project/CadModel/Drone). Merged via `mergeSchemas()`.
- **RPC contract** — `src/types.ts` exports `WorkspaceD1RPC` for Workers Service Binding callers.

```bash
mise run workspace-d1-start    # start worker (pitchfork, port 8787)
mise run workspace-d1-stop     # stop
mise run workspace-d1-reset    # wipe D1 state + restart
mise run workspace-d1-logs     # tail logs
mise run workspace-d1-test     # run integration tests (single worker)
```

### Running tests

```bash
mise run workspace-d1-reset    # wipe DB
mise run workspace-d1-start    # start worker
mise run workspace-d1-test     # 70+ tests: permissions, filesystem, /zanzo/* routes
```

---

## Development

```bash
mise install        # installs all tools (node, pnpm, pitchfork)
pnpm install        # installs JS dependencies
pnpm build          # builds all packages
pnpm test           # runs all tests
```

---

## Original Context (plat-trunk — kept for reference)

The original motivation came from plat-trunk, but this library is now generic across all projects.

plat-trunk requires fine-grained authorization across multiple actor types and resource types. The existing Better Auth session/auth layer provides identity but has no per-resource-instance authorization. Specifically:

**Actors:**
- Human users (browser, Tauri desktop)
- MCP agents (AI-driven geometry authoring via ADR-0039)
- Service accounts (RICOS pipeline, FEA solver)

**Resources:**
- CAD models (assemblies, parts, sketches)
- Projects and workspaces
- Drone/robot instances
- Scene graph nodes
- Sync branches (ADR-0038)

**Required checks (examples):**
- `can User:gerard execute_command on Drone:123`
- `can Agent:claude-mcp read on CadModel:456`
- `can User:max-kusterman edit on Project:789`
- `can Agent:ricos-pipeline read_telemetry on Assembly:abc`

RBAC (as provided by Better Auth's org/admin plugins) is insufficient because:

1. Permissions must be checked against **specific resource instances**, not resource types
2. **Hierarchical inheritance** is required — access to a Project implies access to its child CadModels and Assemblies
3. **MCP agents** are first-class actors alongside human users
4. All data must remain in **Cloudflare D1** — no external authorization services
5. The system must run inside **Cloudflare Workers** — no Node.js-specific dependencies

An exhaustive search of the npm ecosystem (418+ packages evaluated) found no production-ready solution combining tuple-based ReBAC + D1 + Better Auth native integration. Evaluated candidates included:

| Candidate | Verdict |
|---|---|
| Better Auth org/admin plugin | RBAC only, no per-resource-instance checks |
| `better-auth-zanzibar-plugin` | Thin callback wrapper, no tuple storage, `node-cache` dies in Workers |
| `better-auth-abac` (cnbrown04) | Alpha, abandoned, parallel DB connection anti-pattern |
| OpenFGA | Go binary, no Workers support, JS SDK has open issue #72 blocking edge runtimes |
| SpiceDB | Same — requires separate service with Postgres/CockroachDB |
| `@tsfga/core` | Architecturally rigorous, OpenFGA-compatible, but Postgres/Kysely only — no D1 |
| `polizy` | Prisma only |
| **`@zanzojs/core` + `@zanzojs/drizzle`** | **Zero deps, D1-native SQLite dialect, real tuple storage, SQL pushdown** |

---

## Decision

Adopt **`@zanzojs/core` + `@zanzojs/drizzle`** as the ReBAC engine for plat-trunk, wired into the existing Better Auth + Hono stack.

`@zanzojs` is used as the **authorization engine only** — it does not replace Better Auth for identity, sessions, or API key management. Better Auth remains the single source of identity. The `@zanzojs` tuple table in D1 is the single source of permissions.

---

## Architecture

### Layer Responsibilities

```
┌─────────────────────────────────────────┐
│  Better Auth                            │  Identity + Sessions + MCP agent tokens
│  (ADR-0039 for agent auth)              │
└────────────────┬────────────────────────┘
                 │ userId / agentId
                 ▼
┌─────────────────────────────────────────┐
│  Hono Middleware (authz guard)          │  Extracts session → passes actor to @zanzojs
└────────────────┬────────────────────────┘
                 │ actor string e.g. "User:gerard"
                 ▼
┌─────────────────────────────────────────┐
│  @zanzojs/core + @zanzojs/drizzle       │  Generates EXISTS SQL → checks D1 tuple table
└────────────────┬────────────────────────┘
                 │ SQL WHERE clause
                 ▼
┌─────────────────────────────────────────┐
│  D1: zanzo_tuples table                 │  (subject, relation, object) rows
└─────────────────────────────────────────┘
```

### Tuple Table (D1 Migration)

```sql
CREATE TABLE zanzo_tuples (
  subject  TEXT NOT NULL,   -- e.g. "User:gerard" | "Agent:claude-mcp"
  relation TEXT NOT NULL,   -- e.g. "owner" | "operator" | "viewer"
  object   TEXT NOT NULL,   -- e.g. "CadModel:abc123" | "Project:xyz"
  UNIQUE(subject, relation, object)
);

CREATE INDEX idx_zanzo_subject_relation ON zanzo_tuples(subject, relation);
CREATE INDEX idx_zanzo_object_relation  ON zanzo_tuples(object, relation);
```

### Schema Definition (`src/auth/zanzo.config.ts`)

```ts
import { ZanzoBuilder, ZanzoEngine } from '@zanzojs/core';

export const schema = new ZanzoBuilder()
  .entity('User',  { actions: [], relations: {} })
  .entity('Agent', { actions: [], relations: {} })

  .entity('Project', {
    actions: ['read', 'edit', 'delete', 'manage'],
    relations: { owner: 'User', editor: 'User', viewer: 'User' },
    permissions: {
      read:   ['owner', 'editor', 'viewer'],
      edit:   ['owner', 'editor'],
      delete: ['owner'],
      manage: ['owner'],
    }
  })

  .entity('CadModel', {
    actions: ['read', 'edit', 'delete', 'execute_command'],
    relations: { owner: 'User', editor: 'User', viewer: 'User', project: 'Project' },
    permissions: {
      read:            ['owner', 'editor', 'viewer', 'project.viewer', 'project.owner'],
      edit:            ['owner', 'editor', 'project.editor', 'project.owner'],
      delete:          ['owner', 'project.owner'],
      execute_command: ['owner', 'editor', 'project.owner'],
    }
  })

  .entity('Drone', {
    actions: ['read_telemetry', 'execute_command'],
    relations: { operator: 'User', viewer: 'User', agent: 'Agent', project: 'Project' },
    permissions: {
      read_telemetry:  ['operator', 'viewer', 'agent', 'project.viewer'],
      execute_command: ['operator', 'agent', 'project.owner'],
    }
  })

  .build();

export const engine = new ZanzoEngine(schema);
```

### Drizzle Adapter Initialisation (`src/auth/zanzo.adapter.ts`)

```ts
import { createZanzoAdapter } from '@zanzojs/drizzle';
import { engine } from './zanzo.config';
import { zanzoTuples } from '../db/schema';

// dialect: 'sqlite' generates || concatenation instead of CONCAT() for D1
export const withPermissions = createZanzoAdapter(engine, zanzoTuples, {
  dialect: 'sqlite',
});
```

### Hono Middleware Usage

```ts
import { withPermissions } from '../auth/zanzo.adapter';
import { cadModels } from '../db/schema';

// List all CAD models the current user can read
app.get('/api/cad-models', async (c) => {
  const session = await auth.api.getSession({ headers: c.req.raw.headers });
  if (!session) return c.json({ error: 'Unauthorized' }, 401);

  const actor = `User:${session.user.id}`;

  // Generates: WHERE EXISTS (SELECT 1 FROM zanzo_tuples WHERE ...)
  const filter = withPermissions(actor, 'read', 'CadModel', cadModels.id);

  const models = await db.select().from(cadModels).where(filter);
  return c.json(models);
});

// Single resource permission check
app.post('/api/cad-models/:id/execute', async (c) => {
  const session = await auth.api.getSession({ headers: c.req.raw.headers });
  const actor = session?.user.id
    ? `User:${session.user.id}`
    : `Agent:${session?.agentId}`; // MCP agent from ADR-0039

  const filter = withPermissions(actor, 'execute_command', 'CadModel', cadModels.id);

  const [model] = await db
    .select()
    .from(cadModels)
    .where(and(eq(cadModels.id, c.req.param('id')), filter));

  if (!model) return c.json({ error: 'Forbidden' }, 403);
  // ...
});
```

### Writing Tuples (Grant/Revoke)

```ts
// Grant a user viewer access to a CAD model
await db.insert(zanzoTuples).values({
  subject:  `User:${userId}`,
  relation: 'viewer',
  object:   `CadModel:${modelId}`,
}).onConflictDoNothing();

// Hierarchical: grant project-level access (materialise derived tuples)
import { materializeDerivedTuples } from '@zanzojs/core';

const base = { subject: `User:${userId}`, relation: 'editor', object: `Project:${projectId}` };
const { expandedTuples } = await materializeDerivedTuples({
  schema: engine.getSchema(),
  newTuple: base,
  fetchChildren: async (parentObj, relation) => {
    // Return all child CadModels and Drones in this project
    const children = await db.select({ id: cadModels.id })
      .from(cadModels)
      .where(eq(cadModels.projectId, parentObj.split(':')[1]));
    return children.map(c => `CadModel:${c.id}`);
  }
});

await db.insert(zanzoTuples).values([base, ...expandedTuples]).onConflictDoNothing();
```

---

## Consequences

### Positive

- **Zero new infrastructure** — all authorization data lives in D1 alongside application data
- **Workers-native** — `@zanzojs/core` has zero dependencies and no Node.js APIs
- **SQL pushdown** — authorization checks are `EXISTS` subqueries, never loading tuples into memory per-request
- **MCP agents as first-class actors** — `Agent:xyz` subject type handles ADR-0039 use cases cleanly
- **Hierarchical permissions** — project-level access materialised to child resources at write time
- **Data sovereignty** — no external service, no network hop on permission checks
- **Rust kernel access** — the `zanzo_tuples` table can be queried directly from Rust WASM via D1 binding for complex path-finding if needed
- **Audit trail** — tuple inserts/deletes are standard D1 rows, queryable for compliance

### Negative / Risks

- **`@zanzojs` immaturity** — 1 month old, 1 contributor, 0 formal releases as of 2026-03-31. API may change.
- **Materialised tuples complexity** — hierarchical permissions require `materializeDerivedTuples()` on every write that affects a hierarchy. Write paths become more complex.
- **No Better Auth native plugin** — wiring is manual (Better Auth session → actor string → `@zanzojs`). No `ctx.context.internalAdapter` integration.
- **Migration risk** — if `@zanzojs` is abandoned, the tuple table schema is standard SQL and the `EXISTS` query pattern can be re-implemented independently.

### Mitigations

- Fork `@zanzojs` into the plat-trunk monorepo as a vendored package — insulates from upstream churn
- Contact GonzaloJeria (https://github.com/GonzaloJeria/zanzojs/issues) to establish collaboration
- The tuple table schema and SQL pattern are simple enough that the dependency could be dropped entirely and replaced with ~150 lines if needed

---

## Alternatives Considered

### Do Nothing (Better Auth org/admin plugin only)
Rejected. RBAC without per-resource-instance checks is insufficient for plat-trunk's multi-tenant CAD resource model.

### Custom Tuple Table (hand-rolled)
Viable fallback. The `@zanzojs` approach is essentially this — a tuple table plus SQL pushdown — but with type safety, schema validation, and hierarchy expansion utilities already implemented. Using `@zanzojs` is preferred unless it proves unmaintainable.

### OpenFGA on Cloudflare Containers
Rejected. Cloudflare Containers has ephemeral disk — SQLite datastore is wiped on container sleep. Postgres backing store would require an external database, breaking data sovereignty. JS SDK has open issue blocking edge runtime support (openfga/js-sdk#72).

### SpiceDB / Permify / Ory Keto
Rejected. All require a separate persistent service with Postgres/CockroachDB. Network hop on every permission check. Incompatible with Workers-first architecture.

### `@tsfga/core`
Strong candidate architecturally (OpenFGA-compatible, conformance-tested, rigorous 5-step algorithm). Rejected for now due to Postgres/Kysely only — no D1 adapter. Revisit if `@zanzojs` proves unstable; contributing a SQLite/D1 adapter to `@tsfga` is a viable path (contact: @lemuelroberto on Twitter).

---

## References

- `@zanzojs` source: https://github.com/GonzaloJeria/zanzojs
- `@zanzojs/drizzle` D1 example: https://github.com/GonzaloJeria/zanzojs/tree/main/examples/nextjs-d1
- Google Zanzibar paper: https://research.google/pubs/zanzibar-googles-consistent-global-authorization-system/
- ADR-0039: Tauri v2 / MCP Agent Integration
- ADR-0038: Versioning model with R2 storage
- ADR-0008: Pure Rust sync path
- openfga/js-sdk#72: Edge runtime blocker (open as of 2026-03-31)