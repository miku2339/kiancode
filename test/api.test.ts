import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from '../src/http/server.js';
import { developmentAuth } from '../src/auth.js';
import { SqliteStore } from '../src/storage/sqlite.js';
import type { Principal, ToolDefinition } from '../src/contracts.js';
import type { Task } from '../src/domain.js';

const token = 'test-owner-token-with-at-least-thirty-two-characters';
const headers = { authorization: `Bearer ${token}` };

test('authenticated chat creates a durable task and returns stored history', async () => {
  const store = new SqliteStore();
  const server = await createServer({ store, authenticate: developmentAuth(token), runner: async () => ({ text: 'Hello from the runtime' }) });
  try {
    assert.equal((await server.app.inject({ method: 'GET', url: '/v1/conversations' })).statusCode, 401);
    const created = await server.app.inject({ method: 'POST', url: '/v1/conversations', headers, payload: { title: 'Project' } });
    assert.equal(created.statusCode, 201, created.body);
    const id = created.json().data.id;
    const sent = await server.app.inject({ method: 'POST', url: `/v1/conversations/${id}/messages`, headers, payload: { content: 'Hello', requestId: 'mobile-message-1' } });
    assert.equal(sent.statusCode, 202, sent.body);
    await server.tasks.drain();
    const history = await server.app.inject({ method: 'GET', url: `/v1/conversations/${id}/messages`, headers });
    assert.deepEqual(history.json().data.map((item: { data: { content: string } }) => item.data.content), ['Hello', 'Hello from the runtime']);
    const result = await server.app.inject({ method: 'GET', url: `/v1/tasks/${sent.json().data.id}`, headers });
    assert.equal(result.json().data.data.state, 'completed');
    const events = await server.app.inject({ method: 'GET', url: `/v1/tasks/${sent.json().data.id}/events`, headers });
    assert.ok(events.json().data.some((event: { data: { type: string } }) => event.data.type === 'completed'));
  } finally { await server.close(); }
});

test('conversation request IDs survive edits and reject reuse with different original input', async () => {
  const store = new SqliteStore();
  const server = await createServer({ store, authenticate: developmentAuth(token), runner: async () => ({ text: 'unused' }) });
  try {
    const payload = { title: 'Original', requestId: 'create-conversation-1' };
    const first = await server.app.inject({ method: 'POST', url: '/v1/conversations', headers, payload });
    const retry = await server.app.inject({ method: 'POST', url: '/v1/conversations', headers, payload });
    assert.equal(first.statusCode, 201, first.body);
    assert.equal(retry.json().data.id, first.json().data.id);

    const edited = await server.app.inject({
      method: 'PATCH', url: `/v1/conversations/${first.json().data.id}`, headers,
      payload: { revision: first.json().data.revision, changes: { title: 'Edited later' } },
    });
    assert.equal(edited.statusCode, 200, edited.body);
    const afterEdit = await server.app.inject({ method: 'POST', url: '/v1/conversations', headers, payload });
    assert.equal(afterEdit.json().data.id, first.json().data.id);
    assert.equal(afterEdit.json().data.data.title, 'Edited later');

    const conflict = await server.app.inject({
      method: 'POST', url: '/v1/conversations', headers,
      payload: { title: 'Different original', requestId: 'create-conversation-1' },
    });
    assert.equal(conflict.statusCode, 409, conflict.body);
  } finally { await server.close(); }
});

test('workspace task history is persisted and filtered without assigning legacy tasks', async () => {
  const store = new SqliteStore();
  const tool: ToolDefinition = {
    name: 'workspace.inspect',
    description: 'Inspect a workspace.',
    inputSchema: { type: 'object' },
    requiredCapabilities: ['workspace:read'],
    requiresWorkspace: true,
    sideEffect: 'read',
    execute: async () => ({ content: '{}' }),
  };
  const server = await createServer({
    store,
    authenticate: developmentAuth(token),
    runner: async () => ({ text: '{}' }),
    tools: [tool],
  });
  try {
    const first = await store.create('workspace', 'local-owner', {
      name: 'First', root: '/first', deviceId: 'server', capabilities: ['workspace:read'], allowCloud: false,
    });
    const second = await store.create('workspace', 'local-owner', {
      name: 'Second', root: '/second', deviceId: 'server', capabilities: ['workspace:read'], allowCloud: false,
    });
    const otherOwner = await store.create('workspace', 'other-owner', {
      name: 'Other', root: '/other', deviceId: 'server', capabilities: ['workspace:read'], allowCloud: false,
    });
    const start = async (workspaceId: string, requestId: string) => server.app.inject({
      method: 'POST',
      url: `/v1/workspaces/${workspaceId}/operations`,
      headers,
      payload: { tool: tool.name, input: {}, requestId },
    });
    const firstTask = await start(first.id, 'first-operation');
    const secondTask = await start(second.id, 'second-operation');
    assert.equal(firstTask.statusCode, 202, firstTask.body);
    assert.equal(firstTask.json().data.data.workspaceId, first.id);
    assert.equal(secondTask.json().data.data.workspaceId, second.id);

    const legacyPrincipal: Principal = { id: 'local-owner', level: 1, scopes: ['*'] };
    await store.create<Task>('task', 'local-owner', {
      conversationId: 'operation-legacy',
      prompt: 'workspace.inspect',
      principal: legacyPrincipal,
      state: 'completed',
      grantExpiresAt: new Date().toISOString(),
      pendingActions: [],
      approvedActionHashes: [],
    }, 'legacy-task');

    const filtered = await server.app.inject({
      method: 'GET', url: `/v1/tasks?workspaceId=${first.id}`, headers,
    });
    assert.equal(filtered.statusCode, 200, filtered.body);
    assert.deepEqual(filtered.json().data.map((row: { id: string }) => row.id), [firstTask.json().data.id]);

    const all = await server.app.inject({ method: 'GET', url: '/v1/tasks', headers });
    assert.equal(all.json().data.length, 3);
    assert.ok(all.json().data.some((row: { id: string; data: { workspaceId?: string } }) =>
      row.id === 'legacy-task' && row.data.workspaceId === undefined));

    const foreign = await server.app.inject({
      method: 'GET', url: `/v1/tasks?workspaceId=${otherOwner.id}`, headers,
    });
    assert.equal(foreign.statusCode, 404, foreign.body);
  } finally { await server.close(); }
});

test('workspace task filtering requires workspace read authorization', async () => {
  const store = new SqliteStore();
  const authenticate = async (): Promise<Principal> => ({ id: 'limited-owner', level: 1, scopes: ['task:read'] });
  const server = await createServer({ store, authenticate, runner: async () => ({ text: 'unused' }) });
  try {
    const workspace = await store.create('workspace', 'limited-owner', {
      name: 'Limited', root: '/limited', deviceId: 'server', capabilities: [], allowCloud: false,
    });
    const response = await server.app.inject({
      method: 'GET', url: `/v1/tasks?workspaceId=${workspace.id}`, headers,
    });
    assert.equal(response.statusCode, 403, response.body);
  } finally { await server.close(); }
});
