# workspace-d1-app

Public HTTP surface for `workspace-d1`. All calls go via Workers Service Binding (RPC) — no HTTP hop in production.

**Port:** 8788 | **Requires:** `workspace-d1` running on port 8787

## What it does

Exposes `workspace-d1`'s RPC methods as HTTP endpoints for curl/browser testing. In production this is the only public-facing worker — `workspace-d1` is binding-only.

## HTTP surface

### Permissions
```
PUT    /grant              body: { subject, relation, type, id }
DELETE /revoke             body: { subject, relation, type, id }
GET    /check              ?actor=&action=&type=&id=
```

### Files
```
GET    /files/*path        ?actor=   read file
PUT    /files/*path        ?actor=   write file  (body = content)
DELETE /files/*path        ?actor=   delete file
POST   /append/*path       ?actor=   append to file  (body = content)
GET    /exists/*path       ?actor=   { exists: true|false }
GET    /stat/*path         ?actor=   { stat: { type, size, mtime } }
```

### Directories
```
GET    /ls/*path           ?actor=   list directory entries
POST   /mkdir/*path        ?actor=   create directory
DELETE /rmdir/*path        ?actor=   delete directory recursively
GET    /glob               ?actor=&pattern=   glob files (paths only, no permission gate)
```

### Copy / Move
```
POST   /cp                 body: { from, to }  ?actor=   copy file
POST   /mv                 body: { from, to }  ?actor=   move file
POST   /cpdir              body: { from, to }  ?actor=   copy directory
POST   /mvdir              body: { from, to }  ?actor=   move directory
```

### Debug
```
GET    /demo               full RPC smoke test (grant → write → check → revoke)
```

## Example

```bash
# Grant alice owner on a directory
curl -X PUT http://localhost:8788/grant \
  -H "Content-Type: application/json" \
  -d '{"subject":"User:alice","relation":"owner","type":"Directory","id":"/demo"}'

# Write a file
curl -X PUT "http://localhost:8788/files/demo/notes.txt?actor=User:alice" \
  -d "hello world"

# Read it
curl "http://localhost:8788/files/demo/notes.txt?actor=User:alice"

# Bob is denied (no permission yet)
curl "http://localhost:8788/files/demo/notes.txt?actor=User:bob"
```

## Wiring

`workspace-d1-app` imports only `WorkspaceD1RPC` from `workspace-d1/src/types.ts` — zero transitive deps. The Service Binding in `wrangler.toml` routes RPC calls directly to the `WorkspaceD1` class.

```toml
[[services]]
binding = "FILES"
service = "workspace-d1"
```

## Dev

```bash
mise run workspace-d1-start        # start workspace-d1 first
mise run workspace-d1-app-start    # then start this (port 8788)
mise run workspace-d1-app-stop     # stop
mise run workspace-d1-app-logs     # tail logs
mise run workspace-d1-test         # run integration tests
```

## Production

```bash
# workspace-d1 must be deployed first
wrangler deploy --env production
```
