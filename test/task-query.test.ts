import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from '../src/http/server.js';
import { developmentAuth } from '../src/auth.js';
import { SqliteStore } from '../src/storage/sqlite.js';

const token = 'test-owner-token-with-at-least-thirty-two-characters';
const headers = { authorization: `Bearer ${token}` };

test('task filters and pagination preserve owner isolation and include every tied row once', async () => {
  const store = new SqliteStore();
  const server = await createServer({ store, authenticate: developmentAuth(token), runner: async () => ({ text: 'unused' }) });
  try {
    for (const id of ['a', 'b', 'c']) await store.create('task', 'local-owner', { state: 'completed', conversationId: 'conversation' }, id);
    await store.create('task', 'local-owner', { state: 'failed', conversationId: 'conversation' }, 'failed');
    await store.create('task', 'other-owner', { state: 'completed', conversationId: 'conversation' }, 'private');
    const first = await server.app.inject({ method: 'GET', url: '/v1/tasks?conversationId=conversation&state=completed&limit=2', headers });
    assert.equal(first.statusCode, 200, first.body);
    const page = first.json(); assert.equal(page.data.length, 2); assert.ok(page.nextCursor);
    const next = await server.app.inject({ method: 'GET', url: `/v1/tasks?conversationId=conversation&state=completed&limit=2&cursor=${page.nextCursor}`, headers });
    assert.equal(next.statusCode, 200, next.body);
    assert.deepEqual([...page.data, ...next.json().data].map((row) => row.id).sort(), ['a', 'b', 'c']);
    assert.equal(next.json().nextCursor, undefined);
    assert.equal((await server.app.inject({ method: 'GET', url: '/v1/tasks?cursor=invalid', headers })).statusCode, 400);
    assert.equal((await server.app.inject({ method: 'GET', url: '/v1/tasks?limit=201', headers })).statusCode, 400);
  } finally { await server.close(); }
});

test('workspace settings reject stale revisions and never accept changing the device or root', async () => {
  const store = new SqliteStore();
  const server = await createServer({ store, authenticate: developmentAuth(token), runner: async () => ({ text: 'unused' }) });
  try {
    const workspace = await store.create('workspace', 'local-owner', { name: 'Before', root: '/project', deviceId: 'server', capabilities: ['workspace:read'], allowCloud: false });
    const updated = await server.app.inject({ method: 'PATCH', url: `/v1/workspaces/${workspace.id}`, headers, payload: { revision: workspace.revision, changes: { name: 'After', allowCloud: true } } });
    assert.equal(updated.statusCode, 200, updated.body);
    assert.equal(updated.json().data.data.name, 'After');
    assert.equal((await server.app.inject({ method: 'PATCH', url: `/v1/workspaces/${workspace.id}`, headers, payload: { revision: workspace.revision, changes: { name: 'Stale' } } })).statusCode, 409);
    assert.equal((await server.app.inject({ method: 'PATCH', url: `/v1/workspaces/${workspace.id}`, headers, payload: { revision: 2, changes: { root: '/private' } } })).statusCode, 400);
  } finally { await server.close(); }
});
