import { describe, it, expect, vi } from 'vitest';
import { ZanzoBuilder, ZanzoEngine, ZanzoError, ZanzoErrorCode } from '../src/index';
import { materializeDerivedTuples } from '../src/expander/index';

describe('Fix 6: Deterministic Date.now() in temporal evaluations', () => {
  it('captures Date.now() exactly once to ensure deterministic evaluation across deep graphs', () => {
    // We create a deep combinatorial graph.
    // In the old behavior, `Date.now()` was called inside `isExpired` for every edge walked.
    // If we mock Date.now() to increment on every call, the old behavior would
    // validate early edges and reject later edges for the identical expiration timestamp.

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

    const engine = new ZanzoEngine(schema);

    // Give Alice access to Folder A, expiring at timestamp 100
    engine.grant('viewer').to('User:alice').on('Folder:A').until(new Date(100));

    // Connect B -> A, C -> B
    engine.grant('parent').to('Folder:A').on('Folder:B');
    engine.grant('parent').to('Folder:B').on('Folder:C');

    // Mock Date.now to start at 90, and increment by 5 on every call.
    // Call 1: 90
    // Call 2: 95
    // Call 3: 100
    // Call 4: 105 (Expired!)
    let time = 85;
    const dateSpy = vi.spyOn(Date, 'now').mockImplementation(() => {
      time += 5;
      return time;
    });

    try {
      // The single deterministic Date.now() capture means the entire evaluation happens as if it's t=90.
      // So alice should be able to view Folder C via inheritance without it randomly expiring mid-traversal.
      const canView = engine.for('User:alice').can('view').on('Folder:C');
      expect(canView).toBe(true);

      // Date.now() should only have been called ONCE at the start of engine.can()
      // Wait: uniqueTupleKey, checkRelationsRecursive, etc. don't call Date.now() anymore.
      expect(dateSpy).toHaveBeenCalledTimes(1);
    } finally {
      dateSpy.mockRestore();
    }
  });

  it('captures Date.now() exactly once during evaluateAllActions', () => {
    const schema = new ZanzoBuilder()
      .entity('User', { actions: [], relations: {} })
      .entity('Doc', {
        actions: ['read', 'write'],
        relations: { owner: 'User', reader: 'User' },
        permissions: {
          read: ['reader', 'owner'],
          write: ['owner'],
        },
      })
      .build();

    const engine = new ZanzoEngine(schema);
    engine.grant('owner').to('User:alice').on('Doc:1').until(new Date(100));

    let time = 75;
    const dateSpy = vi.spyOn(Date, 'now').mockImplementation(() => {
      time += 15; // Call 1: 90 (Active), Call 2: 105 (Expired)
      return time;
    });

    try {
      const actions = engine.evaluateAllActions('User:alice', 'Doc:1');
      expect(actions.sort()).toEqual(['read', 'write']);
      expect(dateSpy).toHaveBeenCalledTimes(1);
    } finally {
      dateSpy.mockRestore();
    }
  });
});

describe('Fix 7: AbortSignal timeout support in DeferredExpansion.executePending', () => {
  it('aborts execution properly and rejects with ZANZO_EXPANSION_ABORTED when signal fires', async () => {
    const schema = new ZanzoBuilder()
      .entity('User', { actions: [], relations: {} })
      .entity('Folder', {
        actions: ['view'],
        relations: { viewer: 'User', parent: 'Folder' },
        permissions: {
          view: ['viewer', 'parent.viewer'],
        },
      })
      .build();

    const controller = new AbortController();

    const deferred = await materializeDerivedTuples({
      schema,
      newTuple: { subject: 'User:alice', relation: 'viewer', object: 'Folder:A' },
      mode: 'deferred',
      signal: controller.signal,
      fetchChildren: async (parentObj) => {
        // Simulate a painfully slow DB query that hangs
        return new Promise((resolve) => {
          setTimeout(() => {
            resolve(['Folder:B']);
          }, 1000); // 1 second
        });
      },
    });

    // We abort the signal 10ms after starting executePending (while fetchChildren is in-flight)
    setTimeout(() => {
      controller.abort();
    }, 10);

    // It should NOT wait 1000ms. It should reject almost immediately.
    const start = Date.now();
    try {
      await deferred.executePending();
      expect.unreachable('Should have thrown EXPANSION_ABORTED');
    } catch (e) {
      const elapsed = Date.now() - start;
      expect(elapsed).toBeLessThan(50); // Rejected quickly (within 50ms)

      expect(e).toBeInstanceOf(ZanzoError);
      expect((e as ZanzoError).code).toBe(ZanzoErrorCode.EXPANSION_ABORTED);
    }
  });

  it('aborts immediately if the signal is already aborted before execution starts', async () => {
    const schema = new ZanzoBuilder()
      .entity('User', { actions: [], relations: {} })
      .entity('Folder', { actions: [], relations: { parent: 'Folder' } })
      .build();

    const controller = new AbortController();
    controller.abort(); // Abort BEFORE calling executePending

    const deferred = await materializeDerivedTuples({
      schema,
      newTuple: { subject: 'User:alice', relation: 'viewer', object: 'Folder:A' },
      mode: 'deferred',
      signal: controller.signal,
      fetchChildren: async () => ['Folder:B'],
    });

    await expect(deferred.executePending()).rejects.toThrowError(
      /aborted before execution started/,
    );
  });
});
