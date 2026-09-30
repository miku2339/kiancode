import assert from 'node:assert/strict';
import test from 'node:test';
import { AgentCoordinator, type OrchestrationPlan } from '../src/agents/coordinator.js';
import { createTaskRunner, reconcileAgentTasks } from '../src/runtime-adapter.js';
import { AgentRuntime, type ModelProvider } from '../src/runtime/index.js';
import { SqliteStore } from '../src/storage/sqlite.js';
import { TaskService } from '../src/tasks.js';
import type { Conversation, Task } from '../src/domain.js';
import { DomainError } from '../src/contracts.js';

const principal = { id: 'owner', level: 1 as const, scopes: ['*'], expiresAt: new Date(Date.now() + 3_600_000).toISOString() };

test('agent.delegate creates one durable restricted child and resumes the parent from its checkpoint', async () => {
  const store = new SqliteStore();
  const calls: Array<{ taskId: string; tools: string[]; integration: boolean }> = [];
  let parentId = '';
  const provider: ModelProvider = { id: 'model', locality: 'cloud', async chat(request) {
    const integration = request.messages.some((message) => message.role === 'user'
      && message.content.startsWith('Integrate these delegated results'));
    calls.push({ taskId: request.context!.taskId, tools: request.tools.map((tool) => tool.name), integration });
    if (request.context!.taskId === parentId && !integration) {
      return {
        message: {
          role: 'assistant',
          content: '',
          toolCalls: [{
            id: 'delegate-once',
            name: 'agent.delegate',
            arguments: { prompt: 'Inspect the evidence independently.', childKey: 'researcher' },
          }],
        },
        usage: { inputTokens: 10, outputTokens: 4 },
      };
    }
    return {
      message: { role: 'assistant', content: integration ? 'Integrated the durable child result.' : 'Independent evidence.' },
      usage: { inputTokens: 8, outputTokens: 5 },
    };
  } };
  const runtime = new AgentRuntime({
    providers: [provider],
    models: [{ id: 'model', providerId: 'model', locality: 'cloud', capabilities: ['streaming', 'tools'] }],
  });
  const coordinator = new AgentCoordinator(store);
  const runner = createTaskRunner(store, runtime, [], undefined, coordinator);
  let tasks = new TaskService(store, runner, { reauthorize: async (current) => current });
  try {
    const conversation = await store.create<Conversation>('conversation', principal.id, {
      title: 'Delegate', scope: 'private', modelPolicy: 'cloud', strategy: 'single', mode: 'ask', archived: false,
    });
    const parent = await tasks.enqueue(principal, conversation.id, 'Research this');
    parentId = parent.id;
    await tasks.drain();

    const waiting = (await store.get<Task>('task', parent.id, principal.id))!;
    assert.equal(waiting.data.state, 'waiting_for_children');
    assert.equal((waiting.data.runtimeMessages as Array<{ role?: string; name?: string }>).some((message) => message.role === 'tool' && message.name === 'agent.delegate'), true);
    const plan = (await store.scan<OrchestrationPlan>('agent_plan', principal.id))[0]!;
    assert.equal(plan.data.childIds.length, 1);
    const child = (await store.get<Task>('task', plan.data.childIds[0]!, principal.id))!;
    assert.equal(child.data.state, 'completed', child.data.error);
    assert.equal(child.data.orchestration?.strategy, 'single');
    assert.equal(child.data.principal.level, parent.data.principal.level);
    assert.equal(child.data.principal.scopes.includes('workspace:write'), false);
    assert.equal(child.data.principal.scopes.includes('shell:execute'), false);
    assert.equal(child.data.principal.scopes.includes('agent:write'), false);
    assert.equal(child.data.orchestration?.budgetId, waiting.data.orchestration?.budgetId);

    await tasks.close();
    tasks = new TaskService(store, runner, { reauthorize: async (current) => current });
    await reconcileAgentTasks(store, coordinator);
    await tasks.drain();
    await reconcileAgentTasks(store, coordinator);

    const completed = (await store.get<Task>('task', parent.id, principal.id))!;
    assert.equal(completed.data.state, 'completed', completed.data.error);
    assert.equal(completed.data.result, 'Integrated the durable child result.');
    assert.equal((await coordinator.budgets.get(principal.id, plan.data.budgetId)).used.calls, 3);
    assert.equal(calls.filter((call) => call.taskId === parent.id).length, 2);
    assert.equal(calls.find((call) => call.taskId === parent.id && !call.integration)?.tools.includes('agent.delegate'), true);
    assert.equal(calls.find((call) => call.taskId === parent.id && call.integration)?.tools.includes('agent.delegate'), false);
    await reconcileAgentTasks(store, coordinator);
    await tasks.drain();
    assert.equal(calls.length, 3);
  } finally { await tasks.close(); await store.close(); }
});

