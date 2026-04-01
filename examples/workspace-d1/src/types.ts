/**
 * RPC contract for workspace-d1.
 *
 * Import this in any Worker that has a Service Binding to workspace-d1:
 *
 *   import type { WorkspaceD1RPC } from '@zanzojs/example-workspace-d1/types';
 *   interface Env { FILES: WorkspaceD1RPC }
 *
 * This file has zero dependencies — safe to import from any Worker without
 * pulling in drizzle, cloudflare-shell, or other implementation types.
 * The WorkspaceD1 class in worker.ts must implement this interface.
 */

/** Minimal stat info — enough for UI display and conditional logic. */
export interface FileStat {
  type: 'file' | 'directory' | 'symlink';
  size: number;
  mtime: Date;
}

export interface WorkspaceD1RPC {
  // ── Permissions ────────────────────────────────────────────────────────
  grant(subject: string, relation: string, type: string, id: string): Promise<void>;
  revoke(subject: string, relation: string, type: string, id: string): Promise<number>;
  check(actor: string, action: string, type: string, id: string): Promise<boolean>;

  // ── Read ───────────────────────────────────────────────────────────────
  readFile(path: string, actor: string): Promise<string | null>;
  exists(path: string, actor: string): Promise<boolean>;
  stat(path: string, actor: string): Promise<FileStat | null>;
  listDir(path: string, actor: string): Promise<string[]>;
  glob(pattern: string, actor: string): Promise<string[]>;

  // ── Write ──────────────────────────────────────────────────────────────
  writeFile(path: string, content: string, actor: string): Promise<void>;
  appendFile(path: string, content: string, actor: string): Promise<void>;
  mkdir(path: string, actor: string): Promise<void>;

  // ── Move / Copy ────────────────────────────────────────────────────────
  moveFile(from: string, to: string, actor: string): Promise<void>;
  copyFile(from: string, to: string, actor: string): Promise<void>;
  moveDir(from: string, to: string, actor: string): Promise<void>;
  copyDir(from: string, to: string, actor: string): Promise<void>;

  // ── Delete ─────────────────────────────────────────────────────────────
  deleteFile(path: string, actor: string): Promise<void>;
  deleteDir(path: string, actor: string): Promise<void>;
}
