import type { AccessibleResult } from '../types/index';

/**
 * A lightweight, ultra-fast O(1) ReBAC Client intended for Frontend applications
 * or Edge Environments.
 *
 * It operates solely on a pre-compiled JSON mask. It forces 0 dependencies
 * and requires no knowledge of schemas, graph recursion, or Rebac Engines.
 *
 * Issue #5: Uses Map<string, Set<string>> internally for true O(1) lookups.
 * Issue #12: Deep-copies incoming snapshot to prevent external mutation.
 */
export class ZanzoClient {
  private permissions: Map<string, Set<string>>;
  private snapshotCache: Record<string, string[]> | null = null;

  /**
   * Initializes the client with a strictly flat JSON representation of permissions.
   * The input is deep-copied internally to prevent Prototype Pollution
   * or external mutation attacks.
   *
   * @param compiledPermissions The Record<ResourceID, string[]> derived from `createZanzoSnapshot`
   */
  constructor(compiledPermissions: Record<string, string[]>) {
    // Issue #12: Deep-copy to prevent external mutation of the source object
    this.permissions = new Map(
      Object.entries(compiledPermissions).map(([key, actions]) => [
        key,
        new Set(Array.isArray(actions) ? actions : []),
      ]),
    );
  }

  /**
   * True O(1) constant time evaluation of permissions via Set.has().
   *
   * @param action The specific action to evaluate
   * @param resource The target resource entity identifier
   * @returns boolean True if authorized, False otherwise
   */
  public can(action: string, resource: string): boolean {
    const allowedActions = this.permissions.get(resource);
    if (!allowedActions) {
      return false;
    }

    return allowedActions.has(action);
  }

  /**
   * Returns all accessible objects of the given entity type with their allowed actions.
   *
   * **Complexity: O(n)** where n is the number of unique resources in the snapshot.
   * Unlike can() which is O(1), this method iterates the full snapshot.
   * For large snapshots (1000+ resources), use this sparingly — prefer can()
   * for per-resource checks in render loops.
   *
   * @example
   * const docs = client.listAccessible('Document')
   * // → [{ object: 'Document:doc1', actions: ['read', 'write'] }]
   */
  public listAccessible(entityType: string): AccessibleResult[] {
    const results: AccessibleResult[] = [];
    const prefix = `${entityType}:`;

    for (const [objectKey, actions] of this.permissions) {
      if (objectKey.startsWith(prefix)) {
        results.push({
          object: objectKey,
          actions: [...actions],
        });
      }
    }

    return results;
  }

  /**
   * Returns the compiled snapshot state as a plain JSON object.
   * Result is cached after first call to avoid re-serialization.
   * Useful for persisting it locally or dumping to Redux/Vuex inside Client apps.
   */
  public getSnapshot(): Record<string, string[]> {
    if (this.snapshotCache) {
      return this.snapshotCache;
    }

    const result: Record<string, string[]> = Object.create(null);
    for (const [key, actions] of this.permissions) {
      result[key] = [...actions];
    }

    this.snapshotCache = result;
    return result;
  }
}
