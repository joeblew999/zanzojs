import { describe, it, expect } from 'vitest';
import { ZanzoBuilder, ZanzoEngine } from '../src/index';

const schema = new ZanzoBuilder()
  .entity('User', { actions: [], relations: {} })
  .entity('Document', {
    actions: ['read'],
    relations: { viewer: 'User' },
    permissions: {
      read: ['viewer'],
    },
  })
  .build();

describe('PermissionCache - Extended', () => {
  it('invalidates cache when cleanup() removes expired tuples', async () => {
    const engine = new ZanzoEngine(schema);

    // Grant with expiration in the past
    const past = new Date(Date.now() - 1000);
    engine.grant('viewer').to('User:alice').on('Document:doc1').until(past);

    engine.enableCache({ ttlMs: 10_000 });

    // First call (cache miss) -> false because it is already expired in storage lookup
    // Wait, addTuple adds it, cleanup removes it.
    // If I call can() it checks isExpired()
    expect(engine.for('User:alice').can('read').on('Document:doc1')).toBe(false);

    // Now grant it again without expiration to test cache invalidation by cleanup
    engine.grant('viewer').to('User:alice').on('Document:doc1');
    expect(engine.for('User:alice').can('read').on('Document:doc1')).toBe(true);

    // Manually force an expired entry into the store (simulating time pass)
    // Actually engine.grant().until() and then waiting is better but slow.
    // Let's just test that cleanup() explicitly calls invalidate() if it removes something.

    const future = new Date(Date.now() + 50);
    engine.revoke('viewer').from('User:alice').on('Document:doc1');
    engine.grant('viewer').to('User:alice').on('Document:doc1').until(future);

    expect(engine.for('User:alice').can('read').on('Document:doc1')).toBe(true);

    // Wait for it to expire
    await new Promise((resolve) => setTimeout(resolve, 100));

    // Calling can() now will detect expiration in isExpired() and return false (invalidating cache)
    // But we want to test that cleanup() ALSO does it.

    const removed = engine.cleanup();
    expect(removed).toBeGreaterThan(0);

    // After cleanup, cache should be invalidated.
    // We already have r1=true in cache from previous call.
    // If cleanup invalidated it, the next call should be fresh.
    expect(engine.for('User:alice').can('read').on('Document:doc1')).toBe(false);
  });
});

const transitiveSchema = new ZanzoBuilder()
  .entity('User', { actions: [], relations: {} })
  .entity('Workspace', {
    actions: ['read_all'],
    relations: { admin: 'User' },
    permissions: { read_all: ['admin'] },
  })
  .entity('Document', {
    actions: ['read', 'write'],
    relations: { workspace: 'Workspace' },
    permissions: {
      read: ['workspace.admin'],
      write: ['workspace.admin'],
    },
  })
  .build();

describe('Selective Cache Invalidation', () => {
  it('only invalidates affected entries on direct tuple mutation', () => {
    const engine = new ZanzoEngine(schema);
    // selective is default
    engine.enableCache({ ttlMs: 10_000 });

    engine.grant('viewer').to('User:1').on('Document:1');
    engine.grant('viewer').to('User:2').on('Document:2');

    // Populate cache
    expect(engine.for('User:1').can('read').on('Document:1')).toBe(true);
    expect(engine.for('User:2').can('read').on('Document:2')).toBe(true);

    // Assert cache internal size
    const cacheSizeBefore = (engine as any).cache.size;
    expect(cacheSizeBefore).toBe(2);

    // Mutating Document:1 should not invalidate Document:2's cache
    engine.revoke('viewer').from('User:1').on('Document:1');

    // Cache size should be 1
    expect((engine as any).cache.size).toBe(1);

    expect(engine.for('User:1').can('read').on('Document:1')).toBe(false); // fresh eval
    expect(engine.for('User:2').can('read').on('Document:2')).toBe(true); // cached O(1)
  });

  it('invalidates child documents when parent workspace relation changes transitively', () => {
    const engine = new ZanzoEngine(transitiveSchema);
    engine.enableCache({ invalidationType: 'selective' });

    engine.grant('workspace').to('Workspace:A').on('Document:Child');
    engine.grant('admin').to('User:1').on('Workspace:A');

    // Now User:1 can read Document:Child
    expect(engine.for('User:1').can('read').on('Document:Child')).toBe(true);

    // Unrelated document
    engine.grant('workspace').to('Workspace:B').on('Document:Other');
    engine.grant('admin').to('User:2').on('Workspace:B');
    expect(engine.for('User:2').can('write').on('Document:Other')).toBe(true);

    expect((engine as any).cache.size).toBe(2);

    // Mutate Workspace A: revoke admin 1
    engine.revoke('admin').from('User:1').on('Workspace:A');

    // Expected: Document:Child should be invalidated because of DFS mapping from Document:Child -> Workspace:A.
    // The key "User:1|read|Document:Child" cachedActor="User:1" cachedResource="Document:Child".
    // isReachable(Document:Child, Workspace:A) is evaluated!
    // -> Document:Child index has workspace -> Workspace:A
    // so it reaches it, deletes it.
    expect((engine as any).cache.size).toBe(1); // Document:Other is still there

    expect(engine.for('User:1').can('read').on('Document:Child')).toBe(false);
    expect(engine.for('User:2').can('write').on('Document:Other')).toBe(true);
  });

  it('clears the entire cache if invalidationType is full', () => {
    const engine = new ZanzoEngine(schema);
    engine.enableCache({ ttlMs: 10_000, invalidationType: 'full' });

    engine.grant('viewer').to('User:1').on('Document:1');
    engine.grant('viewer').to('User:2').on('Document:2');

    expect(engine.for('User:1').can('read').on('Document:1')).toBe(true);
    expect(engine.for('User:2').can('read').on('Document:2')).toBe(true);
    expect((engine as any).cache.size).toBe(2);

    engine.revoke('viewer').from('User:1').on('Document:1');

    // Cache should be completely wiped
    expect((engine as any).cache.size).toBe(0);
  });

  it('falls back to full clear when cache size exceeds selectiveThreshold', () => {
    const engine = new ZanzoEngine(schema);
    // Setting threshold to 1
    engine.enableCache({ invalidationType: 'selective', selectiveThreshold: 1 });

    engine.grant('viewer').to('User:1').on('Document:1');
    engine.grant('viewer').to('User:2').on('Document:2');

    // Populate cache with 2 entries
    expect(engine.for('User:1').can('read').on('Document:1')).toBe(true);
    expect(engine.for('User:2').can('read').on('Document:2')).toBe(true);

    // Validate cache size is larger than threshold
    expect((engine as any).cache.size).toBe(2);

    // Mutate unrelated document
    engine.revoke('viewer').from('User:1').on('Document:1');

    // Because size (2) > threshold (1), it should have fallen back to full clear
    expect((engine as any).cache.size).toBe(0);
  });
});
