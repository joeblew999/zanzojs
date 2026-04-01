import type { SchemaData } from '../builder/index';
import type { Tuple, AllSchemaRelations, SchemaEntityRef } from '../types/index';
import { parseEntityRef, RELATION_PATH_SEPARATOR, FIELD_SEPARATOR } from '../ref/index';
import { ForBuilder, GrantBuilder, RevokeBuilder } from '../fluent/index';
import { ZanzoError, ZanzoErrorCode } from '../errors';
import type { CheckResult, TraceStep } from './trace';
import { PermissionCache } from './cache';
import type { CacheOptions } from './cache';
import type { ZanzoExtension } from '../extensions/index';

/**
 * Represents a logical ReBAC relational tuple binding a Subject to an Object via a Relation.
 * Example: User:1 is the 'owner' of Project:A
 */
export interface RelationTuple {
  /**
   * The actor or subject Entity, typically format 'Type:ID' (e.g. 'User:123')
   */
  subject: string;
  /**
   * The relationship linking the subject to the object (e.g. 'owner', 'viewer')
   */
  relation: string;
  /**
   * The target object Entity, typically format 'Type:ID' (e.g. 'Project:456')
   */
  object: string;
}

/**
 * Extracts all valid Entity Types (Resources) defined in the provided Schema
 */
export type ExtractSchemaResources<TSchema extends SchemaData> = keyof TSchema;

/**
 * Extracts all Action string unions allowed for a specific Resource type
 * from the provided Schema.
 */
export type ExtractSchemaActions<
  TSchema extends SchemaData,
  TResource extends keyof TSchema,
> = TSchema[TResource]['actions'][number];

/**
 * Internal stored tuple with optional metadata (e.g. expiration).
 * @internal
 */
interface StoredTuple {
  subject: string;
  relation: string;
  object: string;
  expiresAt?: Date;
}

/**
 * Advanced Generic ReBAC Engine.
 * Takes a Schema initialized by ZanzoBuilder as its type base to offer strict autocomplete.
 */
export class ZanzoEngine<TSchema extends SchemaData> {
  private schema: Readonly<TSchema>;
  // Map<ObjectIdentifier, Map<Relation, Set<SubjectIdentifier>>>
  private index = new Map<string, Map<string, Set<string>>>();
  // Parallel store for tuple metadata (expiration)
  private tupleStore = new Map<string, StoredTuple>();
  // O(1) expiration lookup
  private expiryIndex = new Map<string, Date>();
  // Optional permission cache with TTL
  private cache: PermissionCache | null = null;

  private uniqueTupleKey(subject: string, relation: string, object: string): string {
    return `${subject}|${relation}|${object}`;
  }

  constructor(schema: Readonly<TSchema>) {
    this.schema = schema;
    this.validateSchema();
  }

  /**
   * Validates that all permission paths reference relations that exist in the entity.
   * Called once during construction to catch schema typos early.
   * @throws {ZanzoError} MISSING_RELATION if a permission path references an undefined relation.
   */
  private validateSchema(): void {
    for (const [entityName, definition] of Object.entries(this.schema) as [string, any][]) {
      if (!definition.permissions || !definition.relations) continue;

      const definedRelations = new Set(Object.keys(definition.relations));

      for (const [action, paths] of Object.entries(definition.permissions) as [
        string,
        string[],
      ][]) {
        if (!Array.isArray(paths)) continue;

        for (const path of paths) {
          // The first segment of the path is the relation name (e.g. 'workspace' in 'workspace.admin')
          const firstSegment = path.split(RELATION_PATH_SEPARATOR)[0]!;

          if (!definedRelations.has(firstSegment)) {
            throw new ZanzoError(
              ZanzoErrorCode.MISSING_RELATION,
              `[Zanzo] Missing relation: Entity "${entityName}" permission "${action}" references ` +
                `relation "${firstSegment}" (in path "${path}"), but this relation is not defined ` +
                `in the entity's relations map. Defined relations: [${[...definedRelations].join(', ')}].`,
            );
          }
        }
      }
    }
  }

  // ─── Cache API ────────────────────────────────────────────────────

