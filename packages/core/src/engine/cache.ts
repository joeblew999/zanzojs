/**
 * In-memory permission cache with configurable TTL.
 * Caches `can()` results keyed by `actor|action|resource` (3 components).
 *
 * **CRITICAL:** The key includes ALL three components — actor, action, AND resource —
 * to prevent collisions between different permission checks on the same resource.
 *
 * The cache is automatically invalidated when tuples change
 * (`addTuple`, `removeTuple`, `load`, `clearTuples`).
 */
export interface CacheOptions {
  /**
   * Time-to-live in milliseconds for cached entries.
   * After this time, entries are lazily evicted on next access.
   * @default 5000
   */
  ttlMs?: number;
  /**
   * Cache invalidation strategy when tuples are mutated.
   * - 'selective': Only invalidates cache entries that are transitively affected by the mutation.
   * - 'full': Clears the entire cache on any tuple mutation (v0.3.0 strict deterministic behavior).
   * @default 'selective'
   */
  invalidationType?: 'selective' | 'full';
  /**
   * Threshold for the number of entries in the cache before falling back to
   * a full cache clear during selective invalidation. A DFS traversal on a very
   * large cache can be more expensive than a full clear.
   * @default 1000
   */
  selectiveThreshold?: number;
}

interface CacheEntry {
  result: boolean;
  expiresAt: number;
}

export class PermissionCache {
  private cache = new Map<string, CacheEntry>();
  private ttlMs: number;
  private invalidationType: 'selective' | 'full';
  private selectiveThreshold: number;

  constructor(options: CacheOptions = {}) {
    this.ttlMs = options.ttlMs ?? 5000;
    this.invalidationType = options.invalidationType ?? 'selective';
    this.selectiveThreshold = options.selectiveThreshold ?? 1000;
  }

  /**
   * Builds the cache key from the three components: actor, action, resource.
   * All three MUST be included to prevent cross-check collisions.
   */
  static buildKey(actor: string, action: string, resource: string): string {
    return `${actor}|${action}|${resource}`;
  }

  get(actor: string, action: string, resource: string): boolean | undefined {
    const key = PermissionCache.buildKey(actor, action, resource);
    const entry = this.cache.get(key);

    if (!entry) return undefined;

    if (Date.now() > entry.expiresAt) {
      this.cache.delete(key);
      return undefined;
    }

    return entry.result;
  }

  set(actor: string, action: string, resource: string, result: boolean): void {
    const key = PermissionCache.buildKey(actor, action, resource);
    this.cache.set(key, {
      result,
      expiresAt: Date.now() + this.ttlMs,
    });
  }

  /**
   * Invalidates cached entries based on the invalidation strategy.
   * If 'selective', removes only paths that are transitively affected using the provided reachable callback.
   * If 'full' or no tuple provided, clears the whole cache.
   */
  invalidate(
    mutatedTuple?: { subject: string; object: string },
    isReachable?: (start: string, target: string) => boolean,
  ): void {
    if (this.invalidationType === 'full' || !mutatedTuple || !isReachable) {
      this.cache.clear();
      return;
    }

    if (this.cache.size > this.selectiveThreshold) {
      this.cache.clear();
      return;
    }

    const { subject: mutatedSubject, object: mutatedObject } = mutatedTuple;

    for (const key of this.cache.keys()) {
      const parts = key.split('|');
      const cachedActor = parts[0];
      const cachedResource = parts[2];

      if (!cachedActor || !cachedResource) continue;

      // 1. Direct relation match
      if (cachedActor === mutatedSubject || cachedResource === mutatedObject) {
        this.cache.delete(key);
        continue;
      }

      // 2. Descendencia: Cached resource descends from mutated object
      if (isReachable(cachedResource, mutatedObject)) {
        this.cache.delete(key);
        continue;
      }

      // 3. Ascendencia: Cached actor descends from mutated subject
      if (isReachable(cachedActor, mutatedSubject)) {
        this.cache.delete(key);
        continue;
      }
    }
  }

  /** Returns the current number of cached entries (for testing). */
  get size(): number {
    return this.cache.size;
  }
}
