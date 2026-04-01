import { describe, it, expect } from 'vitest';
import { ZanzoBuilder, ZanzoEngine, FIELD_SEPARATOR } from '../src/index';

// ─── Shared Schema ──────────────────────────────────────────────────
const schema = new ZanzoBuilder()
  .entity('Document', {
    actions: ['read', 'write'],
    relations: { owner: 'User', viewer: 'User' },
    permissions: {
      read: ['viewer', 'owner'],
      write: ['owner'],
    },
  })
  .entity('Review', {
    actions: ['read', 'edit'],
    relations: { reviewer: 'User', fieldEditor: 'User' },
    permissions: {
      read: ['reviewer'],
      edit: ['fieldEditor'],
    },
  })
  .entity('User', { actions: [], relations: {} })
  .build();

// ─── Fluent API ─────────────────────────────────────────────────────
describe('Fluent API', () => {
  it('engine.grant().to().on() adds the tuple correctly', () => {
    const engine = new ZanzoEngine(schema);
    engine.grant('owner').to('User:alice').on('Document:doc1');

    expect(engine.for('User:alice').can('write').on('Document:doc1')).toBe(true);
    expect(engine.for('User:alice').can('read').on('Document:doc1')).toBe(true);
  });

  it('engine.grant().to().on().until(date) adds tuple with expiresAt', () => {
    const engine = new ZanzoEngine(schema);
    const futureDate = new Date(Date.now() + 60_000);
    engine.grant('viewer').to('User:bob').on('Document:doc1').until(futureDate);

    // Should still be valid because the date is in the future
    expect(engine.for('User:bob').can('read').on('Document:doc1')).toBe(true);
  });

  it('engine.revoke().from().on() removes the tuple', () => {
    const engine = new ZanzoEngine(schema);
    engine.grant('owner').to('User:alice').on('Document:doc1');
    expect(engine.for('User:alice').can('write').on('Document:doc1')).toBe(true);

    engine.revoke('owner').from('User:alice').on('Document:doc1');
    expect(engine.for('User:alice').can('write').on('Document:doc1')).toBe(false);
  });

  it('engine.for().can().on() evaluates correctly (true/false)', () => {
    const engine = new ZanzoEngine(schema);
    engine.grant('viewer').to('User:bob').on('Document:doc1');

    expect(engine.for('User:bob').can('read').on('Document:doc1')).toBe(true);
    expect(engine.for('User:bob').can('write').on('Document:doc1')).toBe(false);
    expect(engine.for('User:carol').can('read').on('Document:doc1')).toBe(false);
  });

  it('engine.for().listAccessible() returns only accessible objects with their actions', () => {
    const engine = new ZanzoEngine(schema);
    engine.grant('owner').to('User:alice').on('Document:doc1');
    engine.grant('viewer').to('User:alice').on('Document:doc2');
    engine.grant('owner').to('User:bob').on('Document:doc3');

    const results = engine.for('User:alice').listAccessible('Document');

    expect(results).toHaveLength(2);

    const doc1 = results.find((r) => r.object === 'Document:doc1');
    expect(doc1).toBeDefined();
    expect(doc1!.actions).toContain('read');
    expect(doc1!.actions).toContain('write');

    const doc2 = results.find((r) => r.object === 'Document:doc2');
    expect(doc2).toBeDefined();
    expect(doc2!.actions).toContain('read');
    expect(doc2!.actions).not.toContain('write');

    // doc3 belongs to bob, not alice
    const doc3 = results.find((r) => r.object === 'Document:doc3');
    expect(doc3).toBeUndefined();
  });
});

// ─── Expiration ─────────────────────────────────────────────────────
describe('Temporal Permissions (Expiration)', () => {
  it('tuple without expiresAt is always valid', () => {
    const engine = new ZanzoEngine(schema);
    engine.grant('owner').to('User:alice').on('Document:doc1');
    expect(engine.for('User:alice').can('write').on('Document:doc1')).toBe(true);
  });

  it('tuple with expiresAt in the future is valid', () => {
    const engine = new ZanzoEngine(schema);
    const futureDate = new Date(Date.now() + 60_000);
    engine.grant('viewer').to('User:bob').on('Document:doc1').until(futureDate);
    expect(engine.for('User:bob').can('read').on('Document:doc1')).toBe(true);
  });

  it('tuple with expiresAt in the past is ignored — can() returns false', () => {
    const engine = new ZanzoEngine(schema);
    const pastDate = new Date(Date.now() - 60_000);
    engine.grant('viewer').to('User:bob').on('Document:doc1').until(pastDate);
    expect(engine.for('User:bob').can('read').on('Document:doc1')).toBe(false);
  });

  it('engine.cleanup() removes only expired tuples and returns correct count', () => {
    const engine = new ZanzoEngine(schema);
    const pastDate = new Date(Date.now() - 60_000);
    const futureDate = new Date(Date.now() + 60_000);

    engine.grant('owner').to('User:alice').on('Document:doc1');
    engine.grant('viewer').to('User:bob').on('Document:doc1').until(pastDate);
    engine.grant('viewer').to('User:carol').on('Document:doc1').until(futureDate);

    const removed = engine.cleanup();

    // Only bob's expired tuple should be removed
    expect(removed).toBe(1);
    expect(engine.for('User:alice').can('write').on('Document:doc1')).toBe(true);
    expect(engine.for('User:bob').can('read').on('Document:doc1')).toBe(false);
    expect(engine.for('User:carol').can('read').on('Document:doc1')).toBe(true);
  });
});

