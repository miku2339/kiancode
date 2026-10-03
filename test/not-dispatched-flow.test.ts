import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { DomainError, notDispatched, type Principal, type ToolDefinition } from '../src/contracts.js';
import type { Conversation, Task, TaskEvent } from '../src/domain.js';
import { createTaskRunner } from '../src/runtime-adapter.js';
import { AgentRuntime, type ChatRequest, type ModelProvider } from '../src/runtime/index.js';
import { SqliteStore } from '../src/storage/sqlite.js';
import type { Entity, Store } from '../src/storage/store.js';
import { TaskService } from '../src/tasks.js';

const principal: Principal = {
  id: 'owner',
  level: 3,
  scopes: ['*'],
  expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
};

const conversation: Conversation = {
  title: 'Runtime',
  scope: 'private',
  modelPolicy: 'local',
  strategy: 'single',
  mode: 'act',
  archived: false,
};

class FailingDispatchEventStore implements Store {
  public failNextDispatch = false;

  public constructor(private readonly delegate: Store) {}

  public create<T>(kind: string, ownerId: string, data: T, id?: string): Promise<Entity<T>> {
    if (kind === 'event' && this.failNextDispatch && (data as TaskEvent).type === 'tool_dispatched') {
      this.failNextDispatch = false;
      throw new Error('dispatch event persistence failed');
    }
    return this.delegate.create(kind, ownerId, data, id);
  }

