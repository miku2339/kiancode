import assert from 'node:assert/strict';
import test from 'node:test';
import { DomainError, type Principal } from '../src/contracts.js';
import type { Conversation, Task, TaskEvent } from '../src/domain.js';
import { SqliteStore } from '../src/storage/sqlite.js';
import { TaskService } from '../src/tasks.js';

const principal: Principal = { id: 'owner', level: 1, scopes: ['*'] };
const occurrence = 'turn-1:0';
const actionHash = 'a'.repeat(64);

async function unknownTask(): Promise<{
  store: SqliteStore;
  service: TaskService;
  taskId: string;
  executions: () => number;
}> {
  const store = new SqliteStore();
  let executions = 0;
  const service = new TaskService(store, async () => {
    executions += 1;
    return { text: 'must not run' };
  }, {
    reauthorize: async (current) => current,
  });
  const conversation = await store.create<Conversation>('conversation', principal.id, {
    title: 'Task', scope: 'private', modelPolicy: 'cloud', strategy: 'single', mode: 'act', archived: false,
  });
  const task = await service.enqueue(principal, conversation.id, 'send');
  const unknown = await store.put<Task>('task', task.id, principal.id, {
    ...task.data,
    state: 'unknown',
    error: 'Outcome unknown',
    runtimeMessages: [
      { role: 'user', content: 'send' },
      { role: 'assistant', content: '', toolCalls: [{ id: 'call-1', occurrenceId: occurrence, name: 'send', arguments: { text: 'hello' } }] },
    ],
  }, task.revision);
  const sequence = 2;
  await store.create<TaskEvent>('event', principal.id, {
    taskId: task.id,
    sequence,
    type: 'tool_dispatched',
    payload: {
      type: 'tool_dispatched', toolCallId: 'call-1', toolOccurrenceId: occurrence, actionHash,
      sideEffect: 'external', toolCall: { id: 'call-1', occurrenceId: occurrence, name: 'send', arguments: { text: 'hello' } },
    },
    at: unknown.updatedAt,
  }, `${task.id}:${String(sequence).padStart(12, '0')}`);
  return { store, service, taskId: task.id, executions: () => executions };
}

async function appendDispatch(
  store: SqliteStore,
  taskId: string,
  sequence: number,
  value: { occurrence?: string; hash: string; result?: 'confirmed' | 'failed' },
): Promise<void> {
  await store.create<TaskEvent>('event', principal.id, {
    taskId,
    sequence,
    type: 'tool_dispatched',
    payload: {
      type: 'tool_dispatched', toolCallId: 'call-1', ...(value.occurrence ? { toolOccurrenceId: value.occurrence } : {}),
      actionHash: value.hash, sideEffect: 'external',
      toolCall: { id: 'call-1', ...(value.occurrence ? { occurrenceId: value.occurrence } : {}), name: 'send', arguments: { text: 'hello' } },
    },
    at: new Date().toISOString(),
  }, `${taskId}:manual:${sequence}`);
  if (value.result) {
    await store.create<TaskEvent>('event', principal.id, {
      taskId,
      sequence: sequence + 1,
      type: 'tool_result',
      payload: {
        type: 'tool_result', toolCallId: 'call-1', ...(value.occurrence ? { toolOccurrenceId: value.occurrence } : {}),
        actionHash: value.hash, sideEffect: 'external', outcome: value.result, isError: value.result === 'failed',
      },
      at: new Date().toISOString(),
    }, `${taskId}:manual:${sequence + 1}`);
  }
}

test('abandon is receipt-first and a repeated identical decision is idempotent', async () => {
  const harness = await unknownTask();
  try {
    const input = { resolution: 'abandon' as const, toolOccurrenceId: occurrence, note: 'Operator stopped recovery' };
    const first = await harness.service.reconcileOutcome(principal, harness.taskId, input);
    const second = await harness.service.reconcileOutcome(principal, harness.taskId, input);
    assert.equal(first.data.state, 'cancelled');
    assert.equal(second.id, first.id);
    const events = await harness.service.events(principal.id, harness.taskId);
    assert.equal(events.filter((event) => event.data.type === 'tool_result').length, 1);
    assert.equal(events.filter((event) => event.data.type === 'reconcile').length, 1);
  } finally {
    await harness.service.close();
    await harness.store.close();
  }
});

