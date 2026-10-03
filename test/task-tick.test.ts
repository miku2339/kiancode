import assert from 'node:assert/strict';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { DomainError, type Principal } from '../src/contracts.js';
import type { Conversation, Task } from '../src/domain.js';
import { SqliteStore } from '../src/storage/sqlite.js';
import type { Entity, Store } from '../src/storage/store.js';
import { TaskService, type TaskTickFailure, type TaskTickRecovery } from '../src/tasks.js';

const principal: Principal = { id: 'alice', level: 1, scopes: ['*'] };
const conversation: Conversation = {
  title: 'Tick',
  scope: 'private',
  modelPolicy: 'cloud',
  strategy: 'single',
  mode: 'ask',
  archived: false,
};

class FaultStore implements Store {
  public readonly failScan = new Map<string, unknown>();
  public scanDelayMs = 0;

  public constructor(private readonly delegate: Store) {}

  public create<T>(kind: string, ownerId: string, data: T, id?: string): Promise<Entity<T>> {
    return this.delegate.create(kind, ownerId, data, id);
  }

  public get<T>(kind: string, id: string, ownerId: string): Promise<Entity<T> | undefined> {
    return this.delegate.get(kind, id, ownerId);
  }

  public async scan<T>(kind: string, ownerId?: string): Promise<Array<Entity<T>>> {
    if (this.failScan.has(kind)) {
      if (this.scanDelayMs) await delay(this.scanDelayMs);
      throw this.failScan.get(kind);
    }
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

async function waitForState(store: Store, taskId: string, state: Task['state'], timeoutMs = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while ((await store.get<Task>('task', taskId, principal.id))?.data.state !== state) {
    if (Date.now() >= deadline) break;
    await delay(5);
  }
  assert.equal((await store.get<Task>('task', taskId, principal.id))?.data.state, state);
}

test('a failing notification reconcile is reported by the tick but does not stop tasks from being claimed', async () => {
  const store = new SqliteStore();
  const failure = new DomainError('idempotency_conflict', 'Notification key belongs to another event.', 409);
  const service = new TaskService(store, async () => ({ text: 'done' }), {
    notifications: {
      publishTask: async () => undefined,
      reconcile: async () => { throw failure; },
    },
  });
  try {
    const thread = await store.create('conversation', principal.id, conversation);
    const task = await service.enqueue(principal, thread.id, 'run despite the notification failure');
    await assert.rejects(service.drain(), (error: unknown) => error === failure);
    await waitForState(store, task.id, 'completed');
  } finally {
    await service.close();
    await store.close();
  }
});

test('each failed tick is counted once and one successful tick reports recovery', async () => {
  const store = new FaultStore(new SqliteStore());
  let now = Date.parse('2026-10-01T12:00:00.000Z');
  const failures: TaskTickFailure[] = [];
  const recoveries: TaskTickRecovery[] = [];
  const service = new TaskService(store, async () => ({ text: 'done' }), {
    now: () => now,
    onTickError: (failure) => failures.push(failure),
    onTickRecovered: (recovery) => recoveries.push(recovery),
  });
  try {
    const failure = new DomainError('storage_unavailable', 'Primary storage is unavailable.', 503);
    store.failScan.set('task', failure);
    await assert.rejects(service.drain(), (error: unknown) => error === failure);
    now += 1_000;
    await assert.rejects(service.drain(), (error: unknown) => error === failure);
    assert.deepEqual(service.tickStatus(), {
      consecutiveFailures: 2,
      lastErrorAt: '2026-10-01T12:00:01.000Z',
    });
    assert.deepEqual(failures, [
      { phase: 'reconciliations', code: 'domain_error', message: 'Task tick failed.', consecutiveFailures: 1 },
      { phase: 'reconciliations', code: 'domain_error', message: 'Task tick failed.', consecutiveFailures: 2 },
    ]);

    store.failScan.clear();
    await service.drain();
    assert.deepEqual(service.tickStatus(), {
      consecutiveFailures: 0,
      lastErrorAt: '2026-10-01T12:00:01.000Z',
    });
    assert.deepEqual(recoveries, [{ failedTicks: 2 }]);
    await service.drain();
    assert.deepEqual(recoveries, [{ failedTicks: 2 }]);
  } finally {
    await service.close();
    await store.close();
  }
});

test('reconciliation and agent reconcile failures do not block task claims and count as one failed tick', async () => {
  const store = new SqliteStore();
  const tickFailures: TaskTickFailure[] = [];
  const service = new TaskService(store, async () => ({ text: 'done' }), {
    notifications: {
      publishTask: async () => undefined,
      reconcile: async () => { throw new Error('notification failed'); },
    },
    onTickError: (failure) => tickFailures.push(failure),
  });
  service.setReconciler(async () => { throw new Error('agent reconcile failed'); });
  try {
    const thread = await store.create('conversation', principal.id, conversation);
    const task = await service.enqueue(principal, thread.id, 'run despite phase failures');
    await assert.rejects(service.drain(), /notification failed/);
    await waitForState(store, task.id, 'completed');
    assert.equal(service.tickStatus().consecutiveFailures, 1);
    assert.deepEqual(tickFailures.map((failure) => failure.phase), ['notifications']);
  } finally {
    await service.close();
    await store.close();
  }
});

test('pending receipts finish before the agent reconciler runs', async () => {
  const store = new SqliteStore();
  const service = new TaskService(store, async () => ({ text: 'unused' }));
  try {
    const thread = await store.create('conversation', principal.id, conversation);
    const queued = await service.enqueue(principal, thread.id, 'reconcile first');
    const acceptedAt = new Date().toISOString();
    await store.put<Task>('task', queued.id, principal.id, {
      ...queued.data,
      state: 'unknown',
      reconciliation: {
        phase: 'pending',
        resolution: 'abandon',
        receiptId: `${queued.id}:reconciled:abandon`,
        actor: { id: principal.id, level: principal.level },
        acceptedAt,
        targetState: 'cancelled',
        resumePrincipal: principal,
        grantExpiresAt: queued.data.grantExpiresAt,
      },
    }, queued.revision);
    let observedState: Task['state'] | undefined;
    service.setReconciler(async () => {
      observedState = (await store.get<Task>('task', queued.id, principal.id))?.data.state;
    });
    await service.drain();
    assert.equal(observedState, 'cancelled');
  } finally {
    await service.close();
    await store.close();
  }
});

test('a failed pending reconciliation still runs agent reconcile and claims queued work', async () => {
  const store = new SqliteStore();
  const failures: TaskTickFailure[] = [];
  const service = new TaskService(store, async () => ({ text: 'done' }), {
    onTickError: (failure) => failures.push(failure),
  });
  let reconcilerRuns = 0;
  service.setReconciler(async () => { reconcilerRuns += 1; });
  try {
    const thread = await store.create('conversation', principal.id, conversation);
    const invalid = await service.enqueue(principal, thread.id, 'invalid pending receipt');
    const acceptedAt = new Date().toISOString();
    await store.put<Task>('task', invalid.id, principal.id, {
      ...invalid.data,
      state: 'unknown',
      reconciliation: {
        phase: 'pending',
        resolution: 'not_applied',
        receiptId: `${invalid.id}:invalid`,
        actor: { id: principal.id, level: principal.level },
        acceptedAt,
        targetState: 'queued',
        resumePrincipal: principal,
        grantExpiresAt: invalid.data.grantExpiresAt,
      },
    }, invalid.revision);
    const runnable = await service.enqueue(principal, thread.id, 'still run');

    await assert.rejects(service.drain(), { code: 'reconciliation_integrity' });
    await waitForState(store, runnable.id, 'completed');
    assert.equal(reconcilerRuns, 1);
    assert.deepEqual(failures.map((failure) => failure.phase), ['reconciliations']);
  } finally {
    await service.close();
    await store.close();
  }
});

test('callers sharing one in-flight failed tick do not double count it', async () => {
  const store = new FaultStore(new SqliteStore());
  const failures: TaskTickFailure[] = [];
  const service = new TaskService(store, async () => ({ text: 'unused' }), {
    onTickError: (failure) => failures.push(failure),
  });
  try {
    store.scanDelayMs = 30;
    store.failScan.set('task', new Error('slow failure'));
    const results = await Promise.allSettled([service.drain(), service.drain()]);
    assert.deepEqual(results.map((result) => result.status), ['rejected', 'rejected']);
    assert.equal(service.tickStatus().consecutiveFailures, 1);
    assert.equal(failures.length, 1);
  } finally {
    await service.close();
    await store.close();
  }
});

test('tick failure reports do not expose code or message from arbitrary thrown values', async () => {
  const store = new FaultStore(new SqliteStore());
  const failures: TaskTickFailure[] = [];
  const service = new TaskService(store, async () => ({ text: 'unused' }), {
    onTickError: (failure) => failures.push(failure),
  });
  try {
    store.failScan.set('task', Object.assign(new Error(`first line\n${'x'.repeat(10_000)}`), {
      code: 'c'.repeat(300),
    }));
    await assert.rejects(service.drain());
    assert.equal(failures[0]?.code, 'internal_error');
    assert.equal(failures[0]?.message, 'Task tick failed.');
  } finally {
    await service.close();
    await store.close();
  }
});
