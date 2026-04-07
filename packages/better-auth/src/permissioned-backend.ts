/**
 * PermissionedBackend — wraps a StateBackend with ReBAC permission checks.
 *
 * Every operation is intercepted, canDo() is called with the actor, and
 * only if allowed does the call delegate to the underlying StateBackend.
 *
 * This is the permission entry layer for the filesystem. It does not
 * re-implement any filesystem logic — that all lives in createWorkspaceStateBackend().
 *
 * ── Package source ───────────────────────────────────────────────────────────
 *
 *   npm:    @cloudflare/shell
 *   repo:   github.com/cloudflare/agents
 *   path:   packages/shell/src/
 *   export: import { Workspace, createWorkspaceStateBackend } from '@cloudflare/shell'
 *
 *   There is also a /workers subpath (@cloudflare/shell/workers) that exposes
 *   stateTools() for LLM codemode execution inside Workers — that is NOT what
 *   we use here. We use the main export's createWorkspaceStateBackend() directly.
 *
 * ── How to create an instance ────────────────────────────────────────────────
 *
 *   // Workspace — D1 + optional R2 file store (packages/shell/src/workspace.ts)
 *   // createWorkspaceStateBackend — converts a Workspace into a full StateBackend
 *   //   (packages/shell/src/backends/workspace-backend.ts or similar)
 *
 *   import { Workspace, createWorkspaceStateBackend } from '@cloudflare/shell';
 *
 *   const workspace = new Workspace({ sql: env.DB, r2: env.FILES, r2Prefix: 'workspace' });
 *   const rawBackend = createWorkspaceStateBackend(workspace);
 *   const fs = new PermissionedBackend(rawBackend, actor, canDo);
 *
 * ── Where StateBackend comes from ────────────────────────────────────────────
 *
 *   StateBackend and all State* types are defined in packages/shell/src/ and
 *   exported from @cloudflare/shell (main index). createWorkspaceStateBackend()
 *   returns an object that satisfies StateBackend. PermissionedBackend wraps it —
 *   same interface, permission gate in front of every method.
 *
 * ── canDo ────────────────────────────────────────────────────────────────────
 *
 *   canDo is the canDo() function from worker.ts — it queries the zanzo_tuples
 *   D1 table using the ZanzoEngine-generated SQL to check actor permissions.
 */

// StateBackend is the only exported type we need from @cloudflare/shell.
// All State* sub-types are declared internally but NOT exported from the package.
// We derive them from StateBackend's method signatures using TypeScript utility
// types — this is robust against upstream type export changes.
import type { StateBackend } from '@cloudflare/shell';