// ─── Field-Level Granularity ────────────────────────────────────────
describe('Field-Level Granularity', () => {
  it('permission on Review:cert1#strengths does NOT affect Review:cert1', () => {
    const engine = new ZanzoEngine(schema);
    engine.grant('fieldEditor').to('User:alice').on('Review:cert1#strengths');

    // Field permission should work
    expect(
      engine
        .for('User:alice')
        .can('edit')
        .on('Review:cert1#strengths' as any),
    ).toBe(true);
    // Should NOT inherit to the parent object
    expect(
      engine
        .for('User:alice')
        .can('edit')
        .on('Review:cert1' as any),
    ).toBe(false);
  });

  it('permission on Review:cert1 does NOT inherit to Review:cert1#strengths', () => {
    const engine = new ZanzoEngine(schema);
    engine.grant('fieldEditor').to('User:alice').on('Review:cert1');

    expect(
      engine
        .for('User:alice')
        .can('edit')
        .on('Review:cert1' as any),
    ).toBe(true);
    // Field-level should be independent
    expect(
      engine
        .for('User:alice')
        .can('edit')
        .on('Review:cert1#strengths' as any),
    ).toBe(false);
  });

  it('exact field-level check works correctly', () => {
    const engine = new ZanzoEngine(schema);
    engine.grant('reviewer').to('User:bob').on('Review:cert1#weaknesses');

    expect(
      engine
        .for('User:bob')
        .can('read')
        .on('Review:cert1#weaknesses' as any),
    ).toBe(true);
    expect(
      engine
        .for('User:bob')
        .can('read')
        .on('Review:cert1#strengths' as any),
    ).toBe(false);
    expect(
      engine
        .for('User:bob')
        .can('read')
        .on('Review:cert1' as any),
    ).toBe(false);
  });

  it('FIELD_SEPARATOR constant is exported as "#"', () => {
    expect(FIELD_SEPARATOR).toBe('#');
  });

  it('rejects objects with multiple # separators', () => {
    const engine = new ZanzoEngine(schema);
    expect(() => {
      engine.grant('reviewer').to('User:alice').on('Review:cert1#field1#field2');
    }).toThrow(/multiple '#' separators/);
  });
});

// ─── engine.load() ─────────────────────────────────────────────────
describe('engine.load() (DB Hydration)', () => {
  it('hydrates correctly from an array of tuples', () => {
    const engine = new ZanzoEngine(schema);
    engine.load([
      { subject: 'User:alice', relation: 'owner', object: 'Document:doc1' },
      { subject: 'User:bob', relation: 'viewer', object: 'Document:doc2' },
    ]);

    expect(engine.for('User:alice').can('write').on('Document:doc1')).toBe(true);
    expect(engine.for('User:bob').can('read').on('Document:doc2')).toBe(true);
  });

  it('silently ignores tuples with expired expiresAt', () => {
    const engine = new ZanzoEngine(schema);
    const pastDate = new Date(Date.now() - 60_000);

    engine.load([
      { subject: 'User:alice', relation: 'owner', object: 'Document:doc1' },
      { subject: 'User:bob', relation: 'viewer', object: 'Document:doc2', expiresAt: pastDate },
    ]);

    expect(engine.for('User:alice').can('write').on('Document:doc1')).toBe(true);
    // Bob's tuple was expired and should have been silently skipped
    expect(engine.for('User:bob').can('read').on('Document:doc2')).toBe(false);
  });

  it('accepts an empty array without errors', () => {
    const engine = new ZanzoEngine(schema);
    expect(() => engine.load([])).not.toThrow();
  });

  it('loads tuples with expiresAt in the future correctly', () => {
    const engine = new ZanzoEngine(schema);
    const futureDate = new Date(Date.now() + 60_000);

    engine.load([
      { subject: 'User:carol', relation: 'viewer', object: 'Document:doc3', expiresAt: futureDate },
    ]);

    expect(engine.for('User:carol').can('read').on('Document:doc3')).toBe(true);
  });
});

// ─── Backward Compatibility (Deprecations) ──────────────────────────
describe('Backward Compatibility', () => {
  it('addTuple still functions after deprecation', () => {
    const engine = new ZanzoEngine(schema);
    engine.addTuple({ subject: 'User:legacy', relation: 'owner', object: 'Document:old' });
    expect(engine.can('User:legacy', 'write' as any, 'Document:old' as any)).toBe(true);
  });

  it('addTuples still functions after deprecation', () => {
    const engine = new ZanzoEngine(schema);
    engine.addTuples([
      { subject: 'User:legacy1', relation: 'owner', object: 'Document:old1' },
      { subject: 'User:legacy2', relation: 'viewer', object: 'Document:old2' },
    ]);
    expect(engine.can('User:legacy1', 'write' as any, 'Document:old1' as any)).toBe(true);
    expect(engine.can('User:legacy2', 'read' as any, 'Document:old2' as any)).toBe(true);
  });

  it('can() still functions after deprecation', () => {
    const engine = new ZanzoEngine(schema);
    engine.addTuple({ subject: 'User:test', relation: 'viewer', object: 'Document:x' });
    expect(engine.can('User:test', 'read' as any, 'Document:x' as any)).toBe(true);
    expect(engine.can('User:test', 'write' as any, 'Document:x' as any)).toBe(false);
  });
});
