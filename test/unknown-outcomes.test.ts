import assert from 'node:assert/strict';
import test from 'node:test';
import { AgentCoordinator } from '../src/agents/coordinator.js';
import { DomainError, type Principal } from '../src/contracts.js';
import type { Conversation, Task, TaskEvent } from '../src/domain.js';
import { reconcileAgentTasks } from '../src/runtime-adapter.js';
import { SqliteStore } from '../src/storage/sqlite.js';
import type { Entity, Store } from '../src/storage/store.js';
import { TaskService, type TaskExecution } from '../src/tasks.js';

class FailFinalReconciliationStore implements Store {
  public fail = true;

  public constructor(private readonly inner: Store) {}

  create<T>(kind: string, ownerId: string, data: T, id?: string): Promise<Entity<T>> {
    return this.inner.create(kind, ownerId, data, id);
  }

  get<T>(kind: string, id: string, ownerId: string): Promise<Entity<T> | undefined> {
    return this.inner.get(kind, id, ownerId);
  }

  scan<T>(kind: string, ownerId?: string): Promise<Array<Entity<T>>> {
    return this.inner.scan(kind, ownerId);
  }

  put<T>(kind: string, id: string, ownerId: string, data: T, expectedRevision: number): Promise<Entity<T>> {
    const task = data as { reconciliation?: { phase?: string } };
    if (this.fail && kind === 'task' && task.reconciliation?.phase === 'complete') {
      this.fail = false;
      throw new Error('crash before final task CAS');
    }
    return this.inner.put(kind, id, ownerId, data, expectedRevision);
  }

  remove(kind: string, id: string, ownerId: string, expectedRevision: number): Promise<boolean> {
    return this.inner.remove(kind, id, ownerId, expectedRevision);
  }

  close(): Promise<void> {
    return this.inner.close();
  }
}

class PauseReconciliationAuditStore implements Store {
  private reachedAudit!: () => void;
  private continueAudit!: () => void;
  private readonly auditGate = new Promise<void>((resolve) => { this.continueAudit = resolve; });
  public readonly auditReached = new Promise<void>((resolve) => { this.reachedAudit = resolve; });

  public constructor(private readonly inner: Store) {}

  public async create<T>(kind: string, ownerId: string, data: T, id?: string): Promise<Entity<T>> {
    if (kind === 'event' && id?.endsWith(':audit')) {
      this.reachedAudit();
      await this.auditGate;
    }
    return this.inner.create(kind, ownerId, data, id);
  }

  get<T>(kind: string, id: string, ownerId: string): Promise<Entity<T> | undefined> {
    return this.inner.get(kind, id, ownerId);
  }

  scan<T>(kind: string, ownerId?: string): Promise<Array<Entity<T>>> {
    return this.inner.scan(kind, ownerId);
  }

  put<T>(kind: string, id: string, ownerId: string, data: T, expectedRevision: number): Promise<Entity<T>> {
    return this.inner.put(kind, id, ownerId, data, expectedRevision);
  }

  remove(kind: string, id: string, ownerId: string, expectedRevision: number): Promise<boolean> {
    return this.inner.remove(kind, id, ownerId, expectedRevision);
  }

  close(): Promise<void> {
    return this.inner.close();
  }

  public releaseAudit(): void {
    this.continueAudit();
  }
}

