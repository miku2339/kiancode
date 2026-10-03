import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { AgentCoordinator, type OrchestrationPlan } from '../src/agents/coordinator.js';
import type { Principal } from '../src/contracts.js';
import type { Conversation, Task, TaskEvent } from '../src/domain.js';
import { reconcileAgentTasks } from '../src/runtime-adapter.js';
import { SqliteStore } from '../src/storage/sqlite.js';
import type { Entity, Store } from '../src/storage/store.js';
import { TaskService, type TaskReconciliation } from '../src/tasks.js';

const principal: Principal = {
  id: 'nested-owner',
  level: 1,
  scopes: ['*'],
  expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
};

class FinalReconciliationCrashStore implements Store {
  public failTaskId?: string;
  public crashed = false;

  public constructor(public readonly database = new SqliteStore()) {}

  public create<T>(kind: string, ownerId: string, data: T, id?: string): Promise<Entity<T>> {
    return this.database.create(kind, ownerId, data, id);
  }

  public get<T>(kind: string, id: string, ownerId: string): Promise<Entity<T> | undefined> {
    return this.database.get(kind, id, ownerId);
  }

  public scan<T>(kind: string, ownerId?: string): Promise<Array<Entity<T>>> {
    return this.database.scan(kind, ownerId);
  }

  public put<T>(
    kind: string,
    id: string,
    ownerId: string,
    data: T,
    expectedRevision: number,
  ): Promise<Entity<T>> {
    const task = data as Task;
    if (!this.crashed
      && kind === 'task'
      && id === this.failTaskId
      && task.reconciliation?.phase === 'complete') {
      this.crashed = true;
      throw new Error('Injected crash at final reconciliation CAS');
    }
    return this.database.put(kind, id, ownerId, data, expectedRevision);
  }

  public remove(kind: string, id: string, ownerId: string, expectedRevision: number): Promise<boolean> {
    return this.database.remove(kind, id, ownerId, expectedRevision);
  }

  public close(): Promise<void> {
    return this.database.close();
  }
}

interface NestedHarness {
  store: Store;
  service: TaskService;
  coordinator: AgentCoordinator;
  rootId: string;
  middleId: string;
  leafIds: string[];
  rootPlanId: string;
  middlePlanId: string;
  executions: { count: number };
}

async function nestedHarness(store: Store = new SqliteStore(), leafCount = 1): Promise<NestedHarness> {
  const executions = { count: 0 };
  // This controlled runner only detects accidental execution; it never manufactures a completion.
  const service = new TaskService(store, async () => {
    executions.count += 1;
    throw new Error('Controlled runner must not execute during reconciliation');
  }, { reauthorize: async (current) => current });
  const coordinator = new AgentCoordinator(store);
  const conversation = await store.create<Conversation>('conversation', principal.id, {
    title: 'Nested reconciliation',
    scope: 'private',
    modelPolicy: 'cloud',
    strategy: 'single',
    mode: 'act',
    archived: false,
  });
  const root = await service.enqueue(principal, conversation.id, 'root work', 'nested-root');
  const rootPlan = await coordinator.prepare(principal.id, root.id, {
    key: 'root-to-middle',
    children: [{ key: 'middle', prompt: 'coordinate leaf work' }],
    budget: { maxCalls: 12, maxTokens: 12_000 },
  });
  const middleId = rootPlan.data.childIds[0]!;
  const middlePlan = await coordinator.prepare(principal.id, middleId, {
    key: 'middle-to-leaves',
    strategy: leafCount === 1 ? 'single' : 'experts',
    children: Array.from({ length: leafCount }, (_, index) => ({
      key: `leaf-${index + 1}`,
      prompt: `perform leaf work ${index + 1}`,
    })),
  });
  return {
    store,
    service,
    coordinator,
    rootId: root.id,
    middleId,
    leafIds: middlePlan.data.childIds,
    rootPlanId: rootPlan.id,
    middlePlanId: middlePlan.id,
    executions,
  };
}

