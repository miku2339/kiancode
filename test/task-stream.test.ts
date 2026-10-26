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

test('a task stream delivers the completion event persisted after the completed state', async () => {
  const store = new DelayedCompletionEventStore(new SqliteStore(), 500);
  const server = await createServer({
    store,
    authenticate: developmentAuth(token),
    runner: async () => ({ text: 'streamed result' }),
  });
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

    const stream = await server.app.inject({ method: 'GET', url: `/v1/tasks/${task.id}/stream`, headers });
    await draining;

    assert.equal(stream.statusCode, 200, stream.body);
    assert.equal((stream.body.match(/event: completed/g) ?? []).length, 1, stream.body);
    assert.match(stream.body, /streamed result/);
  } finally {
    await server.close();
  }
});
