import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { appendFile, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { AgentCoordinator, type OrchestrationPlan } from '../src/agents/coordinator.js';
import type { Principal, ToolDefinition } from '../src/contracts.js';
import type { Conversation, Task } from '../src/domain.js';
import { SqliteStore } from '../src/storage/sqlite.js';
import { TaskService, type TaskRunner } from '../src/tasks.js';
import { createWorkspaceTools } from '../src/tools/workspace.js';

const principal: Principal = {
  id: 'owner-1',
  level: 3,
  scopes: ['chat:read', 'task:read', 'workspace:read', 'workspace:write'],
  expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
};

const conversation = (workspaceId?: string): Conversation => ({
  title: 'Root work',
  scope: 'private',
  modelPolicy: 'cloud',
  strategy: 'single',
  mode: 'act',
  workspaceId,
  archived: false,
});

async function rootTask(store: SqliteStore, service: TaskService, workspaceId?: string) {
  const thread = await store.create('conversation', principal.id, conversation(workspaceId));
  return service.enqueue(principal, thread.id, 'Coordinate this work', 'root-task');
}

test('invalid delegation and over-budget adoption do not poison a corrected retry', async () => {
  const store = new SqliteStore();
  const service = new TaskService(store, async () => ({ text: 'unused' }));
  const coordinator = new AgentCoordinator(store);
  try {
    const parent = await rootTask(store, service);
    await assert.rejects(
      coordinator.prepare(principal.id, parent.id, {
        key: 'adoption-before-child',
        children: [{ key: 'worker', prompt: 'Do not run', profileId: 'missing-profile' }],
        budget: { maxCalls: 3, maxTokens: 20 },
      }, { parentRuntimeUsage: { calls: 1, totalTokens: 5 } }),
      hasCode('not_found'),
    );
    assert.equal((await store.scan('agent_plan', principal.id)).length, 0);
    assert.equal((await store.scan('agent_budget', principal.id)).length, 0);

    const corrected = {
      key: 'adoption-before-child',
      children: [{ key: 'worker', prompt: 'Run after validation' }],
      budget: { maxCalls: 3, maxTokens: 20 },
    };
    await assert.rejects(
      coordinator.prepare(principal.id, parent.id, corrected, { parentRuntimeUsage: { calls: 3, totalTokens: 21 } }),
      hasCode('budget_exceeded'),
    );
    const plans = await store.scan<{ childIds: string[]; state: string }>('agent_plan', principal.id);
    assert.equal(plans.length, 0);
    assert.equal((await store.scan('agent_plan_claim', principal.id)).length, 0);
    const plan = await coordinator.prepare(principal.id, parent.id, corrected, {
      parentRuntimeUsage: { calls: 2, totalTokens: 12 },
    });
    assert.equal(plan.data.state, 'waiting');
    assert.equal((await store.get<Task>('task', plan.data.childIds[0]!, principal.id))?.data.state, 'queued');
    assert.deepEqual((await coordinator.budgets.get(principal.id, plan.data.budgetId)).used, { calls: 2, tokens: 12 });
    const replay = await coordinator.prepare(principal.id, parent.id, corrected, {
      parentRuntimeUsage: { calls: 3, totalTokens: 15 },
    });
    assert.equal(replay.id, plan.id);
    assert.deepEqual((await coordinator.budgets.get(principal.id, plan.data.budgetId)).used, { calls: 3, tokens: 15 });
  } finally {
    await service.close();
    await store.close();
  }
});

test('invalid budget preflight does not reserve a parent plan claim', async () => {
  const store = new SqliteStore();
  const service = new TaskService(store, async () => ({ text: 'unused' }));
  const coordinator = new AgentCoordinator(store);
  try {
    const parent = await rootTask(store, service);
    await assert.rejects(
      coordinator.prepare(principal.id, parent.id, {
        key: 'invalid-limits',
        children: [{ key: 'worker', prompt: 'Do not reserve a claim' }],
        budget: { maxCalls: 0, maxTokens: 20 },
      }),
      hasCode('invalid_budget'),
    );
    assert.equal((await store.scan('agent_plan_claim', principal.id)).length, 0);
    assert.equal((await store.scan('agent_plan', principal.id)).length, 0);
    assert.equal((await store.scan('agent_budget', principal.id)).length, 0);

    const correctedLimits = await coordinator.prepare(principal.id, parent.id, {
      key: 'invalid-limits',
      children: [{ key: 'worker', prompt: 'Proceed with corrected limits' }],
      budget: { maxCalls: 3, maxTokens: 20 },
    });
    assert.equal(correctedLimits.data.state, 'waiting');

    const secondThread = await store.create('conversation', principal.id, conversation());
    const secondParent = await service.enqueue(principal, secondThread.id, 'Check existing limits', 'preflight-root');
    const budgetId = createHash('sha256').update(`${principal.id}\0${secondParent.id}\0budget`).digest('hex');
    await coordinator.budgets.create(principal.id, budgetId, secondParent.id, { maxCalls: 3, maxTokens: 20 });
    const claimsBeforeMismatch = (await store.scan('agent_plan_claim', principal.id)).length;
    await assert.rejects(
      coordinator.prepare(principal.id, secondParent.id, {
        key: 'incompatible-limits',
        children: [{ key: 'worker', prompt: 'Do not reserve a claim' }],
        budget: { maxCalls: 4, maxTokens: 20 },
      }),
      hasCode('idempotency_conflict'),
    );
    assert.equal((await store.scan('agent_plan_claim', principal.id)).length, claimsBeforeMismatch);
    assert.equal((await store.scan<OrchestrationPlan>('agent_plan', principal.id))
      .filter((plan) => plan.data.parentTaskId === secondParent.id).length, 0);

    const corrected = await coordinator.prepare(principal.id, secondParent.id, {
      key: 'incompatible-limits',
      children: [{ key: 'worker', prompt: 'Proceed with the existing limits' }],
      budget: { maxCalls: 3, maxTokens: 20 },
    });
    assert.equal(corrected.data.state, 'waiting');
  } finally {
    await service.close();
    await store.close();
  }
});

test('durable child runs a real workspace tool and parent integration remains verification-gated', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'kiancode-agent-workspace-'));
  const checkpoints = await mkdtemp(path.join(tmpdir(), 'kiancode-agent-checkpoints-'));
  const store = new SqliteStore();
  const tools = await createWorkspaceTools({ checkpointDirectory: checkpoints });
  const write = tools.find((tool) => tool.name === 'workspace.write') as ToolDefinition;
  const read = tools.find((tool) => tool.name === 'workspace.read') as ToolDefinition;
  let coordinator: AgentCoordinator;
  let parentRuns = 0;
  const runner: TaskRunner = async ({ task, workspace, signal, onEvent }) => {
    assert.ok(workspace);
    const isChild = task.data.orchestration?.role === 'child';
    if (!isChild) parentRuns += 1;
    const target = isChild ? 'child.txt' : 'integrated.txt';
    if (!isChild) {
      const readHash = `${task.id}:read-child`;
      await onEvent({ type: 'tool_dispatched', actionHash: readHash, sideEffect: 'read', toolCall: { id: readHash, name: 'workspace.read', arguments: { path: 'child.txt' } } });
      const readResult = await read.execute({ path: 'child.txt' }, { principal: task.data.principal, workspace, taskId: task.id, signal });
      await onEvent({ type: 'tool_result', actionHash: readHash, toolCallId: readHash, sideEffect: 'read', outcome: 'confirmed', isError: false, result: readResult });
    }
    const content = isChild
      ? 'durable child output\n'
      : `verified input: ${(await coordinator.results(task.ownerId, task.data.orchestration!.planId)).children[0]?.result}\n`;
    const actionHash = `${task.id}:write`;
    await onEvent({ type: 'tool_dispatched', actionHash, sideEffect: 'write', toolCall: { id: actionHash, name: 'workspace.write', arguments: { path: target } } });
    const result = await write.execute({ path: target, content }, {
      principal: task.data.principal,
      workspace,
      taskId: task.id,
      signal,
    });
    await onEvent({ type: 'tool_result', actionHash, toolCallId: actionHash, sideEffect: 'write', outcome: 'confirmed', isError: false, result });
    return { text: JSON.parse(result.content).sha256 as string };
  };
  const service = new TaskService(store, runner, { concurrency: 1, reauthorize: async (current) => current });
  coordinator = new AgentCoordinator(store, (ownerId, taskId, action) => service.control(ownerId, taskId, action));
  try {
    const workspace = await store.create('workspace', principal.id, {
      name: 'Shared',
      root,
      deviceId: 'server',
      capabilities: ['workspace:read', 'workspace:write'],
      allowCloud: true,
    });
    const parent = await rootTask(store, service, workspace.id);
    const plan = await coordinator.prepare(principal.id, parent.id, {
      key: 'implementation',
      children: [{ key: 'builder', prompt: 'Write the child output', scopes: ['workspace:write'] }],
      budget: { maxCalls: 4, maxTokens: 2_000 },
    });

    assert.equal((await store.get<Task>('task', parent.id, principal.id))?.data.state, 'waiting_for_children');
    assert.equal((await store.get<Task>('task', plan.data.childIds[0]!, principal.id))?.data.workspaceId, workspace.id);
    await service.drain();
    assert.equal(parentRuns, 0, 'waiting parent must not occupy the only scheduler slot');
    assert.equal(await readFile(path.join(root, 'child.txt'), 'utf8'), 'durable child output\n');

    const childResults = await coordinator.results(principal.id, plan.id);
    assert.equal(childResults.ready, true);
    assert.equal(childResults.successful, true);
    assert.equal(childResults.verificationRequired, true);
    const childEvents = await service.events(principal.id, plan.data.childIds[0]!);
    assert.deepEqual(childEvents.map((event) => event.data.type), ['queued', 'tool_dispatched', 'tool_result', 'completed']);

    await coordinator.queueIntegration(principal.id, plan.id);
    await service.drain();
    assert.equal(parentRuns, 1);
    assert.match(await readFile(path.join(root, 'integrated.txt'), 'utf8'), /verified input: [a-f0-9]{64}/);
    assert.equal((await coordinator.results(principal.id, plan.id)).verificationRequired, true);

    const verified = await coordinator.verifyIntegration(principal.id, plan.id);
    assert.equal(verified.data.state, 'completed');
    assert.equal((await store.get<Task>('task', parent.id, principal.id))?.data.orchestration?.verification, 'passed');
  } finally {
    await service.close();
    await store.close();
    await rm(root, { recursive: true, force: true });
    await rm(checkpoints, { recursive: true, force: true });
  }
});

