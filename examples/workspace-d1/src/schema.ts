/**
 * schema.ts — combines fsSchema + domainSchema into a single ZanzoEngine.
 *
 * Both schemas share the same zanzo_tuples D1 table and the same canDo()
 * query. Splitting them into separate files makes the boundary explicit:
 *
 *   schema-fs.ts     — File + Directory (driven by @cloudflare/shell)
 *   schema-domain.ts — Project, CadModel, Drone (application resources)
 *
 * The merged engine is used by canDo() in worker.ts for all permission checks.
 */

import { sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { ZanzoEngine, mergeSchemas } from '@zanzojs/core';
import { fsSchema } from './schema-fs';
import { domainSchema } from './schema-domain';

// ── D1 tuple table ────────────────────────────────────────────────────────────
// Single table for all permission tuples — filesystem and domain resources alike.
// (subject, relation, object) e.g. ('User:alice', 'owner', 'Directory:/projects/demo')

export const zanzoTuples = sqliteTable('zanzo_tuples', {
  subject:  text('subject').notNull(),
  relation: text('relation').notNull(),
  object:   text('object').notNull(),
});

// ── Merged engine ─────────────────────────────────────────────────────────────
// mergeSchemas() — from @zanzojs/core — throws if the same entity is defined
// in both schemas. Actors (User/Agent/Service) live in domainSchema only.
// fsSchema has File + Directory; domainSchema has actors + Project/CadModel/Drone.

export const engine = new ZanzoEngine(mergeSchemas(fsSchema, domainSchema));