// Derived from StateBackend method signatures
// (github.com/cloudflare/agents — packages/shell/src/backend.d.ts)
type StateCapabilities        = Awaited<ReturnType<StateBackend['getCapabilities']>>;
type StateStat                = NonNullable<Awaited<ReturnType<StateBackend['stat']>>>;
type StateMkdirOptions        = Parameters<StateBackend['mkdir']>[1];
type StateRmOptions           = Parameters<StateBackend['rm']>[1];
type StateCopyOptions         = Parameters<StateBackend['cp']>[2];
type StateMoveOptions         = Parameters<StateBackend['mv']>[2];
type StateDirent              = Awaited<ReturnType<StateBackend['readdirWithFileTypes']>>[number];
type StateFindOptions         = Parameters<StateBackend['find']>[1];
type StateFindEntry           = Awaited<ReturnType<StateBackend['find']>>[number];
type StateTreeOptions         = Parameters<StateBackend['walkTree']>[1];
type StateTreeNode            = Awaited<ReturnType<StateBackend['walkTree']>>;
type StateTreeSummary         = Awaited<ReturnType<StateBackend['summarizeTree']>>;
type StateSearchOptions       = Parameters<StateBackend['searchText']>[2];
type StateTextMatch           = Awaited<ReturnType<StateBackend['searchText']>>[number];
type StateFileSearchResult    = Awaited<ReturnType<StateBackend['searchFiles']>>[number];
type StateReplaceResult       = Awaited<ReturnType<StateBackend['replaceInFile']>>;
type StateReplaceInFilesOptions = Parameters<StateBackend['replaceInFiles']>[3];
type StateReplaceInFilesResult = Awaited<ReturnType<StateBackend['replaceInFiles']>>;
type StateJsonWriteOptions    = Parameters<StateBackend['writeJson']>[2];
type StateJsonUpdateOperation = Parameters<StateBackend['updateJson']>[1][number];
type StateJsonUpdateResult    = Awaited<ReturnType<StateBackend['updateJson']>>;
type StateEdit                = Parameters<StateBackend['applyEdits']>[0][number];
type StateEditInstruction     = Parameters<StateBackend['planEdits']>[0][number];
type StateEditPlan            = Awaited<ReturnType<StateBackend['planEdits']>>;
type StateApplyEditsOptions   = Parameters<StateBackend['applyEdits']>[1];
type StateApplyEditsResult    = Awaited<ReturnType<StateBackend['applyEdits']>>;
type StateArchiveEntry        = Awaited<ReturnType<StateBackend['listArchive']>>[number];
type StateArchiveCreateResult = Awaited<ReturnType<StateBackend['createArchive']>>;
type StateArchiveExtractResult = Awaited<ReturnType<StateBackend['extractArchive']>>;
type StateCompressionResult   = Awaited<ReturnType<StateBackend['compressFile']>>;
type StateHashOptions         = Parameters<StateBackend['hashFile']>[1];
type StateFileDetection       = Awaited<ReturnType<StateBackend['detectFile']>>;

type CanDoFn = (actor: string, action: string, type: string, path: string) => Promise<boolean>;

export class PermissionedBackend implements StateBackend {
  constructor(
    private readonly backend: StateBackend,
    private readonly actor: string,
    private readonly canDo: CanDoFn,
  ) {}

  private async assertRead(path: string): Promise<void> {
    if (!(await this.canDo(this.actor, 'read', 'File', path))) {
      throw new Error(`Forbidden: ${this.actor} cannot read ${path}`);
    }
  }

  private async assertWrite(path: string): Promise<void> {
    if (!(await this.canDo(this.actor, 'write', 'File', path))) {
      throw new Error(`Forbidden: ${this.actor} cannot write ${path}`);
    }
  }

  private async assertDelete(path: string): Promise<void> {
    if (!(await this.canDo(this.actor, 'delete', 'File', path))) {
      throw new Error(`Forbidden: ${this.actor} cannot delete ${path}`);
    }
  }

  private async assertReadDir(path: string): Promise<void> {
    if (!(await this.canDo(this.actor, 'read', 'Directory', path))) {
      throw new Error(`Forbidden: ${this.actor} cannot read directory ${path}`);
    }
  }

  private async assertDeleteDir(path: string): Promise<void> {
    if (!(await this.canDo(this.actor, 'delete', 'Directory', path))) {
      throw new Error(`Forbidden: ${this.actor} cannot delete directory ${path}`);
    }
  }

  // ── Capabilities ──────────────────────────────────────────────────────
  getCapabilities(): Promise<StateCapabilities> {
    return this.backend.getCapabilities();
  }

  // ── Read operations ───────────────────────────────────────────────────
  async readFile(path: string): Promise<string> {
    await this.assertRead(path);
    return this.backend.readFile(path);
  }

  async readFileBytes(path: string): Promise<Uint8Array> {
    await this.assertRead(path);
    return this.backend.readFileBytes(path);
  }

  async readJson(path: string): Promise<unknown> {
    await this.assertRead(path);
    return this.backend.readJson(path);
  }

  async queryJson(path: string, query: string): Promise<unknown> {
    await this.assertRead(path);
    return this.backend.queryJson(path, query);
  }