test('an occurrence selects one of two open dispatches that reuse the same raw id', async () => {
  const harness = await unknownTask();
  try {
    const secondOccurrence = 'turn-2:0';
    const secondHash = 'b'.repeat(64);
    const task = (await harness.store.get<Task>('task', harness.taskId, principal.id))!;
    await harness.store.put<Task>('task', task.id, task.ownerId, {
      ...task.data,
      runtimeMessages: [
        { role: 'user', content: 'send twice' },
        { role: 'assistant', content: '', toolCalls: [
          { id: 'call-1', occurrenceId: occurrence, name: 'send', arguments: { text: 'hello' } },
          { id: 'call-1', occurrenceId: secondOccurrence, name: 'send', arguments: { text: 'hello' } },
        ] },
      ],
    }, task.revision);
    await appendDispatch(harness.store, harness.taskId, 3, { occurrence: secondOccurrence, hash: secondHash });

    const done = await harness.service.reconcileOutcome(principal, harness.taskId, {
      resolution: 'applied', toolOccurrenceId: secondOccurrence,
    });

    assert.equal(done.data.state, 'unknown');
    assert.equal(done.data.reconciliation?.actionHash, secondHash);
    const receipt = (await harness.service.events(principal.id, harness.taskId))
      .find((event) => event.data.type === 'tool_result' && (event.data.payload as { reconciled?: string }).reconciled === 'applied');
    assert.equal((receipt?.data.payload as { toolOccurrenceId?: string }).toolOccurrenceId, secondOccurrence);
    await harness.service.drain();
    assert.equal(harness.executions(), 0);

    const resumed = await harness.service.reconcileOutcome(principal, harness.taskId, {
      resolution: 'applied', toolOccurrenceId: occurrence,
    });
    assert.equal(resumed.data.state, 'queued');
  } finally {
    await harness.service.close();
    await harness.store.close();
  }
});

test('cancellation waits for every unknown occurrence and records each receipt in the checkpoint', async () => {
  const harness = await unknownTask();
  try {
    const secondOccurrence = 'turn-2:0';
    const task = (await harness.store.get<Task>('task', harness.taskId, principal.id))!;
    await harness.store.put<Task>('task', task.id, task.ownerId, {
      ...task.data,
      cancelRequested: true,
      runtimeMessages: [
        { role: 'user', content: 'send twice' },
        { role: 'assistant', content: '', toolCalls: [
          { id: 'call-1', occurrenceId: occurrence, name: 'send', arguments: { text: 'hello' } },
          { id: 'call-1', occurrenceId: secondOccurrence, name: 'send', arguments: { text: 'hello' } },
        ] },
      ],
    }, task.revision);
    await appendDispatch(harness.store, harness.taskId, 3, {
      occurrence: secondOccurrence, hash: 'b'.repeat(64),
    });

    const partial = await harness.service.reconcileOutcome(principal, harness.taskId, {
      resolution: 'applied', toolOccurrenceId: secondOccurrence,
    });
    assert.equal(partial.data.state, 'unknown');
    assert.equal(
      (partial.data.runtimeMessages as Array<{ role?: string; toolOccurrenceId?: string }> | undefined)
        ?.some((message) => message.role === 'tool' && message.toolOccurrenceId === secondOccurrence),
      true,
    );

    const cancelled = await harness.service.reconcileOutcome(principal, harness.taskId, {
      resolution: 'applied', toolOccurrenceId: occurrence,
    });
    assert.equal(cancelled.data.state, 'cancelled');
    assert.equal(cancelled.data.cancelRequested, true);
  } finally {
    await harness.service.close();
    await harness.store.close();
  }
});

test('a repeated legacy raw id is ambiguous while an earlier closed call leaves one exact open target', async () => {
  const ambiguous = await unknownTask();
  try {
    const task = (await ambiguous.store.get<Task>('task', ambiguous.taskId, principal.id))!;
    const events = await ambiguous.store.scan<TaskEvent>('event', principal.id);
    for (const event of events.filter((row) => row.data.type === 'tool_dispatched')) {
      await ambiguous.store.remove('event', event.id, event.ownerId, event.revision);
    }
    await appendDispatch(ambiguous.store, ambiguous.taskId, 2, { hash: 'c'.repeat(64) });
    await appendDispatch(ambiguous.store, ambiguous.taskId, 3, { hash: 'd'.repeat(64) });
    await assert.rejects(
      ambiguous.service.reconcileOutcome(principal, task.id, { resolution: 'abandon', toolCallId: 'call-1' }),
      (error: unknown) => (error as { code?: string }).code === 'ambiguous_reconciliation',
    );
    assert.equal((await ambiguous.store.get<Task>('task', task.id, principal.id))?.data.reconciliation, undefined);
  } finally {
    await ambiguous.service.close();
    await ambiguous.store.close();
  }

  const compatible = await unknownTask();
  try {
    const events = await compatible.store.scan<TaskEvent>('event', principal.id);
    for (const event of events.filter((row) => row.data.type === 'tool_dispatched')) {
      await compatible.store.remove('event', event.id, event.ownerId, event.revision);
    }
    await appendDispatch(compatible.store, compatible.taskId, 2, { hash: 'e'.repeat(64), result: 'confirmed' });
    await appendDispatch(compatible.store, compatible.taskId, 4, { hash: 'f'.repeat(64) });
    const done = await compatible.service.reconcileOutcome(principal, compatible.taskId, {
      resolution: 'abandon', toolCallId: 'call-1',
    });
    assert.equal(done.data.reconciliation?.actionHash, 'f'.repeat(64));
  } finally {
    await compatible.service.close();
    await compatible.store.close();
  }
});