async function task(store: Store, id: string): Promise<Entity<Task>> {
  const row = await store.get<Task>('task', id, principal.id);
  assert.ok(row, `task ${id} must exist`);
  return row;
}

async function setTask(
  store: Store,
  id: string,
  change: (current: Task) => Task,
): Promise<Entity<Task>> {
  const current = await task(store, id);
  return store.put('task', id, principal.id, change(current.data), current.revision);
}

async function makeUnknown(
  store: Store,
  taskId: string,
  label: string,
  sideEffect: 'write' | 'external' = 'external',
): Promise<{ toolOccurrenceId: string; actionHash: string }> {
  const current = await task(store, taskId);
  const toolOccurrenceId = `${label}:0`;
  const actionHash = createHash('sha256').update(`${taskId}\0${label}`).digest('hex');
  const toolCall = {
    id: 'reused-provider-id',
    occurrenceId: toolOccurrenceId,
    name: sideEffect === 'write' ? 'workspace.write' : 'send',
    arguments: sideEffect === 'write' ? { path: 'result.txt', content: label } : { text: label },
    actionHash,
  };
  await store.put<Task>('task', taskId, principal.id, {
    ...current.data,
    state: 'unknown',
    error: 'Outcome unknown',
    workerId: undefined,
    leaseExpiresAt: undefined,
    runtimeMessages: [
      ...((current.data.runtimeMessages ?? [{ role: 'user', content: current.data.prompt }]) as unknown[]),
      { role: 'assistant', content: '', toolCalls: [toolCall] },
    ],
  }, current.revision);
  const existing = (await store.scan<TaskEvent>('event', principal.id))
    .filter((event) => event.data.taskId === taskId);
  const sequence = Math.max(1, ...existing.map((event) => event.data.sequence)) + 1;
  await store.create<TaskEvent>('event', principal.id, {
    taskId,
    sequence,
    type: 'tool_dispatched',
    payload: {
      type: 'tool_dispatched',
      toolCallId: toolCall.id,
      toolOccurrenceId,
      actionHash,
      sideEffect,
      toolCall,
    },
    at: new Date().toISOString(),
  }, `${taskId}:manual:${label}`);
  return { toolOccurrenceId, actionHash };
}

async function propagateUnknown(harness: NestedHarness): Promise<void> {
  await reconcileAgentTasks(harness.store, harness.coordinator);
  await reconcileAgentTasks(harness.store, harness.coordinator);
  assert.equal((await task(harness.store, harness.middleId)).data.state, 'unknown');
  assert.equal((await task(harness.store, harness.rootId)).data.state, 'unknown');
}

async function parentEvents(store: Store, taskId: string): Promise<Array<Entity<TaskEvent>>> {
  return (await store.scan<TaskEvent>('event', principal.id))
    .filter((event) => event.data.taskId === taskId && event.data.type === 'child_reconciled');
}

const applied = (target: { toolOccurrenceId: string; actionHash: string }): TaskReconciliation => ({
  resolution: 'applied',
  toolOccurrenceId: target.toolOccurrenceId,
  actionHash: target.actionHash,
  note: 'Effect verified independently',
});

