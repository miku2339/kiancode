import assert from 'node:assert/strict';
import test from 'node:test';
import { developmentAuth } from '../src/auth.js';
import { DomainError, notDispatched, type ToolDefinition } from '../src/contracts.js';
import type { Task, TaskEvent } from '../src/domain.js';
import { createServer } from '../src/http/server.js';
import { createTaskRunner } from '../src/runtime-adapter.js';
import { SqliteStore } from '../src/storage/sqlite.js';
import type { Entity, Store } from '../src/storage/store.js';
import { TaskService, type TaskRunner } from '../src/tasks.js';

const token = 'workspace-operations-development-token-thirty-two';
const headers = { authorization: `Bearer ${token}` };

interface EventPayload {
  type?: string;
  toolCallId?: string;
  toolOccurrenceId?: string;
  outcome?: string;
  isError?: boolean;
  notDispatched?: boolean;
  sideEffect?: string;
}

class FailedEventFaultStore implements Store {
  public failNextExecutionConversationRead = false;
  public failedEventFault?: 'before' | 'after';

  public constructor(private readonly delegate: Store) {}

  public async create<T>(kind: string, ownerId: string, data: T, id?: string): Promise<Entity<T>> {
    if (kind === 'event' && (data as TaskEvent).type === 'failed') {
      if (this.failedEventFault === 'before') throw new Error('failed event write failed before persistence');
      const created = await this.delegate.create(kind, ownerId, data, id);
      if (this.failedEventFault === 'after') {
        this.failedEventFault = undefined;
        throw new Error('failed event write failed after persistence');
      }
      return created;
    }
    return this.delegate.create(kind, ownerId, data, id);
  }

  public get<T>(kind: string, id: string, ownerId: string): Promise<Entity<T> | undefined> {
    if (kind === 'conversation' && this.failNextExecutionConversationRead) {
      this.failNextExecutionConversationRead = false;
      throw new Error('Query read timeout');
    }
    return this.delegate.get(kind, id, ownerId);
  }

  public scan<T>(kind: string, ownerId?: string): Promise<Array<Entity<T>>> {
    return this.delegate.scan(kind, ownerId);
  }

  public put<T>(kind: string, id: string, ownerId: string, data: T, revision: number): Promise<Entity<T>> {
    return this.delegate.put(kind, id, ownerId, data, revision);
  }

  public remove(kind: string, id: string, ownerId: string, revision: number): Promise<boolean> {
    return this.delegate.remove(kind, id, ownerId, revision);
  }

  public close(): Promise<void> {
    return this.delegate.close();
  }
}

function fakeTool(sideEffect: 'write' | 'external', execute: ToolDefinition['execute']): ToolDefinition {
  return {
    name: sideEffect === 'write' ? 'fake.write' : 'fake.run',
    description: 'Fake workspace tool',
    inputSchema: { type: 'object' },
    requiredCapabilities: [],
    requiresWorkspace: true,
    sideEffect,
    execute,
  };
}

async function harness(tool: ToolDefinition) {
  const store = new SqliteStore();
  const server = await createServer({
    store,
    tools: [tool],
    authenticate: developmentAuth(token),
    runner: createTaskRunner(store, { run: async () => { throw new Error('model must not run'); } }, [tool]),
    reauthorize: async (current) => current,
  });
  const workspace = await store.create('workspace', 'local-owner', {
    name: 'Local', root: '/project', deviceId: 'server', capabilities: [], allowCloud: false,
  });
  return {
    store,
    server,
    async operate(requestId: string): Promise<string> {
      const response = await server.app.inject({
        method: 'POST',
        url: `/v1/workspaces/${workspace.id}/operations`,
        headers,
        payload: { tool: tool.name, input: { path: 'a.txt' }, requestId },
      });
      assert.equal(response.statusCode, 202, response.body);
      await server.tasks.drain();
      return response.json().data.id as string;
    },
    async task(id: string): Promise<Task> {
      return (await store.get<Task>('task', id, 'local-owner'))!.data;
    },
    async payloads(id: string): Promise<EventPayload[]> {
      return (await server.tasks.events('local-owner', id)).map((row) => row.data.payload as EventPayload);
    },
    async close(): Promise<void> { await server.close(); await store.close(); },
  };
}

for (const [sideEffect, error] of [
  ['write', notDispatched('write_conflict', 'File changed since it was read', 409)],
  ['external', notDispatched('terminal_sandbox_required', 'Terminal was refused before launch', 503)],
] as const) {
  test(`a workspace ${sideEffect} refusal ends failed and closes its occurrence`, async () => {
    const context = await harness(fakeTool(sideEffect, async () => { throw error; }));
    try {
      const id = await context.operate('refused-1');
      const task = await context.task(id);
      assert.equal(task.state, 'failed');
      assert.equal(task.error, error.message);
      const payloads = await context.payloads(id);
      const events = payloads.filter((payload) => payload.type?.startsWith('tool_'));
      assert.deepEqual(events.map((payload) => payload.type), ['tool_dispatched', 'tool_result']);
      assert.deepEqual(
        [events[1]!.outcome, events[1]!.isError, events[1]!.notDispatched, events[1]!.sideEffect],
        ['failed', true, true, sideEffect],
      );
      assert.ok(events[0]!.toolOccurrenceId);
      assert.equal(events[1]!.toolOccurrenceId, events[0]!.toolOccurrenceId);
      assert.equal(payloads.filter((payload) => payload.type === 'failed').length, 1);
      await context.server.tasks.drain();
      assert.equal((await context.payloads(id)).filter((payload) => payload.type === 'failed').length, 1);
    } finally { await context.close(); }
  });
}

