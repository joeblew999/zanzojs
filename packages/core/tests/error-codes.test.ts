import { describe, it, expect } from 'vitest';
import {
  ZanzoBuilder,
  ZanzoEngine,
  ZanzoError,
  ZanzoErrorCode,
  materializeDerivedTuples,
} from '../src/index';

describe('ZANZO_MISSING_RELATION — Schema Validation', () => {
  it('throws MISSING_RELATION when a permission references an undefined relation', () => {
    const badSchema = new ZanzoBuilder()
      .entity('User', { actions: [], relations: {} })
      .entity('Document', {
        actions: ['read'],
        relations: { owner: 'User' },
        permissions: {
          read: ['editor' as any], // "editor" does NOT exist in relations
        },
      })
      .build();

    expect(() => new ZanzoEngine(badSchema)).toThrowError(ZanzoError);

    try {
      new ZanzoEngine(badSchema);
    } catch (e) {
      expect(e).toBeInstanceOf(ZanzoError);
      expect((e as ZanzoError).code).toBe(ZanzoErrorCode.MISSING_RELATION);
      expect((e as ZanzoError).message).toContain('editor');
      expect((e as ZanzoError).message).toContain('Document');
      expect((e as ZanzoError).message).toContain('owner');
    }
  });

  it('throws MISSING_RELATION on nested paths with invalid first segment', () => {
    const badSchema = new ZanzoBuilder()
      .entity('User', { actions: [], relations: {} })
      .entity('Team', {
        actions: [] as const,
        relations: { member: 'User' } as const,
      })
      .entity('Document', {
        actions: ['read'],
        relations: { owner: 'User' },
        permissions: {
          read: ['team.member' as any], // "team" does NOT exist in Document's relations
        },
      })
      .build();

    expect(() => new ZanzoEngine(badSchema)).toThrowError(ZanzoError);

    try {
      new ZanzoEngine(badSchema);
    } catch (e) {
      expect((e as ZanzoError).code).toBe(ZanzoErrorCode.MISSING_RELATION);
      expect((e as ZanzoError).message).toContain('team');
    }
  });

  it('does NOT throw for valid schemas', () => {
    const validSchema = new ZanzoBuilder()
      .entity('User', { actions: [], relations: {} })
      .entity('Document', {
        actions: ['read', 'write'],
        relations: { owner: 'User', viewer: 'User' },
        permissions: {
          read: ['viewer', 'owner'],
          write: ['owner'],
        },
      })
      .build();

    expect(() => new ZanzoEngine(validSchema)).not.toThrow();
  });

  it('does NOT throw for valid nested paths', () => {
    const validSchema = new ZanzoBuilder()
      .entity('User', { actions: [], relations: {} })
      .entity('Team', {
        actions: [] as const,
        relations: { member: 'User' } as const,
      })
      .entity('Document', {
        actions: ['read'],
        relations: { team: 'Team', owner: 'User' },
        permissions: {
          read: ['team.member', 'owner'],
        },
      })
      .build();

    expect(() => new ZanzoEngine(validSchema)).not.toThrow();
  });
});

