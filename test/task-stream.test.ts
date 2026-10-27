import assert from 'node:assert/strict';
import test from 'node:test';
import { developmentAuth } from '../src/auth.js';
import { DomainError, type Principal } from '../src/contracts.js';
import type { Conversation, Task, TaskEvent, TaskState } from '../src/domain.js';
import { createServer } from '../src/http/server.js';
import { SqliteStore } from '../src/storage/sqlite.js';
import type { Entity, Store } from '../src/storage/store.js';
import { TaskService } from '../src/tasks.js';

const token = 'task-stream-development-token-thirty-two-chars';
const headers = { authorization: `Bearer ${token}` };
const owner: Principal = { id: 'local-owner', level: 1, scopes: ['*'] };
const conversation: Conversation = { title: 'Stream', scope: 'private', modelPolicy: 'cloud', strategy: 'single', mode: 'act', archived: false };

// Fails the first transition event a writer publishes, as if its instance stopped after the state write.
class LostTransitionEventStore implements Store {
  private lost = false;

  public constructor(private readonly delegate: Store) {}

  public async create<T>(kind: string, ownerId: string, data: T, id?: string): Promise<Entity<T>> {
    if (kind === 'event' && id?.includes(':transition:') && !this.lost) {
      this.lost = true;
      throw new Error('instance stopped before publishing the transition');
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

class TaskReadBarrierStore extends SqliteStore {
  public afterTaskRead?: (task: Entity<Task>) => Promise<void>;

  public override async get<T>(kind: string, id: string, ownerId: string): Promise<Entity<T> | undefined> {
    const row = await super.get<T>(kind, id, ownerId);
    if (kind === 'task' && row) await this.afterTaskRead?.(row as Entity<Task>);
    return row;
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
    const terminalEvents = (await store.scan<TaskEvent>('event', owner.id))
      .filter((event) => event.data.taskId === task.id && event.data.type === 'completed');
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

test('a task stream follows a task resumed after its stopped snapshot was read', { timeout: 15_000 }, async () => {
  const store = new TaskReadBarrierStore();
  const server = await createServer({
    store,
    authenticate: developmentAuth(token),
    runner: async () => {
      await new Promise<void>((resolve) => setTimeout(resolve, 50));
      return { text: 'completed after concurrent resume' };
    },
  });
  const other = new TaskService(store, async () => ({ text: 'unused' }));
  let draining: Promise<void> | undefined;
  try {
    const thread = await store.create('conversation', owner.id, conversation);
    const task = await server.tasks.enqueue(owner, thread.id, 'resume while streaming');
    await server.tasks.control(owner.id, task.id, 'pause');
    let reads = 0;
    store.afterTaskRead = async (snapshot) => {
      // The first read checks access; the next supplies the stream's stopped snapshot.
      if (++reads !== 2) return;
      store.afterTaskRead = undefined;
      assert.equal(snapshot.data.state, 'paused');
      await other.control(owner.id, task.id, 'resume', [], owner);
      draining = server.tasks.drain();
    };

    const stream = await streamWithin(server, task.id, 10_000);

    assert.equal(stream.statusCode, 200, stream.body);
    assert.match(stream.body, /event: resume/);
    assert.equal((stream.body.match(/event: completed/g) ?? []).length, 1, stream.body);
    assert.match(stream.body, /completed after concurrent resume/);
  } finally {
    store.afterTaskRead = undefined;
    await draining;
    await other.close();
    await server.close();
  }
});

test('a task stream ends when metadata changes preserve its stopped transition', { timeout: 15_000 }, async () => {
  const store = new TaskReadBarrierStore();
  const server = await createServer({ store, authenticate: developmentAuth(token), runner: async () => ({ text: 'unused' }) });
  try {
    const thread = await store.create('conversation', owner.id, conversation);
    const task = await server.tasks.enqueue(owner, thread.id, 'pause while streaming');
    await server.tasks.control(owner.id, task.id, 'pause');
    let reads = 0;
    store.afterTaskRead = async (snapshot) => {
      if (++reads !== 2) return;
      store.afterTaskRead = undefined;
      await store.put('task', task.id, owner.id, { ...snapshot.data, prompt: 'updated prompt' }, snapshot.revision);
    };

    const started = Date.now();
    const stream = await streamWithin(server, task.id, 10_000);

    assert.equal(stream.statusCode, 200, stream.body);
    assert.ok(Date.now() - started < 1_000, `the paused stream waited ${Date.now() - started}ms`);
    assert.equal((stream.body.match(/event: pause/g) ?? []).length, 1, stream.body);
  } finally {
    store.afterTaskRead = undefined;
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

for (const [code, state] of [
  ['outcome_unknown', 'unknown'],
  ['grant_expired', 'paused'],
  ['waiting_for_device', 'waiting_for_device'],
] as const) {
  test(`a task stream ends at once when a failed run leaves the task ${state}`, { timeout: 15_000 }, async () => {
    const store = new SqliteStore();
    const server = await createServer({
      store,
      authenticate: developmentAuth(token),
      runner: async () => {
        throw new DomainError(code, `runner stopped with ${code}`, 409);
      },
    });
    try {
      const thread = await store.create('conversation', owner.id, conversation);
      const task = await server.tasks.enqueue(owner, thread.id, `stop as ${state}`);
      await server.tasks.drain();
      assert.equal((await store.get<Task>('task', task.id, owner.id))?.data.state, state);

      const started = Date.now();
      const stream = await streamWithin(server, task.id, 10_000);

      assert.equal(stream.statusCode, 200, stream.body);
      assert.ok(Date.now() - started < 1_000, `the ${state} stream waited ${Date.now() - started}ms`);
      const transitions = streamedEvents(stream.body).filter((event) => event.type === 'transition');
      assert.equal(transitions.length, 1, stream.body);
      assert.equal((transitions[0]!.payload as { state?: TaskState }).state, state);
    } finally {
      await server.close();
    }
  });
}

test('another instance publishes a lost transition event once and ends the stream', { timeout: 15_000 }, async () => {
  const store = new LostTransitionEventStore(new SqliteStore());
  const first = await createServer({ store, authenticate: developmentAuth(token), runner: async () => ({ text: 'unused' }) });
  const second = await createServer({ store, authenticate: developmentAuth(token), runner: async () => ({ text: 'unused' }) });
  try {
    const thread = await store.create('conversation', owner.id, conversation);
    const task = await first.tasks.enqueue(owner, thread.id, 'cancel while the first instance stops');
    await assert.rejects(first.tasks.control(owner.id, task.id, 'cancel'), /instance stopped/);
    assert.equal((await store.get<Task>('task', task.id, owner.id))?.data.state, 'cancelled');

    const started = Date.now();
    const [stream] = await Promise.all([
      streamWithin(second, task.id, 10_000),
      first.tasks.events(owner.id, task.id),
      second.tasks.events(owner.id, task.id),
    ]);
    await first.tasks.events(owner.id, task.id);

    assert.equal(stream.statusCode, 200, stream.body);
    assert.ok(Date.now() - started < 1_000, `the cancelled stream waited ${Date.now() - started}ms`);
    assert.equal((stream.body.match(/event: cancel/g) ?? []).length, 1, stream.body);
    const cancellations = (await store.scan<TaskEvent>('event', owner.id))
      .filter((event) => event.data.taskId === task.id && event.data.type === 'cancel');
    assert.equal(cancellations.length, 1);
    assert.deepEqual(cancellations[0]!.data.payload, { type: 'cancel', state: 'cancelled' });
  } finally {
    await first.close();
    await second.close();
  }
});

test('a task stream reconnects after its last received event without replaying it', { timeout: 15_000 }, async () => {
  const store = new SqliteStore();
  let releaseRunner!: () => void;
  const runnerMayFinish = new Promise<void>((resolve) => { releaseRunner = resolve; });
  let markRunnerStarted!: () => void;
  const runnerStarted = new Promise<void>((resolve) => { markRunnerStarted = resolve; });
  const server = await createServer({
    store,
    authenticate: developmentAuth(token),
    runner: async () => {
      markRunnerStarted();
      await runnerMayFinish;
      return { text: 'completed after reconnecting' };
    },
  });
  const disconnected = new AbortController();
  let draining: Promise<void> | undefined;
  try {
    const thread = await store.create('conversation', owner.id, conversation);
    const task = await server.tasks.enqueue(owner, thread.id, 'reconnect while running');
    draining = server.tasks.drain();
    await runnerStarted;
    const address = await server.app.listen({ host: '127.0.0.1', port: 0 });
    const url = `${address}/v1/tasks/${task.id}/stream`;
    const initial = await fetch(url, { headers, signal: disconnected.signal });
    assert.equal(initial.status, 200);
    const reader = initial.body!.getReader();
    const first = await reader.read();
    const received = streamedSequences(new TextDecoder().decode(first.value));
    assert.equal(received.length, 1);
    const lastReceived = received[0]!;
    disconnected.abort();
    await reader.cancel().catch(() => undefined);
    releaseRunner();
    await draining;

    const reconnected = await fetch(url, { headers: { ...headers, 'last-event-id': String(lastReceived) }, signal: AbortSignal.timeout(2_000) });
    const body = await reconnected.text();

    assert.equal(reconnected.status, 200, body);
    assert.ok(streamedSequences(body).every((sequence) => sequence > lastReceived), body);
    assert.equal((body.match(/event: completed/g) ?? []).length, 1, body);
    const lastCompleted = streamedSequences(body).at(-1)!;
    const terminal = await fetch(url, { headers: { ...headers, 'last-event-id': String(lastCompleted) }, signal: AbortSignal.timeout(2_000) });
    assert.equal(terminal.status, 200);
    assert.equal(await terminal.text(), '');
  } finally {
    disconnected.abort();
    releaseRunner();
    await draining;
    await server.close();
  }
});

test('a task stream selects and validates its resume cursor', { timeout: 15_000 }, async (t) => {
  const store = new SqliteStore();
  const server = await createServer({ store, authenticate: developmentAuth(token), runner: async () => ({ text: 'cursor result' }) });
  try {
    const thread = await store.create('conversation', owner.id, conversation);
    const task = await server.tasks.enqueue(owner, thread.id, 'read selected events');
    await server.tasks.drain();
    const cases: Array<{ name: string; after?: string; lastEventId?: string; status?: number; sequences?: number[] }> = [
      { name: 'no cursor replays the history', sequences: [1, 2] },
      { name: 'query cursor remains supported without a header', after: '1', sequences: [2] },
      { name: 'a later header wins over an earlier query', after: '0', lastEventId: '1', sequences: [2] },
      { name: 'a zero header wins over a later query', after: '2', lastEventId: '0', sequences: [1, 2] },
      { name: 'a valid header wins over an invalid query', after: 'invalid', lastEventId: '1', sequences: [2] },
      { name: 'a zero header wins over an invalid query', after: '-1', lastEventId: '0', sequences: [1, 2] },
      { name: 'an acknowledged terminal event ends with no replay', after: '0', lastEventId: '2', sequences: [] },
      { name: 'the maximum safe header cursor is accepted', after: '0', lastEventId: String(Number.MAX_SAFE_INTEGER), sequences: [] },
      { name: 'an empty header uses the query cursor', after: '1', lastEventId: '', sequences: [2] },
      { name: 'an empty header without a query replays the history', lastEventId: '', sequences: [1, 2] },
      { name: 'an empty header preserves query validation', after: 'invalid', lastEventId: '', status: 400 },
      { name: 'a negative header is rejected', lastEventId: '-1', status: 400 },
      { name: 'a nonnumeric header is rejected', lastEventId: 'invalid', status: 400 },
      { name: 'a fractional header is rejected', lastEventId: '1.5', status: 400 },
      { name: 'an unsafe header integer is rejected', lastEventId: '9007199254740992', status: 400 },
    ];
    for (const entry of cases) {
      await t.test(entry.name, async () => {
        const query = entry.after === undefined ? '' : `?after=${encodeURIComponent(entry.after)}`;
        const requestHeaders = entry.lastEventId === undefined ? headers : { ...headers, 'last-event-id': entry.lastEventId };
        const stream = await server.app.inject({ method: 'GET', url: `/v1/tasks/${task.id}/stream${query}`, headers: requestHeaders });
        assert.equal(stream.statusCode, entry.status ?? 200, stream.body);
        if (entry.sequences) assert.deepEqual(streamedSequences(stream.body), entry.sequences, stream.body);
      });
    }
  } finally {
    await server.close();
  }
});

function streamedSequences(body: string): number[] {
  return [...body.matchAll(/^id: (\d+)$/gm)].map((match) => Number(match[1]));
}

function streamedEvents(body: string): TaskEvent[] {
  return [...body.matchAll(/^data: (.+)$/gm)].map((match) => JSON.parse(match[1]!) as TaskEvent);
}

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