test('agent.delegate rejects an unavailable profile before persistence and permits a corrected retry', async () => {
  const store = new SqliteStore();
  let parentId = '';
  let parentCalls = 0;
  let exposedProfile = false;
  const provider: ModelProvider = { id: 'model', locality: 'cloud', async chat(request) {
    if (request.context!.taskId === parentId) {
      parentCalls += 1;
      const delegate = request.tools.find((tool) => tool.name === 'agent.delegate');
      exposedProfile ||= Boolean((delegate?.inputSchema.properties as Record<string, unknown> | undefined)?.profileId);
      return {
        message: {
          role: 'assistant',
          content: '',
          toolCalls: [{
            id: `delegate-${parentCalls}`,
            name: 'agent.delegate',
            arguments: parentCalls === 1
              ? { prompt: 'Inspect independently.', childKey: 'worker', profileId: 'invented-default' }
              : { prompt: 'Inspect independently.', childKey: 'worker' },
          }],
        },
        usage: { inputTokens: 5, outputTokens: 3 },
      };
    }
    return { message: { role: 'assistant', content: 'Child evidence.' }, usage: { inputTokens: 4, outputTokens: 2 } };
  } };
  const runtime = new AgentRuntime({
    providers: [provider],
    models: [{ id: 'model', providerId: 'model', locality: 'cloud', capabilities: ['streaming', 'tools'] }],
  });
  const coordinator = new AgentCoordinator(store);
  const tasks = new TaskService(store, createTaskRunner(store, runtime, [], undefined, coordinator), {
    reauthorize: async (current) => current,
  });
  try {
    const conversation = await store.create<Conversation>('conversation', principal.id, {
      title: 'Retry delegate', scope: 'private', modelPolicy: 'cloud', strategy: 'single', mode: 'ask', archived: false,
    });
    const parent = await tasks.enqueue(principal, conversation.id, 'Delegate once');
    parentId = parent.id;
    await tasks.drain();

    assert.equal(exposedProfile, false);
    assert.equal(parentCalls, 2);
    const plans = await store.scan<OrchestrationPlan>('agent_plan', principal.id);
    assert.equal(plans.length, 1);
    assert.equal(plans[0]?.data.state, 'waiting');
    assert.equal((await store.get<Task>('task', plans[0]!.data.childIds[0]!, principal.id))?.data.state, 'completed');
    assert.deepEqual((await coordinator.budgets.get(principal.id, plans[0]!.data.budgetId)).used, {
      calls: 3,
      tokens: 22,
    });
  } finally { await tasks.close(); await store.close(); }
});

test('MoA creates durable single-agent children, shares calls and integrates once after a scheduler restart', async () => {
  const store = new SqliteStore();
  const calls: string[] = [];
  const provider: ModelProvider = { id: 'model', locality: 'cloud', async chat(request) {
    calls.push(request.context!.taskId);
    return { message: { role: 'assistant', content: request.messages.at(-1)!.content.startsWith('Integrate') ? 'Checked the three proposals.' : 'A supported proposal.' }, usage: { inputTokens: 8, outputTokens: 6 } };
  } };
  const runtime = new AgentRuntime({ providers: [provider], models: [{ id: 'model', providerId: 'model', locality: 'cloud', capabilities: ['streaming'] }] });
  const coordinator = new AgentCoordinator(store);
  const runner = createTaskRunner(store, runtime, [], undefined, coordinator);
  let tasks = new TaskService(store, runner);
  try {
    const conversation = await store.create<Conversation>('conversation', principal.id, { title: 'Compare', scope: 'private', modelPolicy: 'cloud', strategy: 'moa', mode: 'ask', archived: false });
    const root = await tasks.enqueue(principal, conversation.id, 'Compare the approaches');
    await tasks.drain();
    const waiting = (await store.get<Task>('task', root.id, principal.id))!;
    assert.equal(waiting.data.state, 'waiting_for_children');
    const planId = waiting.data.orchestration!.planId;
    assert.equal((await coordinator.results(principal.id, planId)).children.length, 3);
    await tasks.close();
    tasks = new TaskService(store, runner);
    await tasks.drain();
    await reconcileAgentTasks(store, coordinator);
    await tasks.drain();
    await reconcileAgentTasks(store, coordinator);
    assert.equal((await store.get<Task>('task', root.id, principal.id))?.data.state, 'completed');
    assert.equal(calls.length, 4);
    assert.equal(calls.filter((id) => id === root.id).length, 1);
    const results = await coordinator.results(principal.id, planId);
    assert.equal(results.plan.data.state, 'completed');
    assert.equal((await coordinator.budgets.get(principal.id, results.plan.data.budgetId)).used.calls, 4);
    await reconcileAgentTasks(store, coordinator);
    await tasks.drain();
    assert.equal(calls.length, 4);
  } finally { await tasks.close(); await store.close(); }
});

