/**
 * Represents a parsed, validated Zanzo entity reference.
 * All entity identifiers in Zanzo follow the "Type:ID" convention.
 */
export interface EntityRef {
  readonly type: string;
  readonly id: string;
}

import { ZanzoError, ZanzoErrorCode } from '../errors';

/**
 * The canonical separator used to join EntityRef parts into a string.
 * Both expandTuples and the Drizzle adapter depend on this constant.
 * Never hardcode ':' for entity refs anywhere else in the codebase.
 */
export const ENTITY_REF_SEPARATOR = ':' as const;

/**
 * The canonical separator used to join nested relation path segments.
 * Both expandTuples and the Drizzle adapter depend on this constant.
 * Never hardcode '.' for relation paths anywhere else in the codebase.
 */
export const RELATION_PATH_SEPARATOR = '.' as const;

/**
 * The canonical separator for field-level granularity.
 * Allows fine-grained permissions on specific fields of an entity
 * (e.g. 'Review:cert1#strengths' targets the 'strengths' field of Review:cert1).
 * A valid object identifier may contain at most one '#'.
 */
export const FIELD_SEPARATOR = '#' as const;

/** @internal Shared control-character regex matching validateInput in ZanzoEngine */
const CONTROL_CHARS_REGEX = /[\x00-\x1F\x7F]/;

/**
 * Parses a "Type:ID" string into a structured EntityRef.
 * Validates format strictly at the boundary.
 *
 * @throws Error if the string does not contain exactly one ':' separator,
 * or if type or id segments are empty.
 */
export function parseEntityRef(raw: string): EntityRef {
  if (!raw || typeof raw !== 'string') {
    throw new ZanzoError(
      ZanzoErrorCode.INVALID_ENTITY_REF,
      `[Zanzo] Invalid EntityRef: received ${raw === '' ? 'empty string' : String(raw)}. ` +
        `Expected a non-empty string in "Type:ID" format.`,
    );
  }

  if (raw.length > 255) {
    throw new ZanzoError(
      ZanzoErrorCode.INVALID_ENTITY_REF,
      `[Zanzo] Invalid EntityRef: input exceeds 255 characters (got ${raw.length}). ` +
        `Entity references must be under 255 characters.`,
    );
  }

  if (CONTROL_CHARS_REGEX.test(raw)) {
    throw new ZanzoError(
      ZanzoErrorCode.INVALID_ENTITY_REF,
      `[Zanzo] Invalid EntityRef: input contains illegal unprintable control characters. ` +
        `Sanitize the input before creating an EntityRef.`,
    );
  }

  const sepIndex = raw.indexOf(ENTITY_REF_SEPARATOR);

  if (sepIndex === -1) {
    throw new ZanzoError(
      ZanzoErrorCode.INVALID_ENTITY_REF,
      `[Zanzo] Invalid EntityRef: "${raw}" does not contain a '${ENTITY_REF_SEPARATOR}' separator. ` +
        `Expected format is "Type:ID" (e.g. "User:123").`,
    );
  }

  // Check for more than one separator
  if (raw.indexOf(ENTITY_REF_SEPARATOR, sepIndex + 1) !== -1) {
    throw new ZanzoError(
      ZanzoErrorCode.INVALID_ENTITY_REF,
      `[Zanzo] Invalid EntityRef: "${raw}" contains multiple '${ENTITY_REF_SEPARATOR}' separators. ` +
        `Expected exactly one separator in "Type:ID" format.`,
    );
  }

  const type = raw.substring(0, sepIndex);
  const id = raw.substring(sepIndex + 1);

  if (type.length === 0) {
    throw new ZanzoError(
      ZanzoErrorCode.INVALID_ENTITY_REF,
      `[Zanzo] Invalid EntityRef: "${raw}" has an empty type segment. ` +
        `The type before '${ENTITY_REF_SEPARATOR}' must be non-empty (e.g. "User:123").`,
    );
  }

  if (id.length === 0) {
    throw new ZanzoError(
      ZanzoErrorCode.INVALID_ENTITY_REF,
      `[Zanzo] Invalid EntityRef: "${raw}" has an empty id segment. ` +
        `The id after '${ENTITY_REF_SEPARATOR}' must be non-empty (e.g. "User:123").`,
    );
  }

  return { type, id };
}

/**
 * Serializes an EntityRef back to its canonical "Type:ID" string form.
 */
export function serializeEntityRef(entityRef: EntityRef): string {
  return `${entityRef.type}${ENTITY_REF_SEPARATOR}${entityRef.id}`;
}

/**
 * Convenience factory. Equivalent to parseEntityRef but named for ergonomics.
 * Use this at API boundaries when constructing entity identifiers.
 *
 * @example
 * ref('User:123')     // { type: 'User', id: '123' }
 * ref('Project:A')    // { type: 'Project', id: 'A' }
 */
export function ref(raw: string): EntityRef {
  return parseEntityRef(raw);
}
