import type { SchemaData } from '../builder/index';
import type { ZanzoEngine } from '../engine/index';
import type {
  AccessibleResult,
  Tuple,
  AllSchemaActions,
  AllSchemaEntities,
  SchemaEntityRef,
} from '../types/index';
import type { CheckResult } from '../engine/trace';

/**
 * Intermediate builder for `engine.for(actor)`.
 * Provides `can(action)`, `check(action)`, `listAccessible(entityType)`, and `canBatch(checks)`.
 */
export class ForBuilder<TSchema extends SchemaData> {
  constructor(
    private engine: ZanzoEngine<TSchema>,
    private actor: string,
  ) {}

  /**
   * Begins a permission check for a specific action.
   * Chain with `.on(resource)` to get the boolean result.
   *
   * @example engine.for('User:alice').can('view').on('Document:doc1')
   */
  can<TAction extends AllSchemaActions<TSchema> & string>(action: TAction): CanBuilder<TSchema> {
    return new CanBuilder(this.engine, this.actor, action);
  }

  /**
   * Begins a traced permission check for debugging.
   * Returns `{ allowed, trace }` instead of just a boolean.
   * Each TraceStep shows which path was evaluated, on which target,
   * and whether a matching subject was found.
   *
   * @example
   * ```ts
   * const result = engine.for('User:alice').check('write').on('Document:doc1');
   * console.log(result.allowed); // false
   * console.log(result.trace);   // [{ path: 'owner', target: 'Document:doc1', found: false, subjects: [] }]
   * ```
   */
  check<TAction extends AllSchemaActions<TSchema> & string>(
    action: TAction,
  ): CheckBuilder<TSchema> {
    return new CheckBuilder(this.engine, this.actor, action);
  }

  /**
   * Lists all objects of a given entity type that the actor can access,
   * along with the granted actions for each object.
   *
   * @example engine.for('User:alice').listAccessible('Document')
   */
  listAccessible<TEntity extends AllSchemaEntities<TSchema> & string>(
    entityType: TEntity,
  ): AccessibleResult[] {
    const results: AccessibleResult[] = [];
    const index = this.engine.getIndex();

    for (const [objectKey] of index) {
      // Only consider objects of the requested entity type
      if (!objectKey.startsWith(`${entityType}:`)) continue;

      const actions = this.engine.evaluateAllActions(this.actor, objectKey);
      if (actions.length > 0) {
        results.push({ object: objectKey, actions });
      }
    }

    return results;
  }

  /**
   * Batch-checks multiple permissions in a single call.
   * Groups checks by resource and uses `evaluateAllActions` to avoid
   * redundant graph traversals for the same resource.
   *
   * @param checks Array of `{ action, resource }` pairs to evaluate.
   * @returns Map where keys are `action:resource` and values are booleans.
   *
   * @example
   * ```ts
   * const results = engine.for('User:alice').canBatch([
   *   { action: 'read', resource: 'Document:doc1' },
   *   { action: 'write', resource: 'Document:doc1' },
   *   { action: 'read', resource: 'Document:doc2' },
   * ]);
   * results.get('read:Document:doc1');  // true
   * results.get('write:Document:doc1'); // true
   * results.get('read:Document:doc2');  // false
   * ```
   */
  canBatch(
    checks: Array<{
      action: AllSchemaActions<TSchema> & string;
      resource: SchemaEntityRef<TSchema> & string;
    }>,
  ): Map<string, boolean> {
    const results = new Map<string, boolean>();

    // Group checks by resource to avoid redundant evaluations
    const byResource = new Map<string, string[]>();
    for (const { action, resource } of checks) {
      const existing = byResource.get(resource);
      if (existing) {
        existing.push(action);
      } else {
        byResource.set(resource, [action]);
      }
    }

    for (const [resource, actions] of byResource) {
      const grantedActions = this.engine.evaluateAllActions(this.actor, resource);
      const grantedSet = new Set(grantedActions);

      for (const action of actions) {
        results.set(`${action}:${resource}`, grantedSet.has(action));
      }
    }

    return results;
  }
}

/**
 * Intermediate builder for `engine.for(actor).can(action)`.
 * Call `.on(resource)` to evaluate.
 */
export class CanBuilder<TSchema extends SchemaData> {
  constructor(
    private engine: ZanzoEngine<TSchema>,
    private actor: string,
    private action: string,
  ) {}

  /**
   * Evaluates the permission check against a specific resource.
   * @returns `true` if the actor is authorized, `false` otherwise.
   */
  on<TResource extends SchemaEntityRef<TSchema> & string>(resource: TResource): boolean {
    return this.engine.can(this.actor, this.action as any, resource as any);
  }
}

