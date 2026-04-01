import { describe, it, expect, beforeEach } from 'vitest';
import { ZanzoBuilder, ZanzoEngine } from '../src/index';

describe('Zanzo Core Security Audit', () => {
  let engine: ZanzoEngine<any>;

  beforeEach(() => {
    // 1. Setup a cyclical schema
    const schema = new ZanzoBuilder()
      .entity('User', { actions: [], relations: {} })
      .entity('Node', {
        actions: ['read'],
        relations: { parent: 'Node', owner: 'User' },
        permissions: { read: ['owner', 'parent.owner'] },
      })
      .build();

    engine = new ZanzoEngine(schema);
  });

  it('should not throw Maximum Call Stack Size Exceeded on cyclic graphs, but safely abort using Set signatures', () => {
    // Inject a vicious infinite cycle: Node:A parent of Node:B, Node:B parent of Node:A
    engine.addTuples([
      { subject: 'Node:B', relation: 'parent', object: 'Node:A' },
      { subject: 'Node:A', relation: 'parent', object: 'Node:B' },
    ]);

    // Request evaluation that triggers the exploration
    // It should hit the Cycle Detection mechanism and return false, without Stack Overflow
    const result = engine.can('User:99', 'read', 'Node:A');
    expect(result).toBe(false);
  });

  it('should enforce Max Depth Threshold (50) and throw a controlled Security Exception on artificially deep nested chains', () => {
    // Re-create the checkRelationsRecursive max depth exploit loop dynamically
    const fakeRoute = new Array(51).fill('parent').map((p) => [p]);

    // Call the internal recursive explicitly bypassing the entry limit just for validation coverage
    // Actually wait, let's just trigger it logically since we have 50 layers deeply linked:
    const nodes = Array.from({ length: 55 }, (_, i) => `Node:${i}`);
    for (let i = 0; i < 52; i++) {
      engine.addTuple({ subject: nodes[i + 1], relation: 'parent', object: nodes[i] });
    }

    // Now User:99 owns Node:52
    engine.addTuple({ subject: 'User:99', relation: 'owner', object: nodes[52] });

    // Assuming the path requires stepping 50+ times:
    // This will actually stop at depth 50 and throw instead of continuing recursively forever.
    // However, the standard `can` dynamically builds the evaluation using the AST limit (which only has 1 layer deep 'parent.owner').
    // To trigger depth, we simulate the internal method directly or build a massive linear explicit mock graph if public.
    // Let's use internal accessor just to check the depth boundary:
    expect(() => {
      (engine as any).checkRelationsRecursive('User:99', fakeRoute, 'Node:0', new Set(), 51);
    }).toThrow(/Security Exception: Maximum relationship depth of 50 exceeded/);
  });

  it('should immediately intercept poisoning attacks (Null byte injections or monstrous payloads)', () => {
    const maliciousActor = 'User:Inject\x00'; // Null byte control char
    const overSizedActor = 'a'.repeat(256);

    expect(() => engine.can(maliciousActor, 'read', 'Node:A')).toThrow(
      /unprintable control characters/,
    );

    expect(() => engine.can(overSizedActor, 'read', 'Node:A')).toThrow(/under 255 characters/);
  });
});