test('a pending reconciliation finishes before tick claims the task and does not duplicate receipts', async () => {
  const sqlite = new SqliteStore();
  const store = new FailFinalReconciliationStore(sqlite);
  const principal: Principal = { id: 'owner', level: 1, scopes: ['*'] };
  let executions = 0;
  const first = new TaskService(store, async () => { executions += 1; return { text: 'continued' }; });
  try {
    const conversation = await store.create<Conversation>('conversation', principal.id, {
      title: 'Recovery', scope: 'private', modelPolicy: 'cloud', strategy: 'single', mode: 'act', archived: false,
    });
    const queued = await first.enqueue(principal, conversation.id, 'send');
    const task = await store.put<Task>('task', queued.id, principal.id, {
      ...queued.data,
      state: 'unknown',
      error: 'Outcome unknown',
      runtimeMessages: [
        { role: 'user', content: 'send' },
        { role: 'assistant', content: '', toolCalls: [
          { id: 'call-1', occurrenceId: 'turn-1:0', name: 'send', arguments: { text: 'hello' } },
        ] },
      ],
    }, queued.revision);
    await store.create<TaskEvent>('event', principal.id, {
      taskId: task.id,
      sequence: 2,
      type: 'tool_dispatched',
      payload: {
        type: 'tool_dispatched', toolCallId: 'call-1', toolOccurrenceId: 'turn-1:0', actionHash: 'a'.repeat(64),
        sideEffect: 'external', toolCall: { id: 'call-1', occurrenceId: 'turn-1:0', name: 'send', arguments: { text: 'hello' } },
      },
      at: task.updatedAt,
    }, `${task.id}:dispatch`);
    await assert.rejects(first.reconcileOutcome(principal, task.id, {
      resolution: 'applied', toolOccurrenceId: 'turn-1:0', note: 'Confirmed in destination',
    }), /crash before final/);
    assert.equal((await store.get<Task>('task', task.id, principal.id))?.data.reconciliation?.phase, 'pending');
    await assert.rejects(first.reconcileOutcome(principal, task.id, {
      resolution: 'not_applied', toolOccurrenceId: 'turn-1:0', note: 'Changed answer',
    }), (error: unknown) => (error as { code?: string }).code === 'reconciliation_conflict');
    assert.equal(executions, 0);

    const restarted = new TaskService(store, async () => { executions += 1; return { text: 'continued' }; });
    await restarted.drain();
    const done = await store.get<Task>('task', task.id, principal.id);
    assert.equal(done?.data.state, 'completed');
    assert.equal(done?.data.reconciliation?.phase, 'complete');
    assert.equal(executions, 1);
    const events = await restarted.events(principal.id, task.id);
    assert.equal(events.filter((event) => event.data.type === 'tool_result').length, 1);
    assert.equal(events.filter((event) => event.data.type === 'reconcile').length, 1);
    await restarted.close();
  } finally {
    await first.close();
    await sqlite.close();
  }
});

test('restart finishes a child reconciliation before agent recovery can strand its restored parent', async () => {
  const sqlite = new SqliteStore();
  const store = new FailFinalReconciliationStore(sqlite);
  const principal: Principal = { id: 'owner', level: 1, scopes: ['*'] };
  const coordinator = new AgentCoordinator(store);
  const runner = async ({ task, onEvent }: TaskExecution) => {
    if (task.data.orchestration?.role !== 'child') return { text: 'parent integrated' };
    const messages = task.data.runtimeMessages as Array<{ role?: string }> | undefined;
    if (messages?.some((message) => message.role === 'tool')) return { text: 'child completed' };
    const toolCall = {
      id: 'provider-call', occurrenceId: 'child-turn:0', name: 'send', arguments: { text: 'hello' },
    };
    await onEvent({
      type: 'tool_dispatched',
      toolCallId: toolCall.id,
      toolOccurrenceId: toolCall.occurrenceId,
      actionHash: 'a'.repeat(64),
      sideEffect: 'external',
      toolCall,
      checkpointMessages: [
        { role: 'user', content: task.data.prompt },
        { role: 'assistant', content: '', toolCalls: [{ ...toolCall, actionHash: 'a'.repeat(64) }] },
      ],
    });
    throw new DomainError('outcome_unknown', 'Provider response was lost', 409);
  };
  const first = new TaskService(store, runner, { reauthorize: async (current) => current });
  try {
    const conversation = await store.create<Conversation>('conversation', principal.id, {
      title: 'Agent recovery', scope: 'private', modelPolicy: 'cloud', strategy: 'single', mode: 'act', archived: false,
    });
    const parent = await first.enqueue(principal, conversation.id, 'coordinate');
    const plan = await coordinator.prepare(principal.id, parent.id, {
      key: 'recover-child',
      children: [{ key: 'worker', prompt: 'send once' }],
      budget: { maxCalls: 2, maxTokens: 100 },
    });
    const childId = plan.data.childIds[0]!;
    await first.drain();
    await reconcileAgentTasks(store, coordinator);
    assert.equal((await store.get<Task>('task', parent.id, principal.id))?.data.state, 'unknown');

    await assert.rejects(first.reconcileOutcome(principal, childId, {
      resolution: 'applied', toolOccurrenceId: 'child-turn:0', note: 'confirmed',
    }), /crash before final/);
    const interruptedParent = await store.get<Task>('task', parent.id, principal.id);
    assert.equal(interruptedParent?.data.state, 'waiting_for_children');
    assert.equal(interruptedParent?.data.reconciliationRestoration?.childTaskId, childId);
    assert.equal((await store.get<Task>('task', childId, principal.id))?.data.reconciliation?.phase, 'pending');

    const restarted = new TaskService(store, runner, { reauthorize: async (current) => current });
    restarted.setReconciler(async () => reconcileAgentTasks(store, coordinator));
    await restarted.drain();

    const doneParent = await store.get<Task>('task', parent.id, principal.id);
    const doneChild = await store.get<Task>('task', childId, principal.id);
    assert.equal(doneChild?.data.state, 'completed');
    assert.equal(doneParent?.data.state, 'completed', doneParent?.data.error);
    assert.equal(
      (await restarted.events(principal.id, parent.id))
        .filter((event) => event.data.type === 'child_reconciled').length,
      1,
    );
    await restarted.close();
  } finally {
    await first.close();
    await sqlite.close();
  }
});