test('an exact applied receipt restores two ancestors once after a final-CAS crash and restart', async () => {
  const store = new FinalReconciliationCrashStore();
  const harness = await nestedHarness(store);
  let restarted: TaskService | undefined;
  try {
    const leafId = harness.leafIds[0]!;
    const target = await makeUnknown(store, leafId, 'leaf-effect');
    await propagateUnknown(harness);
    store.failTaskId = leafId;

    await assert.rejects(
      harness.service.reconcileOutcome(principal, leafId, applied(target)),
      /Injected crash at final reconciliation CAS/,
    );
    assert.equal((await task(store, leafId)).data.reconciliation?.phase, 'pending');
    await harness.service.close();

    restarted = new TaskService(store, async () => {
      harness.executions.count += 1;
      throw new Error('Controlled runner must not execute during reconciliation restart');
    }, { reauthorize: async (current) => current });
    const reconciled = await restarted.reconcileOutcome(principal, leafId, applied(target));

    assert.equal(reconciled.data.state, 'queued');
    assert.equal(reconciled.data.reconciliation?.phase, 'complete');
    assert.equal((await task(store, harness.middleId)).data.state, 'waiting_for_children');
    assert.equal((await task(store, harness.rootId)).data.state, 'waiting_for_children');
    assert.equal(harness.executions.count, 0);

    const leafEvents = (await store.scan<TaskEvent>('event', principal.id))
      .filter((event) => event.data.taskId === leafId);
    const receipts = leafEvents.filter((event) => event.data.type === 'tool_result'
      && (event.data.payload as { reconciled?: string }).reconciled === 'applied');
    const audits = leafEvents.filter((event) => event.data.type === 'reconcile');
    assert.equal(receipts.length, 1);
    assert.equal(audits.length, 1);
    assert.deepEqual(
      {
        occurrence: (receipts[0]!.data.payload as { toolOccurrenceId?: string }).toolOccurrenceId,
        hash: (receipts[0]!.data.payload as { actionHash?: string }).actionHash,
        receiptId: (receipts[0]!.data.payload as { receiptId?: string }).receiptId,
      },
      {
        occurrence: target.toolOccurrenceId,
        hash: target.actionHash,
        receiptId: reconciled.data.reconciliation?.receiptId,
      },
    );
    assert.equal((await parentEvents(store, harness.middleId)).length, 1);
    assert.equal((await parentEvents(store, harness.rootId)).length, 1);
    assert.equal(
      ((await parentEvents(store, harness.rootId))[0]!.data.payload as { childTaskId?: string }).childTaskId,
      harness.middleId,
    );
  } finally {
    await restarted?.close();
    await harness.service.close();
    await store.close();
  }
});

test('a child receipt cannot revive a cancelled or cancellation-requested middle parent', async (t) => {
  for (const variant of ['cancelRequested', 'cancelled'] as const) {
    await t.test(variant, async () => {
      const harness = await nestedHarness();
      try {
        const leafId = harness.leafIds[0]!;
        const target = await makeUnknown(harness.store, leafId, `leaf-${variant}`);
        await propagateUnknown(harness);
        await setTask(harness.store, harness.middleId, (middle) => ({
          ...middle,
          ...(variant === 'cancelRequested' ? { cancelRequested: true } : { state: 'cancelled' }),
        }));

        await harness.service.reconcileOutcome(principal, leafId, applied(target));
        await reconcileAgentTasks(harness.store, harness.coordinator);

        const middle = await task(harness.store, harness.middleId);
        assert.equal(variant === 'cancelRequested' ? middle.data.cancelRequested : middle.data.state,
          variant === 'cancelRequested' ? true : 'cancelled');
        assert.equal((await task(harness.store, harness.rootId)).data.state, 'unknown');
        assert.equal((await parentEvents(harness.store, harness.middleId)).length, 0);
        assert.equal(harness.executions.count, 0);
      } finally {
        await harness.service.close();
        await harness.store.close();
      }
    });
  }
});