  /**
   * Enables the in-memory permission cache.
   * Subsequent `can()` calls will be cached with the specified TTL.
   * Cache is automatically invalidated when tuples change.
   *
   * @note The default `invalidationType: 'selective'` is backwards-compatible and optimizes cache
   * clearing by ensuring security is never broken while retaining unaffected entries.
   * If the cache size exceeds `selectiveThreshold` (default 1000), it automatically falls back
   * to a full clear to prevent O(N*DFS) performance degradation.
   * If you need to reproduce the strict deterministic full-clear behavior of v0.3.0,
   * pass `invalidationType: 'full'`.
   *
   * @example
   * ```ts
   * engine.enableCache({ ttlMs: 5000 });
   * engine.for('User:alice').can('read').on('Document:doc1'); // cache miss → evaluates
   * engine.for('User:alice').can('read').on('Document:doc1'); // cache hit → O(1)
   * ```
   */
  public enableCache(options?: CacheOptions): void {
    this.cache = new PermissionCache(options);
  }

  /**
   * Disables and clears the permission cache.
   */
  public disableCache(): void {
    this.cache = null;
  }

  /**
   * Performs a bounded DFS on the engine's internal index to determine if there is a
   * dependency path from `start` to `target`.
   * The index stores edges as: Object -> Relation -> Subjects.
   * This means traversing the index goes from a resource to its owners/parents.
   */
  private isReachable(
    start: string,
    target: string,
    depth = 0,
    visited = new Set<string>(),
  ): boolean {
    if (start === target) return true;
    if (depth > 50) return false;

    if (visited.has(start)) return false;
    visited.add(start);

    const targetRelationsIndex = this.index.get(start);
    if (!targetRelationsIndex) return false;

    for (const subjectsSet of targetRelationsIndex.values()) {
      for (const subject of subjectsSet) {
        if (this.isReachable(subject, target, depth + 1, visited)) {
          return true;
        }
      }
    }

    return false;
  }

  /**
   * Retreives the readonly schema structure.
   */
  public getSchema(): Readonly<TSchema> {
    return this.schema;
  }

  /**
   * Retrieves the read-only relation-graph maps indexing memory objects.
   * Exposing strictly for flat compilers.
   */
  public getIndex(): ReadonlyMap<string, ReadonlyMap<string, ReadonlySet<string>>> {
    return this.index as unknown as ReadonlyMap<string, ReadonlyMap<string, ReadonlySet<string>>>;
  }

  // ZANZO-REVIEW: Extraído según la especificación (validateActorInput).
  // Nota: hemos agrupado `resourceType` bajo su propia directriz, pero mantenemos esta abstracción idéntica
  // a cómo se extrae la validación limpia del actor tal y como solicitaste.
  // Issue #9: Unified validation — previously duplicated between actor and resource validators.
  private validateInput(input: string, label: string): void {
    if (!input || typeof input !== 'string' || input.length > 255) {
      throw new ZanzoError(
        ZanzoErrorCode.INVALID_INPUT,
        `[Zanzo] Invalid ${label} input. Must be a non-empty string under 255 characters.`,
      );
    }
    const controlCharsRegex = /[\x00-\x1F\x7F]/;
    if (controlCharsRegex.test(input)) {
      throw new ZanzoError(
        ZanzoErrorCode.INVALID_INPUT,
        `[Zanzo] Security Exception: ${label} input contains illegal unprintable control characters.`,
      );
    }

    // The pipe character is used as the internal separator for cache keys and tuple keys.
    // Allowing it in inputs would break cache key parsing in invalidate() and cause stale access.
    if (input.includes('|')) {
      throw new ZanzoError(
        ZanzoErrorCode.INVALID_INPUT,
        `[Zanzo] Invalid ${label} input: the character '|' is reserved as an internal separator and cannot appear in identifiers.`,
      );
    }

    if (label === 'actor' || label === 'subject' || label === 'object' || label === 'resource') {
      const parts = input.split(':');
      if (parts.length !== 2 || parts[0] === '' || parts[1] === '') {
        throw new ZanzoError(
          ZanzoErrorCode.INVALID_ENTITY_REF,
          `[Zanzo] Invalid ${label}: "${input}" must follow the "Type:Id" format.`,
        );
      }
    }
  }