test('agent recovery waits while an HTTP child reconciliation is pending after parent restoration', async () => {
  const sqlite = new SqliteStore();
  const store = new PauseReconciliationAuditStore(sqlite);
  const principal: Principal = { id: 'owner', level: 1, scopes: ['*'] };
  const coordinator = new AgentCoordinator(store);
  const runner = async ({ task, onEvent }: TaskExecution) => {
    if (task.data.orchestration?.role !== 'child') return { text: 'parent integrated' };
    const messages = task.data.runtimeMessages as Array<{ role?: string }> | undefined;
    if (messages?.some((message) => message.role === 'tool')) return { text: 'child completed' };
    const toolCall = {
      id: 'provider-call', occurrenceId: 'child-turn:0', name: 'send', arguments: { text: 'hello' },
    };
    await onEvent({
      type: 'tool_dispatched',
      toolCallId: toolCall.id,
      toolOccurrenceId: toolCall.occurrenceId,
      actionHash: 'a'.repeat(64),
      sideEffect: 'external',
      toolCall,
      checkpointMessages: [
        { role: 'user', content: task.data.prompt },
        { role: 'assistant', content: '', toolCalls: [{ ...toolCall, actionHash: 'a'.repeat(64) }] },
      ],
    });
    throw new DomainError('outcome_unknown', 'Provider response was lost', 409);
  };
  const service = new TaskService(store, runner, { reauthorize: async (current) => current });
  let reconciliation: Promise<unknown> | undefined;
  try {
    const conversation = await store.create<Conversation>('conversation', principal.id, {
      title: 'Concurrent recovery', scope: 'private', modelPolicy: 'cloud', strategy: 'single', mode: 'act', archived: false,
    });
    const parent = await service.enqueue(principal, conversation.id, 'coordinate');
    const plan = await coordinator.prepare(principal.id, parent.id, {
      key: 'concurrent-child',
      children: [{ key: 'worker', prompt: 'send once' }],
      budget: { maxCalls: 2, maxTokens: 100 },
    });
    const childId = plan.data.childIds[0]!;
    await service.drain();
    await reconcileAgentTasks(store, coordinator);
    assert.equal((await store.get<Task>('task', parent.id, principal.id))?.data.state, 'unknown');

    reconciliation = service.reconcileOutcome(principal, childId, {
      resolution: 'applied', toolOccurrenceId: 'child-turn:0', note: 'confirmed',
    });
    await store.auditReached;
    assert.equal((await store.get<Task>('task', parent.id, principal.id))?.data.state, 'waiting_for_children');
    assert.equal((await store.get<Task>('task', childId, principal.id))?.data.reconciliation?.phase, 'pending');
    assert.equal((await coordinator.results(principal.id, plan.id)).ready, false);
    await assert.rejects(
      coordinator.queueIntegration(principal.id, plan.id),
      (error: unknown) => (error as { code?: string }).code === 'children_running',
    );

    await reconcileAgentTasks(store, coordinator);
    assert.equal((await store.get<Task>('task', parent.id, principal.id))?.data.state, 'waiting_for_children');

    store.releaseAudit();
    await reconciliation;
    service.setReconciler(async () => reconcileAgentTasks(store, coordinator));
    await service.drain();
    assert.equal((await store.get<Task>('task', childId, principal.id))?.data.state, 'completed');
    assert.equal((await store.get<Task>('task', parent.id, principal.id))?.data.state, 'completed');
    assert.equal(
      (await service.events(principal.id, parent.id))
        .filter((event) => event.data.type === 'child_reconciled').length,
      1,
    );
  } finally {
    store.releaseAudit();
    await reconciliation?.catch(() => undefined);
    await service.close();
    await sqlite.close();
  }
});