test('accepted decisions survive restart and reject a changed note or resolution', async () => {
  const harness = await unknownTask();
  try {
    const body = { resolution: 'abandon' as const, toolOccurrenceId: occurrence, note: 'verified stopped' };
    const first = await harness.service.reconcileOutcome(principal, harness.taskId, body);
    const restarted = new TaskService(harness.store, async () => ({ text: 'must not run' }));
    const replay = await restarted.reconcileOutcome(principal, harness.taskId, body);
    assert.equal(replay.data.reconciliation?.receiptId, first.data.reconciliation?.receiptId);
    await assert.rejects(
      restarted.reconcileOutcome(principal, harness.taskId, { ...body, note: 'different' }),
      (error: unknown) => (error as { code?: string }).code === 'reconciliation_conflict',
    );
    await assert.rejects(
      restarted.reconcileOutcome(principal, harness.taskId, { ...body, resolution: 'applied' }),
      (error: unknown) => (error as { code?: string }).code === 'reconciliation_conflict',
    );
    await restarted.close();
  } finally {
    await harness.service.close();
    await harness.store.close();
  }
});

test('successive unknown occurrences with one provider id keep independent reconciliation receipts', async () => {
  const store = new SqliteStore();
  let dispatches = 0;
  const service = new TaskService(store, async ({ task, onEvent }) => {
    dispatches += 1;
    const toolOccurrenceId = `turn-${dispatches}:0`;
    const actionHash = String(dispatches).repeat(64);
    const toolCall = {
      id: 'provider-call',
      occurrenceId: toolOccurrenceId,
      name: 'send',
      arguments: { text: `message-${dispatches}` },
      actionHash,
    };
    await onEvent({
      type: 'tool_dispatched',
      toolCallId: toolCall.id,
      toolOccurrenceId,
      actionHash,
      sideEffect: 'external',
      toolCall,
      checkpointMessages: [
        ...((task.data.runtimeMessages ?? [{ role: 'user', content: task.data.prompt }]) as unknown[]),
        { role: 'assistant', content: '', toolCalls: [toolCall] },
      ],
    });
    throw new DomainError('outcome_unknown', 'Provider response was lost', 409);
  }, { reauthorize: async (current) => current });
  try {
    const conversation = await store.create<Conversation>('conversation', principal.id, {
      title: 'Two rounds', scope: 'private', modelPolicy: 'cloud', strategy: 'single', mode: 'act', archived: false,
    });
    const task = await service.enqueue(principal, conversation.id, 'send twice');

    await service.drain();
    assert.equal((await store.get<Task>('task', task.id, principal.id))?.data.state, 'unknown');
    await service.reconcileOutcome(principal, task.id, {
      resolution: 'applied', toolOccurrenceId: 'turn-1:0', note: 'first confirmed',
    });

    await service.drain();
    assert.equal((await store.get<Task>('task', task.id, principal.id))?.data.state, 'unknown');
    const second = {
      resolution: 'applied' as const,
      toolOccurrenceId: 'turn-2:0',
      note: 'second confirmed',
    };
    await service.reconcileOutcome(principal, task.id, second);
    await service.reconcileOutcome(principal, task.id, second);

    await assert.rejects(
      service.reconcileOutcome(principal, task.id, {
        resolution: 'applied', toolOccurrenceId: 'turn-1:0', note: 'first confirmed',
      }),
      (error: unknown) => (error as { statusCode?: number }).statusCode === 409,
    );
    await assert.rejects(
      service.reconcileOutcome(principal, task.id, { ...second, resolution: 'not_applied' }),
      (error: unknown) => (error as { code?: string }).code === 'reconciliation_conflict',
    );
    await assert.rejects(
      service.reconcileOutcome({ ...principal, applicationId: 'different-client' }, task.id, second),
      (error: unknown) => (error as { code?: string }).code === 'reconciliation_conflict',
    );

    const events = await service.events(principal.id, task.id);
    assert.equal(dispatches, 2);
    assert.deepEqual(
      events.filter((event) => event.data.type === 'tool_result'
        && (event.data.payload as { reconciled?: string }).reconciled === 'applied')
        .map((event) => (event.data.payload as { toolOccurrenceId?: string }).toolOccurrenceId),
      ['turn-1:0', 'turn-2:0'],
    );
    assert.equal(events.filter((event) => event.data.type === 'reconcile').length, 2);
  } finally {
    await service.close();
    await store.close();
  }
});