/**
 * Intermediate builder for `engine.for(actor).check(action)`.
 * Call `.on(resource)` to get a `CheckResult` with trace.
 */
export class CheckBuilder<TSchema extends SchemaData> {
  constructor(
    private engine: ZanzoEngine<TSchema>,
    private actor: string,
    private action: string,
  ) {}

  /**
   * Evaluates the permission check with full trace.
   * @returns `CheckResult` with `allowed` boolean and `trace` array.
   */
  on<TResource extends SchemaEntityRef<TSchema> & string>(resource: TResource): CheckResult {
    return this.engine.checkWithTrace(this.actor, this.action, resource);
  }
}

/**
 * Grants a permission by adding a tuple to the engine's in-memory index.
 *
 * **When to use:**
 * - Unit tests: hydrate the engine without a database
 * - Seeds and development scripts
 * - Permission simulation sandboxes (evaluate without persisting)
 *
 * **Not for production writes:** In a per-request serverless flow, mutations
 * via grant() are ephemeral and disappear when the request ends.
 * To persist permissions, write directly to your database and use
 * materializeDerivedTuples() to materialize derived tuples.
 */
export class GrantBuilder<TSchema extends SchemaData> {
  constructor(
    private engine: ZanzoEngine<TSchema>,
    private relation: string,
  ) {}

  to<TSubject extends SchemaEntityRef<TSchema> & string>(
    subject: TSubject,
  ): GrantToBuilder<TSchema> {
    (this.engine as any).validateInput(subject, 'subject');
    return new GrantToBuilder(this.engine, this.relation, subject);
  }
}

/**
 * Intermediate builder for `engine.grant(relation).to(subject)`.
 * Chain with `.on(object)`.
 */
export class GrantToBuilder<TSchema extends SchemaData> {
  constructor(
    private engine: ZanzoEngine<TSchema>,
    private relation: string,
    private subject: string,
  ) {}

  on<TObject extends SchemaEntityRef<TSchema> & string>(object: TObject): GrantOnBuilder<TSchema> {
    const tuple: Tuple = { subject: this.subject, relation: this.relation, object };
    this.engine.addTuple(tuple);
    return new GrantOnBuilder(this.engine, tuple);
  }
}

/**
 * Terminal builder for `engine.grant().to().on()`.
 * Optionally chain `.until(date)` to set an expiration.
 */
export class GrantOnBuilder<TSchema extends SchemaData> {
  constructor(
    private engine: ZanzoEngine<TSchema>,
    private tuple: Tuple,
  ) {}

  /**
   * Sets an expiration date on the granted tuple.
   * Uses atomic metadata update — the tuple is never removed from the index.
   */
  until(date: Date): void {
    // Atomically update the expiration without removing the tuple from the index.
    // This eliminates the race condition where a concurrent can() would see the tuple
    // as missing between removeTuple and addTuple.
    this.engine.updateTupleExpiration(this.tuple, date);
    this.tuple.expiresAt = date;
  }
}

/**
 * Revokes a permission by removing a tuple from the engine's in-memory index.
 *
 * **When to use:**
 * - Unit tests: hydrate the engine without a database
 * - Seeds and development scripts
 * - Permission simulation sandboxes (evaluate without persisting)
 *
 * **Not for production writes:** In a per-request serverless flow, mutations
 * via revoke() are ephemeral and disappear when the request ends.
 * To persist permissions, write directly to your database and use
 * removeDerivedTuples() to remove derived tuples.
 */
export class RevokeBuilder<TSchema extends SchemaData> {
  constructor(
    private engine: ZanzoEngine<TSchema>,
    private relation: string,
  ) {}

  from<TSubject extends SchemaEntityRef<TSchema> & string>(
    subject: TSubject,
  ): RevokeFromBuilder<TSchema> {
    (this.engine as any).validateInput(subject, 'subject');
    return new RevokeFromBuilder(this.engine, this.relation, subject);
  }
}

/**
 * Terminal builder for `engine.revoke(relation).from(subject)`.
 * Call `.on(object)` to execute the revocation.
 */
export class RevokeFromBuilder<TSchema extends SchemaData> {
  constructor(
    private engine: ZanzoEngine<TSchema>,
    private relation: string,
    private subject: string,
  ) {}

  on<TObject extends SchemaEntityRef<TSchema> & string>(object: TObject): void {
    this.engine.removeTuple({ subject: this.subject, relation: this.relation, object });
  }
}
