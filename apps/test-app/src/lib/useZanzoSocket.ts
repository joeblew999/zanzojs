'use client';

import { useEffect, useRef, useState, useCallback } from 'react';

/**
 * useZanzoSocket — subscribes to live permission snapshots via the
 * ZanzoPermServer Durable Object WebSocket.
 *
 * The DO sends { type: 'snapshot', data: Record<string, string[]> }
 * on connect and after every grant/revoke that affects this actor.
 *
 * URL pattern: ws://<host>/parties/zanzo-perm-server/<actor>
 * (partyserver middleware routing built into workspace-d1 worker)
 */
export function useZanzoSocket(actor: string, workerUrl = 'http://localhost:8787') {
  const [snapshot, setSnapshot] = useState<Record<string, string[]>>({});
  const [connected, setConnected] = useState(false);
  const wsRef = useRef<WebSocket | null>(null);
  const actorRef = useRef(actor);
  actorRef.current = actor;

  const connect = useCallback(() => {
    // Close any existing connection for a previous actor
    wsRef.current?.close();

    const wsBase = workerUrl.replace(/^http/, 'ws');
    const url = `${wsBase}/parties/zanzo-perm-server/${encodeURIComponent(actor)}`;
    const ws = new WebSocket(url);
    wsRef.current = ws;

    ws.onopen = () => setConnected(true);
    ws.onclose = () => {
      setConnected(false);
      // Reconnect after 2s if actor hasn't changed
      setTimeout(() => {
        if (actorRef.current === actor) connect();
      }, 2000);
    };
    ws.onerror = () => ws.close();
    ws.onmessage = (ev) => {
      try {
        const msg = JSON.parse(ev.data) as { type: string; data: Record<string, string[]> };
        if (msg.type === 'snapshot') setSnapshot(msg.data);
      } catch { /* ignore malformed */ }
    };
  }, [actor, workerUrl]);

  useEffect(() => {
    connect();
    return () => {
      wsRef.current?.close();
      wsRef.current = null;
    };
  }, [connect]);

  return { snapshot, connected };
}
