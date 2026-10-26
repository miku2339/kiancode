import assert from 'node:assert/strict';
import test from 'node:test';
import { developmentAuth } from '../src/auth.js';
import type { Principal } from '../src/contracts.js';
import type { Conversation, Task, TaskEvent } from '../src/domain.js';
import { createServer } from '../src/http/server.js';
import { SqliteStore } from '../src/storage/sqlite.js';
import type { Entity, Store } from '../src/storage/store.js';

const token = 'task-stream-development-token-thirty-two-chars';
const headers = { authorization: `Bearer ${token}` };
const owner: Principal = { id: 'local-owner', level: 1, scopes: ['*'] };
const conversation: Conversation = { title: 'Stream', scope: 'private', modelPolicy: 'cloud', strategy: 'single', mode: 'act', archived: false };

class DelayedCompletionEventStore implements Store {
  public constructor(
    private readonly delegate: Store,
    private readonly delayMs: number,
  ) {}

  public async create<T>(kind: string, ownerId: string, data: T, id?: string): Promise<Entity<T>> {
    if (kind === 'event' && (data as TaskEvent).type === 'completed') {
      await new Promise<void>((resolve) => setTimeout(resolve, this.delayMs));
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

test('a task stream delivers the completion event persisted after the completed state', { timeout: 15_000 }, async () => {
  const store = new DelayedCompletionEventStore(new SqliteStore(), 2_500);
  const server = await createServer({
    store,
    authenticate: developmentAuth(token),
    runner: async () => ({ text: 'streamed result' }),
  });
  let streamTimeout: ReturnType<typeof setTimeout> | undefined;
  try {
    const thread = await store.create('conversation', owner.id, conversation);
    const task = await server.tasks.enqueue(owner, thread.id, 'finish while a client is watching');
    const draining = server.tasks.drain();
    const deadline = Date.now() + 10_000;
    while ((await store.get<Task>('task', task.id, owner.id))?.data.state !== 'completed') {
      if (Date.now() >= deadline) throw new Error('Timed out waiting for the completed state');
      await new Promise<void>((resolve) => setTimeout(resolve, 5));
    }
    const terminalEvents = (await server.tasks.events(owner.id, task.id))
      .filter((event) => event.data.type === 'completed');
    assert.equal(terminalEvents.length, 0, 'the completion event must still be pending when the stream opens');

    const stream = await Promise.race([
      server.app.inject({ method: 'GET', url: `/v1/tasks/${task.id}/stream`, headers }),
      new Promise<never>((_resolve, reject) => {
        streamTimeout = setTimeout(() => reject(new Error('Timed out waiting for the terminal stream event')), 10_000);
      }),
    ]);
    await draining;

    assert.equal(stream.statusCode, 200, stream.body);
    assert.equal((stream.body.match(/event: completed/g) ?? []).length, 1, stream.body);
    assert.match(stream.body, /streamed result/);
  } finally {
    if (streamTimeout) clearTimeout(streamTimeout);
    await server.close();
  }
});

test('a cancelled task stream ends when a later event follows its cancellation', { timeout: 15_000 }, async () => {
  const store = new SqliteStore();
  const server = await createServer({
    store,
    authenticate: developmentAuth(token),
    runner: async () => ({ text: 'unused' }),
  });
  try {
    const thread = await store.create('conversation', owner.id, conversation);
    const task = await server.tasks.enqueue(owner, thread.id, 'cancel before running');
    await server.tasks.control(owner.id, task.id, 'cancel');
    await appendEvent(store, task.id, 3, { type: 'token', content: 'written after cancellation' });

    const stream = await streamWithin(server, task.id, 10_000);

    assert.equal(stream.statusCode, 200, stream.body);
    assert.equal((stream.body.match(/event: cancel/g) ?? []).length, 1, stream.body);
    assert.match(stream.body, /event: token/);
  } finally {
    await server.close();
  }
});

test('an earlier reconciliation does not end a completed stream before its completion event', { timeout: 15_000 }, async () => {
  const store = new DelayedCompletionEventStore(new SqliteStore(), 2_500);
  const server = await createServer({
    store,
    authenticate: developmentAuth(token),
    runner: async () => ({ text: 'completed after reconciliation' }),
  });
  try {
    const thread = await store.create('conversation', owner.id, conversation);
    const task = await server.tasks.enqueue(owner, thread.id, 'resume after reconciliation');
    await appendEvent(store, task.id, 2, { type: 'reconcile', state: 'queued', resolution: 'not_applied' });
    const draining = server.tasks.drain();
    const deadline = Date.now() + 10_000;
    while ((await store.get<Task>('task', task.id, owner.id))?.data.state !== 'completed') {
      if (Date.now() >= deadline) throw new Error('Timed out waiting for the completed state');
      await new Promise<void>((resolve) => setTimeout(resolve, 5));
    }

    const stream = await streamWithin(server, task.id, 10_000);
    await draining;

    assert.equal(stream.statusCode, 200, stream.body);
    assert.equal((stream.body.match(/event: completed/g) ?? []).length, 1, stream.body);
  } finally {
    await server.close();
  }
});

async function appendEvent(
  store: Store,
  taskId: string,
  sequence: number,
  payload: { type: string; [key: string]: unknown },
): Promise<void> {
  await store.create<TaskEvent>('event', owner.id, {
    taskId,
    sequence,
    type: payload.type,
    payload,
    at: new Date().toISOString(),
  }, `${taskId}:${String(sequence).padStart(12, '0')}`);
}

async function streamWithin(
  server: Awaited<ReturnType<typeof createServer>>,
  taskId: string,
  timeoutMs: number,
): Promise<Awaited<ReturnType<Awaited<ReturnType<typeof createServer>>['app']['inject']>>> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      server.app.inject({ method: 'GET', url: `/v1/tasks/${taskId}/stream`, headers }),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error('Timed out waiting for the task stream to end')), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