  /**
   * Validates that a field-level identifier contains at most one '#' separator.
   */
  private validateFieldSeparator(input: string, label: string): void {
    const firstHash = input.indexOf(FIELD_SEPARATOR);
    if (firstHash !== -1 && input.indexOf(FIELD_SEPARATOR, firstHash + 1) !== -1) {
      throw new ZanzoError(
        ZanzoErrorCode.INVALID_FIELD_SEPARATOR,
        `[Zanzo] Invalid ${label}: "${input}" contains multiple '${FIELD_SEPARATOR}' separators. ` +
          `An object identifier may contain at most one '#' for field-level granularity.`,
      );
    }
  }

  // ─── Fluent API ───────────────────────────────────────────────────

  /**
   * Starts a fluent permission check for a specific actor.
   *
   * @example
   * engine.for('User:alice').can('view').on('Document:doc1')
   * engine.for('User:alice').listAccessible('Document')
   */
  public for<TActor extends SchemaEntityRef<TSchema> & string>(actor: TActor): ForBuilder<TSchema> {
    this.validateInput(actor, 'actor');
    return new ForBuilder(this, actor);
  }

  /**
   * Starts a fluent permission check for any actor string, bypassing schema validation.
   * This is intended for internal use by adapters (e.g. Angular) that create synthetic actors
   * or use pre-filtered snapshots.
   *
   * @internal For adapter use only.
   */
  public forAny(actor: string): ForBuilder<TSchema> {
    this.validateInput(actor, 'actor');
    return new ForBuilder(this, actor);
  }

  /**
   * Starts a fluent grant chain to add a relation tuple.
   *
   * @example
   * engine.grant('owner').to('User:alice').on('Document:doc1')
   * engine.grant('viewer').to('User:bob').on('Document:doc1').until(new Date())
   */
  public grant<TRelation extends AllSchemaRelations<TSchema> & string>(
    relation: TRelation,
  ): GrantBuilder<TSchema> {
    this.validateInput(relation, 'relation');
    return new GrantBuilder(this, relation);
  }

  /**
   * Starts a fluent revoke chain to remove a relation tuple.
   *
   * @example
   * engine.revoke('owner').from('User:alice').on('Document:doc1')
   */
  public revoke<TRelation extends AllSchemaRelations<TSchema> & string>(
    relation: TRelation,
  ): RevokeBuilder<TSchema> {
    this.validateInput(relation, 'relation');
    return new RevokeBuilder(this, relation);
  }

  // ─── Tuple Management ─────────────────────────────────────────────

  /**
   * Injects a relation tuple into the in-memory store.
   * Issue #3: Validates all tuple fields before storing to prevent graph poisoning.
   *
   * @deprecated Use `engine.grant(relation).to(subject).on(object)` instead.
   * Will be removed in v1.0.0.
   */
  public addTuple(tuple: RelationTuple | Tuple, skipCacheInvalidation: boolean = false): void {
    this.validateInput(tuple.subject, 'subject');
    this.validateInput(tuple.object, 'object');
    this.validateInput(tuple.relation, 'relation');
    this.validateFieldSeparator(tuple.object, 'object');
    this.validateFieldSeparator(tuple.subject, 'subject');

    let objectRelations = this.index.get(tuple.object);
    if (!objectRelations) {
      objectRelations = new Map<string, Set<string>>();
      this.index.set(tuple.object, objectRelations);
    }

    let subjectsSet = objectRelations.get(tuple.relation);
    if (!subjectsSet) {
      subjectsSet = new Set<string>();
      objectRelations.set(tuple.relation, subjectsSet);
    }

    subjectsSet.add(tuple.subject);

    // Store metadata for expiration support
    const storedTuple: StoredTuple = {
      subject: tuple.subject,
      relation: tuple.relation,
      object: tuple.object,
    };
    if ('expiresAt' in tuple && tuple.expiresAt) {
      storedTuple.expiresAt = tuple.expiresAt;
      this.expiryIndex.set(
        this.uniqueTupleKey(tuple.subject, tuple.relation, tuple.object),
        tuple.expiresAt,
      );
    } else {
      this.expiryIndex.delete(this.uniqueTupleKey(tuple.subject, tuple.relation, tuple.object));
    }

    this.tupleStore.set(
      this.uniqueTupleKey(tuple.subject, tuple.relation, tuple.object),
      storedTuple,
    );

    // Invalidate cache on any tuple mutation unless skipped for bulk processing
    if (!skipCacheInvalidation) {
      this.cache?.invalidate(tuple as RelationTuple, (start, target) =>
        this.isReachable(start, target),
      );
    }
  }

