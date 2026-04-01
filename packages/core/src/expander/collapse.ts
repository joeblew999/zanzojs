import type { SchemaData } from '../builder/index';
import type { RelationTuple } from '../engine/index';
import type { FetchChildrenCallback } from './index';
import { _walkExpansionGraph } from './walk';

export interface CollapseContext {
  schema: Readonly<SchemaData>;
  /**
   * The base tuple being revoked.
   * Must be identical to the base tuple originally passed to `materializeDerivedTuples`.
   */
  revokedTuple: RelationTuple;
  fetchChildren: FetchChildrenCallback;
  /**
   * Maximum number of tuples to process in the collapse queue.
   * Should match the `maxExpansionSize` used during expansion.
   * @default 500
   */
  maxCollapseSize?: number;
}

/**
 * Computes all derived tuples that must be removed from the database
 * when revoking a base tuple previously expanded with `materializeDerivedTuples`.
 *
 * This function is the symmetric inverse of `materializeDerivedTuples`. It uses
 * the same queue-based traversal algorithm and the same `fetchChildren` callback
 * to reconstruct which derived tuples exist and must be deleted.
 *
 * It is PURE: it does not delete anything. It returns the tuples to delete
 * so the caller can execute the DELETE in their database.
 *
 * **CRITICAL:** Use `buildBulkDeleteCondition()` to convert the result into
 * a format suitable for a single bulk `DELETE` statement inside a transaction.
 * Do NOT delete tuples one-by-one in a loop.
 *
 * @example
 * ```ts
 * await db.transaction(async (tx) => {
 *   const tuplesToDelete = await removeDerivedTuples({
 *     schema,
 *     revokedTuple: baseTuple,
 *     fetchChildren: async (parentObj, rel) => {
 *       return (await tx.select()...).map(d => `Document:${d.id}`);
 *     },
 *   });
 *   const conditions = buildBulkDeleteCondition(tuplesToDelete);
 *
 *   // IMPORTANT: Execute bulk delete + base tuple delete in one transaction.
 *   // You must filter by all three columns (subject, relation, object) to avoid accidental deletions!
 *   for (const [sub, rel, obj] of conditions) {
 *     await tx.delete(zanzoTuples).where(
 *       and(
 *         eq(zanzoTuples.subject, sub),
 *         eq(zanzoTuples.relation, rel),
 *         eq(zanzoTuples.object, obj)
 *       )
 *     );
 *   }
 *
 *   await tx.delete(zanzoTuples).where(
 *     and(
 *       eq(zanzoTuples.object, baseTuple.object),
 *       eq(zanzoTuples.relation, baseTuple.relation),
 *       eq(zanzoTuples.subject, baseTuple.subject)
 *     )
 *   );
 * });
 * ```
 *
 * @returns Array of RelationTuples that must be deleted.
 * Does NOT include the `revokedTuple` itself (the caller deletes it separately).
 */
export async function removeDerivedTuples(ctx: CollapseContext): Promise<RelationTuple[]> {
  const { schema, revokedTuple, fetchChildren, maxCollapseSize = 500 } = ctx;

  const walkResults = await _walkExpansionGraph(
    schema,
    revokedTuple,
    fetchChildren,
    maxCollapseSize,
  );

  return walkResults.map((r) => ({
    subject: r.subject,
    relation: r.relation,
    object: r.object,
  }));
}

/**
 * @deprecated Use `removeDerivedTuples` instead. Will be removed in v1.0.0.
 */
export const collapseTuples = removeDerivedTuples;
