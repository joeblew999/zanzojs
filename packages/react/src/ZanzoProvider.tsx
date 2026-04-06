'use client';

import React, { createContext, useMemo, ReactNode } from 'react';
import { 
  AccessibleResult, 
  SchemaData, 
  ExtractSchemaResources, 
  ExtractSchemaActions,
  ZanzoClient
} from '@zanzojs/core';

export interface ZanzoContextValue<TSchema extends SchemaData = any> {
    /**
     * True O(1) constant time evaluation of permissions via pre-compiled snapshot.
     */
    can: <
      TResourceName extends Extract<ExtractSchemaResources<TSchema>, string>,
      TAction extends ExtractSchemaActions<TSchema, TResourceName>,
    >(action: TAction, resource: `${TResourceName}:${string}`) => boolean;

    /**
     * Returns all accessible objects of the given entity type with their allowed actions.
     * 
     * **Complexity: O(n)** where n is the number of unique resources in the snapshot.
     */
    listAccessible: (entityType: Extract<ExtractSchemaResources<TSchema>, string>) => AccessibleResult[];
}

export const ZanzoContext = createContext<ZanzoContextValue<any> | null>(null);

export interface ZanzoProviderProps<TSchema extends SchemaData> {
    /**
     * The flat JSON snapshot object provided by the server-side createZanzoSnapshot().
     * 
     * **Security Warning**: Client-side authorization is purely for UI/UX (hiding buttons, etc). 
     * Authorization MUST always be enforced on the server-side as snapshots can be manipulated.
     */
    snapshot: Record<string, string[]>;
    children: ReactNode;
}

/**
 * Injects the Zanzo ReBAC evaluation context into the React Component Tree.
 * It builds an optimized O(1) in-memory client using the provided snapshot.
 * 
 * @remarks
 * **Security Warning**: Client-side authorization via `useZanzo` is purely for UI/UX control 
 * (e.g., hiding buttons or menu items). Since snapshots are sent to the browser, 
 * they can be bypassed or manipulated. **The real authorization MUST always happen 
 * on the server-side** before executing any sensitive transaction.
 * 
 * **Note on Type Safety**: Due to React context variance constraints, the type connection 
 * between the provider's `TSchema` and the consumer's `useZanzo<TSchema>` is not enforced 
 * by the compiler. Both must reference the same schema manually. This is a known 
 * limitation of React's context typing model.
 */
export function ZanzoProvider<TSchema extends SchemaData>({ 
  snapshot, 
  children 
}: ZanzoProviderProps<TSchema>) {

    // Instance the lightweight client only once per snapshot reference.
    // We import ZanzoClient dynamically to avoid forcing heavy engine logic into client bundles
    // if only the client is needed, though usually they are bundled together.
    const client = useMemo(() => {
      // Defensive initialization: Handle cases where snapshot might be missing due to fetch errors.
      if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) {
        console.warn('[Zanzo] Provider received an invalid or missing snapshot. Initializing with empty state.');
        return new ZanzoClient({});
      }
      
      return new ZanzoClient(snapshot);
    }, [snapshot]);

    // Context value exposed to hooks
    const value = useMemo<ZanzoContextValue<TSchema>>(() => ({
        can: (action, resource) => client.can(action as string, resource),
        listAccessible: (entityType) => client.listAccessible(entityType as string)
    }), [client]);

    return (
        <ZanzoContext.Provider value={value as any}>
            {children}
        </ZanzoContext.Provider>
    );
}