  /**
   * Injects multiple relation tuples into the in-memory store.
   *
   * @deprecated Use `engine.load(tuples)` instead.
   * Will be removed in v1.0.0.
   */
  public addTuples(tuples: (RelationTuple | Tuple)[]): void {
    const isLargeBatch = tuples.length > 50;
    for (const tuple of tuples) {
      this.addTuple(tuple, isLargeBatch);
    }
    // For large loads, do an O(1) bulk clear at the end instead of N independent DFS operations
    if (isLargeBatch && tuples.length > 0) {
      this.cache?.invalidate();
    }
  }

  /**
   * Hydrates the engine with tuples loaded from an external source (e.g. database).
   * Use this instead of `addTuples()` when loading existing relationships at request time.
   * Supports `expiresAt` for temporal permissions — expired tuples are silently ignored.
   *
   * **Semantic difference:**
   * - `grant()` — otorga un permiso nuevo (write operation)
   * - `load()` — hidrata el engine con permisos existentes desde DB (read operation)
   *
   * @example
   * const rows = await db.select().from(zanzoTuples).where(...)
   * const engine = new ZanzoEngine(schema)
   * engine.load(rows)
   */
  public load(tuples: (RelationTuple | Tuple)[]): void {
    const now = new Date();
    // Optimization: When loading a large batch (> 50 tuples natively), bypass the selective
    // depth-first-search (DFS) per tuple and instead execute an instant full cache wipe at the end.
    // This scales hydration logic linearly avoiding O(N * (Graph DFS)) spikes.
    const isLargeBatch = tuples.length > 50;
    let loadedCount = 0;

    for (const tuple of tuples) {
      if ('expiresAt' in tuple && tuple.expiresAt && tuple.expiresAt <= now) {
        continue; // Silently skip expired tuples during hydration
      }
      this.addTuple(tuple, isLargeBatch);
      loadedCount++;
    }

    if (isLargeBatch && loadedCount > 0) {
      this.cache?.invalidate();
    }
  }

  /**
   * Hydrates the engine with capabilities dynamically declared on frontend components.
   * These extensions are transformed into memory tuples allowing `can()` evaluations to resolve locally.
   *
   * @param extensions ZanzoExtension instance containing capabilities per entity.
   * @param relation The base relation mapping the entity instance to the capability object (e.g. 'module')
   */
  public loadExtensions(extensions: ZanzoExtension<any>, relation: string = 'module'): void {
    const extensionTuples = extensions.toTuples(relation) as RelationTuple[];
    this.load(extensionTuples);
  }

  /**
   * Removes a specific tuple from the in-memory store.
   * Used internally by the Fluent API's revoke chain.
   */
  public removeTuple(tuple: RelationTuple | Tuple): void {
    const objectRelations = this.index.get(tuple.object);
    if (objectRelations) {
      const subjectsSet = objectRelations.get(tuple.relation);
      if (subjectsSet) {
        subjectsSet.delete(tuple.subject);
        if (subjectsSet.size === 0) {
          objectRelations.delete(tuple.relation);
        }
        if (objectRelations.size === 0) {
          this.index.delete(tuple.object);
        }
      }
    }

    // Remove from tuple store and expiry index
    const key = this.uniqueTupleKey(tuple.subject, tuple.relation, tuple.object);
    this.tupleStore.delete(key);
    this.expiryIndex.delete(key);

    // Invalidate cache on any tuple mutation
    this.cache?.invalidate(tuple as RelationTuple, (start, target) =>
      this.isReachable(start, target),
    );
  }

  /**
   * Atomically updates the expiration metadata of an existing tuple
   * WITHOUT removing it from the index. This prevents the race condition
   * that occurs with removeTuple+addTuple where the tuple briefly doesn't exist.
   * @internal Used by GrantOnBuilder.until()
   */
  public updateTupleExpiration(tuple: RelationTuple | Tuple, expiresAt: Date): void {
    const key = this.uniqueTupleKey(tuple.subject, tuple.relation, tuple.object);
    const stored = this.tupleStore.get(key);

    if (stored) {
      // Update metadata in-place — the tuple stays in the index the entire time
      stored.expiresAt = expiresAt;
      this.expiryIndex.set(key, expiresAt);
      // Invalidate cache once (not twice like remove+add would)
      this.cache?.invalidate(tuple as RelationTuple, (start, target) =>
        this.isReachable(start, target),
      );
    } else {
      // Tuple wasn't in the store yet — do a full add with expiresAt
      const tupleWithExpiry = { ...tuple, expiresAt };
      this.addTuple(tupleWithExpiry);
    }
  }

