import { describe, it, expect } from 'vitest';
import { ZanzoBuilder, ZanzoEngine } from '../src/index';

const schema = new ZanzoBuilder()
  .entity('User', { actions: [], relations: {} })
  .entity('Team', {
    actions: [] as const,
    relations: { member: 'User' } as const,
  })
  .entity('Document', {
    actions: ['read', 'write'],
    relations: { owner: 'User', viewer: 'User', team: 'Team' },
    permissions: {
      read: ['viewer', 'owner', 'team.member'],
      write: ['owner'],
    },
  })
  .build();

describe('Debug Trace — engine.for().check().on()', () => {
  it('returns allowed: true with trace when permission is granted', () => {
    const engine = new ZanzoEngine(schema);
    engine.grant('owner').to('User:alice').on('Document:doc1');

    const result = engine.for('User:alice').check('write').on('Document:doc1');

    expect(result.allowed).toBe(true);
    expect(result.trace.length).toBeGreaterThan(0);

    // The 'owner' path should be found
    const ownerStep = result.trace.find((s) => s.path === 'owner' && s.found);
    expect(ownerStep).toBeDefined();
    expect(ownerStep!.target).toBe('Document:doc1');
    expect(ownerStep!.subjects).toContain('User:alice');
  });

  it('returns allowed: false with trace showing which paths failed', () => {
    const engine = new ZanzoEngine(schema);
    engine.grant('viewer').to('User:bob').on('Document:doc1');

    const result = engine.for('User:bob').check('write').on('Document:doc1');

    expect(result.allowed).toBe(false);
    // The 'owner' path should show found: false
    const ownerStep = result.trace.find((s) => s.path === 'owner');
    expect(ownerStep).toBeDefined();
    expect(ownerStep!.found).toBe(false);
  });

  it('returns trace for nested permission paths (team.member)', () => {
    const engine = new ZanzoEngine(schema);
    engine.grant('member').to('User:carol').on('Team:Devs');
    engine.grant('team').to('Team:Devs').on('Document:doc1');

    const result = engine.for('User:carol').check('read').on('Document:doc1');

    expect(result.allowed).toBe(true);
    expect(result.trace.length).toBeGreaterThanOrEqual(1);

    // Should have a trace step showing the nested resolution succeeded
    const teamMemberStep = result.trace.find((s) => s.path === 'team.member' && s.found);
    expect(teamMemberStep).toBeDefined();
  });

  it('returns empty trace for unknown entity type', () => {
    const engine = new ZanzoEngine(schema);

    const result = engine
      .for('User:alice')
      .check('read')
      .on('Unknown:x' as any);

    expect(result.allowed).toBe(false);
    expect(result.trace).toEqual([]);
  });

  it('returns empty trace for action with no permission mappings', () => {
    const engine = new ZanzoEngine(schema);

    const result = engine
      .for('User:alice')
      .check('delete' as any)
      .on('Document:doc1');

    expect(result.allowed).toBe(false);
    expect(result.trace).toEqual([]);
  });

  it('trace includes all subjects holding the relation', () => {
    const engine = new ZanzoEngine(schema);
    engine.grant('viewer').to('User:alice').on('Document:doc1');
    engine.grant('viewer').to('User:bob').on('Document:doc1');

    const result = engine.for('User:carol').check('read').on('Document:doc1');

    expect(result.allowed).toBe(false);
    const viewerStep = result.trace.find((s) => s.path === 'viewer');
    expect(viewerStep).toBeDefined();
    expect(viewerStep!.subjects).toContain('User:alice');
    expect(viewerStep!.subjects).toContain('User:bob');
  });

  it('check() agrees with can() on all results', () => {
    const engine = new ZanzoEngine(schema);
    engine.grant('owner').to('User:alice').on('Document:doc1');
    engine.grant('viewer').to('User:bob').on('Document:doc2');

    // True cases
    expect(engine.for('User:alice').check('read').on('Document:doc1').allowed).toBe(
      engine.for('User:alice').can('read').on('Document:doc1'),
    );
    expect(engine.for('User:alice').check('write').on('Document:doc1').allowed).toBe(
      engine.for('User:alice').can('write').on('Document:doc1'),
    );
    expect(engine.for('User:bob').check('read').on('Document:doc2').allowed).toBe(
      engine.for('User:bob').can('read').on('Document:doc2'),
    );

    // False cases
    expect(engine.for('User:bob').check('write').on('Document:doc2').allowed).toBe(
      engine.for('User:bob').can('write').on('Document:doc2'),
    );
    expect(engine.for('User:carol').check('read').on('Document:doc1').allowed).toBe(
      engine
        .for('User:carol' as any)
        .can('read')
        .on('Document:doc1'),
    );
  });
});
