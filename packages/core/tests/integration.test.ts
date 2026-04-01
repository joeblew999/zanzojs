import { describe, it, expect, beforeEach } from 'vitest';
import {
  ZanzoBuilder,
  ZanzoEngine,
  expandTuples,
  collapseTuples,
  ref,
  parseEntityRef,
  serializeEntityRef,
  ENTITY_REF_SEPARATOR,
  RELATION_PATH_SEPARATOR,
} from '../src/index';
import type { RelationTuple } from '../src/index';

// ---------------------------------------------------------------------------
// Shared Schema: Organization + Project + User
// ---------------------------------------------------------------------------
function buildOrgProjectSchema() {
  return new ZanzoBuilder()
    .entity('User', { actions: [] as const, relations: {} })
    .entity('Organization', {
      actions: ['manage_billing'] as const,
      relations: { owner: 'User', admin: 'User' } as const,
      permissions: { manage_billing: ['owner', 'admin'] } as const,
    })
    .entity('Project', {
      actions: ['read', 'write', 'delete'] as const,
      relations: { author: 'User', org: 'Organization' } as const,
      permissions: {
        read: ['author', 'org.admin', 'org.owner'],
        write: ['author', 'org.admin'],
        delete: ['org.owner'],
      } as const,
    })
    .build();
}

// ===========================================================================
// Suite 1 — Full ReBAC Flow: Direct Permissions
// ===========================================================================
describe('Full ReBAC Flow — Direct Permissions', () => {
  const schema = buildOrgProjectSchema();
  let engine: ZanzoEngine<typeof schema>;

  beforeEach(() => {
    engine = new ZanzoEngine(schema);

    // Org:A with owner User:Owner and admin User:Admin
    engine.addTuples([
      { subject: 'User:Owner', relation: 'owner', object: 'Organization:A' },
      { subject: 'User:Admin', relation: 'admin', object: 'Organization:A' },
    ]);

    // Org:B with admin User:OtherAdmin
    engine.addTuple({ subject: 'User:OtherAdmin', relation: 'admin', object: 'Organization:B' });

    // Project:1 authored by User:Author, belonging to Org:A
    engine.addTuples([
      { subject: 'User:Author', relation: 'author', object: 'Project:1' },
      { subject: 'Organization:A', relation: 'org', object: 'Project:1' },
    ]);
  });

  it('author can read and write their own project, but NOT delete', () => {
    expect(engine.can('User:Author', 'read', 'Project:1')).toBe(true);
    expect(engine.can('User:Author', 'write', 'Project:1')).toBe(true);
    expect(engine.can('User:Author', 'delete', 'Project:1')).toBe(false);
  });

  it('org owner can read and delete on projects in their org, but NOT write (write requires author or org.admin)', () => {
    expect(engine.can('User:Owner', 'read', 'Project:1')).toBe(true);
    // write: ['author', 'org.admin'] — org.owner is NOT in write permissions
    expect(engine.can('User:Owner', 'write', 'Project:1')).toBe(false);
    expect(engine.can('User:Owner', 'delete', 'Project:1')).toBe(true);
  });

  it('org admin can read and write, but NOT delete', () => {
    expect(engine.can('User:Admin', 'read', 'Project:1')).toBe(true);
    expect(engine.can('User:Admin', 'write', 'Project:1')).toBe(true);
    expect(engine.can('User:Admin', 'delete', 'Project:1')).toBe(false);
  });

  it('unrelated user cannot do anything', () => {
    expect(engine.can('User:Stranger', 'read', 'Project:1')).toBe(false);
    expect(engine.can('User:Stranger', 'write', 'Project:1')).toBe(false);
    expect(engine.can('User:Stranger', 'delete', 'Project:1')).toBe(false);
  });

  it('admin of Org:B cannot access projects of Org:A', () => {
    expect(engine.can('User:OtherAdmin', 'read', 'Project:1')).toBe(false);
    expect(engine.can('User:OtherAdmin', 'write', 'Project:1')).toBe(false);
    expect(engine.can('User:OtherAdmin', 'delete', 'Project:1')).toBe(false);
  });
});