  async exists(path: string): Promise<boolean> {
    await this.assertRead(path);
    return this.backend.exists(path);
  }

  async stat(path: string): Promise<StateStat | null> {
    await this.assertRead(path);
    return this.backend.stat(path);
  }

  async lstat(path: string): Promise<StateStat | null> {
    await this.assertRead(path);
    return this.backend.lstat(path);
  }

  async readlink(path: string): Promise<string> {
    await this.assertRead(path);
    return this.backend.readlink(path);
  }

  async realpath(path: string): Promise<string> {
    await this.assertRead(path);
    return this.backend.realpath(path);
  }

  async resolvePath(base: string, path: string): Promise<string> {
    return this.backend.resolvePath(base, path);
  }

  async readdir(path: string): Promise<string[]> {
    await this.assertReadDir(path);
    return this.backend.readdir(path);
  }

  async readdirWithFileTypes(path: string): Promise<StateDirent[]> {
    await this.assertReadDir(path);
    return this.backend.readdirWithFileTypes(path);
  }

  async find(path: string, options?: StateFindOptions): Promise<StateFindEntry[]> {
    await this.assertReadDir(path);
    return this.backend.find(path, options);
  }

  async walkTree(path: string, options?: StateTreeOptions): Promise<StateTreeNode> {
    await this.assertReadDir(path);
    return this.backend.walkTree(path, options);
  }

  async summarizeTree(path: string, options?: StateTreeOptions): Promise<StateTreeSummary> {
    await this.assertReadDir(path);
    return this.backend.summarizeTree(path, options);
  }

  async glob(pattern: string): Promise<string[]> {
    // glob returns paths only, not content — no permission check here.
    // Actual content access is still gated by readFile/readdir etc.
    // Knowing a path exists is not a meaningful security boundary in this system.
    return this.backend.glob(pattern);
  }

  async diff(pathA: string, pathB: string): Promise<string> {
    await this.assertRead(pathA);
    await this.assertRead(pathB);
    return this.backend.diff(pathA, pathB);
  }

  async diffContent(path: string, newContent: string): Promise<string> {
    await this.assertRead(path);
    return this.backend.diffContent(path, newContent);
  }

  async hashFile(path: string, options?: StateHashOptions): Promise<string> {
    await this.assertRead(path);
    return this.backend.hashFile(path, options);
  }

  async detectFile(path: string): Promise<StateFileDetection> {
    await this.assertRead(path);
    return this.backend.detectFile(path);
  }

  async listArchive(path: string): Promise<StateArchiveEntry[]> {
    await this.assertRead(path);
    return this.backend.listArchive(path);
  }

  async searchText(path: string, query: string, options?: StateSearchOptions): Promise<StateTextMatch[]> {
    await this.assertRead(path);
    return this.backend.searchText(path, query, options);
  }

  async searchFiles(pattern: string, query: string, options?: StateSearchOptions): Promise<StateFileSearchResult[]> {
    // searchFiles returns matching lines from files — requires read on each matched file.
    // The underlying backend will only return content we delegate readFile calls through,
    // but since this bypasses per-file checks, treat it as requiring root read permission.
    await this.assertReadDir('/');
    return this.backend.searchFiles(pattern, query, options);
  }

  // ── Write operations ──────────────────────────────────────────────────
  async writeFile(path: string, content: string): Promise<void> {
    await this.assertWrite(path);
    return this.backend.writeFile(path, content);
  }

  async writeFileBytes(path: string, content: Uint8Array): Promise<void> {
    await this.assertWrite(path);
    return this.backend.writeFileBytes(path, content);
  }

  async appendFile(path: string, content: string | Uint8Array): Promise<void> {
    await this.assertWrite(path);
    return this.backend.appendFile(path, content);
  }

  async writeJson(path: string, value: unknown, options?: StateJsonWriteOptions): Promise<void> {
    await this.assertWrite(path);
    return this.backend.writeJson(path, value, options);
  }

