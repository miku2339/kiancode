import assert from 'node:assert/strict';
import test from 'node:test';
import { developmentAuth } from '../src/auth.js';
import type { Conversation, Task, TaskEvent } from '../src/domain.js';
import { createServer } from '../src/http/server.js';
import { SqliteStore } from '../src/storage/sqlite.js';
import { WorkspaceWriteLeaseService } from '../src/workspace-write-lease.js';

const token = 'reconcile-http-token-at-least-thirty-two-characters';
const headers = { authorization: `Bearer ${token}` };

test('operation reconciliation over HTTP is strict and idempotent', async () => {
  const store = new SqliteStore();
  let executions = 0;
  const server = await createServer({
    store,
    authenticate: developmentAuth(token),
    runner: async () => { executions += 1; return { text: 'must not run' }; },
  });
  try {
    const workspace = await store.create('workspace', 'local-owner', {
      name: 'Project', root: '/project', deviceId: 'server', capabilities: ['workspace:write'], allowCloud: false,
    });
    const conversation = await store.create<Conversation>('conversation', 'local-owner', {
      title: 'Operation', scope: 'private', modelPolicy: 'local', strategy: 'single', mode: 'act', archived: false,
      workspaceId: workspace.id,
      internalOperation: { tool: 'workspace.write', input: { path: 'a.txt' } },
    });
    const task = await server.tasks.enqueue({ id: 'local-owner', level: 1, scopes: ['*'] }, conversation.id, 'write');
    await new WorkspaceWriteLeaseService(store, () => 0, 100).acquire({
      principal: { id: 'local-owner', level: 1, scopes: ['*'] },
      taskId: task.id,
      signal: new AbortController().signal,
      workspace: { id: workspace.id, ownerId: workspace.ownerId, ...workspace.data },
    });
    const unknown = await store.put<Task>('task', task.id, task.ownerId, {
      ...task.data, state: 'unknown', error: 'Outcome unknown',
    }, task.revision);
    await store.create<TaskEvent>('event', task.ownerId, {
      taskId: task.id,
      sequence: 2,
      type: 'tool_dispatched',
      payload: {
        type: 'tool_dispatched', toolCallId: task.id, toolOccurrenceId: 'operation:0', actionHash: 'a'.repeat(64),
        sideEffect: 'write', toolCall: { id: task.id, occurrenceId: 'operation:0', name: 'workspace.write', arguments: { path: 'a.txt' } },
      },
      at: unknown.updatedAt,
    }, `${task.id}:dispatch`);
    const payload = { resolution: 'applied', toolOccurrenceId: 'operation:0', note: 'File is present' };
    const invalid = await server.app.inject({
      method: 'POST', url: `/v1/tasks/${task.id}/reconcile`, headers, payload: { ...payload, extra: true },
    });
    assert.equal(invalid.statusCode, 400);

    const first = await server.app.inject({ method: 'POST', url: `/v1/tasks/${task.id}/reconcile`, headers, payload });
    const retry = await server.app.inject({ method: 'POST', url: `/v1/tasks/${task.id}/reconcile`, headers, payload });
    assert.equal(first.statusCode, 200, first.body);
    assert.equal(retry.statusCode, 200, retry.body);
    assert.equal(first.json().data.data.state, 'completed');
    assert.equal(retry.json().data.data.reconciliation.receiptId, first.json().data.data.reconciliation.receiptId);
    assert.equal(executions, 0);
    const events = await server.tasks.events(task.ownerId, task.id);
    assert.equal(events.filter((event) => event.data.type === 'tool_result').length, 1);
    assert.equal(events.filter((event) => event.data.type === 'reconcile').length, 1);

    const released = await server.app.inject({
      method: 'GET', url: `/v1/workspaces/${workspace.id}/write-lease`, headers,
    });
    assert.equal(released.statusCode, 200, released.body);
    const releasedLease = released.json().data;
    const verification = releasedLease.data.verification;
    const legacy = await server.app.inject({
      method: 'POST',
      url: `/v1/workspaces/${workspace.id}/write-lease/reconcile`,
      headers,
      payload: { revision: releasedLease.revision, verifiedStopped: true, note: 'Legacy overwrite' },
    });
    assert.equal(legacy.statusCode, 409, legacy.body);
    const preserved = await server.app.inject({
      method: 'GET', url: `/v1/workspaces/${workspace.id}/write-lease`, headers,
    });
    assert.equal(preserved.statusCode, 200, preserved.body);
    assert.deepEqual(preserved.json().data.data.verification, verification);

    const changed = await server.app.inject({
      method: 'POST', url: `/v1/tasks/${task.id}/reconcile`, headers, payload: { ...payload, note: 'Different' },
    });
    assert.equal(changed.statusCode, 409, changed.body);
  } finally {
    await server.close();
  }
});

for (const scope of ['task:write', 'approval:write']) {
  test(`HTTP reconciliation rejects ${scope} without its other required scope`, async () => {
    const store = new SqliteStore();
    const server = await createServer({
      store,
      authenticate: async () => ({ id: 'owner', level: 1, scopes: [scope] }),
      runner: async () => ({ text: 'unused' }),
    });
    try {
      const response = await server.app.inject({
        method: 'POST',
        url: '/v1/tasks/missing/reconcile',
        headers: { authorization: 'Bearer any-token' },
        payload: { resolution: 'abandon', toolOccurrenceId: 'turn-1:0' },
      });
      assert.equal(response.statusCode, 403);
      assert.equal(response.json().error.code, 'forbidden');
    } finally {
      await server.close();
    }
  });
}
