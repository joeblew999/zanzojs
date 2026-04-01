import { describe, it, expect } from 'vitest';
import { ZanzoBuilder, ZanzoEngine, createZanzoSnapshot } from '../src/index';

const schema = new ZanzoBuilder()
  .entity('User', { actions: [], relations: {} })
  .entity('Document', {
    actions: ['read', 'write'],
    relations: { owner: 'User', viewer: 'User' },
    permissions: {
      read: ['viewer', 'owner'],
      write: ['owner'],
    },
  })
  .entity('Project', {
    actions: ['view', 'edit'],
    relations: { admin: 'User' },
    permissions: {
      view: ['admin'],
      edit: ['admin'],
    },
  })
  .build();

// ─── Cache ──────────────────────────────────────────────────────────
describe('PermissionCache (enableCache / disableCache)', () => {
  it('caches can() results after enableCache()', () => {
    const engine = new ZanzoEngine(schema);
    engine.enableCache({ ttlMs: 10_000 });
    engine.grant('owner').to('User:alice').on('Document:doc1');

    const r1 = engine.for('User:alice').can('read').on('Document:doc1');
    const r2 = engine.for('User:alice').can('read').on('Document:doc1');

    expect(r1).toBe(true);
    expect(r2).toBe(true);
  });

  it('invalidates cache when a tuple is added', () => {
    const engine = new ZanzoEngine(schema);
    engine.enableCache({ ttlMs: 10_000 });

    expect(engine.for('User:alice').can('read').on('Document:doc1')).toBe(false);

    engine.grant('owner').to('User:alice').on('Document:doc1');

    // Should get fresh result after tuple mutation
    expect(engine.for('User:alice').can('read').on('Document:doc1')).toBe(true);
  });

  it('invalidates cache when a tuple is removed', () => {
    const engine = new ZanzoEngine(schema);
    engine.grant('owner').to('User:alice').on('Document:doc1');
    engine.enableCache({ ttlMs: 10_000 });

    expect(engine.for('User:alice').can('write').on('Document:doc1')).toBe(true);

    engine.revoke('owner').from('User:alice').on('Document:doc1');

    expect(engine.for('User:alice').can('write').on('Document:doc1')).toBe(false);
  });

  it('invalidates cache on clearTuples()', () => {
    const engine = new ZanzoEngine(schema);
    engine.grant('owner').to('User:alice').on('Document:doc1');
    engine.enableCache({ ttlMs: 10_000 });

    expect(engine.for('User:alice').can('read').on('Document:doc1')).toBe(true);

    engine.clearTuples();

    expect(engine.for('User:alice').can('read').on('Document:doc1')).toBe(false);
  });

  it('disableCache() stops caching', () => {
    const engine = new ZanzoEngine(schema);
    engine.enableCache({ ttlMs: 10_000 });
    engine.grant('owner').to('User:alice').on('Document:doc1');

    engine.for('User:alice').can('read').on('Document:doc1'); // cache

    engine.disableCache();

    // Should still work correctly without cache
    expect(engine.for('User:alice').can('read').on('Document:doc1')).toBe(true);
  });

  it('cache uses actor|action|resource key (3 components prevent collisions)', () => {
    const engine = new ZanzoEngine(schema);
    engine.enableCache({ ttlMs: 10_000 });
    engine.grant('owner').to('User:alice').on('Document:doc1');

    // Same actor, same resource, different actions → different cache entries
    const canRead = engine.for('User:alice').can('read').on('Document:doc1');
    const canWrite = engine.for('User:alice').can('write').on('Document:doc1');

    expect(canRead).toBe(true);
    expect(canWrite).toBe(true);
  });

  it('TTL expires cached entries', async () => {
    const engine = new ZanzoEngine(schema);
    engine.enableCache({ ttlMs: 50 }); // 50ms TTL
    engine.grant('owner').to('User:alice').on('Document:doc1');

    expect(engine.for('User:alice').can('read').on('Document:doc1')).toBe(true);

    // Revoke but don't invalidate (simulate TTL behavior)
    // Wait for TTL to expire
    await new Promise((resolve) => setTimeout(resolve, 60));

    // Cache should have expired, re-evaluate
    expect(engine.for('User:alice').can('read').on('Document:doc1')).toBe(true);
  });
});