test('a failed child blocks aggregation and reports the actual failed child', async () => {
  const store = new SqliteStore();
  const coordinator = new AgentCoordinator(store);
  const tasks = new TaskService(store, async () => { throw new Error('Provider unavailable'); });
  try {
    const conversation = await store.create<Conversation>('conversation', principal.id, { title: 'Compare', scope: 'private', modelPolicy: 'local', strategy: 'moa', mode: 'ask', archived: false });
    const root = await tasks.enqueue(principal, conversation.id, 'Compare locally');
    const plan = await coordinator.prepare(principal.id, root.id, { key: 'initial', strategy: 'single', budget: { maxCalls: 5, maxTokens: 1000 }, children: [{ key: 'worker', prompt: 'Inspect' }] });
    await tasks.drain();
    await reconcileAgentTasks(store, coordinator);
    const parent = (await store.get<Task>('task', root.id, principal.id))!;
    assert.equal(parent.data.state, 'failed');
    assert.match(parent.data.error!, /worker: failed/);
    assert.equal((await coordinator.results(principal.id, plan.id)).plan.data.aggregationClaimed, false);
  } finally { await tasks.close(); await store.close(); }
});

test('an unknown child outcome propagates to the parent without blind retry', async () => {
  const store = new SqliteStore();
  const coordinator = new AgentCoordinator(store);
  let childRuns = 0;
  const tasks = new TaskService(store, async ({ task, onEvent }) => {
    if (task.data.orchestration?.role !== 'child') return { text: 'parent' };
    childRuns += 1;
    const actionHash = `${task.id}:external`;
    await onEvent({
      type: 'tool_dispatched',
      actionHash,
      sideEffect: 'external',
      toolCall: { id: actionHash, name: 'plugin.call', arguments: {} },
    });
    await onEvent({
      type: 'tool_result', actionHash, toolCallId: actionHash, sideEffect: 'external', outcome: 'unknown', isError: true,
    });
    throw new DomainError('outcome_unknown', 'Dispatch result was not confirmed', 409);
  }, { reauthorize: async (current) => current });
  try {
    const conversation = await store.create<Conversation>('conversation', principal.id, {
      title: 'Unknown', scope: 'private', modelPolicy: 'cloud', strategy: 'single', mode: 'act', archived: false,
    });
    const parent = await tasks.enqueue(principal, conversation.id, 'Delegate external work');
    const plan = await coordinator.prepare(principal.id, parent.id, {
      key: 'unknown-child',
      children: [{ key: 'worker', prompt: 'Dispatch once' }],
      budget: { maxCalls: 2, maxTokens: 100 },
    });
    await tasks.drain();
    assert.equal((await coordinator.results(principal.id, plan.id)).children[0]?.state, 'unknown');
    await reconcileAgentTasks(store, coordinator);
    assert.equal((await store.get<Task>('task', parent.id, principal.id))?.data.state, 'unknown');
    await tasks.drain();
    await reconcileAgentTasks(store, coordinator);
    assert.equal(childRuns, 1);
    assert.equal((await store.get<Task>('task', parent.id, principal.id))?.data.state, 'unknown');
  } finally { await tasks.close(); await store.close(); }
});

