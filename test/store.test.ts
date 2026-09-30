import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { SqliteStore } from '../src/storage/sqlite.js';

test('records survive reopening, enforce ownership and reject lost updates', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'kiancode-store-'));
  const path = join(directory, 'state.sqlite');
  let store = new SqliteStore(path);
  try {
    const record = await store.create('conversation', 'alice', { title: 'My project' });
    assert.equal(await store.get('conversation', record.id, 'bob'), undefined);
    assert.deepEqual(await store.scan('conversation', 'bob'), []);
    const updated = await store.put('conversation', record.id, 'alice', { title: 'Updated' }, record.revision);
    await assert.rejects(store.put('conversation', record.id, 'alice', { title: 'Stale' }, record.revision), /conflict/i);
    await assert.rejects(store.put('conversation', record.id, 'bob', { title: 'Intrusion' }, updated.revision), /not found/i);
    await store.close();
    store = new SqliteStore(path);
    assert.equal((await store.get<{ title: string }>('conversation', record.id, 'alice'))?.data.title, 'Updated');
    assert.equal(await store.remove('conversation', record.id, 'bob', updated.revision), false);
    assert.equal(await store.remove('conversation', record.id, 'alice', updated.revision), true);
    assert.equal(await store.get('conversation', record.id, 'alice'), undefined);
  } finally {
    await store.close();
    await rm(directory, { recursive: true, force: true });
  }
});
