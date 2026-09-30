import assert from 'node:assert/strict';
import test from 'node:test';
import { MaintenanceService } from '../src/maintenance.js';
import { SqliteStore } from '../src/storage/sqlite.js';
import { DomainError, type Principal } from '../src/contracts.js';
import { developmentAuth } from '../src/auth.js';
import { createServer } from '../src/http/server.js';
const actor: Principal = { id: 'owner', level: 1, scopes: ['*'] };

test('maintenance status uses actual owner state and distinguishes unknown operations', async (t) => {
  const store = new SqliteStore(); t.after(() => store.close());
  const service = new MaintenanceService(store, () => Date.parse('2026-09-27T00:00:00Z'));
  await store.create('task', actor.id, { state: 'unknown', conversationId: 'c1', error: 'result_unconfirmed' });
  await store.create('task', 'other', { state: 'failed', prompt: 'secret' });
  await store.create('device', actor.id, { name: 'Mac', paused: false, lastSeen: '2026-09-26T23:59:00Z' });
  await store.create('artifact', actor.id, { bytes: 12 });
  const status = await service.status(actor);
  assert.deepEqual(status.tasks, { total: 1, states: { unknown: 1 } });
  assert.equal(status.attention[0]?.error, 'result_unconfirmed');
  assert.equal(status.devices[0]?.status, 'offline'); assert.equal(status.storage.artifactBytes, 12);
  assert.deepEqual(status.backups, []);
  await assert.rejects(service.status({ ...actor, level: 2 }), (error) => error instanceof DomainError && error.code === 'owner_required');
});

test('activity retains route templates, bounds retention and preserves user and unknown execution data', async (t) => {
  const store = new SqliteStore(); t.after(() => store.close());
  const service = new MaintenanceService(store, () => Date.parse('2026-09-27T00:00:00Z'));
  await service.record(actor, { method: 'PUT', route: '/v1/providers/:id', statusCode: 200, requestId: 'r1' });
  await service.record(actor, { method: 'PUT', route: '/v1/providers/a?secret=bad', statusCode: 200, requestId: 'r2' });
  await store.create('maintenance_activity', actor.id, { at: '2026-01-01T00:00:00Z' });
  await store.create('maintenance_activity', 'other', { at: '2026-01-01T00:00:00Z' });
  await store.create('model_probe', actor.id, { state: 'finished', expiresAt: '2026-01-01T00:00:00Z' });
  await store.create('model_probe', actor.id, { state: 'running', expiresAt: '2026-01-01T00:00:00Z' });
  await store.create('task', actor.id, { state: 'unknown' });
  await store.create('memory', actor.id, { text: 'keep' });
  assert.deepEqual(await service.cleanExpiredActivity(actor), { removedActivity: 1, removedProbes: 1 });
  assert.equal((await service.activity(actor)).length, 1);
  assert.equal((await store.scan('maintenance_activity', 'other')).length, 1);
  assert.equal((await store.scan('task', actor.id)).length, 1);
  assert.equal((await store.scan('memory', actor.id)).length, 1);
});

test('authenticated mutations record only the route template and request metadata', async () => {
  const store = new SqliteStore();
  const token = 'maintenance-owner-token-with-at-least-thirty-two-characters';
  const maintenance = new MaintenanceService(store, () => Date.parse('2026-09-27T00:00:00Z'));
  const server = await createServer({
    store,
    authenticate: developmentAuth(token),
    runner: async () => ({ text: 'unused' }),
    maintenance,
  });
  try {
    const response = await server.app.inject({
      method: 'POST',
      url: '/v1/conversations?secret=query-value',
      headers: { authorization: `Bearer ${token}` },
      payload: { title: 'private body value' },
    });
    assert.equal(response.statusCode, 201, response.body);
    const rows = await maintenance.activity({ id: 'local-owner', level: 1, scopes: ['*'] });
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.data.route, '/v1/conversations');
    assert.equal(rows[0]?.data.method, 'POST');
    assert.equal(rows[0]?.data.statusCode, 201);
    const serialized = JSON.stringify(rows);
    assert.equal(serialized.includes('query-value'), false);
    assert.equal(serialized.includes('private body value'), false);
  } finally {
    await server.close();
  }
});