describe('ZANZO_CYCLE_DETECTED — Expansion Cycle Detection', () => {
  it('processes equal-relation diamond graphs successfully without throwing CYCLE_DETECTED', async () => {
    // Schema: Folder has parent:Folder and permissions up to 3 levels deep
    // Diamond graph: multiple paths reach the same child via the exact same derived relation.
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

    const baseTuple = {
      subject: 'User:alice',
      relation: 'viewer',
      object: 'Folder:A',
    };

    const results = await materializeDerivedTuples({
      schema,
      newTuple: baseTuple,
      fetchChildren: async (parentObj) => {
        // Equal-relation diamond graph: A -> X, Y. X,Y -> B.
        // Both `Folder:X` and `Folder:Y` will enqueue `Folder:B`.
        // The engine should deduplicate `Folder:B` silently without throwing a cycle error.
        if (parentObj === 'Folder:A') return ['Folder:X', 'Folder:Y'];
        if (parentObj === 'Folder:X') return ['Folder:B'];
        if (parentObj === 'Folder:Y') return ['Folder:B'];
        return [];
      },
    });

    // Should return tuples for Folder:X, Folder:Y, and exactly one for Folder:B
    expect(results.length).toBeGreaterThan(0);
    const bTuples = results.filter((r) => r.object === 'Folder:B');
    expect(bTuples.length).toBe(1); // Deduplicated!
  });

  it('detects a TRUE circular reference (A -> B -> A) during tuple expansion', async () => {
    // True cycle: A node appears in its own ancestry chain.
    const cyclicSchema = new ZanzoBuilder()
      .entity('User', { actions: [], relations: {} })
      .entity('Folder', {
        actions: ['view'],
        relations: { viewer: 'User', parent: 'Folder' },
        permissions: {
          view: ['viewer', 'parent.viewer', 'parent.parent.viewer', 'parent.parent.parent.viewer'],
        },
      })
      .build();

    const baseTuple = {
      subject: 'User:alice',
      relation: 'viewer',
      object: 'Folder:A',
    };

    try {
      await materializeDerivedTuples({
        schema: cyclicSchema,
        newTuple: baseTuple,
        fetchChildren: async (parentObj) => {
          // True cycle: A -> B -> C -> A
          if (parentObj === 'Folder:A') return ['Folder:B'];
          if (parentObj === 'Folder:B') return ['Folder:C'];
          if (parentObj === 'Folder:C') return ['Folder:A']; // ← object is an ancestor of itself
          return [];
        },
      });
      expect.unreachable('Should have thrown CYCLE_DETECTED');
    } catch (e) {
      expect(e).toBeInstanceOf(ZanzoError);
      expect((e as ZanzoError).code).toBe(ZanzoErrorCode.CYCLE_DETECTED);
      expect((e as ZanzoError).message).toContain('Circular reference');
      expect((e as ZanzoError).message).toContain('Folder:A');
      expect((e as ZanzoError).message).toContain('ancestry chain');
    }
  });

  it('does NOT throw for non-cyclic expansion', async () => {
    const linearSchema = new ZanzoBuilder()
      .entity('User', { actions: [], relations: {} })
      .entity('Team', {
        actions: [] as const,
        relations: { member: 'User' } as const,
      })
      .entity('Project', {
        actions: ['view'],
        relations: { team: 'Team' },
        permissions: {
          view: ['team.member'],
        },
      })
      .build();

    const baseTuple = {
      subject: 'User:alice',
      relation: 'member',
      object: 'Team:devs',
    };

    const result = await materializeDerivedTuples({
      schema: linearSchema,
      newTuple: baseTuple,
      fetchChildren: async (parentObj, _relation) => {
        if (parentObj === 'Team:devs') return ['Project:p1', 'Project:p2'];
        return [];
      },
    });

    expect(result.length).toBe(2);
  });
});

describe('ZANZO_INVALID_ENTITY_REF — Entity Format Validation', () => {
  it('throws ZANZO_INVALID_ENTITY_REF when actor or subject/object is not Type:Id format', () => {
    const validSchema = new ZanzoBuilder()
      .entity('User', { actions: [], relations: {} })
      .entity('Document', {
        actions: ['read'],
        relations: { viewer: 'User' },
        permissions: { read: ['viewer'] },
      })
      .build();

    const engine = new ZanzoEngine(validSchema);

    // Test for()
    expect(() => engine.for('invalid' as any)).toThrowError(ZanzoError);
    expect(() => engine.for('invalid' as any)).toThrowError(/Type:Id/);
    expect(() => engine.for(':' as any)).toThrowError(ZanzoError);
    expect(() => engine.for('User:' as any)).toThrowError(ZanzoError);

    try {
      engine.for('invalid' as any);
    } catch (e: any) {
      expect(e.code).toBe(ZanzoErrorCode.INVALID_ENTITY_REF);
    }
  });
});