  /**
   * Clears all relation tuples in the memory store.
   */
  public clearTuples(): void {
    this.index.clear();
    this.tupleStore.clear();
    this.expiryIndex.clear();
    this.cache?.invalidate();
  }

  /**
   * Removes expired tuples from the engine's in-memory index.
   * Returns the number of tuples removed.
   *
   * **When to use:** Only relevant for long-lived engine instances such as
   * background workers or WebSocket servers that keep a ZanzoEngine in memory
   * for extended periods.
   *
   * **Not needed in per-request flows:** engine.load() already skips expired
   * tuples during hydration. If you create a fresh engine per request,
   * cleanup() will always return 0.
   */
  public cleanup(): number {
    const now = new Date();
    let removed = 0;

    const expiredTuples = [];
    for (const t of this.tupleStore.values()) {
      if (t.expiresAt && t.expiresAt <= now) {
        expiredTuples.push(t);
      }
    }

    for (const tuple of expiredTuples) {
      this.removeTuple(tuple);
      removed++;
    }

    return removed;
  }

  // ─── Evaluation ───────────────────────────────────────────────────

  /**
   * Checks if a tuple is expired.
   * @internal
   */
  private isExpired(
    subject: string,
    relation: string,
    object: string,
    now: number = Date.now(),
  ): boolean {
    const expiresAt = this.expiryIndex.get(this.uniqueTupleKey(subject, relation, object));
    if (expiresAt && expiresAt.getTime() <= now) {
      this.cache?.invalidate();
      return true;
    }
    return false;
  }

  /**
   * PERF-2: Evaluates ALL actions for a given actor on a specific resource in a
   * single pass. Returns the list of granted actions.
   *
   * This is more efficient than calling can() per action because:
   * - Identical routes shared by multiple actions are evaluated only once
   * - Early exit when all actions are already resolved
   * - Only one validation pass per (actor, resource) pair
   *
   * @internal This method is public solely because `createZanzoSnapshot` (in compiler/)
   * requires access to it. It is NOT part of the public API contract and may change
   * without notice in any minor version. Making it private would require moving
   * `createZanzoSnapshot` into ZanzoEngine as a method, which would break the current
   * modular architecture where the compiler is a standalone pure function.
   */
  public evaluateAllActions(actor: string, resource: string): string[] {
    this.validateInput(actor, 'actor');
    this.validateInput(resource, 'resource');

    const now = Date.now();

    // For field-level resources (e.g. Review:cert1#strengths), extract the entity type
    // from the base object before the '#'
    const baseResource = resource.includes(FIELD_SEPARATOR)
      ? resource.split(FIELD_SEPARATOR)[0]!
      : resource;
    const resourceType = parseEntityRef(baseResource).type;
    const resourceSchema = this.schema[resourceType as keyof TSchema];

    if (!resourceSchema) return [];

    const actions = resourceSchema.actions as string[];
    if (!actions || actions.length === 0) return [];

    const permissions = resourceSchema.permissions as Record<string, string[]> | undefined;
    if (!permissions) return [];

    // ── Cache fast-path: resolve as many actions as possible from cache ──
    const grantedActions = new Set<string>();
    const uncachedActions: string[] = [];

    if (this.cache) {
      for (const action of actions) {
        const cached = this.cache.get(actor, action, resource);
        if (cached === true) {
          grantedActions.add(action);
        } else if (cached === undefined) {
          // Cache miss — need to evaluate
          uncachedActions.push(action);
        }
        // cached === false → explicitly denied, skip evaluation
      }

      // If all actions are resolved from cache, return immediately
      if (uncachedActions.length === 0) {
        return actions.filter((a) => grantedActions.has(a));
      }
    } else {
      uncachedActions.push(...actions);
    }

    // Deduplicate routes: group UNCACHED actions by their route string to avoid
    // traversing the same graph path multiple times (e.g. 'owner' used by view, edit, delete)
    const routeMap = new Map<string, { parts: string[]; actions: Set<string> }>();

    for (const action of uncachedActions) {
      const relationsForAction = permissions[action];
      if (!relationsForAction || relationsForAction.length === 0) continue;

      for (const route of relationsForAction) {
        let entry = routeMap.get(route);
        if (!entry) {
          entry = { parts: route.split(RELATION_PATH_SEPARATOR), actions: new Set() };
          routeMap.set(route, entry);
        }
        entry.actions.add(action);
      }
    }

    if (routeMap.size === 0) {
      // All uncached actions have no routes — they are denied. Write to cache.
      if (this.cache) {
        for (const action of uncachedActions) {
          this.cache.set(actor, action, resource, false);
        }
      }
      return actions.filter((a) => grantedActions.has(a));
    }

    // Track which uncached actions were evaluated so we can cache denials too
    const evaluatedActions = new Set<string>();

    // Evaluate each unique route once, mapping results to all associated actions
    for (const { parts, actions: routeActions } of routeMap.values()) {
      // Skip if all actions for this route are already granted
      const allAlreadyGranted = [...routeActions].every((a) => grantedActions.has(a));
      if (allAlreadyGranted) continue;

      // Each unique route gets a fresh visited set to avoid cross-route interference
      const resolved = this.checkRelationsRecursive(
        actor,
        [parts],
        resource, // Use the original resource (potentially with field separator)
        new Set<string>(),
        0,
        '',
        undefined,
        undefined,
        now,
      );

      for (const action of routeActions) {
        evaluatedActions.add(action);
      }

      if (resolved) {
        for (const action of routeActions) {
          grantedActions.add(action);
        }
      }

      // Early exit if all actions are granted
      if (grantedActions.size === actions.length) break;
    }

    // ── Write results to cache for all evaluated actions ──
    if (this.cache) {
      for (const action of uncachedActions) {
        this.cache.set(actor, action, resource, grantedActions.has(action));
      }
    }

    // Return in original action order to maintain deterministic output
    return actions.filter((a) => grantedActions.has(a));
  }