  async updateJson(path: string, operations: StateJsonUpdateOperation[]): Promise<StateJsonUpdateResult> {
    await this.assertWrite(path);
    return this.backend.updateJson(path, operations);
  }

  async mkdir(path: string, options?: StateMkdirOptions): Promise<void> {
    await this.assertWrite(path);
    return this.backend.mkdir(path, options);
  }

  async symlink(target: string, linkPath: string): Promise<void> {
    await this.assertWrite(linkPath);
    return this.backend.symlink(target, linkPath);
  }

  async cp(src: string, dest: string, options?: StateCopyOptions): Promise<void> {
    await this.assertRead(src);
    await this.assertWrite(dest);
    return this.backend.cp(src, dest, options);
  }

  async copyTree(src: string, dest: string): Promise<void> {
    await this.assertReadDir(src);
    await this.assertWrite(dest);
    return this.backend.copyTree(src, dest);
  }

  async replaceInFile(path: string, search: string, replacement: string, options?: StateSearchOptions): Promise<StateReplaceResult> {
    await this.assertWrite(path);
    return this.backend.replaceInFile(path, search, replacement, options);
  }

  async replaceInFiles(pattern: string, search: string, replacement: string, options?: StateReplaceInFilesOptions): Promise<StateReplaceInFilesResult> {
    await this.assertWrite('/');
    return this.backend.replaceInFiles(pattern, search, replacement, options);
  }

  async createArchive(path: string, sources: string[]): Promise<StateArchiveCreateResult> {
    for (const src of sources) await this.assertRead(src);
    await this.assertWrite(path);
    return this.backend.createArchive(path, sources);
  }

  async extractArchive(path: string, destination: string): Promise<StateArchiveExtractResult> {
    await this.assertRead(path);
    await this.assertWrite(destination);
    return this.backend.extractArchive(path, destination);
  }

  async compressFile(path: string, destination?: string): Promise<StateCompressionResult> {
    await this.assertRead(path);
    if (destination) await this.assertWrite(destination);
    return this.backend.compressFile(path, destination);
  }

  async decompressFile(path: string, destination?: string): Promise<StateCompressionResult> {
    await this.assertRead(path);
    if (destination) await this.assertWrite(destination);
    return this.backend.decompressFile(path, destination);
  }

  async planEdits(instructions: StateEditInstruction[]): Promise<StateEditPlan> {
    for (const i of instructions) await this.assertWrite(i.path);
    return this.backend.planEdits(instructions);
  }

  async applyEditPlan(plan: StateEditPlan, options?: StateApplyEditsOptions): Promise<StateApplyEditsResult> {
    for (const e of plan.edits) await this.assertWrite(e.path);
    return this.backend.applyEditPlan(plan, options);
  }

  async applyEdits(edits: StateEdit[], options?: StateApplyEditsOptions): Promise<StateApplyEditsResult> {
    for (const e of edits) await this.assertWrite(e.path);
    return this.backend.applyEdits(edits, options);
  }

  // ── Delete operations ─────────────────────────────────────────────────
  async rm(path: string, options?: StateRmOptions): Promise<void> {
    if (options?.recursive) {
      await this.assertDeleteDir(path);
    } else {
      await this.assertDelete(path);
    }
    return this.backend.rm(path, options);
  }

  async removeTree(path: string): Promise<void> {
    await this.assertDeleteDir(path);
    return this.backend.removeTree(path);
  }

  // ── Move — delete src + write dest ───────────────────────────────────
  async mv(src: string, dest: string, options?: StateMoveOptions): Promise<void> {
    await this.assertDelete(src);
    await this.assertWrite(dest);
    return this.backend.mv(src, dest, options);
  }

  async moveTree(src: string, dest: string): Promise<void> {
    await this.assertDeleteDir(src);
    await this.assertWrite(dest);
    return this.backend.moveTree(src, dest);
  }
}
