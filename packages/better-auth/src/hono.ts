/**
 * createZanzoHonoApp — mounts zanzo grant/revoke/check/snapshot as a Hono sub-app.
 *
 * Mount once in your Worker:
 *   app.route('/zanzo', createZanzoHonoApp(zanzo, { getActor }))
 *
 * Routes:
 *   GET  /snapshot   — full permission snapshot for the current actor
 *   GET  /check      — can actor do action on type:id? → { allowed }
 *   PUT  /grant      — insert a tuple (owner/manage check if enforceOwnership: true)
 *   DELETE /revoke   — remove a tuple (owner/manage check if enforceOwnership: true)
 *
 * Actor resolution order:
 *   1. getActor(c)  — caller-supplied function (wire to Better Auth session here)
 *   2. x-actor header  — fallback for RPC / service-to-service calls
 *   3. ?actor= query param  — fallback for testing
 *   4. 'User:anonymous'
 */

import { Hono } from 'hono';
import type { ZanzoPluginInstance } from './plugin';

export interface ZanzoHonoOptions {
  /**
   * Resolves the current actor from the Hono context.
   * Wire to Better Auth session here:
   *   getActor: async (c) => {
   *     const s = await auth.api.getSession({ headers: c.req.raw.headers });
   *     return s ? `User:${s.user.id}` : 'User:anonymous';
   *   }
   */
  getActor?: (c: any) => Promise<string> | string;

  /**
   * If true, PUT /grant and DELETE /revoke require the requester to be the
   * owner of the target object or have 'manage' permission on it.
   * Default: false (trust the caller — use for server-side routes behind auth middleware).
   */
  enforceOwnership?: boolean;
}

// Default actor resolver: x-actor header > ?actor query param > anonymous
function defaultGetActor(c: any): string {
  return (
    c.req.header('x-actor') ??
    c.req.query('actor') ??
    'User:anonymous'
  );
}

export function createZanzoHonoApp(
  zanzo: ZanzoPluginInstance,
  options: ZanzoHonoOptions = {},
): Hono {
  const { getActor = defaultGetActor, enforceOwnership = false } = options;
  const app = new Hono();

  // ── Error handler — map Forbidden errors to 403, others to 500 ────────────
  app.onError((err, c) => {
    const msg = (err as any)?.message ?? 'Internal error';
    if (msg.startsWith('Forbidden')) return c.json({ error: msg }, 403);
    console.error('[zanzo]', err);
    return c.json({ error: 'Internal server error' }, 500);
  });

  // ── GET /snapshot ─────────────────────────────────────────────────────────
  // Returns the full permission snapshot for the current actor.
  // Feed into ZanzoProvider / ZanzoClient on the frontend.
  app.get('/snapshot', async (c) => {
    const actor    = await getActor(c);
    const data     = await zanzo.snapshot(actor);
    return c.json({ actor, snapshot: data });
  });

  // ── GET /check ────────────────────────────────────────────────────────────
  // Quick permission check. ?action=read&type=File&id=/projects/demo/notes.txt
  app.get('/check', async (c) => {
    const actor  = await getActor(c);
    const action = c.req.query('action') ?? '';
    const type   = c.req.query('type')   ?? '';
    const id     = c.req.query('id')     ?? '';
    if (!action || !type || !id) {
      return c.json({ error: 'Missing required params: action, type, id' }, 400);
    }
    const allowed = await zanzo.check(actor, action, type, id);
    return c.json({ allowed, actor, action, type, id });
  });

  // ── PUT /grant ────────────────────────────────────────────────────────────
  // Body: { subject, relation, type, id, expiresAt? }
  app.put('/grant', async (c) => {
    const requester = await getActor(c);
    const body = await c.req.json<{
      subject: string; relation: string; type: string; id: string; expiresAt?: string;
    }>();

    if (enforceOwnership) {
      const canGrant = await zanzo.check(requester, 'share', body.type, body.id);
      if (!canGrant) {
        return c.json({ error: `Forbidden: ${requester} cannot share ${body.type}:${body.id}` }, 403);
      }
    }

    await zanzo.grant(
      body.subject,
      body.relation,
      body.type,
      body.id,
      body.expiresAt ? { expiresAt: new Date(body.expiresAt) } : undefined,
    );
    return c.json({ granted: { subject: body.subject, relation: body.relation, object: `${body.type}:${body.id}` } });
  });

  // ── DELETE /revoke ────────────────────────────────────────────────────────
  // Body: { subject, relation, type, id }
  app.delete('/revoke', async (c) => {
    const requester = await getActor(c);
    const body = await c.req.json<{
      subject: string; relation: string; type: string; id: string;
    }>();

    if (enforceOwnership) {
      const canRevoke = await zanzo.check(requester, 'share', body.type, body.id);
      if (!canRevoke) {
        return c.json({ error: `Forbidden: ${requester} cannot revoke from ${body.type}:${body.id}` }, 403);
      }
    }

    const count = await zanzo.revoke(body.subject, body.relation, body.type, body.id);
    return c.json({ revoked: { subject: body.subject, relation: body.relation, object: `${body.type}:${body.id}` }, count });
  });

  return app;
}
