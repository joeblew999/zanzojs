export { zanzoPlugin }         from './plugin';
export type {
  ZanzoPluginOptions,
  ZanzoPluginInstance,
  TupleChangeEvent,
  AuditEvent,
  GrantOptions,
  CleanupMode,
  WorkspaceChangeEvent,
}                              from './plugin';

export { createZanzoHonoApp } from './hono';
export type { ZanzoHonoOptions } from './hono';

export { zanzoClientPlugin }  from './client';
export type {
  ZanzoClientOptions,
  ZanzoSnapshotResult,
  ZanzoCheckResult,
}                              from './client';

// PermissionedBackend — wraps @cloudflare/shell StateBackend with ReBAC checks.
// Optional peer dep: @cloudflare/shell. Only import this if you use @cloudflare/shell.
export { PermissionedBackend } from './permissioned-backend';
export type { } from './permissioned-backend';

// Migration SQL — apply once to your D1 database before using zanzoPlugin.
// Also importable from '@zanzojs/better-auth/migration' for tree-shaking.
export { ZANZO_MIGRATION_SQL, ZANZO_MIGRATION_SQL_PG } from './migration';
