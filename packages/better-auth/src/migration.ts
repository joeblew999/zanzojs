/**
 * ZANZO_MIGRATION_SQL — D1/SQLite migration for the zanzo_tuples table.
 *
 * Run this once against your D1 database before using zanzoPlugin:
 *
 *   // In a wrangler migration file (migrations/0000_zanzo.sql):
 *   import { ZANZO_MIGRATION_SQL } from '@zanzojs/better-auth/migration';
 *
 *   // Or apply programmatically:
 *   await env.DB.exec(ZANZO_MIGRATION_SQL);
 *
 * The SQL uses IF NOT EXISTS so it is safe to run multiple times.
 */
/** SQLite / D1 migration — table + recommended indexes. Safe to re-run (IF NOT EXISTS). */
export const ZANZO_MIGRATION_SQL = /* sql */`
CREATE TABLE IF NOT EXISTS zanzo_tuples (
  subject  TEXT NOT NULL,
  relation TEXT NOT NULL,
  object   TEXT NOT NULL,
  UNIQUE(subject, relation, object)
);

CREATE INDEX IF NOT EXISTS idx_zanzo_subject_relation ON zanzo_tuples (subject, relation);
CREATE INDEX IF NOT EXISTS idx_zanzo_object_relation  ON zanzo_tuples (object, relation);
CREATE INDEX IF NOT EXISTS idx_zanzo_subject_object   ON zanzo_tuples (subject, object);
`.trim();

/** PostgreSQL migration — use CONCURRENTLY variants for zero-downtime deploys. */
export const ZANZO_MIGRATION_SQL_PG = /* sql */`
CREATE TABLE IF NOT EXISTS zanzo_tuples (
  subject  TEXT NOT NULL,
  relation TEXT NOT NULL,
  object   TEXT NOT NULL,
  UNIQUE(subject, relation, object)
);

CREATE INDEX IF NOT EXISTS idx_zanzo_subject_relation ON zanzo_tuples (subject, relation);
CREATE INDEX IF NOT EXISTS idx_zanzo_object_relation  ON zanzo_tuples (object, relation);
CREATE INDEX IF NOT EXISTS idx_zanzo_subject_object   ON zanzo_tuples (subject, object);
`.trim();