// ===========================================================================
// Suite 2 — Full ReBAC Flow: expandTuples Integration
// ===========================================================================
describe('Full ReBAC Flow — expandTuples Integration', () => {
  it('should derive tuples and allow engine.can() after insertion', async () => {
    const schema = buildOrgProjectSchema();
    const engine = new ZanzoEngine(schema);

    const baseTuple: RelationTuple = {
      subject: 'User:1',
      relation: 'admin',
      object: 'Organization:A',
    };

    const fetchChildren = async (parentObject: string, relation: string) => {
      if (parentObject === 'Organization:A' && relation === 'org') {
        return ['Project:1', 'Project:2'];
      }
      return [];
    };

    const derived = await expandTuples({
      schema,
      newTuple: baseTuple,
      fetchChildren,
    });

    // Should derive exactly 2 tuples
    expect(derived).toHaveLength(2);
    expect(derived).toEqual(
      expect.arrayContaining([
        { subject: 'User:1', relation: `org${RELATION_PATH_SEPARATOR}admin`, object: 'Project:1' },
        { subject: 'User:1', relation: `org${RELATION_PATH_SEPARATOR}admin`, object: 'Project:2' },
      ]),
    );

    // Insert base + derived into engine
    engine.addTuple(baseTuple);
    engine.addTuples(derived);
    // Also link org to projects
    engine.addTuple({ subject: 'Organization:A', relation: 'org', object: 'Project:1' });
    engine.addTuple({ subject: 'Organization:A', relation: 'org', object: 'Project:2' });

    // Admin of Org:A should be able to read Project:1
    expect(engine.can('User:1', 'read', 'Project:1')).toBe(true);
    expect(engine.can('User:1', 'read', 'Project:2')).toBe(true);
    expect(engine.can('User:1', 'write', 'Project:1')).toBe(true);
    // Admin cannot delete (only org.owner can)
    expect(engine.can('User:1', 'delete', 'Project:1')).toBe(false);
  });
});

// ===========================================================================
// Suite 3 — EntityRef Validation
// ===========================================================================
describe('EntityRef Validation', () => {
  it('ref("User:123") returns { type: "User", id: "123" }', () => {
    const result = ref('User:123');
    expect(result).toEqual({ type: 'User', id: '123' });
  });

  it('ref("Project:") throws error with actionable message', () => {
    expect(() => ref('Project:')).toThrow(/\[Zanzo\] Invalid EntityRef/);
    expect(() => ref('Project:')).toThrow(/empty id segment/);
  });

  it('ref(":123") throws error', () => {
    expect(() => ref(':123')).toThrow(/\[Zanzo\] Invalid EntityRef/);
    expect(() => ref(':123')).toThrow(/empty type segment/);
  });

  it('ref("NoSeparator") throws error', () => {
    expect(() => ref('NoSeparator')).toThrow(/\[Zanzo\] Invalid EntityRef/);
    expect(() => ref('NoSeparator')).toThrow(/does not contain/);
  });

  it('ref("Too:Many:Colons") throws error', () => {
    expect(() => ref('Too:Many:Colons')).toThrow(/\[Zanzo\] Invalid EntityRef/);
    expect(() => ref('Too:Many:Colons')).toThrow(/multiple/);
  });

  it('ref("User:\\x00malicious") throws error for control character', () => {
    expect(() => ref('User:\x00malicious')).toThrow(/\[Zanzo\] Invalid EntityRef/);
    expect(() => ref('User:\x00malicious')).toThrow(/control characters/);
  });

  it('serializeEntityRef({ type: "User", id: "123" }) returns "User:123"', () => {
    expect(serializeEntityRef({ type: 'User', id: '123' })).toBe('User:123');
  });

  it('parseEntityRef round-trips correctly', () => {
    const original = 'Organization:Acme';
    const parsed = parseEntityRef(original);
    expect(serializeEntityRef(parsed)).toBe(original);
  });

  it('ENTITY_REF_SEPARATOR is ":"', () => {
    expect(ENTITY_REF_SEPARATOR).toBe(':');
  });

  it('RELATION_PATH_SEPARATOR is "."', () => {
    expect(RELATION_PATH_SEPARATOR).toBe('.');
  });
});