  /**
   * Evaluates if a given actor has permission to perform an action on a specific resource.
   * Leverages TypeScript assertions to provide strict autocompletion based on the schema.
   *
   * @param actor The subject entity string identifier (e.g., 'User:1')
   * @param action The specific action to perform (e.g., 'edit'), strictly typed.
   * @param resource The target resource entity string identifier (e.g., 'Project:A')
   * @returns boolean True if authorized, false otherwise.
   *
   * @deprecated Use `engine.for(actor).can(action).on(resource)` instead.
   * Will be removed in v1.0.0.
   */
  public can<
    TResourceName extends Extract<ExtractSchemaResources<TSchema>, string>,
    TAction extends ExtractSchemaActions<TSchema, TResourceName>,
  >(actor: string, action: TAction, resource: `${TResourceName}:${string}`): boolean {
    this.validateInput(actor, 'actor');
    this.validateInput(resource, 'resource');

    // For field-level resources, extract the entity type from the base object
    const baseResource = resource.includes(FIELD_SEPARATOR)
      ? resource.split(FIELD_SEPARATOR)[0]!
      : resource;
    const resourceType = parseEntityRef(baseResource).type as TResourceName;
    const resourceSchema = this.schema[resourceType];

    if (!resourceSchema || !resourceSchema.actions.includes(action as any)) {
      return false;
    }

    const allowedRelationsForAction = (resourceSchema.permissions?.[action] || []) as string[];

    if (allowedRelationsForAction.length === 0) {
      return false;
    }

    // Check cache before traversal
    if (this.cache) {
      const cached = this.cache.get(actor, action as string, resource);
      if (cached !== undefined) return cached;
    }

    // Pre-split the allowed routes to avoid running String.split repeatedly during recursion
    const preSplitRoutes: string[][] = allowedRelationsForAction.map((route) =>
      route.split(RELATION_PATH_SEPARATOR),
    );

    // ZANZO-REVIEW: Decidí NO APLICAR la pre-computación de `routeKey` global solicitada en Tarea 3c.
    // Razón: En grafos combinatorios, si un nodo se alcanza por dos ramas requiriendo "remainders" distintos,
    // un hash global estático provocará un falso negativo en el caché `visited` y denegará permisos erróneamente.
    // (Esto causaba que stress.test.ts fallara). Mantenemos la concatenación selectiva pasada por recursión.

    // Call the recursive engine internal handler (use the original resource, potentially with '#')
    const now = Date.now();
    const result = this.checkRelationsRecursive(
      actor,
      preSplitRoutes,
      resource,
      new Set<string>(),
      0,
      '',
      undefined,
      undefined,
      now,
    );

    // Store result in cache if enabled
    this.cache?.set(actor, action as string, resource, result);

    return result;
  }

