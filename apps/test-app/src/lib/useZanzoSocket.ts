'use client';

import { useEffect, useRef, useState } from 'react';
import PartySocket from 'partysocket';

/**
 * useZanzoSocket — subscribes to live permission snapshots via the
 * ZanzoPermServer Durable Object WebSocket, using partysocket for the browser.
 *
 * partysocket handles:
 *   - automatic reconnection with exponential backoff
 *   - message queuing while disconnected
 *   - correct URL construction for partyserver room routing
 *
 * The DO sends { type: 'snapshot', data: Record<string, string[]> }
 * on connect and after every grant/revoke that affects this actor.
 *
 * party name = 'zanzo-perm-server' (partyserver derives from class name)
 * room       = actor string, e.g. 'User:alice'
 */
export function useZanzoSocket(actor: string, workerUrl = 'http://localhost:8787') {
  const [snapshot, setSnapshot] = useState<Record<string, string[]>>({});
  const [connected, setConnected] = useState(false);
  const socketRef = useRef<PartySocket | null>(null);

  useEffect(() => {
    socketRef.current?.close();

    const socket = new PartySocket({
      host: workerUrl.replace(/^https?:\/\//, ''),
      party: 'zanzo-perm-server',
      room: actor,
    });

    socketRef.current = socket;

    socket.addEventListener('open', () => setConnected(true));
    socket.addEventListener('close', () => setConnected(false));
    socket.addEventListener('message', (ev) => {
      try {
        const msg = JSON.parse(ev.data) as { type: string; data: Record<string, string[]> };
        if (msg.type === 'snapshot') setSnapshot(msg.data);
      } catch { /* ignore malformed */ }
    });

    return () => {
      socket.close();
      socketRef.current = null;
    };
  }, [actor, workerUrl]);

  return { snapshot, connected };
}