// ===========================================================================
// Suite 4 — Three-Level Transitive Expansion
// ===========================================================================
describe('Three-Level Transitive Expansion', () => {
  it('should propagate tuples correctly through Company → Organization → Project', async () => {
    const schema = new ZanzoBuilder()
      .entity('User', { actions: [] as const, relations: {} })
      .entity('Company', {
        actions: [] as const,
        relations: { owner: 'User' } as const,
      })
      .entity('Organization', {
        actions: ['read'] as const,
        relations: { admin: 'User', company: 'Company' } as const,
        permissions: {
          read: ['admin', 'company.owner'],
        } as const,
      })
      .entity('Project', {
        actions: ['read'] as const,
        relations: { org: 'Organization' } as const,
        permissions: {
          read: ['org.admin', 'org.company.owner'],
        } as const,
      })
      .build();

    const engine = new ZanzoEngine(schema);

    // Base tuple: User:CEO owns Company:Acme
    const baseTuple: RelationTuple = {
      subject: 'User:CEO',
      relation: 'owner',
      object: 'Company:Acme',
    };

    const fetchChildren = async (parentObject: string, relation: string): Promise<string[]> => {
      // Company:Acme has Organization:Eng via 'company' relation
      if (parentObject === 'Company:Acme' && relation === 'company') {
        return ['Organization:Eng'];
      }
      // Organization:Eng has Project:Alpha via 'org' relation
      if (parentObject === 'Organization:Eng' && relation === 'org') {
        return ['Project:Alpha'];
      }
      return [];
    };

    const derived = await expandTuples({
      schema,
      newTuple: baseTuple,
      fetchChildren,
    });

    // Should derive:
    // 1st level: { subject: 'User:CEO', relation: 'company.owner', object: 'Organization:Eng' }
    // 2nd level: { subject: 'User:CEO', relation: 'org.company.owner', object: 'Project:Alpha' }
    expect(derived.length).toBeGreaterThanOrEqual(2);
    expect(derived).toEqual(
      expect.arrayContaining([
        { subject: 'User:CEO', relation: 'company.owner', object: 'Organization:Eng' },
        { subject: 'User:CEO', relation: 'org.company.owner', object: 'Project:Alpha' },
      ]),
    );

    // Insert everything into engine and verify
    engine.addTuple(baseTuple);
    engine.addTuples(derived);
    engine.addTuple({ subject: 'Company:Acme', relation: 'company', object: 'Organization:Eng' });
    engine.addTuple({ subject: 'Organization:Eng', relation: 'org', object: 'Project:Alpha' });

    expect(engine.can('User:CEO', 'read', 'Project:Alpha')).toBe(true);
    expect(engine.can('User:Random', 'read', 'Project:Alpha')).toBe(false);
  });
});

// ===========================================================================
// Suite 5 — Cycle Detection
// ===========================================================================
describe('Cycle Detection', () => {
  it('engine.can() returns false without infinite loop on cyclic tuples', () => {
    const schema = new ZanzoBuilder()
      .entity('User', { actions: [] as const, relations: {} })
      .entity('Node', {
        actions: ['access'] as const,
        relations: { link: 'Node', viewer: 'User' } as const,
        permissions: { access: ['viewer', 'link.viewer'] } as const,
      })
      .build();

    const engine = new ZanzoEngine(schema);

    // Create a cycle: Node:A → link → Node:B → link → Node:A
    engine.addTuples([
      { subject: 'Node:B', relation: 'link', object: 'Node:A' },
      { subject: 'Node:A', relation: 'link', object: 'Node:B' },
    ]);

    // No viewer is linked, so access should be false — and it should NOT hang
    const start = performance.now();
    expect(engine.can('User:Ghost', 'access', 'Node:A')).toBe(false);
    const elapsed = performance.now() - start;
    expect(elapsed).toBeLessThan(100); // Must complete quickly
  });

  it('expandTuples respects maxExpansionSize to prevent unbounded growth', async () => {
    const schema = new ZanzoBuilder()
      .entity('User', { actions: [] as const, relations: {} })
      .entity('Container', {
        actions: ['view'] as const,
        relations: { parent: 'Container', reader: 'User' } as const,
        permissions: { view: ['reader', 'parent.reader'] } as const,
      })
      .build();

    const baseTuple: RelationTuple = {
      subject: 'User:Flood',
      relation: 'reader',
      object: 'Container:Root',
    };

    // fetchChildren always returns many children, simulating pathological growth
    let callCount = 0;
    const fetchChildren = async () => {
      callCount++;
      return Array.from({ length: 50 }, (_, i) => `Container:Child${callCount}_${i}`);
    };

    await expect(
      expandTuples({
        schema,
        newTuple: baseTuple,
        fetchChildren,
        maxExpansionSize: 10,
      }),
    ).rejects.toThrow(/exceeded maximum size of 10/);
  });
});

