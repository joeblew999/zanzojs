import { describe, it, expect } from 'vitest';
import { ZanzoBuilder, ZanzoEngine, createZanzoSnapshot, ZanzoClient } from '../src/index';

/**
 * Audit 2: Verification of the Canonical Flow
 *
 * This test demonstrates the recommended production lifecycle:
 * 1. Define schema once (Module level)
 * 2. Load user-specific tuples per request (DB -> Engine)
 * 3. Compile snapshot (Server)
 * 4. Sync snapshot to client (JSON)
 * 5. Evaluate in O(1) (Client)
 */
describe('ZanzoJS Canonical Flow', () => {
  // 1. Define schema (once, at module level)
  const schema = new ZanzoBuilder()
    .entity('User', { actions: [], relations: {} })
    .entity('Document', {
      actions: ['read', 'write'],
      relations: { owner: 'User', viewer: 'User' },
      permissions: {
        write: ['owner'],
        read: ['viewer', 'owner'],
      },
    })
    .build();

  it('runs the full end-to-end production flow correctly', async () => {
    // 2. Simulate rows from DB (array of tuples for "User:alice")
    const dbRows = [
      { subject: 'User:alice', relation: 'owner', object: 'Document:doc1' },
      { subject: 'User:alice', relation: 'viewer', object: 'Document:doc2' },
    ];

    // 3. engine.load(rows) in a fresh engine per request
    const engine = new ZanzoEngine(schema);
    engine.load(dbRows);

    // 4. createZanzoSnapshot(engine, actor)
    const snapshot = createZanzoSnapshot(engine, 'User:alice');

    // 5. Sync to Client (The snapshot is a plain JSON object)
    expect(snapshot).toEqual({
      'Document:doc1': ['read', 'write'],
      'Document:doc2': ['read'],
    });

    // 6. new ZanzoClient(snapshot) - This is what happens inside ZanzoProvider
    const client = new ZanzoClient(snapshot);

    // 7. client.can() evaluation in O(1)
    expect(client.can('read', 'Document:doc1')).toBe(true);
    expect(client.can('write', 'Document:doc1')).toBe(true);
    expect(client.can('read', 'Document:doc2')).toBe(true);
    expect(client.can('write', 'Document:doc2')).toBe(false);
    expect(client.can('read', 'Document:unknown')).toBe(false);
  });
});
