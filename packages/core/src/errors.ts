/**
 * Enum of all structured error codes emitted by the Zanzo ecosystem.
 * Use these to filter or group errors in production logging systems.
 *
 * @example
 * ```ts
 * try {
 *   engine.for('invalid').can('read').on('Document:doc1');
 * } catch (e) {
 *   if (e instanceof ZanzoError && e.code === ZanzoErrorCode.INVALID_INPUT) {
 *     logger.warn('Bad actor format', { code: e.code });
 *   }
 * }
 * ```
 */
export const ZanzoErrorCode = {
  /** Input string is empty, too long, or contains control characters */
  INVALID_INPUT: 'ZANZO_INVALID_INPUT',
  /** EntityRef string does not match the "Type:ID" format */
  INVALID_ENTITY_REF: 'ZANZO_INVALID_ENTITY_REF',
  /** Object identifier contains multiple '#' field separators */
  INVALID_FIELD_SEPARATOR: 'ZANZO_INVALID_FIELD_SEPARATOR',
  /** Recursive graph traversal exceeded the 50-level depth limit */
  MAX_DEPTH_EXCEEDED: 'ZANZO_MAX_DEPTH_EXCEEDED',
  /** Tuple expansion/collapse exceeded maxExpansionSize/maxCollapseSize */
  EXPANSION_LIMIT: 'ZANZO_EXPANSION_LIMIT',
  /** The generated AST exceeded the 100-condition safety limit */
  AST_OVERFLOW: 'ZANZO_AST_OVERFLOW',
  /** Two schemas define the same entity name during mergeSchemas() */
  SCHEMA_COLLISION: 'ZANZO_SCHEMA_COLLISION',
  /** useZanzo() was called outside of a ZanzoProvider */
  MISSING_PROVIDER: 'ZANZO_MISSING_PROVIDER',
  /**
   * A permission path references a relation that is not defined in the entity's `relations` map.
   * Example: permissions has `'editor'` but relations only defines `{ owner: 'User', viewer: 'User' }`.
   */
  MISSING_RELATION: 'ZANZO_MISSING_RELATION',
  /**
   * Circular reference detected during tuple expansion.
   * The same object+relation pair was re-encounterd during graph traversal,
   * indicating a cycle in the schema or data (e.g. A→B→A).
   */
  CYCLE_DETECTED: 'ZANZO_CYCLE_DETECTED',
  /** Tuple expansion was aborted via AbortSignal timeout */
  EXPANSION_ABORTED: 'ZANZO_EXPANSION_ABORTED',
} as const;

export type ZanzoErrorCodeValue = (typeof ZanzoErrorCode)[keyof typeof ZanzoErrorCode];

/**
 * Structured error class for all errors thrown by the Zanzo ecosystem.
 * Extends `Error` for full backward compatibility with existing catch blocks.
 *
 * @example
 * ```ts
 * import { ZanzoError, ZanzoErrorCode } from '@zanzojs/core';
 *
 * try {
 *   engine.for('bad-input').can('read').on('Document:1');
 * } catch (e) {
 *   if (e instanceof ZanzoError) {
 *     console.log(e.code);    // 'ZANZO_INVALID_ENTITY_REF'
 *     console.log(e.message); // '[Zanzo] Invalid EntityRef: ...'
 *   }
 * }
 * ```
 */
export class ZanzoError extends Error {
  public readonly code: ZanzoErrorCodeValue;

  constructor(code: ZanzoErrorCodeValue, message: string) {
    super(message);
    this.name = 'ZanzoError';
    this.code = code;
    // Maintain proper prototype chain for instanceof checks
    Object.setPrototypeOf(this, new.target.prototype);
  }
}