test('an unknown task without a side effect can be abandoned idempotently without a tool receipt', async () => {
  const store = new SqliteStore();
  const service = new TaskService(store, async () => ({ text: 'must not run' }));
  try {
    const conversation = await store.create<Conversation>('conversation', principal.id, {
      title: 'Parent', scope: 'private', modelPolicy: 'cloud', strategy: 'experts', mode: 'act', archived: false,
    });
    const queued = await service.enqueue(principal, conversation.id, 'coordinate');
    await store.put<Task>('task', queued.id, principal.id, {
      ...queued.data, state: 'unknown', error: 'Delegated work requires attention: child unknown',
    }, queued.revision);
    const input = { resolution: 'abandon' as const, note: 'Stop the parent' };
    const first = await service.reconcileOutcome(principal, queued.id, input);
    const retry = await service.reconcileOutcome(principal, queued.id, input);
    assert.equal(first.data.state, 'cancelled');
    assert.equal(retry.data.reconciliation?.receiptId, `${queued.id}:reconciled:abandon`);
    const events = await service.events(principal.id, queued.id);
    assert.equal(events.filter((event) => event.data.type === 'tool_result').length, 0);
    assert.equal(events.filter((event) => event.data.type === 'reconcile').length, 1);
  } finally {
    await service.close();
    await store.close();
  }
});

test('invalid or expired reconciliation attempts perform no writes', async () => {
  const harness = await unknownTask();
  try {
    const before = await harness.store.scan('event', principal.id);
    await assert.rejects(
      harness.service.reconcileOutcome(principal, harness.taskId, { resolution: 'applied', toolOccurrenceId: 'wrong' }),
      (error: unknown) => (error as { code?: string }).code === 'invalid_reconciliation',
    );
    await assert.rejects(
      harness.service.reconcileOutcome({ ...principal, expiresAt: new Date(Date.now() - 1).toISOString() }, harness.taskId, {
        resolution: 'applied', toolOccurrenceId: occurrence,
      }),
      (error: unknown) => (error as { code?: string }).code === 'unauthorized',
    );
    assert.equal((await harness.store.scan('event', principal.id)).length, before.length);
    assert.equal((await harness.store.get<Task>('task', harness.taskId, principal.id))?.data.reconciliation, undefined);
  } finally {
    await harness.service.close();
    await harness.store.close();
  }
});