// ─── Batch API ──────────────────────────────────────────────────────
describe('canBatch()', () => {
  it('batch-checks multiple permissions', () => {
    const engine = new ZanzoEngine(schema);
    engine.grant('owner').to('User:alice').on('Document:doc1');
    engine.grant('viewer').to('User:alice').on('Document:doc2');

    const results = engine.for('User:alice').canBatch([
      { action: 'read', resource: 'Document:doc1' },
      { action: 'write', resource: 'Document:doc1' },
      { action: 'read', resource: 'Document:doc2' },
      { action: 'write', resource: 'Document:doc2' },
    ]);

    expect(results.get('read:Document:doc1')).toBe(true);
    expect(results.get('write:Document:doc1')).toBe(true);
    expect(results.get('read:Document:doc2')).toBe(true);
    expect(results.get('write:Document:doc2')).toBe(false);
  });

  it('returns all false for unknown actor', () => {
    const engine = new ZanzoEngine(schema);
    engine.grant('owner').to('User:alice').on('Document:doc1');

    const results = engine.for('User:nobody').canBatch([
      { action: 'read', resource: 'Document:doc1' },
      { action: 'write', resource: 'Document:doc1' },
    ]);

    expect(results.get('read:Document:doc1')).toBe(false);
    expect(results.get('write:Document:doc1')).toBe(false);
  });

  it('handles empty checks array', () => {
    const engine = new ZanzoEngine(schema);
    const results = engine.for('User:alice').canBatch([]);
    expect(results.size).toBe(0);
  });

  it('evaluates permission only once per unique resource', () => {
    const engine = new ZanzoEngine(schema);
    engine.grant('owner').to('User:alice').on('Document:doc1');

    // Spy on evaluateAllActions to verify it's only called once
    let callCount = 0;
    const originalEvaluateAllActions = engine.evaluateAllActions.bind(engine);
    engine.evaluateAllActions = (actor: string, resource: string) => {
      callCount++;
      return originalEvaluateAllActions(actor, resource);
    };

    const results = engine.for('User:alice').canBatch([
      { action: 'read', resource: 'Document:doc1' },
      { action: 'write', resource: 'Document:doc1' }, // Second check on same resource
    ]);

    expect(results.get('read:Document:doc1')).toBe(true);
    expect(results.get('write:Document:doc1')).toBe(true);

    // evaluateAllActions should be called exactly once since there's only one unique resource
    expect(callCount).toBe(1);
  });
});

// ─── Snapshot Filtering ─────────────────────────────────────────────
describe('createZanzoSnapshot — entityTypes filter', () => {
  it('returns only resources of the specified entity types', () => {
    const engine = new ZanzoEngine(schema);
    engine.grant('owner').to('User:alice').on('Document:doc1');
    engine.grant('admin').to('User:alice').on('Project:proj1');

    const snapshot = createZanzoSnapshot(engine, 'User:alice', {
      entityTypes: ['Document'],
    });

    expect(snapshot['Document:doc1']).toBeDefined();
    expect(snapshot['Project:proj1']).toBeUndefined();
  });

  it('returns all resources when entityTypes is not specified', () => {
    const engine = new ZanzoEngine(schema);
    engine.grant('owner').to('User:alice').on('Document:doc1');
    engine.grant('admin').to('User:alice').on('Project:proj1');

    const snapshot = createZanzoSnapshot(engine, 'User:alice');

    expect(snapshot['Document:doc1']).toBeDefined();
    expect(snapshot['Project:proj1']).toBeDefined();
  });

  it('returns empty object when no resources match the filter', () => {
    const engine = new ZanzoEngine(schema);
    engine.grant('owner').to('User:alice').on('Document:doc1');

    const snapshot = createZanzoSnapshot(engine, 'User:alice', {
      entityTypes: ['Project'],
    });

    expect(Object.keys(snapshot)).toHaveLength(0);
  });

  it('supports multiple entity types in the filter', () => {
    const engine = new ZanzoEngine(schema);
    engine.grant('owner').to('User:alice').on('Document:doc1');
    engine.grant('admin').to('User:alice').on('Project:proj1');

    const snapshot = createZanzoSnapshot(engine, 'User:alice', {
      entityTypes: ['Document', 'Project'],
    });

    expect(snapshot['Document:doc1']).toBeDefined();
    expect(snapshot['Project:proj1']).toBeDefined();
  });
});