test('restart reuses deterministic child records and never repeats a confirmed side effect', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'kiancode-agent-restart-'));
  const database = path.join(directory, 'state.sqlite');
  const effectLog = path.join(directory, 'external-effects.log');
  let runs = 0;
  const request = {
    key: 'restart-safe',
    children: [{ key: 'worker', prompt: 'Perform once' }],
    budget: { maxCalls: 2, maxTokens: 100 },
  };
  let planId = '';
  try {
    let store = new SqliteStore(database);
    const runner: TaskRunner = async ({ task, onEvent }) => {
      if (task.data.orchestration?.role === 'child') {
        runs += 1;
        const actionHash = `${task.id}:external`;
        await onEvent({ type: 'tool_dispatched', actionHash, sideEffect: 'external' });
        await appendFile(effectLog, 'confirmed\n');
        await onEvent({ type: 'tool_result', actionHash, sideEffect: 'external', outcome: 'confirmed' });
      }
      return { text: 'done' };
    };
    let service = new TaskService(store, runner, { reauthorize: async (current) => current });
    const parent = await rootTask(store, service);
    const first = await new AgentCoordinator(store).prepare(principal.id, parent.id, request);
    planId = first.id;
    const childId = first.data.childIds[0]!;
    await assert.rejects(
      new AgentCoordinator(store).prepare(principal.id, parent.id, {
        ...request,
        key: 'accidental-new-key',
      }),
      hasCode('active_child_plan'),
    );
    await service.drain();
    assert.equal(await readFile(effectLog, 'utf8'), 'confirmed\n');
    await service.close();
    await store.close();

    store = new SqliteStore(database);
    service = new TaskService(store, runner, { reauthorize: async (current) => current });
    const coordinator = new AgentCoordinator(store);
    const replay = await coordinator.prepare(principal.id, parent.id, request);
    assert.equal(replay.id, planId);
    assert.equal(replay.data.childIds[0], childId);
    assert.equal((await store.scan<Task>('task', principal.id)).length, 2);
    await service.drain();
    await service.drain();
    assert.equal(runs, 1);
    assert.equal(await readFile(effectLog, 'utf8'), 'confirmed\n');
    assert.equal((await store.get<Task>('task', childId, principal.id))?.data.state, 'completed');
    await service.close();
    await store.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('parent plan claims serialize different keys and keep same-key retries idempotent', async () => {
  const store = new SqliteStore();
  const service = new TaskService(store, async () => ({ text: 'unused' }));
  const coordinator = new AgentCoordinator(store);
  try {
    const parent = await rootTask(store, service);
    const different = await Promise.allSettled([
      coordinator.prepare(principal.id, parent.id, {
        key: 'parallel-a',
        children: [{ key: 'worker-a', prompt: 'Work A' }],
        budget: { maxCalls: 5, maxTokens: 100 },
      }),
      coordinator.prepare(principal.id, parent.id, {
        key: 'parallel-b',
        children: [{ key: 'worker-b', prompt: 'Work B' }],
        budget: { maxCalls: 5, maxTokens: 100 },
      }),
    ]);
    const accepted = different.filter((result) => result.status === 'fulfilled');
    const rejected = different.filter((result) => result.status === 'rejected');
    assert.equal(accepted.length, 1);
    assert.equal(rejected.length, 1);
    assert.equal(rejected[0]?.reason?.code, 'active_child_plan');
    assert.equal((await store.scan<OrchestrationPlan>('agent_plan', principal.id))
      .filter((plan) => plan.data.parentTaskId === parent.id).length, 1);
    assert.equal((await store.scan<Task>('task', principal.id))
      .filter((task) => task.data.orchestration?.parentTaskId === parent.id).length, 1);

    await coordinator.propagateControl(principal.id, parent.id, 'cancel');
    const next = await coordinator.prepare(principal.id, parent.id, {
      key: 'after-cancel',
      children: [{ key: 'replacement', prompt: 'Continue after cancellation' }],
    });
    assert.equal(next.data.state, 'waiting');
    assert.equal(next.data.budgetId, accepted[0]!.value.data.budgetId);

    const retryThread = await store.create('conversation', principal.id, conversation());
    const retryParent = await service.enqueue(principal, retryThread.id, 'Retry concurrently', 'retry-root');
    const request = {
      key: 'parallel-retry',
      children: [{ key: 'worker', prompt: 'Run once' }],
      budget: { maxCalls: 5, maxTokens: 100 },
    };
    const same = await Promise.all([
      coordinator.prepare(principal.id, retryParent.id, request),
      coordinator.prepare(principal.id, retryParent.id, request),
    ]);
    assert.equal(same[0].id, same[1].id);
    assert.equal((await store.scan<OrchestrationPlan>('agent_plan', principal.id))
      .filter((plan) => plan.data.parentTaskId === retryParent.id).length, 1);
    assert.equal((await store.scan<Task>('task', principal.id))
      .filter((task) => task.data.orchestration?.parentTaskId === retryParent.id).length, 1);
  } finally {
    await service.close();
    await store.close();
  }
});

test('completed plans remain idempotent while a stopped parent cannot start another key', async () => {
  const store = new SqliteStore();
  const service = new TaskService(store, async () => ({ text: 'done' }));
  const coordinator = new AgentCoordinator(store);
  const request = {
    key: 'completed-plan',
    children: [{ key: 'worker', prompt: 'Complete once' }],
    budget: { maxCalls: 5, maxTokens: 100 },
  };
  try {
    const parent = await rootTask(store, service);
    const plan = await coordinator.prepare(principal.id, parent.id, request);
    await service.drain();
    await coordinator.queueIntegration(principal.id, plan.id);
    await service.drain();
    const completed = await coordinator.verifyIntegration(principal.id, plan.id);
    assert.equal(completed.data.state, 'completed');
    assert.equal((await coordinator.prepare(principal.id, parent.id, request)).id, plan.id);
    await assert.rejects(
      coordinator.prepare(principal.id, parent.id, {
        key: 'after-completion',
        children: [{ key: 'new-worker', prompt: 'Must not restart a stopped parent' }],
      }),
      hasCode('terminal_task'),
    );
  } finally {
    await service.close();
    await store.close();
  }
});

test('depth, child count, account slots, scopes, levels, grants, and shared budget cannot expand', async () => {
  const store = new SqliteStore();
  const service = new TaskService(store, async () => ({ text: 'done' }));
  const coordinator = new AgentCoordinator(store);
  try {
    const parent = await rootTask(store, service);
    await assert.rejects(
      coordinator.prepare(principal.id, parent.id, {
        key: 'too-many-experts',
        strategy: 'experts',
        children: [1, 2, 3].map((number) => ({ key: `expert-${number}`, prompt: 'work' })),
        budget: { maxCalls: 5, maxTokens: 100 },
      }),
      hasCode('invalid_child_count'),
    );
    await assert.rejects(
      coordinator.prepare(principal.id, parent.id, {
        key: 'scope-expansion',
        children: [{ key: 'bad-scope', prompt: 'work', scopes: ['admin:write'] }],
        budget: { maxCalls: 5, maxTokens: 100 },
      }),
      hasCode('scope_expansion'),
    );
    await assert.rejects(
      coordinator.prepare(principal.id, parent.id, {
        key: 'level-expansion',
        children: [{ key: 'bad-level', prompt: 'work', level: 2 }],
        budget: { maxCalls: 5, maxTokens: 100 },
      }),
      hasCode('level_expansion'),
    );
    await assert.rejects(
      coordinator.prepare(principal.id, parent.id, {
        key: 'grant-expansion',
        children: [{ key: 'bad-grant', prompt: 'work', grantExpiresAt: new Date(Date.now() + 7_200_000).toISOString() }],
        budget: { maxCalls: 5, maxTokens: 100 },
      }),
      hasCode('grant_expansion'),
    );

    const first = await coordinator.prepare(principal.id, parent.id, {
      key: 'level-one',
      children: [{ key: 'worker', prompt: 'work', scopes: ['workspace:read'], level: 4 }],
      budget: { maxCalls: 5, maxTokens: 100 },
    });
    const child = (await coordinator.runChildren(principal.id, first.id))[0]!;
    assert.deepEqual(child.data.principal.scopes, ['workspace:read']);
    assert.equal(child.data.principal.level, 4);

    await assert.rejects(
      coordinator.prepare(principal.id, child.id, {
        key: 'budget-change',
        children: [{ key: 'grandchild', prompt: 'work' }],
        budget: { maxCalls: 99, maxTokens: 99 },
      }),
      hasCode('budget_expansion'),
    );
    const nested = await coordinator.prepare(principal.id, child.id, {
      key: 'level-two',
      children: [{ key: 'grandchild', prompt: 'work' }],
    });
    const grandchild = (await coordinator.runChildren(principal.id, nested.id))[0]!;
    assert.equal(grandchild.data.orchestration?.depth, 2);
    assert.equal(grandchild.data.orchestration?.budgetId, child.data.orchestration?.budgetId);
    await assert.rejects(
      coordinator.prepare(principal.id, grandchild.id, {
        key: 'level-three',
        children: [{ key: 'forbidden', prompt: 'work' }],
      }),
      hasCode('max_agent_depth'),
    );

    const anotherThread = await store.create('conversation', principal.id, conversation());
    const anotherParent = await service.enqueue(principal, anotherThread.id, 'Other root', 'other-root');
    const second = await coordinator.prepare(principal.id, anotherParent.id, {
      key: 'third-active-slot',
      children: [{ key: 'third', prompt: 'work' }],
      budget: { maxCalls: 2, maxTokens: 100 },
    });
    assert.equal(second.data.childIds.length, 1);
    const lastThread = await store.create('conversation', principal.id, conversation());
    const lastParent = await service.enqueue(principal, lastThread.id, 'Last root', 'last-root');
    await assert.rejects(
      coordinator.prepare(principal.id, lastParent.id, {
        key: 'fourth-active-slot',
        children: [{ key: 'fourth', prompt: 'work' }],
        budget: { maxCalls: 2, maxTokens: 100 },
      }),
      hasCode('too_many_active_children'),
    );
  } finally {
    await service.close();
    await store.close();
  }
});

test('parent cancellation propagates through TaskService and aborts a running child', async () => {
  const store = new SqliteStore();
  let started: (() => void) | undefined;
  const childStarted = new Promise<void>((resolve) => { started = resolve; });
  const service = new TaskService(store, async ({ task, signal }) => {
    if (task.data.orchestration?.role !== 'child') return { text: 'parent' };
    started?.();
    await new Promise<void>((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    });
    return { text: 'unreachable' };
  }, { concurrency: 1 });
  const coordinator = new AgentCoordinator(store, (ownerId, taskId, action) => service.control(ownerId, taskId, action));
  try {
    const parent = await rootTask(store, service);
    const plan = await coordinator.prepare(principal.id, parent.id, {
      key: 'cancel',
      children: [{ key: 'worker', prompt: 'wait' }],
      budget: { maxCalls: 2, maxTokens: 100 },
    });
    service.start(5);
    await childStarted;
    await service.control(principal.id, parent.id, 'cancel');
    await coordinator.propagateControl(principal.id, parent.id, 'cancel');
    await waitFor(async () => (await store.get<Task>('task', plan.data.childIds[0]!, principal.id))?.data.state === 'cancelled');
    assert.equal((await store.get<Task>('task', parent.id, principal.id))?.data.state, 'cancelled');
    assert.equal((await coordinator.results(principal.id, plan.id)).children[0]?.state, 'cancelled');
  } finally {
    await service.close();
    await store.close();
  }
});

test('MoA is capped at three durable candidates and claims exactly one parent aggregation', async () => {
  const store = new SqliteStore();
  const service = new TaskService(store, async ({ task }) => ({ text: `candidate:${task.data.orchestration?.childKey}` }));
  const coordinator = new AgentCoordinator(store);
  try {
    const parent = await rootTask(store, service);
    const plan = await coordinator.prepare(principal.id, parent.id, {
      key: 'moa',
      strategy: 'moa',
      children: ['a', 'b', 'c'].map((key) => ({ key, prompt: `Candidate ${key}` })),
      budget: { maxCalls: 8, maxTokens: 2_000 },
    });
    assert.equal((await coordinator.runChildren(principal.id, plan.id)).every((task) => task.data.orchestration?.strategy === 'moa'), true);
    assert.equal((await coordinator.runChildren(principal.id, plan.id)).every((task) => task.data.orchestration?.budgetId === plan.data.budgetId), true);
    await service.drain();
    const results = await coordinator.results(principal.id, plan.id);
    assert.equal(results.aggregateRequired, true);
    assert.equal(results.children.length, 3);
    const queued = await coordinator.queueIntegration(principal.id, plan.id);
    const replay = await coordinator.queueIntegration(principal.id, plan.id);
    assert.equal(replay.id, queued.id);
    assert.equal(replay.data.state, 'queued');
    assert.equal((await store.scan<Task>('task', principal.id)).filter((task) => task.id === parent.id).length, 1);
  } finally {
    await service.close();
    await store.close();
  }
});

function hasCode(code: string): (error: unknown) => boolean {
  return (error) => error instanceof Error && 'code' in error && error.code === code;
}

async function waitFor(predicate: () => Promise<boolean>): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (await predicate()) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('Timed out');
}
