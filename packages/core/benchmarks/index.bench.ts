import { ZanzoBuilder, ZanzoEngine, createZanzoSnapshot, ZanzoClient } from '../src/index';

const schema = new ZanzoBuilder()
  .entity('User', { actions: [], relations: {} })
  .entity('Org', { actions: [], relations: { admin: 'User' } })
  .entity('Workspace', { actions: [], relations: { org: 'Org' } })
  .entity('Module', {
    actions: ['create', 'read', 'update', 'delete', 'view', 'manage'],
    relations: { workspace: 'Workspace', viewer: 'User' },
    permissions: {
      view: ['viewer'],
      manage: ['workspace.org.admin'],
    },
  })
  .entity('Resource', {
    actions: ['view'],
    relations: { viewer: 'User' },
    permissions: { view: ['viewer'] },
  })
  .build();

const results: string[] = [];
let passCount = 0;

function assert(name: string, avg: number, threshold: number, min: number, max: number) {
  const passed = avg < threshold;
  if (passed) passCount++;
  results.push(`[${results.length + 1}] ${name}
    avg: ${avg.toFixed(3)}ms | min: ${min.toFixed(3)}ms | max: ${max.toFixed(3)}ms
    ${passed ? 'PASS' : 'FAIL'} (threshold: ${threshold}ms)
`);
}

// 1. Benchmark 1: Direct relation, single tuple
const engine1 = new ZanzoEngine(schema);
engine1.addTuple({ subject: 'User:1', relation: 'viewer', object: 'Resource:A' });
let total = 0,
  min = Infinity,
  max = 0;
for (let i = 0; i < 10000; i++) {
  const start = performance.now();
  engine1.can('User:1', 'view', 'Resource:A');
  const dur = performance.now() - start;
  total += dur;
  if (dur < min) min = dur;
  if (dur > max) max = dur;
}
assert('Direct relation (10k calls)', total / 10000, 0.01, min, max);

// 2. Benchmark 2: Nested path, 3 levels
const engine2 = new ZanzoEngine(schema);
engine2.addTuple({ subject: 'User:1', relation: 'admin', object: 'Org:A' });
engine2.addTuple({ subject: 'Org:A', relation: 'org', object: 'Workspace:ws1' });
engine2.addTuple({ subject: 'Workspace:ws1', relation: 'workspace', object: 'Module:m1' });
total = 0;
min = Infinity;
max = 0;
// Warmup
engine2.can('User:1', 'manage', 'Module:m1');
for (let i = 0; i < 10000; i++) {
  const start = performance.now();
  engine2.can('User:1', 'manage', 'Module:m1');
  const dur = performance.now() - start;
  total += dur;
  if (dur < min) min = dur;
  if (dur > max) max = dur;
}
assert('Nested 3-level path (10k calls)', total / 10000, 0.05, min, max);

// 3. Benchmark 3: Dense graph
const engine3 = new ZanzoEngine(schema);
for (let orgId = 0; orgId < 100; orgId++) {
  const org = `Org:${orgId}`;
  for (let u = 0; u < 5; u++) {
    engine3.addTuple({ subject: `User:${orgId}_${u}`, relation: 'admin', object: org });
  }
  const ws = `Workspace:${orgId}`;
  engine3.addTuple({ subject: org, relation: 'org', object: ws });
  for (let m = 0; m < 10; m++) {
    engine3.addTuple({ subject: ws, relation: 'workspace', object: `Module:${orgId}_${m}` });
  }
}
total = 0;
min = Infinity;
max = 0;
for (let i = 0; i < 1000; i++) {
  const targetOrg = Math.floor(Math.random() * 100);
  const targetModule = Math.floor(Math.random() * 10);
  const targetUser = Math.floor(Math.random() * 5);
  const start = performance.now();
  engine3.can(`User:${targetOrg}_${targetUser}`, 'manage', `Module:${targetOrg}_${targetModule}`);
  const dur = performance.now() - start;
  total += dur;
  if (dur < min) min = dur;
  if (dur > max) max = dur;
}
assert('Dense graph (1k calls)', total / 1000, 1, min, max);

// 4. Benchmark 4: Snapshot compilation
total = 0;
min = Infinity;
max = 0;
for (let i = 0; i < 100; i++) {
  const start = performance.now();
  createZanzoSnapshot(engine3, 'User:50_2');
  const dur = performance.now() - start;
  total += dur;
  if (dur < min) min = dur;
  if (dur > max) max = dur;
}
assert('Snapshot compilation (100 calls)', total / 100, 50, min, max);

// 5. Benchmark 5: ZanzoClient lookup
const snapshotRecord: Record<string, string[]> = {};
for (let i = 0; i < 500; i++) {
  snapshotRecord[`Resource:${i}`] = ['create', 'read', 'update', 'delete', 'share'];
}
const client = new ZanzoClient(snapshotRecord);
total = 0;
min = Infinity;
max = 0;
for (let i = 0; i < 100000; i++) {
  const targetId = Math.floor(Math.random() * 500);
  const start = performance.now();
  client.can('read', `Resource:${targetId}`);
  const dur = performance.now() - start;
  total += dur;
  if (dur < min) min = dur;
  if (dur > max) max = dur;
}
assert('ZanzoClient lookup (100k calls)', total / 100000, 0.001, min, max);

console.log('Zanzo Benchmarks');
console.log('────────────────────────────────────────');
results.forEach((r) => console.log(r));
console.log('────────────────────────────────────────');
console.log(`Results: ${passCount}/5 PASS`);
if (passCount < 5) process.exit(1);