test('a middle parent own unresolved effect is not cleared or queued by its child receipt', async () => {
  const harness = await nestedHarness();
  try {
    const leafId = harness.leafIds[0]!;
    const leafTarget = await makeUnknown(harness.store, leafId, 'leaf-effect');
    await propagateUnknown(harness);
    const middleTarget = await makeUnknown(harness.store, harness.middleId, 'middle-own-write', 'write');
    await setTask(harness.store, harness.middleId, (middle) => ({
      ...middle,
      error: 'Delegated work requires attention: leaf-1 unknown',
    }));

    await harness.service.reconcileOutcome(principal, leafId, applied(leafTarget));
    await reconcileAgentTasks(harness.store, harness.coordinator);

    const middle = await task(harness.store, harness.middleId);
    assert.equal(middle.data.state, 'unknown');
    assert.equal((await task(harness.store, harness.rootId)).data.state, 'unknown');
    assert.equal((await parentEvents(harness.store, harness.middleId)).length, 0);
    assert.equal((await harness.coordinator.results(principal.id, harness.middlePlanId)).ready, false);
    const dispatch = (await harness.service.events(principal.id, harness.middleId))
      .find((event) => (event.data.payload as { toolOccurrenceId?: string }).toolOccurrenceId === middleTarget.toolOccurrenceId);
    assert.equal(dispatch?.data.type, 'tool_dispatched');
    assert.equal(harness.executions.count, 0);
  } finally {
    await harness.service.close();
    await harness.store.close();
  }
});

test('an old complete sibling receipt does not satisfy its new unresolved occurrence', async () => {
  const harness = await nestedHarness(undefined, 2);
  try {
    const [completedLeafId, recurringLeafId] = harness.leafIds as [string, string];
    await setTask(harness.store, completedLeafId, (leaf) => ({
      ...leaf,
      state: 'completed',
      result: 'controlled completed sibling',
    }));
    const oldTarget = await makeUnknown(harness.store, recurringLeafId, 'old-sibling-effect');
    await setTask(harness.store, harness.middleId, (middle) => ({ ...middle, cancelRequested: true }));
    await harness.service.reconcileOutcome(principal, recurringLeafId, applied(oldTarget));
    await setTask(harness.store, harness.middleId, (middle) => ({ ...middle, cancelRequested: false }));
    const newTarget = await makeUnknown(harness.store, recurringLeafId, 'new-sibling-effect');

    await reconcileAgentTasks(harness.store, harness.coordinator);
    await reconcileAgentTasks(harness.store, harness.coordinator);
    const outcome = await harness.coordinator.results(principal.id, harness.middlePlanId);

    assert.equal(outcome.ready, false);
    assert.equal(outcome.successful, false);
    assert.equal((await task(harness.store, harness.middleId)).data.state, 'waiting_for_children');
    assert.equal((await task(harness.store, harness.rootId)).data.state, 'waiting_for_children');
    assert.equal((await task(harness.store, recurringLeafId)).data.reconciliation?.toolOccurrenceId,
      oldTarget.toolOccurrenceId);
    const unresolved = (await harness.service.events(principal.id, recurringLeafId))
      .find((event) => (event.data.payload as { toolOccurrenceId?: string }).toolOccurrenceId === newTarget.toolOccurrenceId);
    assert.equal(unresolved?.data.type, 'tool_dispatched');
    assert.equal((await parentEvents(harness.store, harness.middleId)).length, 0);
    assert.equal(harness.executions.count, 0);
  } finally {
    await harness.service.close();
    await harness.store.close();
  }
});

test('real coordinator preparation keeps the depth-two chain and both plans waiting before reconciliation', async () => {
  const harness = await nestedHarness();
  try {
    const root = await task(harness.store, harness.rootId);
    const middle = await task(harness.store, harness.middleId);
    const leaf = await task(harness.store, harness.leafIds[0]!);
    const rootPlan = await harness.store.get<OrchestrationPlan>('agent_plan', harness.rootPlanId, principal.id);
    const middlePlan = await harness.store.get<OrchestrationPlan>('agent_plan', harness.middlePlanId, principal.id);

    assert.deepEqual([root.data.orchestration?.depth, middle.data.orchestration?.depth, leaf.data.orchestration?.depth], [0, 1, 2]);
    assert.deepEqual([root.data.state, middle.data.state, leaf.data.state], ['waiting_for_children', 'waiting_for_children', 'queued']);
    assert.deepEqual([rootPlan?.data.state, middlePlan?.data.state], ['waiting', 'waiting']);
    assert.equal(harness.executions.count, 0);
  } finally {
    await harness.service.close();
    await harness.store.close();
  }
});
