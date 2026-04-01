import { describe, it, expect, vi } from 'vitest';
import { ZanzoBuilder, materializeDerivedTuples } from '../src/index';

const schema = new ZanzoBuilder()
  .entity('User', { actions: [], relations: {} })
  .entity('Folder', {
    actions: ['read'],
    relations: { owner: 'User' },
    permissions: { read: ['owner'] },
  })
  .entity('Document', {
    actions: ['read'],
    relations: { folder: 'Folder' },
    permissions: { read: ['folder.owner'] },
  })
  .build();

describe('Deferred Tuple Expansion', () => {
  it('eager mode (default) evaluates derivations immediately', async () => {
    const fetchChildren = vi.fn().mockResolvedValue(['Document:1', 'Document:2']);

    const tuples = await materializeDerivedTuples({
      schema,
      newTuple: { subject: 'User:alice', relation: 'owner', object: 'Folder:A' },
      fetchChildren,
    });

    expect(fetchChildren).toHaveBeenCalled();
    expect(tuples).toHaveLength(2);
    expect(tuples).toEqual([
      { subject: 'User:alice', relation: 'folder.owner', object: 'Document:1' },
      { subject: 'User:alice', relation: 'folder.owner', object: 'Document:2' },
    ]);
  });

  it('deferred mode returns an executePending function and does not evaluate immediately', async () => {
    const fetchChildren = vi.fn().mockResolvedValue(['Document:1', 'Document:2']);
    const baseTuple = { subject: 'User:alice', relation: 'owner', object: 'Folder:A' };

    const deferred = await materializeDerivedTuples({
      schema,
      newTuple: baseTuple,
      fetchChildren,
      mode: 'deferred',
    });

    // In deferred mode, the execution should NOT have started yet.
    expect(fetchChildren).not.toHaveBeenCalled();

    // Validate returned structure
    expect(deferred).toHaveProperty('baseTuple', baseTuple);
    expect(typeof deferred.executePending).toBe('function');

    // Execute the pending queue
    const derivedTuples = await deferred.executePending();

    expect(fetchChildren).toHaveBeenCalled();
    expect(derivedTuples).toHaveLength(2);
    expect(derivedTuples).toEqual([
      { subject: 'User:alice', relation: 'folder.owner', object: 'Document:1' },
      { subject: 'User:alice', relation: 'folder.owner', object: 'Document:2' },
    ]);
  });
});
