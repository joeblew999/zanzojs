import { describe, it, expect } from 'vitest';
import { ZanzoBuilder, mergeSchemas, ZanzoEngine, SchemaData } from '../src/index';

describe('Zanzo Schema Composition Feature', () => {
  it('should deep merge independent schemas preventing runtime collisions', () => {
    const hrDomain = new ZanzoBuilder()
      .entity('Employee', { actions: ['read', 'fire'], relations: { manager: 'Employee' } })
      .build();

    const financeDomain = new ZanzoBuilder()
      .entity('Invoice', { actions: ['pay'], relations: { creator: 'Employee' } })
      .build();

    // 1. Dynamic Merge
    const unified = mergeSchemas(hrDomain, financeDomain);

    expect(unified).toHaveProperty('Employee');
    expect(unified).toHaveProperty('Invoice');

    // 2. Pass unified to Engine testing strict types
    const engine = new ZanzoEngine(unified);

    // TypeScript Compiler Test: 'fire' belongs to Employee (hrDomain), 'pay' belongs to Invoice (financeDomain)
    // Both should be valid generic inputs without throwing TS errors
    expect(engine.can('Employee:99', 'fire', 'Employee:1')).toBe(false);
    expect(engine.can('Employee:99', 'pay', 'Invoice:2')).toBe(false);
  });

  it('should throw an immediate descriptive Error if domains have colliding entity names', () => {
    const domainA = new ZanzoBuilder().entity('User', { actions: [] }).build();
    const domainB = new ZanzoBuilder().entity('User', { actions: ['read'] }).build();

    expect(() => mergeSchemas(domainA, domainB)).toThrow(
      /Schema Merge Collision: The entity 'User' is defined in multiple schemas/,
    );
  });

  it('should successfully enforce Type Intersections under the hood (Compilation check)', () => {
    const a = new ZanzoBuilder().entity('A', { actions: ['jump'] }).build();
    const b = new ZanzoBuilder().entity('B', { actions: ['run'] }).build();

    const merged = mergeSchemas(a, b);

    // Virtual compilation check. If this code complies, Intersection works.
    const engine = new ZanzoEngine(merged);

    // Type-safe inference assertions
    engine.can('A:1', 'jump', 'A:2');
    engine.can('B:1', 'run', 'B:2');
  });
});
