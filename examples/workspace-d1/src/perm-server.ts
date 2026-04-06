/**
 * ZanzoPermServer — Durable Object WebSocket server for live permission sync.
 *
 * Source pattern: cloudflare/agents (github.com/cloudflare/agents)
 *   Agent base class  → packages/agents/src/index.ts
 *   Server base class → partyserver (github.com/cloudflare/partykit — packages/partyserver/src/)
 *   Hono middleware   → hono-party  (github.com/cloudflare/partykit — packages/hono-party/src/)
 *
 * Uses Agent (not bare Server) so MCP tool exposure and email are available
 * for future extensions — e.g. an MCP "check permission" tool, or emailing on
 * access-denied events. Agent extends partyserver's Server → DurableObject.
 *
 * One DO per actor, named by actor string: idFromName("User:alice").
 *
 * ── Lifecycle ──────────────────────────────────────────────────────────────────
 *   onConnect(conn)  — build snapshot from D1, send to this connection only
 *   onRequest(req)   — POST /notify called by worker.ts after tuple changes;
 *                      rebuilds snapshot, broadcast() to ALL connected tabs
 *
 * ── Message protocol (raw JSON, compatible with usePartySocket / useAgent) ───
 *   { type: 'snapshot', data: Record<string, string[]> }
 *
 * ── Browser ──────────────────────────────────────────────────────────────────
 *   usePartySocket({ host, party: 'zanzo-perm-server', room: 'User:alice' })
 *   socket.addEventListener('message', e => {
 *     const { type, data } = JSON.parse(e.data);
 *     if (type === 'snapshot') feedToZanzoProvider(data);
 *   });
 *
 * ── wrangler.toml ─────────────────────────────────────────────────────────────
 *   [[durable_objects.bindings]]
 *   name = "ZanzoPermServer"   class_name = "ZanzoPermServer"
 *   [[migrations]]
 *   tag = "v1"   new_sqlite_classes = ["ZanzoPermServer"]
 */

import { Agent } from 'agents';
import type { Connection, ConnectionContext } from 'agents';
import { drizzle } from 'drizzle-orm/d1';
import { ZanzoEngine, createZanzoSnapshot } from '@zanzojs/core';
import { zanzoTuples, mergedSchema } from './schema';

interface Env {
  DB: D1Database;
}

export class ZanzoPermServer extends Agent<Env> {
  // hibernate: true — DO sleeps between messages; WebSocket connections survive
  // via Workers WebSocket Hibernation API. Saves cost for idle browser tabs.
  // Requires new_sqlite_classes migration (partyserver stores WS state in SQLite).
  static options = { hibernate: true };

  /**
   * New browser tab connects — immediately send the current snapshot.
   * Other tabs already connected are unaffected.
   */
  async onConnect(connection: Connection, _ctx: ConnectionContext): Promise<void> {
    connection.send(JSON.stringify({ type: 'snapshot', data: await this.buildSnapshot() }));
  }

  /**
   * HTTP handler — handles POST /notify sent by workspace-d1's notifyActor().
   * Rebuilds the snapshot from D1 and broadcasts to ALL connected browser tabs
   * for this actor in real time.
   */
  async onRequest(req: Request): Promise<Response> {
    if (req.method === 'POST') {
      const snapshot = await this.buildSnapshot();
      this.broadcast(JSON.stringify({ type: 'snapshot', data: snapshot }));
      return new Response('ok');
    }
    return new Response('Not found', { status: 404 });
  }

  /**
   * Build a fresh permission snapshot for this.name (the actor string).
   *
   * Creates a per-call ZanzoEngine — never mutates the shared engine singleton
   * from schema.ts (which has no tuple state loaded).
   *
   * Loads ALL tuples from D1 so hierarchical permissions resolve correctly:
   *   owning Directory:/projects/demo → read access to all files inside it.
   */
  private async buildSnapshot(): Promise<Record<string, string[]>> {
    const actor     = this.name;                                          // e.g. "User:alice"
    const allTuples = await drizzle(this.env.DB).select().from(zanzoTuples).all();

    const eng = new ZanzoEngine(mergedSchema);                            // fresh, no shared state
    eng.load(allTuples);                                                  // hierarchy resolution needs all

    return createZanzoSnapshot(eng, actor);                               // compile this actor's permissions
  }
}
