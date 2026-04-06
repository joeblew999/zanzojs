'use client';

import { useContext } from 'react';
import { ZanzoContext, ZanzoContextValue } from './ZanzoProvider.js';
import { ZanzoError, ZanzoErrorCode, SchemaData } from '@zanzojs/core';

/**
 * Consumes the Zanzo ReBAC context to evaluate permissions synchronously.
 * Must be used within a `<ZanzoProvider>` boundary.
 * 
 * To enable strict typing of actions and resources, pass `typeof schema` as the generic.
 * Without it, `can()` will accept any string without TypeScript validation.
 *
 * @example
 * ```tsx
 * // 1. Untyped (Permissive)
 * const { can } = useZanzo();
 * can('any-action', 'any-resource'); 
 * 
 * // 2. Strictly Typed (Recommended)
 * import { schema } from './zanzo.config';
 * const { can } = useZanzo<typeof schema>();
 * can('read', 'Document:123'); // OK
 * can('typo', 'Document:123'); // TypeScript Error
 * ```
 */
export function useZanzo<TSchema extends SchemaData = any>(): ZanzoContextValue<TSchema> {
  const context = useContext(ZanzoContext);

  if (!context) {
    throw new ZanzoError(ZanzoErrorCode.MISSING_PROVIDER, 'useZanzo must be used within a ZanzoProvider');
  }

  return context as ZanzoContextValue<TSchema>;
}
