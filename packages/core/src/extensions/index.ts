import { ZanzoError, ZanzoErrorCode } from '../errors';

/**
 * A Map representing instances to capabilities.
 * Key: entity instance (e.g. 'Module:ventas')
 * Value: array of capabilities (e.g. ['export_csv', 'import_data'])
 */
export type CapabilityMap = Map<string, string[]>;

/**
 * Equivalent internally to a RelationTuple but typed differently for clarity.
 * These are the tuples generated to synchronize capabilities.
 */
export interface ExtensionTuple {
  subject: string;
  relation: string;
  object: string;
  expiresAt?: Date;
}

/**
 * Given an extensions definition, infers the capabilities actions.
 * Extracts the Action type from the internal mapping or tuple output.
 */
export type ExtractCapabilityActions<TExtensions> = TExtensions extends ZanzoExtension<infer TCaps>
  ? TCaps
  : never;

/**
 * Fluent builder for declaring frontend capabilities on entity instances.
 * Stores mappings that are useful for UI visibility and sync to the backend.
 *
 * Capabilities are normally stored under a "Capability" resource namespace for uniqueness.
 */
export class ZanzoExtension<TCaps extends string = never> {
  private readonly map: CapabilityMap;

  constructor(existingMap?: CapabilityMap) {
    this.map = existingMap || new Map<string, string[]>();
  }

  /**
   * Helper to ensure the instance format matches 'Entity:Id'.
   */
  private validateInstance(instance: string): void {
    if (!instance || typeof instance !== 'string') {
      throw new ZanzoError(
        ZanzoErrorCode.INVALID_INPUT,
        `[Zanzo] Invalid entity instance input. Must be a non-empty string.`,
      );
    }
    const parts = instance.split(':');
    if (parts.length !== 2 || parts[0] === '' || parts[1] === '') {
      throw new ZanzoError(
        ZanzoErrorCode.INVALID_ENTITY_REF,
        `[Zanzo] Invalid entity instance: "${instance}" must follow the "Type:Id" format.`,
      );
    }
  }

  /**
   * Declares a list of capabilities for a specific entity instance.
   * Duplicate capabilities are automatically removed.
   *
   * @param instance The entity instance, e.g. 'Module:ventas'
   * @param capabilities An array of string capabilities, e.g. ['export_csv']
   * @returns A new detached ZanzoExtension carrying the combined capabilities type definition.
   */
  public capability<TCapString extends string>(
    instance: string,
    capabilities: TCapString[],
  ): ZanzoExtension<TCaps | TCapString> {
    this.validateInstance(instance);

    const existing = this.map.get(instance) || [];
    const combined = Array.from(new Set([...existing, ...capabilities]));

    const newMap = new Map(this.map);
    newMap.set(instance, combined);

    return new ZanzoExtension<TCaps | TCapString>(newMap);
  }

  /**
   * Gets the list of capabilities for a particular instance.
   * @param instance The entity instance identifier string.
   */
  public getCapabilities(instance: string): string[] {
    return this.map.get(instance) || [];
  }

  /**
   * Generates a structural Map containing all capabilities grouped by instance.
   */
  public getAllCapabilities(): CapabilityMap {
    // Return a shallow copy to prevent external mutation
    return new Map(this.map);
  }

  /**
   * Generates relation tuples ready to be synchronized with the DB or loaded into ZanzoEngine.
   *
   * @param relation The base relation mapping the subject to the capability. e.g. 'module'
   * @returns Array of RelationTuple objects linking instance -> relation -> Capability:action
   */
  public toTuples(relation: string): ExtensionTuple[] {
    const tuples: ExtensionTuple[] = [];

    for (const [instance, caps] of this.map.entries()) {
      for (const cap of caps) {
        tuples.push({
          subject: instance,
          relation,
          object: `Capability:${cap}`,
        });
      }
    }

    return tuples;
  }

  /**
   * Serializes the capabilities mapping into a plain object format suitable for JSON.stringify.
   * This is useful for passing the extensions as props to Angular/React providers.
   */
  public toJSON(): Record<string, string[]> {
    const obj: Record<string, string[]> = {};
    for (const [key, value] of this.map.entries()) {
      obj[key] = value;
    }
    return obj;
  }
}