  /**
   * Internal recursive relation evaluation algorithm via Map Indexes.
   *
   * @param actor The original actor trying to accomplish the task
   * @param allowedRoutes Array of relation chains (pre-splitted parts) that grant access
   * @param currentTarget The current entity node in the graph being evaluated
   * @param visited Set of visited nodes to prevent cycles in graph evaluation
   * @returns True if relation path connects target to actor
   */
  private checkRelationsRecursive(
    actor: string,
    allowedRoutes: string[][],
    currentTarget: string,
    visited: Set<string>,
    depth: number = 0,
    parentSignature: string = '',
    trace?: TraceStep[],
    routeLabels?: string[],
    now?: number,
  ): boolean {
    const timeToRun = now ?? Date.now();
    if (depth > 50) {
      throw new ZanzoError(
        ZanzoErrorCode.MAX_DEPTH_EXCEEDED,
        `[Zanzo] Security Exception: Maximum relationship depth of 50 exceeded. Graph might contain an infinite cycle or is too heavily nested.`,
      );
    }

    // Memory Hotspot Optimization (GC Friendly):
    const visitedSignature = `${actor}|${currentTarget}|${parentSignature}`;

    if (visited.has(visitedSignature)) {
      return false;
    }
    visited.add(visitedSignature);

    const targetRelationsIndex = this.index.get(currentTarget);

    // If there's absolutely no relations associated with this target, abort the exploration to save cycles
    if (!targetRelationsIndex) {
      if (trace && routeLabels) {
        for (let i = 0; i < allowedRoutes.length; i++) {
          trace.push({
            path: routeLabels[i] || allowedRoutes[i]!.join('.'),
            target: currentTarget,
            found: false,
            subjects: [],
          });
        }
      }
      return false;
    }

    // Since we traverse allowedRoutes dynamically, pass down the identifier of the CURRENT route choice
    for (let i = 0; i < allowedRoutes.length; i++) {
      const routeParts = allowedRoutes[i] as string[];
      const currentRelation = routeParts[0] as string;
      const subjectsForRelation = targetRelationsIndex.get(currentRelation);

      const subjectsList = subjectsForRelation ? [...subjectsForRelation] : [];

      // If no subjects possess this relation on the target, skip this route
      if (!subjectsForRelation || subjectsForRelation.size === 0) {
        if (trace && routeLabels) {
          trace.push({
            path: routeLabels[i] || routeParts.join('.'),
            target: currentTarget,
            found: false,
            subjects: [],
          });
        }
        continue;
      }

      if (routeParts.length === 1) {
        // Direct relation base case check O(1)
        const found =
          subjectsForRelation.has(actor) &&
          !this.isExpired(actor, currentRelation, currentTarget, timeToRun);
        if (trace && routeLabels) {
          trace.push({
            path: routeLabels[i] || currentRelation,
            target: currentTarget,
            found,
            subjects: subjectsList,
          });
        }
        if (found) return true;
      } else {
        // Inherited nested relation graph exploration
        const remainingRoute = routeParts.slice(1);

        const nextSignature = parentSignature
          ? parentSignature + '.' + currentRelation + `[${i}]`
          : currentRelation + `[${i}]`;

        let anyFound = false;
        // Optimize: we execute branching recursively into subsets, and stop at first generic success.
        for (const intermediateSubject of subjectsForRelation) {
          // Check if the intermediate tuple is expired
          if (this.isExpired(intermediateSubject, currentRelation, currentTarget, timeToRun)) {
            continue;
          }

          const isGranted = this.checkRelationsRecursive(
            actor,
            [remainingRoute], // Pass down the remaining route only
            intermediateSubject,
            visited,
            depth + 1,
            nextSignature,
            trace,
            routeLabels
              ? [
                  routeLabels[i]
                    ? routeLabels[i]!.split(RELATION_PATH_SEPARATOR)
                        .slice(1)
                        .join(RELATION_PATH_SEPARATOR)
                    : remainingRoute.join('.'),
                ]
              : undefined,
            timeToRun,
          );

          if (isGranted) {
            anyFound = true;
            break;
          }
        }

        if (trace && routeLabels) {
          trace.push({
            path: routeLabels[i] || routeParts.join('.'),
            target: currentTarget,
            found: anyFound,
            subjects: subjectsList,
          });
        }

        if (anyFound) return true;
      }
    }

    return false;
  }