test('a parent is restored only after every unknown sibling has an accepted receipt', async () => {
  const store = new SqliteStore();
  const service = new TaskService(store, async () => ({ text: 'must not run' }));
  try {
    const conversation = await store.create<Conversation>('conversation', principal.id, {
      title: 'Plan', scope: 'private', modelPolicy: 'cloud', strategy: 'experts', mode: 'act', archived: false,
    });
    let parent = await service.enqueue(principal, conversation.id, 'parent');
    const first = await service.enqueue(principal, conversation.id, 'first child');
    const second = await service.enqueue(principal, conversation.id, 'second child');
    const planId = 'plan-1';
    parent = await store.put<Task>('task', parent.id, principal.id, {
      ...parent.data,
      state: 'unknown',
      error: 'Delegated work requires attention: child outcome unknown',
      orchestration: {
        rootTaskId: parent.id, planId, depth: 0, role: 'parent', strategy: 'experts', budgetId: 'budget',
        phase: 'children', verification: 'pending',
      },
    }, parent.revision);
    await store.create('agent_plan', principal.id, {
      parentTaskId: parent.id, rootTaskId: parent.id, strategy: 'experts', childIds: [first.id, second.id],
      budgetId: 'budget', state: 'waiting', fingerprint: 'fingerprint', aggregationClaimed: false,
    }, planId);
    for (const [index, child] of [first, second].entries()) {
      const childOccurrence = `child-${index}:0`;
      await store.put<Task>('task', child.id, principal.id, {
        ...child.data,
        state: 'unknown',
        error: 'Outcome unknown',
        runtimeMessages: [
          { role: 'user', content: 'send' },
          { role: 'assistant', content: '', toolCalls: [
            { id: 'call-1', occurrenceId: childOccurrence, name: 'send', arguments: { text: 'hello' } },
          ] },
        ],
        orchestration: {
          rootTaskId: parent.id, parentTaskId: parent.id, planId: `child-plan-${index}`, depth: 1,
          role: 'child', strategy: 'single', childKey: String(index), budgetId: 'budget', phase: 'children', verification: 'pending',
        },
      }, child.revision);
      await appendDispatch(store, child.id, 2, { occurrence: childOccurrence, hash: String(index + 1).repeat(64) });
    }

    await service.reconcileOutcome(principal, first.id, { resolution: 'applied', toolOccurrenceId: 'child-0:0' });
    assert.equal((await store.get<Task>('task', parent.id, principal.id))?.data.state, 'unknown');
    await service.reconcileOutcome(principal, second.id, { resolution: 'applied', toolOccurrenceId: 'child-1:0' });
    const restored = await store.get<Task>('task', parent.id, principal.id);
    assert.equal(restored?.data.state, 'waiting_for_children');
    assert.equal((await service.events(principal.id, parent.id)).filter((event) => event.data.type === 'child_reconciled').length, 1);

    const firstAgain = (await store.get<Task>('task', first.id, principal.id))!;
    await store.put<Task>('task', first.id, principal.id, {
      ...firstAgain.data,
      state: 'unknown',
      error: 'Outcome unknown',
      runtimeMessages: [
        ...(firstAgain.data.runtimeMessages ?? []),
        { role: 'assistant', content: '', toolCalls: [
          { id: 'call-1', occurrenceId: 'child-0:1', name: 'send', arguments: { text: 'hello' } },
        ] },
      ],
    }, firstAgain.revision);
    await appendDispatch(store, first.id, 10, { occurrence: 'child-0:1', hash: '4'.repeat(64) });
    const parentAgain = (await store.get<Task>('task', parent.id, principal.id))!;
    await store.put<Task>('task', parent.id, principal.id, {
      ...parentAgain.data,
      state: 'unknown',
      error: 'Delegated work requires attention: child outcome unknown',
    }, parentAgain.revision);

    await service.reconcileOutcome(principal, first.id, {
      resolution: 'applied', toolOccurrenceId: 'child-0:0',
    });
    assert.equal((await store.get<Task>('task', parent.id, principal.id))?.data.state, 'unknown');
    await service.reconcileOutcome(principal, first.id, {
      resolution: 'applied', toolOccurrenceId: 'child-0:1',
    });
    const restoredAgain = await store.get<Task>('task', parent.id, principal.id);
    assert.equal(restoredAgain?.data.state, 'waiting_for_children');
    assert.equal(restoredAgain?.data.reconciliationRestoration?.childTaskId, first.id);
    assert.equal(
      (await service.events(principal.id, parent.id)).filter((event) => event.data.type === 'child_reconciled').length,
      2,
    );

    const abandonedChild = await service.enqueue(principal, conversation.id, 'abandoned child');
    await store.put<Task>('task', abandonedChild.id, principal.id, {
      ...abandonedChild.data,
      state: 'unknown',
      error: 'Outcome unknown',
      orchestration: {
        rootTaskId: parent.id, parentTaskId: parent.id, planId: 'abandoned-child-plan', depth: 1,
        role: 'child', strategy: 'single', childKey: 'abandoned', budgetId: 'budget', phase: 'children', verification: 'pending',
      },
    }, abandonedChild.revision);
    await appendDispatch(store, abandonedChild.id, 2, { occurrence: 'abandoned:0', hash: '3'.repeat(64) });
    const plan = (await store.get<{ childIds: string[] }>('agent_plan', planId, principal.id))!;
    await store.put('agent_plan', plan.id, plan.ownerId, { ...plan.data, childIds: [abandonedChild.id] }, plan.revision);
    const currentParent = (await store.get<Task>('task', parent.id, principal.id))!;
    await store.put<Task>('task', currentParent.id, currentParent.ownerId, {
      ...currentParent.data,
      state: 'unknown',
      error: 'Delegated work requires attention: child outcome unknown',
      reconciliationRestoration: undefined,
    }, currentParent.revision);
    await service.reconcileOutcome(principal, abandonedChild.id, {
      resolution: 'abandon', toolOccurrenceId: 'abandoned:0',
    });
    assert.equal((await store.get<Task>('task', parent.id, principal.id))?.data.state, 'unknown');
  } finally {
    await service.close();
    await store.close();
  }
});