for (const sideEffect of ['write', 'external'] as const) {
  test(`an unmarked ${sideEffect} workspace failure remains unknown and is not replayed`, async () => {
    let executions = 0;
    const context = await harness(fakeTool(sideEffect, async () => {
      executions += 1;
      throw new DomainError('invalid_input', 'Remote side rejected the request');
    }));
    try {
      const id = await context.operate('unknown-1');
      assert.equal((await context.task(id)).state, 'unknown');
      assert.equal(await context.operate('unknown-1'), id);
      assert.equal(executions, 1);
      const events = (await context.payloads(id)).filter((payload) => payload.type?.startsWith('tool_'));
      assert.deepEqual(events.map((payload) => payload.type), ['tool_dispatched', 'tool_result']);
      assert.deepEqual([events[1]!.outcome, events[1]!.toolOccurrenceId], [
        'unknown', events[0]!.toolOccurrenceId,
      ]);
    } finally { await context.close(); }
  });
}

test('a failed workspace operation durably backfills one resumable terminal event without dispatching', async () => {
  const store = new FailedEventFaultStore(new SqliteStore());
  let runnerCalls = 0;
  let modelCalls = 0;
  let toolCalls = 0;
  const tool: ToolDefinition = {
    name: 'fake.read',
    description: 'Read a fake workspace file',
    inputSchema: { type: 'object' },
    requiredCapabilities: ['workspace:read'],
    requiresWorkspace: true,
    sideEffect: 'read',
    async execute() { toolCalls += 1; return { content: 'unreachable' }; },
  };
  const directRunner = createTaskRunner(store, {
    async run() { modelCalls += 1; throw new Error('model must not run'); },
  }, [tool]);
  const runner: TaskRunner = async (input) => {
    runnerCalls += 1;
    return directRunner(input);
  };
  const server = await createServer({
    store,
    tools: [tool],
    authenticate: developmentAuth(token),
    runner,
    reauthorize: async (current) => current,
  });
  const workspace = await store.create('workspace', 'local-owner', {
    name: 'Local', root: '/project', deviceId: 'server', capabilities: ['workspace:read'], allowCloud: false,
  });
  let reopened: TaskService | undefined;
  try {
    const response = await server.app.inject({
      method: 'POST',
      url: `/v1/workspaces/${workspace.id}/operations`,
      headers,
      payload: { tool: tool.name, input: { path: 'a.txt' }, requestId: 'failed-event-repair' },
    });
    assert.equal(response.statusCode, 202, response.body);
    const taskId = response.json().data.id as string;
    store.failNextExecutionConversationRead = true;
    store.failedEventFault = 'before';
    await assert.rejects(server.tasks.drain(), /failed event write failed before persistence/);

    const failed = await store.get<Task>('task', taskId, 'local-owner');
    assert.equal(failed?.data.state, 'failed');
    assert.equal(failed?.data.error, 'Query read timeout');
    const beforeRestart = (await store.scan<TaskEvent>('event', 'local-owner'))
      .filter((event) => event.data.taskId === taskId);
    assert.deepEqual(beforeRestart.map((event) => event.data.type), ['queued']);
    assert.equal((await store.scan('device_job', 'local-owner')).length, 0);
    assert.deepEqual([runnerCalls, modelCalls, toolCalls], [0, 0, 0]);

    const unavailable = await server.app.inject({
      method: 'GET',
      url: `/v1/tasks/${taskId}/stream?after=1`,
      headers,
    });
    assert.equal(unavailable.statusCode, 200, unavailable.body);
    assert.match(unavailable.body, /event: unavailable/);
    assert.doesNotMatch(unavailable.body, /event: failed/);
    assert.equal((await store.get<Task>('task', taskId, 'local-owner'))?.data.state, 'failed');
    assert.equal((await store.scan('device_job', 'local-owner')).length, 0);
    assert.deepEqual([runnerCalls, modelCalls, toolCalls], [0, 0, 0]);

    await server.tasks.close();
    store.failedEventFault = 'after';
    reopened = new TaskService(store, runner, { reauthorize: async (current) => current });
    await assert.rejects(reopened.drain(), /failed event write failed after persistence/);
    await reopened.drain();
    await reopened.drain();

    const events = (await store.scan<TaskEvent>('event', 'local-owner'))
      .filter((event) => event.data.taskId === taskId)
      .sort((left, right) => left.data.sequence - right.data.sequence);
    assert.deepEqual(events.map((event) => event.data.sequence), [1, 2]);
    assert.deepEqual(events.map((event) => event.data.type), ['queued', 'failed']);
    assert.equal((events[1]?.data.payload as EventPayload).type, 'failed');
    assert.equal((events[1]?.data.payload as { error?: string }).error, 'Query read timeout');
    assert.equal((await store.scan('device_job', 'local-owner')).length, 0);
    assert.deepEqual([runnerCalls, modelCalls, toolCalls], [0, 0, 0]);

    const stream = await server.app.inject({
      method: 'GET',
      url: `/v1/tasks/${taskId}/stream?after=1`,
      headers,
    });
    assert.equal(stream.statusCode, 200, stream.body);
    assert.match(stream.body, /event: failed/);
    assert.match(stream.body, /Query read timeout/);
    assert.equal((stream.body.match(/event: failed/g) ?? []).length, 1);
  } finally {
    store.failedEventFault = undefined;
    await reopened?.close();
    await server.close();
  }
});
