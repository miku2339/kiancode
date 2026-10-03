import assert from 'node:assert/strict';
import test from 'node:test';
import type { Notification, Task } from '../src/domain.js';
import { NotificationService } from '../src/notifications.js';
import { SqliteStore } from '../src/storage/sqlite.js';
import type { Entity, Store } from '../src/storage/store.js';

class RecordingStore implements Store {
  public calls: string[] = [];
  public readonly failures = new Map<string, { error: unknown; times: number }>();

  public constructor(private readonly delegate: Store) {}

  private enter(method: string, kind: string): void {
    const call = `${method} ${kind}`;
    this.calls.push(call);
    const failure = this.failures.get(call);
    if (failure && failure.times > 0) {
      failure.times -= 1;
      throw failure.error;
    }
  }

  public async create<T>(kind: string, ownerId: string, data: T, id?: string): Promise<Entity<T>> {
    this.enter('create', kind);
    return this.delegate.create(kind, ownerId, data, id);
  }

  public async get<T>(kind: string, id: string, ownerId: string): Promise<Entity<T> | undefined> {
    this.enter('get', kind);
    return this.delegate.get(kind, id, ownerId);
  }

  public async scan<T>(kind: string, ownerId?: string): Promise<Array<Entity<T>>> {
    this.enter('scan', kind);
    return this.delegate.scan(kind, ownerId);
  }

  public async put<T>(kind: string, id: string, ownerId: string, data: T, revision: number): Promise<Entity<T>> {
    this.enter('put', kind);
    return this.delegate.put(kind, id, ownerId, data, revision);
  }

  public async remove(kind: string, id: string, ownerId: string, revision: number): Promise<boolean> {
    this.enter('remove', kind);
    return this.delegate.remove(kind, id, ownerId, revision);
  }

  public close(): Promise<void> {
    return this.delegate.close();
  }
}

function completedTask(): Task {
  return {
    conversationId: 'conversation-1',
    prompt: 'stored task',
    principal: { id: 'alice', level: 1, scopes: ['*'] },
    state: 'completed',
    grantExpiresAt: '2026-10-01T13:00:00.000Z',
    pendingActions: [],
    approvedActionHashes: [],
  };
}

test('notification reconcile seeds durable keys once and does no per-task lookup afterward', async () => {
  const store = new RecordingStore(new SqliteStore());
  const notifications = new NotificationService(store);
  try {
    for (let index = 0; index < 20; index += 1) {
      await store.create<Task>('task', 'alice', completedTask());
    }
    await notifications.reconcile();
    assert.equal((await store.scan<Notification>('notification', 'alice')).length, 20);

    store.calls = [];
    await notifications.reconcile();
    assert.deepEqual(store.calls, ['scan task', 'scan automation_schedule', 'scan event_trigger']);

    const restarted = new NotificationService(store);
    store.calls = [];
    await restarted.reconcile();
    assert.deepEqual(store.calls, [
      'scan notification',
      'scan task',
      'scan automation_schedule',
      'scan event_trigger',
    ]);
  } finally {
    await store.close();
  }
});

test('a failed notification write is retried and concurrent first scans share one seed', async () => {
  const store = new RecordingStore(new SqliteStore());
  const notifications = new NotificationService(store);
  try {
    await store.create<Task>('task', 'alice', completedTask());
    store.failures.set('create notification', { error: new Error('write failed'), times: 1 });
    await assert.rejects(notifications.reconcile(), /write failed/);
    await notifications.reconcile();
    assert.equal((await store.scan<Notification>('notification', 'alice')).length, 1);

    const restarted = new NotificationService(store);
    store.calls = [];
    await Promise.all([restarted.reconcile(), restarted.reconcile()]);
    assert.equal(store.calls.filter((call) => call === 'scan notification').length, 1);
    assert.equal((await store.scan<Notification>('notification', 'alice')).length, 1);
  } finally {
    await store.close();
  }
});

test('a new authorization failure version is published even when its timestamp is unchanged', async () => {
  const store = new RecordingStore(new SqliteStore());
  const notifications = new NotificationService(store);
  const failedAt = '2026-10-01T08:00:00.000Z';
  try {
    const trigger = await store.create('event_trigger', 'alice', {
      authorizationFailedAt: failedAt,
      authorizationFailedVersion: 1,
      settings: { notification: { type: 'in_app' } },
    }, 'trigger-1');
    await notifications.reconcile();
    await store.put('event_trigger', trigger.id, 'alice', {
      authorizationFailedAt: failedAt,
      authorizationFailedVersion: 2,
      settings: { notification: { type: 'in_app' } },
    }, trigger.revision);
    await notifications.reconcile();
    const rows = await store.scan<Notification>('notification', 'alice');
    assert.equal(rows.length, 2);
    assert.deepEqual(rows.map((row) => row.data.eventTriggerId), ['trigger-1', 'trigger-1']);
  } finally {
    await store.close();
  }
});