// ===========================================================================
// Suite 6 — collapseTuples: Basic Revocation
// ===========================================================================
describe('collapseTuples — Basic Revocation', () => {
  it('should return exactly the derived tuples for deletion', async () => {
    const schema = buildOrgProjectSchema();

    const revokedTuple: RelationTuple = {
      subject: 'User:1',
      relation: 'admin',
      object: 'Organization:A',
    };

    const tuplesToDelete = await collapseTuples({
      schema,
      revokedTuple,
      fetchChildren: (parentObject, relation) => {
        if (parentObject === 'Organization:A' && relation === 'org') {
          return ['Project:1', 'Project:2'];
        }
        return [];
      },
    });

    expect(tuplesToDelete).toHaveLength(2);
    expect(tuplesToDelete).toContainEqual({
      subject: 'User:1',
      relation: 'org.admin',
      object: 'Project:1',
    });
    expect(tuplesToDelete).toContainEqual({
      subject: 'User:1',
      relation: 'org.admin',
      object: 'Project:2',
    });
  });
});

// ===========================================================================
// Suite 7 — collapseTuples: Symmetry with expandTuples
// ===========================================================================
describe('collapseTuples — Symmetry with expandTuples', () => {
  it('should return the exact same tuples as expandTuples for identical input', async () => {
    const schema = buildOrgProjectSchema();

    const baseTuple: RelationTuple = {
      subject: 'User:1',
      relation: 'admin',
      object: 'Organization:A',
    };

    const fetchChildren = async (parentObject: string, relation: string) => {
      if (parentObject === 'Organization:A' && relation === 'org') {
        return ['Project:1', 'Project:2'];
      }
      return [];
    };

    const expanded = await expandTuples({
      schema,
      newTuple: baseTuple,
      fetchChildren,
    });

    const collapsed = await collapseTuples({
      schema,
      revokedTuple: baseTuple,
      fetchChildren,
    });

    // Sort both arrays for deterministic comparison
    const sortTuples = (arr: RelationTuple[]) =>
      [...arr].sort((a, b) =>
        `${a.subject}|${a.relation}|${a.object}`.localeCompare(
          `${b.subject}|${b.relation}|${b.object}`,
        ),
      );

    expect(sortTuples(collapsed)).toEqual(sortTuples(expanded));
  });

  it('should maintain symmetry for three-level transitive schemas', async () => {
    const schema = new ZanzoBuilder()
      .entity('User', { actions: [] as const, relations: {} })
      .entity('Company', {
        actions: [] as const,
        relations: { owner: 'User' } as const,
      })
      .entity('Organization', {
        actions: ['read'] as const,
        relations: { admin: 'User', company: 'Company' } as const,
        permissions: { read: ['admin', 'company.owner'] } as const,
      })
      .entity('Project', {
        actions: ['read'] as const,
        relations: { org: 'Organization' } as const,
        permissions: { read: ['org.admin', 'org.company.owner'] } as const,
      })
      .build();

    const baseTuple: RelationTuple = {
      subject: 'User:CEO',
      relation: 'owner',
      object: 'Company:Acme',
    };

    const fetchChildren = async (parentObject: string, relation: string): Promise<string[]> => {
      if (parentObject === 'Company:Acme' && relation === 'company') return ['Organization:Eng'];
      if (parentObject === 'Organization:Eng' && relation === 'org') return ['Project:Alpha'];
      return [];
    };

    const expanded = await expandTuples({ schema, newTuple: baseTuple, fetchChildren });
    const collapsed = await collapseTuples({ schema, revokedTuple: baseTuple, fetchChildren });

    const sortTuples = (arr: RelationTuple[]) =>
      [...arr].sort((a, b) =>
        `${a.subject}|${a.relation}|${a.object}`.localeCompare(
          `${b.subject}|${b.relation}|${b.object}`,
        ),
      );

    expect(sortTuples(collapsed)).toEqual(sortTuples(expanded));
  });
});

