import assert from 'node:assert/strict';
import test from 'node:test';
import { relevantMemory } from '../src/runtime-adapter.js';
import { SqliteStore } from '../src/storage/sqlite.js';
import type { Memory } from '../src/domain.js';

test('group retrieval excludes personal memory, unrelated agent memory and replaced records', async () => {
  const store = new SqliteStore();
  try {
    const base: Memory = { type: 'preference', text: 'old preference', scope: 'private', source: 'message:1', validFrom: '2026-01-01T00:00:00Z' };
    const old = await store.create('memory', 'owner', base);
    const next = await store.create('memory', 'owner', { ...base, text: 'new preference', replacesId: old.id });
    const group = await store.create('memory', 'owner', { ...base, scope: 'group', scopeId: 'group1', text: 'group preference' });
    await store.create('memory', 'owner', { ...base, scope: 'agent', scopeId: 'other-agent' });
    const rows = await store.scan<Memory>('memory', 'owner');
    assert.deepEqual(relevantMemory(rows, { scope: 'group', conversationId: 'group1', prompt: 'preference' }).map((row) => row.id), [group.id]);
    assert.deepEqual(relevantMemory(rows, { scope: 'private', conversationId: 'private', prompt: 'preference' }).map((row) => row.id), [next.id]);
  } finally { await store.close(); }
});
