/**
 * Filesystem schema — ReBAC entities for @cloudflare/shell file storage.
 *
 * These entities mirror the two resource types that @cloudflare/shell
 * (github.com/cloudflare/agents — packages/shell/src/) operates on:
 *   File      — individual files stored in D1 (or R2 for >~1.5MB)
 *   Directory — directory paths used for hierarchical permission inheritance
 *
 * Permission model:
 *   - owner of a Directory grants owner read/write/delete on everything inside it
 *   - canDo() in worker.ts walks parent paths, so owning /projects/demo
 *     grants access to /projects/demo/notes.txt automatically
 *   - viewer on a File grants read on that file only (not the directory)
 *
 * Used by: PermissionedBackend (permissioned-backend.ts)
 * Tuples stored in: zanzo_tuples (D1)
 */

// Actors (User, Agent, Service) are defined in schema-domain.ts — not here.
// mergeSchemas() in schema.ts combines both. Relations referencing 'User'
// below are validated at merge time when the full schema is assembled.
import { ZanzoBuilder } from '@zanzojs/core';

export const fsSchema = new ZanzoBuilder()

  // ── Filesystem resources ──────────────────────────────────────────────
  .entity('Directory', {
    actions: ['read', 'write', 'delete', 'share'],
    relations: { owner: 'User', editor: 'User', viewer: 'User' },
    permissions: {
      read:   ['owner', 'editor', 'viewer'],
      write:  ['owner', 'editor'],
      delete: ['owner'],
      share:  ['owner'],
    },
  })

  .entity('File', {
    actions: ['read', 'write', 'delete', 'share'],
    relations: { owner: 'User', editor: 'User', viewer: 'User' },
    permissions: {
      read:   ['owner', 'editor', 'viewer'],
      write:  ['owner', 'editor'],
      delete: ['owner'],
      share:  ['owner'],
    },
  })

  .build();