// ===========================================================================
// Suite 8 — collapseTuples: Three-Level Transitive
// ===========================================================================
describe('collapseTuples — Three-Level Transitive', () => {
  it('should identify all derived tuples across three levels for deletion', async () => {
    const schema = new ZanzoBuilder()
      .entity('User', { actions: [] as const, relations: {} })
      .entity('Company', {
        actions: [] as const,
        relations: { owner: 'User' } as const,
      })
      .entity('Organization', {
        actions: ['read'] as const,
        relations: { admin: 'User', company: 'Company' } as const,
        permissions: { read: ['admin', 'company.owner'] } as const,
      })
      .entity('Project', {
        actions: ['read'] as const,
        relations: { org: 'Organization' } as const,
        permissions: { read: ['org.admin', 'org.company.owner'] } as const,
      })
      .build();

    const revokedTuple: RelationTuple = {
      subject: 'User:CEO',
      relation: 'owner',
      object: 'Company:Acme',
    };

    const tuplesToDelete = await collapseTuples({
      schema,
      revokedTuple,
      fetchChildren: async (parentObject, relation) => {
        if (parentObject === 'Company:Acme' && relation === 'company') return ['Organization:Eng'];
        if (parentObject === 'Organization:Eng' && relation === 'org') return ['Project:Alpha'];
        return [];
      },
    });

    expect(tuplesToDelete.length).toBeGreaterThanOrEqual(2);
    expect(tuplesToDelete).toContainEqual({
      subject: 'User:CEO',
      relation: 'company.owner',
      object: 'Organization:Eng',
    });
    expect(tuplesToDelete).toContainEqual({
      subject: 'User:CEO',
      relation: 'org.company.owner',
      object: 'Project:Alpha',
    });
  });
});

// ===========================================================================
// Suite 9 — collapseTuples: maxCollapseSize limit
// ===========================================================================
describe('collapseTuples — maxCollapseSize limit', () => {
  it('should throw Security Exception when collapse exceeds maxCollapseSize', async () => {
    const schema = new ZanzoBuilder()
      .entity('User', { actions: [] as const, relations: {} })
      .entity('Container', {
        actions: ['view'] as const,
        relations: { parent: 'Container', reader: 'User' } as const,
        permissions: { view: ['reader', 'parent.reader'] } as const,
      })
      .build();

    const revokedTuple: RelationTuple = {
      subject: 'User:Flood',
      relation: 'reader',
      object: 'Container:Root',
    };

    let callCount = 0;
    const fetchChildren = async () => {
      callCount++;
      return Array.from({ length: 50 }, (_, i) => `Container:Child${callCount}_${i}`);
    };

    await expect(
      collapseTuples({
        schema,
        revokedTuple,
        fetchChildren,
        maxCollapseSize: 10,
      }),
    ).rejects.toThrow(/exceeded maximum size of 10/);
  });
});

// ===========================================================================
// Suite 10 — collapseTuples: Empty derivations
// ===========================================================================
describe('collapseTuples — Empty derivations', () => {
  it('should return empty array when no nested paths exist for the relation', async () => {
    const schema = new ZanzoBuilder()
      .entity('User', { actions: [] as const, relations: {} })
      .entity('Document', {
        actions: ['read'] as const,
        relations: { viewer: 'User' } as const,
        permissions: { read: ['viewer'] } as const, // direct only, no nested paths
      })
      .build();

    const revokedTuple: RelationTuple = {
      subject: 'User:1',
      relation: 'viewer',
      object: 'Document:A',
    };

    const tuplesToDelete = await collapseTuples({
      schema,
      revokedTuple,
      fetchChildren: async () => [],
    });

    expect(tuplesToDelete).toEqual([]);
  });

  it('should return empty array when fetchChildren returns no children', async () => {
    const schema = buildOrgProjectSchema();

    const revokedTuple: RelationTuple = {
      subject: 'User:1',
      relation: 'admin',
      object: 'Organization:Empty',
    };

    const tuplesToDelete = await collapseTuples({
      schema,
      revokedTuple,
      fetchChildren: async () => [], // Org has no projects
    });

    expect(tuplesToDelete).toEqual([]);
  });
});
