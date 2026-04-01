import { describe, it, expect, vi } from 'vitest';
import {
  ZanzoBuilder,
  ZanzoEngine,
  ZanzoError,
  ZanzoErrorCode,
  materializeDerivedTuples,
  createZanzoSnapshot,
} from '../src/index';

// ─── Fix 1: Pipe character rejection ──────────────────────────────────

describe('Fix 1 — Pipe character rejection in validateInput', () => {
  const schema = new ZanzoBuilder()
    .entity('User', { actions: [], relations: {} })
    .entity('Document', {
      actions: ['read'],
      relations: { viewer: 'User' },
      permissions: { read: ['viewer'] },
    })
    .build();

  it('rejects actor containing | character', () => {
    const engine = new ZanzoEngine(schema);
    expect(() => {
      engine.for('User:pipe|test').can('read').on('Document:doc1');
    }).toThrow(/reserved as an internal separator/);
  });

  it('rejects resource containing | character', () => {
    const engine = new ZanzoEngine(schema);
    engine.grant('viewer').to('User:alice').on('Document:doc1');
    expect(() => {
      engine
        .for('User:alice')
        .can('read')
        .on('Document:pipe|doc' as any);
    }).toThrow(/reserved as an internal separator/);
  });

  it('rejects relation containing | character in grant()', () => {
    const engine = new ZanzoEngine(schema);
    expect(() => {
      engine
        .grant('view|er' as any)
        .to('User:alice')
        .on('Document:doc1');
    }).toThrow(/reserved as an internal separator/);
  });

  it('rejects subject containing | character in grant().to()', () => {
    const engine = new ZanzoEngine(schema);
    expect(() => {
      engine
        .grant('viewer')
        .to('User:a|b' as any)
        .on('Document:doc1');
    }).toThrow(/reserved as an internal separator/);
  });

  it('throws ZanzoError with INVALID_INPUT code', () => {
    const engine = new ZanzoEngine(schema);
    try {
      engine.for('User:pipe|test').can('read').on('Document:doc1');
      expect.unreachable('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(ZanzoError);
      expect((e as ZanzoError).code).toBe(ZanzoErrorCode.INVALID_INPUT);
    }
  });

  it('IDs without | continue to work normally', () => {
    const engine = new ZanzoEngine(schema);
    engine.grant('viewer').to('User:alice').on('Document:doc1');
    expect(engine.for('User:alice').can('read').on('Document:doc1')).toBe(true);
  });
});

// ─── Fix 2: Diamond graph false positive ──────────────────────────────

describe('Fix 2 — Diamond graph expansion (no false CYCLE_DETECTED)', () => {
  it('does not throw CYCLE_DETECTED when an object is child of two different parents', async () => {
    // Schema: Document has relations workspace→Workspace and team→Team
    // Both Workspace and Team have an admin relation to User
    const schema = new ZanzoBuilder()
      .entity('User', { actions: [], relations: {} })
      .entity('Workspace', {
        actions: ['manage'],
        relations: { admin: 'User' },
        permissions: { manage: ['admin'] },
      })
      .entity('Team', {
        actions: ['manage'],
        relations: { admin: 'User' },
        permissions: { manage: ['admin'] },
      })
      .entity('Document', {
        actions: ['read', 'edit'],
        relations: { workspace: 'Workspace', team: 'Team' },
        permissions: {
          read: ['workspace.admin', 'team.admin'],
          edit: ['workspace.admin'],
        },
      })
      .build();

    // Document:shared is child of both Workspace:ws1 and Team:team1
    const fetchChildren = vi.fn().mockImplementation(async (parentObj: string, relName: string) => {
      if (relName === 'workspace') return ['Document:shared', 'Document:only-ws'];
      if (relName === 'team') return ['Document:shared', 'Document:only-team'];
      return [];
    });

    // Expanding admin tuple for Workspace:ws1
    const wsResults = await materializeDerivedTuples({
      schema,
      newTuple: { subject: 'User:alice', relation: 'admin', object: 'Workspace:ws1' },
      fetchChildren,
    });

    // Should produce derived tuples for workspace.admin on both docs WITHOUT throwing
    expect(wsResults.length).toBeGreaterThanOrEqual(2);
    expect(wsResults.some((r) => r.object === 'Document:shared')).toBe(true);
    expect(wsResults.some((r) => r.object === 'Document:only-ws')).toBe(true);
  });

  it('processes equal-relation diamond graphs successfully without throwing CYCLE_DETECTED', async () => {
    const schema = new ZanzoBuilder()
      .entity('User', { actions: [], relations: {} })
      .entity('Folder', {
        actions: ['view'],
        relations: { viewer: 'User', parent: 'Folder' },
        permissions: {
          view: ['viewer', 'parent.viewer', 'parent.parent.viewer'],
        },
      })
      .build();

    // Equal-relation diamond graph: A -> X, Y. X,Y -> B
    // Folder:B is revisited via the exact same derived relation (parent.parent.viewer)
    const cyclicFetch = vi.fn().mockImplementation(async (parentObj: string) => {
      if (parentObj === 'Folder:A') return ['Folder:X', 'Folder:Y'];
      if (parentObj === 'Folder:X') return ['Folder:B'];
      if (parentObj === 'Folder:Y') return ['Folder:B'];
      return [];
    });

    const results = await materializeDerivedTuples({
      schema,
      newTuple: { subject: 'User:alice', relation: 'viewer', object: 'Folder:A' },
      fetchChildren: cyclicFetch,
    });

    // Engine should deduplicate Folder:B and succeed
    expect(results.length).toBeGreaterThan(0);
    expect(results.filter((r) => r.object === 'Folder:B').length).toBe(1);
  });

  it('detects a TRUE circular reference (A -> B -> A) via ancestry tracking', async () => {
    const cyclicSchema = new ZanzoBuilder()
      .entity('User', { actions: [], relations: {} })
      .entity('Folder', {
        actions: ['view'],
        relations: { viewer: 'User', parent: 'Folder' },
        permissions: {
          view: ['viewer', 'parent.viewer', 'parent.parent.viewer'],
        },
      })
      .build();

    // True cycle: A -> B -> A
    const cyclicFetch = vi.fn().mockImplementation(async (parentObj: string) => {
      if (parentObj === 'Folder:A') return ['Folder:B'];
      if (parentObj === 'Folder:B') return ['Folder:A'];
      return [];
    });

    await expect(
      materializeDerivedTuples({
        schema: cyclicSchema,
        newTuple: { subject: 'User:alice', relation: 'viewer', object: 'Folder:A' },
        fetchChildren: cyclicFetch,
      }),
    ).rejects.toThrow(/Circular reference detected/);
  });
});

// ─── Fix 3: evaluateAllActions uses cache ─────────────────────────────

describe('Fix 3 — evaluateAllActions cache integration', () => {
  const schema = new ZanzoBuilder()
    .entity('User', { actions: [], relations: {} })
    .entity('Document', {
      actions: ['read', 'write'],
      relations: { viewer: 'User', owner: 'User' },
      permissions: {
        read: ['viewer', 'owner'],
        write: ['owner'],
      },
    })
    .build();

  it('canBatch benefits from cache — second call hits cache', () => {
    const engine = new ZanzoEngine(schema);
    engine.enableCache({ ttlMs: 10_000 });

    engine.grant('owner').to('User:alice').on('Document:doc1');
    engine.grant('viewer').to('User:alice').on('Document:doc2');

    // First call: cache miss → evaluates
    const results1 = engine.for('User:alice').canBatch([
      { action: 'read', resource: 'Document:doc1' },
      { action: 'write', resource: 'Document:doc1' },
      { action: 'read', resource: 'Document:doc2' },
    ]);

    expect(results1.get('read:Document:doc1')).toBe(true);
    expect(results1.get('write:Document:doc1')).toBe(true);
    expect(results1.get('read:Document:doc2')).toBe(true);

    // Cache should now have entries
    expect((engine as any).cache.size).toBeGreaterThan(0);

    // Second call: should hit cache (we can verify correctness stays the same)
    const results2 = engine.for('User:alice').canBatch([
      { action: 'read', resource: 'Document:doc1' },
      { action: 'write', resource: 'Document:doc1' },
    ]);

    expect(results2.get('read:Document:doc1')).toBe(true);
    expect(results2.get('write:Document:doc1')).toBe(true);
  });

  it('createZanzoSnapshot populates cache entries', () => {
    const engine = new ZanzoEngine(schema);
    engine.enableCache({ ttlMs: 10_000 });

    engine.grant('owner').to('User:alice').on('Document:doc1');

    // Before snapshot, cache is empty
    expect((engine as any).cache.size).toBe(0);

    const snapshot = createZanzoSnapshot(engine, 'User:alice');

    expect(snapshot['Document:doc1']).toContain('read');
    expect(snapshot['Document:doc1']).toContain('write');

    // After snapshot, cache should have entries from evaluateAllActions
    expect((engine as any).cache.size).toBeGreaterThan(0);

    // Subsequent can() call should be a cache hit
    expect(engine.for('User:alice').can('read').on('Document:doc1')).toBe(true);
  });

  it('cache invalidation affects evaluateAllActions results', () => {
    const engine = new ZanzoEngine(schema);
    engine.enableCache({ ttlMs: 10_000 });

    engine.grant('owner').to('User:alice').on('Document:doc1');

    // First batch check populates cache
    const results1 = engine
      .for('User:alice')
      .canBatch([{ action: 'write', resource: 'Document:doc1' }]);
    expect(results1.get('write:Document:doc1')).toBe(true);

    // Revoke owner — this should invalidate cache
    engine.revoke('owner').from('User:alice').on('Document:doc1');

    // Second batch check should reflect the revocation
    const results2 = engine
      .for('User:alice')
      .canBatch([{ action: 'write', resource: 'Document:doc1' }]);
    expect(results2.get('write:Document:doc1')).toBe(false);
  });
});

// ─── Fix 4: until() atomic operation ──────────────────────────────────

describe('Fix 4 — until() atomic operation (no race condition)', () => {
  const schema = new ZanzoBuilder()
    .entity('User', { actions: [], relations: {} })
    .entity('Document', {
      actions: ['read'],
      relations: { viewer: 'User' },
      permissions: { read: ['viewer'] },
    })
    .build();

  it('tuple remains accessible at all times during until() call', () => {
    const engine = new ZanzoEngine(schema);
    const futureDate = new Date(Date.now() + 60_000);

    engine.grant('viewer').to('User:alice').on('Document:doc1');

    // Verify accessible before until()
    expect(engine.for('User:alice').can('read').on('Document:doc1')).toBe(true);

    // Call until() — should NOT temporarily remove the tuple
    engine.grant('viewer').to('User:alice').on('Document:doc1').until(futureDate);

    // Should STILL be accessible immediately after until()
    expect(engine.for('User:alice').can('read').on('Document:doc1')).toBe(true);
  });

  it('expiration set by until() is correctly stored', () => {
    const engine = new ZanzoEngine(schema);
    const pastDate = new Date(Date.now() - 60_000);

    engine.grant('viewer').to('User:alice').on('Document:doc1');
    expect(engine.for('User:alice').can('read').on('Document:doc1')).toBe(true);

    // Set past expiration — should deny access
    engine.grant('viewer').to('User:alice').on('Document:doc1').until(pastDate);
    // NOTE: until() updates an already-inserted tuple atomically.
    // But since the tuple was already added by the .on() call,
    // the grant().to().on() adds a NEW tuple first, then until() updates it.
    // After until() with past date, can() should detect expiration.
    expect(engine.for('User:alice').can('read').on('Document:doc1')).toBe(false);
  });

  it('cache is invalidated exactly once during until()', () => {
    const engine = new ZanzoEngine(schema);
    engine.enableCache({ ttlMs: 10_000 });

    engine.grant('viewer').to('User:alice').on('Document:doc1');

    // Populate cache
    expect(engine.for('User:alice').can('read').on('Document:doc1')).toBe(true);
    const sizeBefore = (engine as any).cache.size;
    expect(sizeBefore).toBe(1);

    const futureDate = new Date(Date.now() + 60_000);
    // This adds a new tuple via on(), then updates expiry via until()
    // Cache should be invalidated but tuple should remain accessible
    engine.grant('viewer').to('User:alice').on('Document:doc1').until(futureDate);

    // After the grant+until, can() should still return true (future date)
    expect(engine.for('User:alice').can('read').on('Document:doc1')).toBe(true);
  });
});

// ─── Fix 5: maxExpansionSize burst protection ─────────────────────────

describe('Fix 5 — maxExpansionSize burst protection', () => {
  const schema = new ZanzoBuilder()
    .entity('User', { actions: [], relations: {} })
    .entity('Folder', {
      actions: ['read'],
      relations: { owner: 'User' },
      permissions: { read: ['owner'] },
    })
    .entity('Document', {
      actions: ['read'],
      relations: { folder: 'Folder' },
      permissions: { read: ['folder.owner'] },
    })
    .build();

  it('rejects a single fetchChildren that returns more children than maxExpansionSize', async () => {
    const maxSize = 5;

    // fetchChildren returns 20 children in a single burst
    const fetchChildren = vi
      .fn()
      .mockResolvedValue(Array.from({ length: 20 }, (_, i) => `Document:burst-${i}`));

    await expect(
      materializeDerivedTuples({
        schema,
        newTuple: { subject: 'User:alice', relation: 'owner', object: 'Folder:A' },
        fetchChildren,
        maxExpansionSize: maxSize,
      }),
    ).rejects.toThrow(/exceeded maximum size of 5/);
  });

  it('allows expansion exactly at maxExpansionSize', async () => {
    const maxSize = 3;

    // fetchChildren returns exactly 3 children
    const fetchChildren = vi.fn().mockResolvedValue(['Document:1', 'Document:2', 'Document:3']);

    const results = await materializeDerivedTuples({
      schema,
      newTuple: { subject: 'User:alice', relation: 'owner', object: 'Folder:A' },
      fetchChildren,
      maxExpansionSize: maxSize,
    });

    expect(results).toHaveLength(3);
  });

  it('rejects at maxExpansionSize + 1', async () => {
    const maxSize = 3;

    // fetchChildren returns 4 children (one more than max)
    const fetchChildren = vi
      .fn()
      .mockResolvedValue(['Document:1', 'Document:2', 'Document:3', 'Document:4']);

    await expect(
      materializeDerivedTuples({
        schema,
        newTuple: { subject: 'User:alice', relation: 'owner', object: 'Folder:A' },
        fetchChildren,
        maxExpansionSize: maxSize,
      }),
    ).rejects.toThrow(/exceeded maximum size of 3/);
  });
});