  public get<T>(kind: string, id: string, ownerId: string): Promise<Entity<T> | undefined> {
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

test('a not-dispatched retry keeps a fresh approval and completes once after rebuilding the runtime', async () => {
  const store = new SqliteStore();
  let modelCalls = 0;
  const provider: ModelProvider = {
    id: 'retry-provider',
    locality: 'local',
    async chat(_request: ChatRequest) {
      modelCalls += 1;
      return modelCalls <= 2
        ? {
            message: {
              role: 'assistant',
              content: '',
              toolCalls: [{ id: 'call-1', name: 'publish', arguments: { target: 'site' } }],
            },
            usage: { inputTokens: 1, outputTokens: 1 },
          }
        : { message: { role: 'assistant', content: 'complete' }, usage: { inputTokens: 1, outputTokens: 1 } };
    },
  };
  let executions = 0;
  const tool: ToolDefinition = {
    name: 'publish',
    description: 'Publish',
    inputSchema: { type: 'object' },
    requiredCapabilities: [],
    sideEffect: 'external',
    async execute() {
      executions += 1;
      if (executions === 1) throw notDispatched('offline', 'No request left this process', 503);
      return { content: 'published' };
    },
  };
  const buildRuntime = () => new AgentRuntime({
    providers: [provider],
    models: [{ id: 'local-model', providerId: provider.id, locality: 'local', capabilities: ['tools'] }],
    tools: [tool],
  });
  let tasks = new TaskService(store, createTaskRunner(store, buildRuntime(), [tool]), {
    reauthorize: async (current) => current,
  });
  try {
    const thread = await store.create<Conversation>('conversation', principal.id, conversation);
    const queued = await tasks.enqueue(principal, thread.id, 'publish');
    await tasks.drain();
    let task = (await store.get<Task>('task', queued.id, principal.id))!;
    const first = task.data.pendingActions[0]!;
    assert.equal(task.data.state, 'waiting_for_approval');
    assert.ok(first.toolOccurrenceId);

    await tasks.control(principal.id, queued.id, 'resume', [first.hash], principal);
    await tasks.drain();
    task = (await store.get<Task>('task', queued.id, principal.id))!;
    const retry = task.data.pendingActions[0]!;
    assert.equal(task.data.state, 'waiting_for_approval', task.data.error);
    assert.equal(executions, 1);
    assert.ok(retry.toolOccurrenceId);
    assert.notEqual(retry.hash, first.hash);
    assert.notEqual(retry.toolOccurrenceId, first.toolOccurrenceId);

    await tasks.close();
    tasks = new TaskService(store, createTaskRunner(store, buildRuntime(), [tool]), {
      reauthorize: async (current) => current,
    });
    await tasks.control(principal.id, queued.id, 'resume', [retry.hash], principal);
    await tasks.drain();

    task = (await store.get<Task>('task', queued.id, principal.id))!;
    assert.equal(task.data.state, 'completed', task.data.error);
    assert.equal(task.data.result, 'complete');
    assert.equal(executions, 2);
  } finally {
    await tasks.close();
    await store.close();
  }
});

test('cancelling a task that only waited for a device ends cancelled', async () => {
  const store = new SqliteStore();
  const provider: ModelProvider = {
    id: 'offline-provider',
    locality: 'local',
    async chat() {
      return {
        message: {
          role: 'assistant',
          content: '',
          toolCalls: [{ id: 'call-1', name: 'remote.run', arguments: {} }],
        },
        usage: { inputTokens: 1, outputTokens: 1 },
      };
    },
  };
  const tool: ToolDefinition = {
    name: 'remote.run',
    description: 'Run remotely',
    inputSchema: { type: 'object' },
    requiredCapabilities: [],
    sideEffect: 'external',
    async execute() {
      throw new DomainError('waiting_for_device', 'Waiting for the authorized device to reconnect');
    },
  };
  const runtime = new AgentRuntime({
    providers: [provider],
    models: [{ id: 'local-model', providerId: provider.id, locality: 'local', capabilities: ['tools'] }],
    tools: [tool],
  });
  const tasks = new TaskService(store, createTaskRunner(store, runtime, [tool]), {
    reauthorize: async (current) => current,
  });
  try {
    const thread = await store.create<Conversation>('conversation', principal.id, conversation);
    const queued = await tasks.enqueue(principal, thread.id, 'run remotely');
    await tasks.drain();
    let task = (await store.get<Task>('task', queued.id, principal.id))!;
    await tasks.control(principal.id, queued.id, 'resume', [task.data.pendingActions[0]!.hash], principal);
    await tasks.drain();
    task = (await store.get<Task>('task', queued.id, principal.id))!;
    assert.equal(task.data.state, 'waiting_for_device', task.data.error);

    const result = (await tasks.events(principal.id, queued.id))
      .findLast((event) => event.data.type === 'tool_result')?.data.payload as {
        outcome?: string;
        notDispatched?: boolean;
        toolOccurrenceId?: string;
      };
    assert.deepEqual([result.outcome, result.notDispatched, Boolean(result.toolOccurrenceId)], ['failed', true, true]);

    const cancelled = await tasks.control(principal.id, queued.id, 'cancel');
    assert.equal(cancelled.data.state, 'cancelled');
  } finally {
    await tasks.close();
    await store.close();
  }
});

test('a dispatch checkpoint is durable before the effect and keeps its occurrence across a rebuilt runtime', async () => {
  const store = new FailingDispatchEventStore(new SqliteStore());
  const firstProvider: ModelProvider = {
    id: 'checkpoint-provider',
    locality: 'local',
    async chat() {
      return {
        message: {
          role: 'assistant',
          content: '',
          toolCalls: [{ id: 'call-1', name: 'publish', arguments: {} }],
        },
        usage: { inputTokens: 1, outputTokens: 1 },
      };
    },
  };
  let executions = 0;
  const tool: ToolDefinition = {
    name: 'publish',
    description: 'Publish',
    inputSchema: { type: 'object' },
    requiredCapabilities: [],
    sideEffect: 'external',
    async execute() {
      executions += 1;
      return { content: 'published' };
    },
  };
  const firstRuntime = new AgentRuntime({
    providers: [firstProvider],
    models: [{ id: 'local-model', providerId: firstProvider.id, locality: 'local', capabilities: ['tools'] }],
    tools: [tool],
  });
  const tasks = new TaskService(store, createTaskRunner(store, firstRuntime, [tool]), {
    reauthorize: async (current) => current,
  });
  try {
    const thread = await store.create<Conversation>('conversation', principal.id, conversation);
    const queued = await tasks.enqueue(principal, thread.id, 'publish');
    await tasks.drain();
    const waiting = (await store.get<Task>('task', queued.id, principal.id))!;
    const action = waiting.data.pendingActions[0]!;
    store.failNextDispatch = true;
    await tasks.control(principal.id, queued.id, 'resume', [action.hash], principal);
    await tasks.drain();

    const stopped = (await store.get<Task>('task', queued.id, principal.id))!;
    const checkpoint = stopped.data.runtimeMessages as Array<{
      role?: string;
      toolCalls?: Array<{ occurrenceId?: string }>;
    }>;
    const checkpointOccurrence = checkpoint.findLast((message) => message.role === 'assistant')
      ?.toolCalls?.[0]?.occurrenceId;
    assert.equal(executions, 0);
    assert.equal(checkpointOccurrence, action.toolOccurrenceId);

    const rebuiltProvider: ModelProvider = {
      id: 'rebuilt-provider',
      locality: 'local',
      async chat() {
        return { message: { role: 'assistant', content: 'complete' }, usage: { inputTokens: 1, outputTokens: 1 } };
      },
    };
    const rebuilt = new AgentRuntime({
      providers: [rebuiltProvider],
      models: [{ id: 'local-model', providerId: rebuiltProvider.id, locality: 'local', capabilities: ['tools'] }],
      tools: [tool],
    });
    const dispatches: Array<{ actionHash: string; toolOccurrenceId?: string }> = [];
    const completed = await rebuilt.run({
      principal,
      taskId: queued.id,
      messages: checkpoint as never[],
      mode: 'act',
      approvedActionHashes: new Set([action.hash]),
      onEvent(event) {
        if (event.type === 'tool_dispatched') dispatches.push(event);
      },
    });
    assert.equal(completed.status, 'completed');
    assert.equal(executions, 1);
    assert.deepEqual(dispatches.map((event) => [event.actionHash, event.toolOccurrenceId]), [
      [action.hash, action.toolOccurrenceId],
    ]);
  } finally {
    await tasks.close();
    await store.close();
  }
});

test('an approved write that throws after its effect ends unknown and is never replayed', async () => {
  const store = new SqliteStore();
  let modelCalls = 0;
  const provider: ModelProvider = {
    id: 'unknown-write-provider',
    locality: 'local',
    async chat() {
      modelCalls += 1;
      return modelCalls === 1
        ? {
            message: {
              role: 'assistant',
              content: '',
              toolCalls: [{ id: 'call-1', name: 'write', arguments: {} }],
            },
            usage: { inputTokens: 1, outputTokens: 1 },
          }
        : { message: { role: 'assistant', content: 'must not continue' }, usage: { inputTokens: 1, outputTokens: 1 } };
    },
  };
  let effects = 0;
  const tool: ToolDefinition = {
    name: 'write',
    description: 'Write',
    inputSchema: { type: 'object' },
    requiredCapabilities: [],
    sideEffect: 'write',
    async execute() {
      effects += 1;
      throw new DomainError('invalid_input', 'Reply was lost after the write');
    },
  };
  const buildRunner = () => createTaskRunner(store, new AgentRuntime({
    providers: [provider],
    models: [{ id: 'local-model', providerId: provider.id, locality: 'local', capabilities: ['tools'] }],
    tools: [tool],
  }), [tool]);
  let tasks = new TaskService(store, buildRunner(), { reauthorize: async (current) => current });
  try {
    const thread = await store.create<Conversation>('conversation', principal.id, conversation);
    const queued = await tasks.enqueue(principal, thread.id, 'write');
    await tasks.drain();
    const waiting = (await store.get<Task>('task', queued.id, principal.id))!;
    await tasks.control(principal.id, queued.id, 'resume', [waiting.data.pendingActions[0]!.hash], principal);
    await tasks.drain();

    const unknown = (await store.get<Task>('task', queued.id, principal.id))!;
    assert.equal(unknown.data.state, 'unknown', unknown.data.error);
    assert.equal(effects, 1);
    assert.equal(modelCalls, 1);
    const result = (await tasks.events(principal.id, queued.id))
      .findLast((event) => event.data.type === 'tool_result')?.data.payload as {
        outcome?: string;
        toolOccurrenceId?: string;
      };
    assert.deepEqual([result.outcome, Boolean(result.toolOccurrenceId)], ['unknown', true]);

    await tasks.close();
    tasks = new TaskService(store, buildRunner(), { reauthorize: async (current) => current });
    await tasks.drain();
    assert.equal((await store.get<Task>('task', queued.id, principal.id))?.data.state, 'unknown');
    assert.equal(effects, 1);
    assert.equal(modelCalls, 1);
  } finally {
    await tasks.close();
    await store.close();
  }
});

test('an expired checkpoint-only call runs once while a recorded dispatch without receipt is never replayed', async () => {
  const store = new SqliteStore();
  const now = Date.now();
  let modelCalls = 0;
  const provider: ModelProvider = {
    id: 'recovery-provider',
    locality: 'local',
    async chat() {
      modelCalls += 1;
      return { message: { role: 'assistant', content: 'complete' }, usage: { inputTokens: 1, outputTokens: 1 } };
    },
  };
  let effects = 0;
  const tool: ToolDefinition = {
    name: 'write',
    description: 'Write',
    inputSchema: { type: 'object' },
    requiredCapabilities: [],
    sideEffect: 'write',
    async execute() {
      effects += 1;
      return { content: 'written' };
    },
  };
  const runtime = new AgentRuntime({
    providers: [provider],
    models: [{ id: 'local-model', providerId: provider.id, locality: 'local', capabilities: ['tools'] }],
    tools: [tool],
  });
  const tasks = new TaskService(store, createTaskRunner(store, runtime, [tool]), {
    now: () => now,
    reauthorize: async (current) => current,
  });
  try {
    const thread = await store.create<Conversation>('conversation', principal.id, conversation);
    const safe = await tasks.enqueue(principal, thread.id, 'safe');
    const unsafe = await tasks.enqueue(principal, thread.id, 'unsafe');
    for (const task of [safe, unsafe]) {
      const occurrenceId = `occurrence:${task.id}`;
      const hash = createHash('sha256')
        .update(`${principal.id}\0${task.id}\0${occurrenceId}\0write\0{}`)
        .digest('hex');
      await store.put<Task>('task', task.id, task.ownerId, {
        ...task.data,
        state: 'running',
        workerId: 'expired-worker',
        leaseExpiresAt: new Date(now - 1_000).toISOString(),
        approvedActionHashes: [hash],
        runtimeMessages: [
          { role: 'user', content: task.data.prompt },
          {
            role: 'assistant',
            content: '',
            toolCalls: [{ id: 'call-1', occurrenceId, name: 'write', arguments: {} }],
          },
        ],
      }, task.revision);
      if (task.id === unsafe.id) {
        await store.create<TaskEvent>('event', principal.id, {
          taskId: task.id,
          sequence: 2,
          type: 'tool_dispatched',
          payload: {
            type: 'tool_dispatched',
            actionHash: hash,
            toolOccurrenceId: occurrenceId,
            sideEffect: 'write',
          },
          at: new Date(now - 500).toISOString(),
        });
      }
    }

    await tasks.drain();

    assert.equal((await store.get<Task>('task', safe.id, principal.id))?.data.state, 'completed');
    assert.equal((await store.get<Task>('task', unsafe.id, principal.id))?.data.state, 'unknown');
    assert.equal(effects, 1);
    assert.equal(modelCalls, 1);
  } finally {
    await tasks.close();
    await store.close();
  }
});
