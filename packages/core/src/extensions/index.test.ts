import { describe, it, expect } from 'vitest';
import { ZanzoExtension } from './index';
import { ZanzoEngine } from '../engine/index';
import { ZanzoErrorCode } from '../errors';

const mockSchema = {
  Module: {
    relations: {
      owner: 'User',
    },
    actions: ['view', 'edit'],
    permissions: {
      view: ['owner'],
      edit: ['owner'],
    },
  },
  Capability: {
    relations: {
      module: 'Module',
    },
    actions: ['use'],
    permissions: {
      use: ['module.owner'],
    },
  },
} as any;

describe('ZanzoExtension', () => {
  it('should declare capabilities and deduplicate them', () => {
    const ext = new ZanzoExtension()
      .capability('Module:ventas', ['export_csv'])
      .capability('Module:ventas', ['export_csv', 'import_data']);

    expect(ext.getCapabilities('Module:ventas')).toEqual(['export_csv', 'import_data']);
  });

  it('should be immutable and support conditional branching', () => {
    const base = new ZanzoExtension();
    const branchA = base.capability('Module:a', ['read']);
    const branchB = base.capability('Module:b', ['write']);

    // They must be different instances
    expect(branchA).not.toBe(base);
    expect(branchB).not.toBe(base);
    expect(branchA).not.toBe(branchB);

    // branchA should only have Module:a capabilities
    expect(branchA.getCapabilities('Module:a')).toEqual(['read']);
    expect(branchA.getCapabilities('Module:b')).toEqual([]);

    // branchB should only have Module:b capabilities
    expect(branchB.getCapabilities('Module:a')).toEqual([]);
    expect(branchB.getCapabilities('Module:b')).toEqual(['write']);
  });

  it('should throw INVALID_ENTITY_REF on bad instance format', () => {
    const ext = new ZanzoExtension();
    expect(() => ext.capability('ModuleVentas', ['export_csv'])).toThrowError(
      expect.objectContaining({ code: ZanzoErrorCode.INVALID_ENTITY_REF }),
    );

    expect(() => ext.capability('', ['export_csv'])).toThrowError(
      expect.objectContaining({ code: ZanzoErrorCode.INVALID_INPUT }),
    );
  });

  it('should allow retrieving all capabilities as a Map', () => {
    const ext = new ZanzoExtension()
      .capability('Module:ventas', ['export_csv'])
      .capability('Module:stock', ['reorder_alert']);

    const map = ext.getAllCapabilities();
    expect(map.get('Module:ventas')).toEqual(['export_csv']);
    expect(map.get('Module:stock')).toEqual(['reorder_alert']);

    // Mutating the returned map shouldn't affect the internal map
    map.set('Module:ventas', []);
    expect(ext.getCapabilities('Module:ventas')).toEqual(['export_csv']);
  });

  it('should generate valid relation tuples', () => {
    const ext = new ZanzoExtension().capability('Module:m1', ['c1', 'c2']);

    const tuples = ext.toTuples('module');
    expect(tuples).toHaveLength(2);
    expect(tuples).toContainEqual({
      subject: 'Module:m1',
      relation: 'module',
      object: 'Capability:c1',
    });
    expect(tuples).toContainEqual({
      subject: 'Module:m1',
      relation: 'module',
      object: 'Capability:c2',
    });
  });

  it('should be serializable to JSON', () => {
    const ext = new ZanzoExtension().capability('Module:m1', ['c1']);

    const json = ext.toJSON();
    expect(json).toEqual({
      'Module:m1': ['c1'],
    });
  });
});

describe('ZanzoEngine - loadExtensions', () => {
  it('should hydrate engine with extension tuples and resolve permissions correctly', () => {
    const engine = new ZanzoEngine(mockSchema);

    // User:u1 owns Module:ventas
    // @ts-ignore
    engine.grant('owner').to('User:u1').on('Module:ventas');

    // Declare capabilities on the frontend
    const ext = new ZanzoExtension().capability('Module:ventas', ['export_csv', 'import_data']);

    // Load extensions into engine memory using default relation ('module')
    engine.loadExtensions(ext);

    // User:u1 should have 'use' action on Capability:export_csv because they own Module:ventas
    expect(engine.for('User:u1').can('use').on('Capability:export_csv')).toBe(true);
    expect(engine.for('User:u1').can('use').on('Capability:import_data')).toBe(true);

    // User without module ownership should not have access
    expect(engine.for('User:u2').can('use').on('Capability:export_csv')).toBe(false);

    // Test explicit relation override
    const customExt = new ZanzoExtension().capability('Module:v2', ['custom_cap']);
    engine.loadExtensions(customExt, 'custom_rel');
    // Note: this wouldn't work with mockSchema unless we added 'custom_rel', but we can verify it doesn't throw
  });
});
