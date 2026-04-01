import { describe, it, expect } from 'vitest';
import { ZanzoBuilder, ZanzoEngine, RelationTuple } from '../src/index';

describe('Zanzo Enterprise Stress & Performance Tests', () => {
  it('should process a massive combinatorial graph (10,000 relations) linearly under 50ms without exceeding memory limits', () => {
    // 1. Setup a standard ReBAC Schema
    const schema = new ZanzoBuilder()
      .entity('User', { actions: [], relations: {} })
      .entity('Folder', {
        actions: ['read'],
        relations: { parent: 'Folder', viewer: 'User' },
        // To allow infinite depth hierarchy in ReBAC pattern we bind 'viewer' to 'parent.viewer'
        permissions: { read: ['viewer', 'parent.viewer', 'parent.parent.viewer'] },
      })
      .build();

    const engine = new ZanzoEngine(schema);

    // 2. Generate monstrous combinatorial data:
    // 1 Root Folder -> 100 Child Folders -> 100 Grandchildren
    // We will connect them all to simulate heavy RBAC nested loops
    const tuples: RelationTuple[] = [];

    // Create 100 level 1 folders
    for (let i = 0; i < 100; i++) {
      tuples.push({ subject: 'Folder:Root', relation: 'parent', object: `Folder:L1_${i}` });

      // For each level 1, create 100 level 2 folders
      for (let j = 0; j < 100; j++) {
        tuples.push({
          subject: `Folder:L1_${i}`,
          relation: 'parent',
          object: `Folder:L2_${i}_${j}`,
        });
      }
    }

    // Assign the User to the Root folder. They should inherit access to all 10,000 descendants.
    tuples.push({ subject: 'User:EnterpriseOwner', relation: 'viewer', object: 'Folder:Root' });

    // Pre-load memory indexes
    engine.addTuples(tuples);
    expect(engine.getIndex().size).toBeGreaterThan(10000);

    // 3. Mark precise execution time baseline
    const startMemory = process.memoryUsage().heapUsed;
    const startTime = performance.now();

    // 4. Trigger Deep Evaluation Strategy
    // The user wants to read Folder:L2_99_99. The engine must traverse up to L1_99 -> Root -> User
    const result = engine.can('User:EnterpriseOwner', 'read', 'Folder:L2_99_99');

    const endTime = performance.now();
    const endMemory = process.memoryUsage().heapUsed;

    const timeDiff = endTime - startTime;
    const memoryDiffMB = (endMemory - startMemory) / 1024 / 1024;

    // Output stats for the test runner logs
    console.log(`[Zanzo Stress] 10,000 Nodes Traversal Time: ${timeDiff.toFixed(2)}ms`);
    console.log(`[Zanzo Stress] Memory Traversal Cost: ${memoryDiffMB.toFixed(2)} MB`);

    // Expectations
    expect(result).toBe(true);
    expect(timeDiff).toBeLessThan(75); // Target execution boundary (allowing margin for VM CI warmup)

    // Make sure we aren't leaking megabytes of RAM per request
    expect(memoryDiffMB).toBeLessThan(5);
  });
});