  /**
   * Evaluates a permission check with a detailed trace of each evaluation step.
   * Used internally by `ForBuilder.check()` — prefer the fluent API:
   *
   * ```ts
   * const { allowed, trace } = engine.for('User:alice').check('write').on('Document:doc1');
   * ```
   */
  public checkWithTrace(actor: string, action: string, resource: string): CheckResult {
    this.validateInput(actor, 'actor');
    this.validateInput(resource, 'resource');

    const baseResource = resource.includes(FIELD_SEPARATOR)
      ? resource.split(FIELD_SEPARATOR)[0]!
      : resource;
    const resourceType = parseEntityRef(baseResource).type;
    const resourceSchema = this.schema[resourceType];

    const trace: TraceStep[] = [];

    if (!resourceSchema || !resourceSchema.actions.includes(action as any)) {
      return { allowed: false, trace };
    }

    const allowedRelationsForAction = (resourceSchema.permissions?.[action] || []) as string[];

    if (allowedRelationsForAction.length === 0) {
      return { allowed: false, trace };
    }

    const preSplitRoutes: string[][] = allowedRelationsForAction.map((route) =>
      route.split(RELATION_PATH_SEPARATOR),
    );

    const now = Date.now();

    const allowed = this.checkRelationsRecursive(
      actor,
      preSplitRoutes,
      resource,
      new Set<string>(),
      0,
      '',
      trace,
      allowedRelationsForAction,
      now,
    );

    return { allowed, trace };
  }

  /**
   * Generates a database-agnostic Abstract Syntax Tree (AST) representing
   * the logical query needed to verify if the given actor is authorized to
   * perform action on a specific resourceType.
   *
   * Useful for "Query Pushdown", allowing ORMs or databases to evaluate permissions
   * directly across their own relational tables instead of loading data into memory.
   *
   * @param actor The subject entity string identifier (e.g., 'User:1')
   * @param action The specific action to perform (e.g., 'read'), strictly typed.
   * @param resourceType The target resource entity TYPE (e.g., 'Project')
   * @returns QueryAST block if action is valid and has mapped relations, null otherwise.
   */
  public buildDatabaseQuery<
    TResourceName extends Extract<ExtractSchemaResources<TSchema>, string>,
    TAction extends ExtractSchemaActions<TSchema, TResourceName>,
  >(
    actor: string,
    action: TAction,
    resourceType: TResourceName,
  ): import('../ast/index').QueryAST | null {
    this.validateInput(actor, 'actor');
    this.validateInput(resourceType as string, 'resourceType');

    const resourceSchema = this.schema[resourceType];

    if (!resourceSchema || !resourceSchema.actions.includes(action as any)) {
      return null;
    }

    const allowedRelationsForAction = (resourceSchema.permissions?.[action] || []) as string[];

    if (allowedRelationsForAction.length === 0) {
      return null;
    }

    // Build the underlying AST based on allowed relation paths
    const conditions = allowedRelationsForAction.map(
      (routeLine): import('../ast/index').Condition => {
        const parts = routeLine.split(RELATION_PATH_SEPARATOR);

        if (parts.length === 1) {
          return {
            type: 'direct',
            relation: parts[0] as string,
            targetSubject: actor,
          };
        }

        return {
          type: 'nested',
          relation: parts[0] as string,
          nextRelationPath: parts.slice(1),
          targetSubject: actor,
        };
      },
    );

    return {
      operator: 'OR', // ReBAC normally operates on union of granted authority paths
      conditions,
    };
  }
}
