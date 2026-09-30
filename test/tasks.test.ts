import assert from 'node:assert/strict';
import test from 'node:test';
import { SqliteStore } from '../src/storage/sqlite.js';
import { orderMessages, TaskService } from '../src/tasks.js';
import type { Conversation, Message, Task, TaskEvent } from '../src/domain.js';
import { DomainError, type Principal } from '../src/contracts.js';
import { NotificationService } from '../src/notifications.js';
import { AutomationDispatcher } from '../src/event-triggers.js';
import { SchedulerService } from '../src/scheduler.js';
import type { Artifact } from '../src/artifacts.js';
import type { Entity, Store } from '../src/storage/store.js';

const principal: Principal = { id: 'alice', level: 1, scopes: ['*'] };
const conversation: Conversation = { title: 'Project', scope: 'private', modelPolicy: 'cloud', strategy: 'single', mode: 'act', archived: false };

class SlowEventStore implements Store {
  public tokenWrites = 0;
  public failTokenWrites = false;

  public constructor(
    private readonly delegate: Store,
    private readonly eventDelayMs = 0,
  ) {}

  public async create<T>(kind: string, ownerId: string, data: T, id?: string): Promise<Entity<T>> {
    if (kind === 'event') {
      if (this.eventDelayMs) await new Promise<void>((resolve) => setTimeout(resolve, this.eventDelayMs));
      if ((data as TaskEvent).type === 'token') {
        this.tokenWrites += 1;
        if (this.failTokenWrites) throw new Error('event storage failed');
      }
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

test('a durable task runs once for a repeated client request and records its result', async () => {
  const store = new SqliteStore();
  let calls = 0;
  const service = new TaskService(store, async ({ onEvent }) => {
    calls += 1;
    await onEvent({ type: 'model_call' });
    return { text: 'Result verified' };
  });
  try {
    const thread = await store.create('conversation', principal.id, conversation);
    const first = await service.enqueue(principal, thread.id, 'Do the work', 'unique-request');
    const retry = await service.enqueue(principal, thread.id, 'Do the work', 'unique-request');
    assert.equal(first.id, retry.id);
    await service.drain();
    await service.drain();
    assert.equal(calls, 1);
    assert.equal((await store.get<Task>('task', first.id, principal.id))?.data.state, 'completed');
    assert.equal((await store.scan('message', principal.id)).length, 2);
    await assert.rejects(service.enqueue({ ...principal, id: 'bob' }, thread.id, 'steal'), /not found/i);
  } finally { await service.close(); await store.close(); }
});

test('tasks snapshot their conversation workspace without assigning legacy records', async () => {
  const store = new SqliteStore();
  const service = new TaskService(store, async () => ({ text: 'done' }));
  try {
    const thread = await store.create('conversation', principal.id, { ...conversation, workspaceId: 'workspace-1' });
    const task = await service.enqueue(principal, thread.id, 'Scoped work', 'workspace-task');
    assert.equal(task.data.workspaceId, 'workspace-1');

    const legacy = await store.create<Task>('task', principal.id, {
      conversationId: thread.id,
      prompt: 'Legacy work',
      principal,
      state: 'completed',
      grantExpiresAt: new Date().toISOString(),
      pendingActions: [],
      approvedActionHashes: [],
    }, 'legacy-task');
    assert.equal(legacy.data.workspaceId, undefined);
  } finally { await service.close(); await store.close(); }
});

test('message sequences preserve user and assistant chronology when timestamps tie', async () => {
  const store = new SqliteStore();
  const service = new TaskService(store, async ({ task }) => ({ text: `reply:${task.data.prompt}` }));
  try {
    const thread = await store.create('conversation', principal.id, conversation);
    await service.enqueue(principal, thread.id, 'first', 'first');
    await service.enqueue(principal, thread.id, 'second', 'second');
    await service.drain();
    const messages = orderMessages((await store.scan<Message>('message', principal.id))
      .filter((message) => message.data.conversationId === thread.id));
    assert.deepEqual(messages.slice(0, 2).map((message) => message.data.content), ['first', 'second']);
    assert.deepEqual(new Set(messages.slice(2).map((message) => message.data.content)), new Set(['reply:first', 'reply:second']));
    assert.deepEqual(messages.map((message) => message.data.sequence), [1, 2, 3, 4]);

    const tied = messages.map((message) => ({ ...message, createdAt: '2026-01-01T00:00:00.000Z' }));
    assert.deepEqual(orderMessages(tied).map((message) => message.data.sequence), [1, 2, 3, 4]);
  } finally { await service.close(); await store.close(); }
});

test('start keeps ticking while long tasks run and limits concurrency per owner', async () => {
  const store = new SqliteStore();
  let release: (() => void) | undefined;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const active = new Map<string, number>();
  const maximum = new Map<string, number>();
  const service = new TaskService(store, async ({ task }) => {
    const count = (active.get(task.ownerId) ?? 0) + 1;
    active.set(task.ownerId, count);
    maximum.set(task.ownerId, Math.max(maximum.get(task.ownerId) ?? 0, count));
    await gate;
    active.set(task.ownerId, (active.get(task.ownerId) ?? 1) - 1);
    return { text: 'done' };
  });
  try {
    const bob = { ...principal, id: 'bob' };
    const aliceThread = await store.create('conversation', principal.id, conversation);
    const bobThread = await store.create('conversation', bob.id, conversation);
    await Promise.all(Array.from({ length: 4 }, (_, index) =>
      service.enqueue(principal, aliceThread.id, `alice ${index}`)));
    await service.enqueue(bob, bobThread.id, 'bob');

    service.start(2);
    await waitFor(() => (active.get('alice') ?? 0) === 3 && (active.get('bob') ?? 0) === 1);

    assert.equal(maximum.get('alice'), 3);
    assert.equal(maximum.get('bob'), 1);
    release?.();
    await service.drain();
    assert.equal((await store.scan<Task>('task')).every((task) => task.data.state === 'completed'), true);
  } finally { await service.close(); await store.close(); }
});

test('attachments are owner-bound, capped, persisted, and part of idempotency', async () => {
  const store = new SqliteStore();
  const service = new TaskService(store, async () => ({ text: 'done' }));
  try {
    const thread = await store.create('conversation', principal.id, conversation);
    const artifact = await store.create('artifact', principal.id, { path: 'image.png' });
    const task = await service.enqueue(principal, thread.id, 'inspect', 'request', [artifact.id, artifact.id]);
    assert.deepEqual(task.data.attachmentIds, [artifact.id]);
    assert.deepEqual((await store.get<{ attachmentIds?: string[] }>('message', `${task.id}:user`, principal.id))?.data.attachmentIds, [artifact.id]);
    await assert.rejects(
      service.enqueue(principal, thread.id, 'inspect', 'request', []),
      (error: unknown) => error instanceof Error && 'code' in error && error.code === 'idempotency_conflict',
    );
    await assert.rejects(
      service.enqueue(principal, thread.id, 'inspect', undefined, ['missing']),
      (error: unknown) => error instanceof Error && 'code' in error && error.code === 'not_found',
    );
    await assert.rejects(
      service.enqueue(principal, thread.id, 'inspect', undefined, Array.from({ length: 11 }, () => artifact.id)),
      (error: unknown) => error instanceof Error && 'code' in error && error.code === 'too_many_attachments',
    );
  } finally { await service.close(); await store.close(); }
});

test('runtime events receive unique ordered sequences and persist checkpoints', async () => {
  const store = new SqliteStore();
  const checkpoint = [{ role: 'assistant', content: 'checkpoint' }];
  const service = new TaskService(store, async ({ onEvent }) => {
    await Promise.all(Array.from({ length: 8 }, (_, index) => onEvent({ type: 'token', index })));
    await onEvent({ type: 'usage', usage: { calls: 1, totalTokens: 2 } });
    await onEvent({ type: 'tool_result', toolCallId: 'read-1', outcome: 'confirmed', checkpointMessages: checkpoint });
    return { text: '', status: 'waiting_for_approval', pendingActions: [{ hash: 'hash-1', tool: 'write', input: {} }] };
  });
  try {
    const thread = await store.create('conversation', principal.id, conversation);
    const task = await service.enqueue(principal, thread.id, 'work');
    await service.drain();

    const events = await service.events(principal.id, task.id);
    assert.deepEqual(events.map((event) => event.data.sequence), Array.from({ length: events.length }, (_, index) => index + 1));
    const stored = await store.get<Task>('task', task.id, principal.id);
    assert.deepEqual(stored?.data.runtimeMessages, checkpoint);
    assert.deepEqual(stored?.data.usage, { calls: 1, totalTokens: 2 });
    assert.equal(stored?.data.state, 'waiting_for_approval');
    const persistedTool = events.find((event) => event.data.type === 'tool_result')?.data.payload as Record<string, unknown>;
    assert.equal('checkpointMessages' in persistedTool, false);
  } finally { await service.close(); await store.close(); }
});

test('streamed tokens are durably coalesced without changing their content', async () => {
  const store = new SlowEventStore(new SqliteStore(), 80);
  const parts = Array.from({ length: 500 }, (_, index) => `<${index}>`);
  const service = new TaskService(store, async ({ onEvent }) => {
    for (const content of parts.slice(0, 20)) await onEvent({ type: 'token', content });
    await new Promise<void>((resolve) => setTimeout(resolve, 40));
    for (const content of parts.slice(20)) await onEvent({ type: 'token', content });
    return { text: parts.join('') };
  });
  try {
    const thread = await store.create('conversation', principal.id, conversation);
    const task = await service.enqueue(principal, thread.id, 'stream');
    await service.drain();

    const events = await service.events(principal.id, task.id);
    const streamed = events
      .filter((event) => event.data.type === 'token')
      .map((event) => (event.data.payload as { content: string }).content)
      .join('');
    assert.equal(streamed, parts.join(''));
    assert.ok(store.tokenWrites <= 4, `expected coalesced token writes, received ${store.tokenWrites}`);
    assert.equal((await store.get<Task>('task', task.id, principal.id))?.data.state, 'completed');
  } finally { await service.close(); await store.close(); }
});

test('token batches are durable before later tool dispatch events', async () => {
  const store = new SlowEventStore(new SqliteStore(), 2);
  const service = new TaskService(store, async ({ onEvent }) => {
    await onEvent({ type: 'token', content: 'first ' });
    await onEvent({ type: 'token', content: 'answer' });
    await onEvent({
      type: 'tool_dispatched',
      toolCallId: 'read-1',
      actionHash: 'read-1',
      sideEffect: 'read',
    });
    await onEvent({ type: 'token', content: ' after tool' });
    return { text: 'first answer after tool' };
  }, { reauthorize: async (current) => current });
  try {
    const thread = await store.create('conversation', principal.id, conversation);
    const task = await service.enqueue(principal, thread.id, 'ordered stream');
    await service.drain();

    const events = await service.events(principal.id, task.id);
    assert.deepEqual(events.map((event) => event.data.type), [
      'queued',
      'token',
      'tool_dispatched',
      'token',
      'completed',
    ]);
    assert.equal((events[1]?.data.payload as { content?: string }).content, 'first answer');
    assert.equal((events[3]?.data.payload as { content?: string }).content, ' after tool');
  } finally { await service.close(); await store.close(); }
});

test('a failed token persistence cannot be reported as completed', async () => {
  const store = new SlowEventStore(new SqliteStore());
  store.failTokenWrites = true;
  const service = new TaskService(store, async ({ onEvent }) => {
    await onEvent({ type: 'token', content: 'not durable' });
    return { text: 'must not complete' };
  });
  try {
    const thread = await store.create('conversation', principal.id, conversation);
    const task = await service.enqueue(principal, thread.id, 'fail persistence');
    await service.drain();

    const stored = await store.get<Task>('task', task.id, principal.id);
    assert.equal(stored?.data.state, 'failed');
    assert.match(stored?.data.error ?? '', /storage failed/);
    assert.equal((await service.events(principal.id, task.id)).some((event) => event.data.type === 'completed'), false);
  } finally { await service.close(); await store.close(); }
});

test('cancellation discards buffered tokens and blocks later external dispatch', async () => {
  const store = new SlowEventStore(new SqliteStore(), 5);
  let buffered: (() => void) | undefined;
  const tokenBuffered = new Promise<void>((resolve) => { buffered = resolve; });
  let externalDispatchRan = false;
  const service = new TaskService(store, async ({ onEvent, signal }) => {
    await onEvent({ type: 'token', content: 'partial draft' });
    buffered?.();
    await new Promise<void>((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    });
    await onEvent({
      type: 'tool_dispatched',
      toolCallId: 'external-1',
      actionHash: 'external-1',
      sideEffect: 'external',
    });
    externalDispatchRan = true;
    return { text: 'unreachable' };
  }, { reauthorize: async (current) => current });
  try {
    const thread = await store.create('conversation', principal.id, conversation);
    const task = await service.enqueue(principal, thread.id, 'cancel stream');
    service.start(5);
    await tokenBuffered;
    await service.control(principal.id, task.id, 'cancel');
    await service.close();

    const events = await service.events(principal.id, task.id);
    assert.deepEqual(events.map((event) => event.data.type), ['queued', 'cancel']);
    assert.equal(externalDispatchRan, false);
    assert.equal((await store.get<Task>('task', task.id, principal.id))?.data.state, 'cancelled');
  } finally { await service.close(); await store.close(); }
});

test('completed tasks expose only confirmed artifacts produced by that task', async () => {
  const store = new SqliteStore();
  const service = new TaskService(store, async ({ task, onEvent }) => {
    await store.create<Artifact>('artifact', task.ownerId, {
      name: 'result.txt', mimeType: 'text/plain', bytes: 6, sha256: 'a'.repeat(64), storageId: 'blob-1',
      source: 'tool', producerTaskId: task.id,
    }, 'result-artifact');
    await store.create<Artifact>('artifact', task.ownerId, {
      name: 'unproven.txt', mimeType: 'text/plain', bytes: 8, sha256: 'e'.repeat(64), storageId: 'blob-unproven',
      source: 'tool', producerTaskId: task.id,
    }, 'unproven-artifact');
    await onEvent({
      type: 'tool_result', toolCallId: 'write-1', outcome: 'confirmed', isError: false,
      result: { content: 'saved', artifactIds: ['result-artifact', 'result-artifact'] },
    });
    await onEvent({
      type: 'tool_result', toolCallId: 'failed-1', outcome: 'failed', isError: true,
      result: { content: 'failed', artifactIds: ['ignored-artifact'] },
    });
    await onEvent({
      type: 'tool_result', toolCallId: 'unproven-1', outcome: 'confirmed',
      result: { content: 'missing error proof', artifactIds: ['unproven-artifact'] },
    });
    return { text: 'done' };
  });
  try {
    const thread = await store.create('conversation', principal.id, conversation);
    const task = await service.enqueue(principal, thread.id, 'create result');
    await service.drain();

    const stored = await store.get<Task>('task', task.id, principal.id);
    assert.equal(stored?.data.state, 'completed');
    assert.deepEqual(stored?.data.resultArtifactIds, ['result-artifact']);
  } finally { await service.close(); await store.close(); }
});

test('tasks reject artifacts from another owner or child task', async () => {
  for (const producer of ['other-owner', 'child-task']) {
    const store = new SqliteStore();
    const service = new TaskService(store, async ({ task, onEvent }) => {
      const ownerId = producer === 'other-owner' ? 'bob' : task.ownerId;
      await store.create<Artifact>('artifact', ownerId, {
        name: 'result.txt', mimeType: 'text/plain', bytes: 6, sha256: 'b'.repeat(64), storageId: 'blob-2',
        source: 'tool', producerTaskId: producer === 'child-task' ? 'child-task' : task.id,
      }, 'foreign-artifact');
      await onEvent({
        type: 'tool_result', toolCallId: 'write-1', outcome: 'confirmed', isError: false,
        result: { content: 'saved', artifactIds: ['foreign-artifact'] },
      });
      return { text: 'done' };
    });
    try {
      const thread = await store.create('conversation', principal.id, conversation);
      const task = await service.enqueue(principal, thread.id, 'create result');
      await service.drain();

      const stored = await store.get<Task>('task', task.id, principal.id);
      assert.equal(stored?.data.state, 'failed');
      assert.equal(stored?.data.resultArtifactIds, undefined);
      assert.match(stored?.data.error ?? '', /does not belong/i);
    } finally { await service.close(); await store.close(); }
  }
});

test('failed tasks do not expose artifacts from confirmed tool results', async () => {
  const store = new SqliteStore();
  const service = new TaskService(store, async ({ task, onEvent }) => {
    await store.create<Artifact>('artifact', task.ownerId, {
      name: 'partial.txt', mimeType: 'text/plain', bytes: 7, sha256: 'c'.repeat(64), storageId: 'blob-3',
      source: 'tool', producerTaskId: task.id,
    }, 'partial-artifact');
    await onEvent({
      type: 'tool_result', toolCallId: 'write-1', outcome: 'confirmed', isError: false,
      result: { content: 'saved', artifactIds: ['partial-artifact'] },
    });
    throw new Error('verification failed');
  });
  try {
    const thread = await store.create('conversation', principal.id, conversation);
    const task = await service.enqueue(principal, thread.id, 'create result');
    await service.drain();

    const stored = await store.get<Task>('task', task.id, principal.id);
    assert.equal(stored?.data.state, 'failed');
    assert.equal(stored?.data.resultArtifactIds, undefined);
  } finally { await service.close(); await store.close(); }
});

test('cancelled tasks do not expose artifacts from earlier confirmed tool results', async () => {
  const store = new SqliteStore();
  let produced: (() => void) | undefined;
  const artifactProduced = new Promise<void>((resolve) => { produced = resolve; });
  const service = new TaskService(store, async ({ task, onEvent, signal }) => {
    await store.create<Artifact>('artifact', task.ownerId, {
      name: 'partial.txt', mimeType: 'text/plain', bytes: 7, sha256: 'd'.repeat(64), storageId: 'blob-4',
      source: 'tool', producerTaskId: task.id,
    }, 'cancelled-artifact');
    await onEvent({ type: 'tool_dispatched', toolCallId: 'write-1', sideEffect: 'write' });
    await onEvent({
      type: 'tool_result', toolCallId: 'write-1', outcome: 'confirmed', isError: false,
      result: { content: 'saved', artifactIds: ['cancelled-artifact'] },
    });
    produced?.();
    await new Promise<void>((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    });
    return { text: 'unreachable' };
  }, { reauthorize: async (current) => current });
  try {
    const thread = await store.create('conversation', principal.id, conversation);
    const task = await service.enqueue(principal, thread.id, 'create result');
    service.start(5);
    await artifactProduced;
    await service.control(principal.id, task.id, 'cancel');

    const stored = await store.get<Task>('task', task.id, principal.id);
    assert.equal(stored?.data.state, 'cancelled');
    assert.equal(stored?.data.resultArtifactIds, undefined);
  } finally { await service.close(); await store.close(); }
});

test('dependencies complete before dependants run and failed dependencies stop them', async () => {
  const store = new SqliteStore();
  const order: string[] = [];
  const service = new TaskService(store, async ({ task }) => {
    order.push(task.data.prompt);
    if (task.data.prompt === 'fail') throw new Error('failed');
    return { text: 'done' };
  });
  try {
    const thread = await store.create('conversation', principal.id, conversation);
    const first = await service.enqueue(principal, thread.id, 'first');
    const second = await service.enqueue(principal, thread.id, 'second', undefined, [], [first.id]);
    const failed = await service.enqueue(principal, thread.id, 'fail');
    const blocked = await service.enqueue(principal, thread.id, 'blocked', undefined, [], [failed.id]);
    await service.drain();

    assert.ok(order.indexOf('first') < order.indexOf('second'));
    assert.equal(order.includes('blocked'), false);
    assert.equal((await store.get<Task>('task', second.id, principal.id))?.data.state, 'completed');
    assert.equal((await store.get<Task>('task', blocked.id, principal.id))?.data.state, 'failed');
  } finally { await service.close(); await store.close(); }
});

test('cancelling after external dispatch records unknown instead of claiming cancellation', async () => {
  const store = new SqliteStore();
  let dispatched: (() => void) | undefined;
  const dispatchSeen = new Promise<void>((resolve) => { dispatched = resolve; });
  const service = new TaskService(store, async ({ onEvent, signal }) => {
    await onEvent({
      type: 'tool_dispatched',
      toolCallId: 'external-1',
      actionHash: 'external-hash',
      sideEffect: 'external',
    });
    dispatched?.();
    await new Promise<void>((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    });
    return { text: 'unreachable' };
  }, { reauthorize: async (current) => current });
  try {
    const thread = await store.create('conversation', principal.id, conversation);
    const task = await service.enqueue(principal, thread.id, 'send');
    service.start(5);
    await dispatchSeen;
    const cancelled = await service.control(principal.id, task.id, 'cancel');
    assert.equal(cancelled.data.state, 'unknown');
    assert.match(cancelled.data.error ?? '', /verify/i);
  } finally { await service.close(); await store.close(); }
});

test('scheduled work revalidates authorization and quiet time silences its notification', async () => {
  const store = new SqliteStore();
  const now = Date.parse('2026-09-27T04:00:00.000Z');
  const notifications = new NotificationService(store, { now: () => new Date(now) });
  await notifications.setPreferences(principal.id, {
    timezone: 'UTC',
    quietHours: { start: '03:00', end: '05:00' },
  });
  const service = new TaskService(store, async () => ({ text: 'done' }), {
    now: () => now,
    notifications,
  });
  try {
    const thread = await store.create('conversation', principal.id, conversation);
    const scheduler = new SchedulerService(store, new AutomationDispatcher(store, service, () => now), {
      enabled: true,
      now: () => now,
      async reauthorize() { throw new DomainError('grant_revoked', 'revoked', 403); },
    });
    const schedule = await scheduler.create(principal, {
      name: 'Scheduled',
      prompt: 'scheduled',
      nextAt: new Date(now - 1_000).toISOString(),
      enabled: true,
      settings: {
        conversationId: thread.id,
        permissions: ['model:read'],
        notification: { type: 'in_app' },
      },
    });
    service.setReconciler(() => scheduler.reconcile());
    await service.drain();
    await service.drain();

    assert.equal((await store.get<{ enabled: boolean }>('automation_schedule', schedule.id, principal.id))?.data.enabled, false);
    assert.equal((await store.scan<Task>('task', principal.id)).length, 0);
    const rows = await store.scan<{ type: string; silent: boolean; pushEligible: boolean }>('notification', principal.id);
    assert.equal(rows[0]?.data.type, 'schedule_authorization_failed');
    assert.equal(rows[0]?.data.silent, true);
    assert.equal(rows[0]?.data.pushEligible, false);
  } finally { await service.close(); await store.close(); }
});

test('approval resumes from the persisted runtime checkpoint', async () => {
  const store = new SqliteStore();
  let calls = 0;
  const checkpoint = [{ role: 'assistant', content: '', toolCalls: [{ id: 'write-1' }] }];
  const service = new TaskService(store, async ({ task }) => {
    calls += 1;
    if (calls === 1) {
      return {
        text: '',
        status: 'waiting_for_approval',
        pendingActions: [{ hash: 'approved-hash', tool: 'workspace.write', input: { path: 'a' } }],
        messages: checkpoint,
      };
    }
    assert.deepEqual(task.data.runtimeMessages, checkpoint);
    assert.deepEqual(task.data.approvedActionHashes, ['approved-hash']);
    return { text: 'completed from checkpoint', messages: [...checkpoint, { role: 'tool', content: 'done' }] };
  });
  try {
    const thread = await store.create('conversation', principal.id, conversation);
    const task = await service.enqueue(principal, thread.id, 'write');
    await service.drain();
    assert.equal((await store.get<Task>('task', task.id, principal.id))?.data.state, 'waiting_for_approval');
    await service.control(principal.id, task.id, 'resume', ['approved-hash']);
    await service.drain();
    assert.equal(calls, 2);
    assert.equal((await store.get<Task>('task', task.id, principal.id))?.data.state, 'completed');
  } finally { await service.close(); await store.close(); }
});

test('expired leases resume from confirmed checkpoints but stop on unresolved dispatches', async () => {
  const store = new SqliteStore();
  const now = Date.now();
  let resumed = 0;
  const service = new TaskService(store, async ({ task }) => {
    resumed += 1;
    assert.deepEqual(task.data.runtimeMessages, [{ role: 'tool', content: 'confirmed' }]);
    return { text: 'resumed' };
  }, { now: () => now });
  try {
    const thread = await store.create('conversation', principal.id, conversation);
    const safe = await service.enqueue(principal, thread.id, 'safe resume');
    const unsafe = await service.enqueue(principal, thread.id, 'unsafe resume');
    for (const task of [safe, unsafe]) {
      await store.put<Task>('task', task.id, task.ownerId, {
        ...task.data,
        state: 'running',
        workerId: 'dead-worker',
        leaseExpiresAt: new Date(now - 1_000).toISOString(),
        ...(task.id === safe.id ? { runtimeMessages: [{ role: 'tool', content: 'confirmed' }] } : {}),
      }, task.revision);
    }
    await store.create('event', principal.id, {
      taskId: safe.id,
      sequence: 2,
      type: 'tool_dispatched',
      payload: { type: 'tool_dispatched', actionHash: 'safe-hash', sideEffect: 'write' },
      at: new Date(now - 2_000).toISOString(),
    });
    await store.create('event', principal.id, {
      taskId: safe.id,
      sequence: 3,
      type: 'tool_result',
      payload: { type: 'tool_result', actionHash: 'safe-hash', outcome: 'confirmed' },
      at: new Date(now - 1_500).toISOString(),
    });
    await store.create('event', principal.id, {
      taskId: unsafe.id,
      sequence: 2,
      type: 'tool_dispatched',
      payload: { type: 'tool_dispatched', actionHash: 'unsafe-hash', sideEffect: 'external' },
      at: new Date(now - 2_000).toISOString(),
    });

    await service.drain();

    assert.equal(resumed, 1);
    assert.equal((await store.get<Task>('task', safe.id, principal.id))?.data.state, 'completed');
    assert.equal((await store.get<Task>('task', unsafe.id, principal.id))?.data.state, 'unknown');
  } finally { await service.close(); await store.close(); }
});

test('tool dispatch revalidates authorization before the action may proceed', async () => {
  const store = new SqliteStore();
  let actionRan = false;
  const service = new TaskService(store, async ({ onEvent }) => {
    await onEvent({
      type: 'tool_dispatched',
      toolCall: { id: 'write-1', name: 'workspace.write', arguments: {} },
      sideEffect: 'write',
    });
    actionRan = true;
    return { text: 'done' };
  }, {
    async reauthorize() { throw new Error('revoked'); },
  });
  try {
    const thread = await store.create('conversation', principal.id, conversation);
    const task = await service.enqueue(principal, thread.id, 'write');
    await service.drain();
    assert.equal(actionRan, false);
    assert.equal((await store.get<Task>('task', task.id, principal.id))?.data.state, 'failed');
  } finally { await service.close(); await store.close(); }
});

test('model calls revalidate current authorization and preserve the task scope ceiling', async () => {
  const store = new SqliteStore();
  let reauthorizations = 0;
  let modelRan = false;
  const scoped = { ...principal, scopes: ['workspace:read'] };
  const service = new TaskService(store, async ({ task, onEvent }) => {
    assert.deepEqual(task.data.principal.scopes, ['workspace:read']);
    await onEvent({ type: 'model_call', call: 1 });
    modelRan = true;
    return { text: 'done' };
  }, {
    async reauthorize(current) {
      reauthorizations += 1;
      if (reauthorizations === 1) return { ...current, scopes: ['*'] };
      throw new DomainError('grant_revoked', 'revoked', 403);
    },
  });
  try {
    const thread = await store.create('conversation', scoped.id, conversation);
    const task = await service.enqueue(scoped, thread.id, 'answer');
    await service.drain();
    assert.equal(modelRan, false);
    assert.equal((await store.get<Task>('task', task.id, scoped.id))?.data.state, 'paused');
  } finally { await service.close(); await store.close(); }
});

test('an expired grant pauses and resumes with the current signed-in principal', async () => {
  const store = new SqliteStore();
  const now = Date.now();
  let runs = 0;
  const service = new TaskService(store, async () => {
    runs += 1;
    return { text: 'resumed safely' };
  }, { now: () => now, reauthorize: async (current) => current });
  try {
    const thread = await store.create('conversation', principal.id, conversation);
    const task = await service.enqueue(principal, thread.id, 'resume me');
    const current = (await store.get<Task>('task', task.id, principal.id))!;
    await store.put<Task>('task', task.id, principal.id, {
      ...current.data,
      grantExpiresAt: new Date(now - 1).toISOString(),
      principal: { ...current.data.principal, scopes: ['workspace:read'], expiresAt: new Date(now - 1).toISOString() },
    }, current.revision);

    await service.drain();
    assert.equal(runs, 0);
    assert.equal((await store.get<Task>('task', task.id, principal.id))?.data.state, 'paused');

    const actor = { ...principal, scopes: ['workspace:read'], expiresAt: new Date(now + 60_000).toISOString() };
    await service.control(principal.id, task.id, 'resume', [], actor);
    await service.drain();
    const completed = await store.get<Task>('task', task.id, principal.id);
    assert.equal(runs, 1);
    assert.equal(completed?.data.state, 'completed');
    assert.equal(completed?.data.principal.expiresAt, actor.expiresAt);
  } finally { await service.close(); await store.close(); }
});

test('a task clears its device wait error after reconnecting and completing', async () => {
  const store = new SqliteStore();
  let now = Date.now();
  let runs = 0;
  const service = new TaskService(store, async () => {
    runs += 1;
    if (runs === 1) throw new DomainError('waiting_for_device', 'Waiting for the authorized device to reconnect', 503);
    return { text: 'reconnected' };
  }, { now: () => now });
  try {
    const thread = await store.create('conversation', principal.id, conversation);
    const task = await service.enqueue(principal, thread.id, 'resume after reconnect');
    await service.drain();
    const waiting = await store.get<Task>('task', task.id, principal.id);
    assert.equal(waiting?.data.state, 'waiting_for_device');
    assert.match(waiting?.data.error ?? '', /reconnect/);
    assert.ok(waiting?.data.nextAttemptAt);

    now += 10_001;
    await service.drain();
    const completed = await store.get<Task>('task', task.id, principal.id);
    assert.equal(completed?.data.state, 'completed');
    assert.equal(completed?.data.result, 'reconnected');
    assert.equal(completed?.data.error, undefined);
    assert.equal(completed?.data.nextAttemptAt, undefined);
  } finally { await service.close(); await store.close(); }
});

async function waitFor(predicate: () => boolean, timeoutMs = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('Timed out waiting for condition');
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
}
