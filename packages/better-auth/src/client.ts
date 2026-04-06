/**
 * zanzoClientPlugin — Better Auth client plugin for @zanzojs/better-auth.
 *
 * Adds authClient.zanzo.snapshot() to the Better Auth client.
 * The session cookie is handled automatically by the Better Auth client.
 *
 * Usage:
 *   import { createAuthClient } from 'better-auth/client'
 *   import { zanzoClientPlugin } from '@zanzojs/better-auth'
 *
 *   const authClient = createAuthClient({
 *     plugins: [zanzoClientPlugin()]
 *   })
 *
 *   // After login
 *   const { snapshot } = await authClient.zanzo.snapshot()
 *   // Feed into ZanzoProvider or ZanzoClient
 *
 * PartyKit re-fetch pattern (live permission sync):
 *   partySocket.onmessage = (e) => {
 *     if (JSON.parse(e.data).type === 'snapshot') {
 *       authClient.zanzo.snapshot().then(({ snapshot }) => setSnapshot(snapshot))
 *     }
 *   }
 */

export interface ZanzoClientOptions {
  /**
   * Base path where the zanzo Hono sub-app is mounted.
   * Default: '/zanzo'
   */
  basePath?: string;
}

export interface ZanzoSnapshotResult {
  actor: string;
  snapshot: Record<string, string[]>;
}

export interface ZanzoCheckResult {
  allowed: boolean;
  actor: string;
  action: string;
  type: string;
  id: string;
}

/**
 * Better Auth client plugin that adds authClient.zanzo.* methods.
 *
 * Works with the server-side zanzo Hono sub-app mounted via:
 *   app.route('/zanzo', createZanzoHonoApp(zanzo, opts))
 */
export function zanzoClientPlugin(options: ZanzoClientOptions = {}) {
  const basePath = options.basePath ?? '/zanzo';

  return {
    id: 'zanzo' as const,

    getActions: ($fetch: (...args: any[]) => any) => ({
      zanzo: {
        /**
         * Fetch the full permission snapshot for the current session's actor.
         * Returns Record<ResourceID, string[]> — feed into ZanzoProvider / ZanzoClient.
         */
        snapshot: (): Promise<ZanzoSnapshotResult> =>
          $fetch(`${basePath}/snapshot`, { method: 'GET' }),

        /**
         * Check whether the current actor can perform an action on a resource.
         */
        check: (params: { action: string; type: string; id: string }): Promise<ZanzoCheckResult> =>
          $fetch(`${basePath}/check?action=${params.action}&type=${params.type}&id=${encodeURIComponent(params.id)}`, { method: 'GET' }),

        /**
         * Grant a tuple. Requires owner/share permission if server has enforceOwnership: true.
         */
        grant: (params: {
          subject: string;
          relation: string;
          type: string;
          id: string;
          expiresAt?: string;
        }): Promise<{ granted: { subject: string; relation: string; object: string } }> =>
          $fetch(`${basePath}/grant`, { method: 'PUT', body: params }),

        /**
         * Revoke a tuple. Requires owner/share permission if server has enforceOwnership: true.
         */
        revoke: (params: {
          subject: string;
          relation: string;
          type: string;
          id: string;
        }): Promise<{ revoked: { subject: string; relation: string; object: string }; count: number }> =>
          $fetch(`${basePath}/revoke`, { method: 'DELETE', body: params }),
      },
    }),
  };
}
