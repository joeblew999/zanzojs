/**
 * ZANZO-REVIEW: Hemos eliminado los aliases opacos (Resource, Action, Relation, Role) en favor de `string` puro.
 * Usar Branded Types habría roto la ergonomía del API Builder al exigir aserciones manuales
 * de tipos literales en los genéricos (ej. '.entity("User" as Resource)').
 * El formato esperado se documenta nativamente.
 */

/**
 * Strict Permission format mapping a Resource to an Action.
 * Automatically infers specific strings from string literals.
 *
 * @example
 * type MyPerm = Permission<'Project', 'read' | 'write'>;
 * // 'Project:read' | 'Project:write'
 */
export type Permission<R extends string, A extends string> = `${R}:${A}`;

/**
 * Extracts the Action type from a given Permission string type.
 */
export type ExtractAction<P extends string> = P extends `${string}:${infer A}` ? A : never;

/**
 * Extracts the Resource type from a given Permission string type.
 */
export type ExtractResource<P extends string> = P extends `${infer R}:${string}` ? R : never;

/**
 * Represents a stored relationship tuple with optional temporal expiration.
 * Used by the Fluent API and the engine's internal store.
 */
export interface Tuple {
  subject: string;
  relation: string;
  object: string;
  /** ABAC basic — if set and past, the tuple is ignored during evaluation. */
  expiresAt?: Date;
}

/**
 * Result of `engine.for(actor).listAccessible(entityType)`.
 * Lists all objects of a given type that the actor can access, along with the granted actions.
 */
export interface AccessibleResult {
  object: string;
  actions: string[];
}

// ─── Schema-Level Type Utilities ────────────────────────────────────

/**
 * Extracts all entity names defined in a schema as a string union.
 *
 * @example
 * type Names = AllSchemaEntities<typeof schema>
 * // → 'User' | 'Document' | 'Workspace'
 */
export type AllSchemaEntities<TSchema extends Record<string, unknown>> = Extract<
  keyof TSchema,
  string
>;

/**
 * Extracts the action literals for a specific entity from the schema.
 */
export type EntityActions<
  TSchema extends Record<string, unknown>,
  TEntity extends keyof TSchema,
> = TSchema[TEntity] extends { actions: (infer A)[] } ? A : never;

/**
 * Extracts ALL action literals across ALL entities in the schema.
 *
 * @example
 * type Actions = AllSchemaActions<typeof schema>
 * // → 'read' | 'write' | 'delete' | 'manage_billing'
 */
export type AllSchemaActions<TSchema extends Record<string, unknown>> = {
  [K in keyof TSchema]: EntityActions<TSchema, K>;
}[keyof TSchema];

/**
 * Extracts ALL relation names across ALL entities in the schema.
 *
 * @example
 * type Relations = AllSchemaRelations<typeof schema>
 * // → 'owner' | 'admin' | 'viewer' | 'workspace'
 */
export type AllSchemaRelations<TSchema extends Record<string, unknown>> = {
  [K in keyof TSchema]: TSchema[K] extends { relations: infer R }
    ? R extends Record<string, unknown>
      ? Extract<keyof R, string>
      : never
    : never;
}[keyof TSchema];

/**
 * Produces a union of `"EntityName:${string}"` template literals for all entities
 * in the schema. Used to type-narrow actor and resource parameters.
 *
 * @example
 * type Ref = SchemaEntityRef<typeof schema>
 * // → `User:${string}` | `Document:${string}` | `Workspace:${string}`
 */
export type SchemaEntityRef<TSchema extends Record<string, unknown>> =
  `${AllSchemaEntities<TSchema>}:${string}`;
