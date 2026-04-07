'use client';

import { useEffect, useState, useCallback } from 'react';

/**
 * usePermissions — fetches the permission snapshot for the given actor.
 * Call refresh() after any grant/revoke to get updated permissions.
 */
export function usePermissions(actor: string, workerUrl = 'http://localhost:8787') {
  const [snapshot, setSnapshot] = useState<Record<string, string[]>>({});
  const [connected, setConnected] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const res = await fetch(
        `${workerUrl}/zanzo/snapshot?actor=${encodeURIComponent(actor)}`
      );
      if (!res.ok) return;
      const data = await res.json() as { snapshot: Record<string, string[]> };
      setSnapshot(data.snapshot ?? {});
      setConnected(true);
    } catch {
      setConnected(false);
    }
  }, [actor, workerUrl]);

  useEffect(() => {
    setConnected(false);
    setSnapshot({});
    refresh();
  }, [refresh]);

  return { snapshot, connected, refresh };
}

// Keep the old name as an alias so page.tsx import doesn't need changing
export { usePermissions as useZanzoSocket };