test('automatic integration verification requires a correlated inspection after child side effects', async () => {
  const store = new SqliteStore();
  const coordinator = new AgentCoordinator(store);
  const tasks = new TaskService(store, async ({ task, onEvent }) => {
    const child = task.data.orchestration?.role === 'child';
    const actionHash = `${task.id}:${child ? 'write' : 'unrelated'}`;
    await onEvent({
      type: 'tool_dispatched',
      actionHash,
      sideEffect: child ? 'write' : 'external',
      toolCall: { id: actionHash, name: child ? 'workspace.write' : 'plugin.call', arguments: child ? { path: 'result.txt' } : {} },
    });
    await onEvent({
      type: 'tool_result',
      actionHash,
      toolCallId: actionHash,
      outcome: 'confirmed',
      isError: false,
    });
    return { text: 'done' };
  }, { reauthorize: async (current) => current });
  try {
    const conversation = await store.create<Conversation>('conversation', principal.id, {
      title: 'Verify', scope: 'private', modelPolicy: 'local', strategy: 'single', mode: 'act', archived: false,
    });
    const root = await tasks.enqueue(principal, conversation.id, 'Implement');
    const plan = await coordinator.prepare(principal.id, root.id, {
      key: 'verify',
      children: [{ key: 'worker', prompt: 'Change state' }],
      budget: { maxCalls: 2, maxTokens: 100 },
    });
    await tasks.drain();
    await reconcileAgentTasks(store, coordinator);
    await tasks.drain();
    await reconcileAgentTasks(store, coordinator);
    assert.equal((await coordinator.results(principal.id, plan.id)).plan.data.state, 'integrating');

    const startedAt = (await coordinator.results(principal.id, plan.id)).plan.updatedAt;
    for (const [sequence, name, path] of [
      [90, 'workspace.list', '.'],
      [92, 'workspace.read', 'unrelated.txt'],
    ] as const) {
      const actionHash = `unrelated-${sequence}`;
      await store.create('event', principal.id, {
        taskId: root.id,
        sequence,
        type: 'tool_dispatched',
        payload: { type: 'tool_dispatched', actionHash, sideEffect: 'read', toolCall: { id: actionHash, name, arguments: { path } } },
        at: startedAt,
      }, `${root.id}:${actionHash}-dispatched`);
      await store.create('event', principal.id, {
        taskId: root.id,
        sequence: sequence + 1,
        type: 'tool_result',
        payload: { type: 'tool_result', actionHash, toolCallId: actionHash, outcome: 'confirmed', isError: false },
        at: startedAt,
      }, `${root.id}:${actionHash}-result`);
    }
    await reconcileAgentTasks(store, coordinator);
    assert.equal((await coordinator.results(principal.id, plan.id)).plan.data.state, 'integrating');
    await assert.rejects(
      coordinator.verifyIntegration(principal.id, plan.id, 'A list command completed.'),
      (error: unknown) => error instanceof Error && 'code' in error && error.code === 'verification_required',
    );

    await store.create('event', principal.id, {
      taskId: root.id,
      sequence: 100,
      type: 'tool_dispatched',
      payload: {
        type: 'tool_dispatched',
        actionHash: 'inspection',
        sideEffect: 'read',
        toolCall: { id: 'inspection', name: 'workspace.read', arguments: { path: 'result.txt' } },
      },
      at: startedAt,
    }, `${root.id}:inspection-dispatched`);
    await store.create('event', principal.id, {
      taskId: root.id,
      sequence: 101,
      type: 'tool_result',
      payload: {
        type: 'tool_result', actionHash: 'inspection', toolCallId: 'inspection', outcome: 'confirmed', isError: false,
      },
      at: startedAt,
    }, `${root.id}:inspection-result`);
    await reconcileAgentTasks(store, coordinator);
    assert.equal((await coordinator.results(principal.id, plan.id)).plan.data.state, 'completed');
  } finally { await tasks.close(); await store.close(); }
});

test('reconciliation finishes a parent verification interrupted after the plan commit', async () => {
  const store = new SqliteStore();
  const coordinator = new AgentCoordinator(store);
  const tasks = new TaskService(store, async () => ({ text: 'done' }));
  try {
    const conversation = await store.create<Conversation>('conversation', principal.id, {
      title: 'Recover verification',
      scope: 'private',
      modelPolicy: 'cloud',
      strategy: 'single',
      mode: 'ask',
      archived: false,
    });
    const parent = await tasks.enqueue(principal, conversation.id, 'Coordinate');
    const plan = await coordinator.prepare(principal.id, parent.id, {
      key: 'recover-verification',
      budget: { maxCalls: 2, maxTokens: 100 },
      children: [{ key: 'worker', prompt: 'Inspect' }],
    });
    const currentPlan = (await store.get<typeof plan.data>('agent_plan', plan.id, principal.id))!;
    await store.put('agent_plan', plan.id, principal.id, {
      ...currentPlan.data,
      state: 'completed',
      verification: { at: new Date().toISOString(), evidence: 'Verified before interruption.' },
    }, currentPlan.revision);
    const currentParent = (await store.get<Task>('task', parent.id, principal.id))!;
    await store.put('task', parent.id, principal.id, {
      ...currentParent.data,
      state: 'completed',
      orchestration: { ...currentParent.data.orchestration!, phase: 'integration', verification: 'pending' },
    }, currentParent.revision);

    await reconcileAgentTasks(store, coordinator);

    assert.equal(
      (await store.get<Task>('task', parent.id, principal.id))?.data.orchestration?.verification,
      'passed',
    );
  } finally {
    await tasks.close();
    await store.close();
  }
});
