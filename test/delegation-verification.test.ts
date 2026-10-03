import assert from 'node:assert/strict';
import test from 'node:test';
import { AgentCoordinator, type OrchestrationPlan } from '../src/agents/coordinator.js';
import type { Principal, ToolDefinition } from '../src/contracts.js';
import type { Conversation, Task } from '../src/domain.js';
import { createTaskRunner, reconcileAgentTasks } from '../src/runtime-adapter.js';
import { AgentRuntime, type ModelProvider, type RunInput, type RunResult, type RuntimeEvent } from '../src/runtime/index.js';
import { SqliteStore } from '../src/storage/sqlite.js';
import type { Entity, Store } from '../src/storage/store.js';
import { TaskService } from '../src/tasks.js';

const principal: Principal = {
  id: 'owner',
  level: 1,
  scopes: ['*'],
  expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
};

interface Step {
  tool: string;
  arguments?: Record<string, unknown>;
  sideEffect?: 'read' | 'write' | 'external';
  failed?: boolean;
  unconfirmed?: boolean;
  result?: unknown;
}

type Emit = (event: { type: string; [key: string]: unknown }) => Promise<void>;

async function emit(onEvent: Emit, taskId: string, steps: Step[]): Promise<void> {
  for (const [index, step] of steps.entries()) {
    const actionHash = `${taskId}:${index}:${step.tool}`;
    const sideEffect = step.sideEffect ?? 'read';
    await onEvent({
      type: 'tool_dispatched',
      actionHash,
      sideEffect,
      toolCall: { id: actionHash, name: step.tool, arguments: step.arguments ?? {} },
    });
    if (step.unconfirmed) continue;
    await onEvent({
      type: 'tool_result',
      actionHash,
      toolCallId: actionHash,
      sideEffect,
      outcome: step.failed ? 'failed' : 'confirmed',
      isError: step.failed ?? false,
      ...(step.result === undefined ? {} : { result: step.result }),
    });
  }
}

interface Delegation {
  parentId: string;
  planId: string;
  childIds: string[];
}

async function startDelegation(
  store: Store,
  service: TaskService,
  coordinator: AgentCoordinator,
  childKeys: string[] = ['worker'],
): Promise<Delegation> {
  const conversation = await store.create<Conversation>('conversation', principal.id, {
    title: 'Delegation', scope: 'private', modelPolicy: 'cloud', strategy: 'single', mode: 'act', archived: false,
  });
  const parent = await service.enqueue(principal, conversation.id, 'Coordinate the work');
  const plan = await coordinator.prepare(principal.id, parent.id, {
    key: 'work',
    strategy: childKeys.length > 1 ? 'experts' : 'single',
    children: childKeys.map((key) => ({ key, prompt: `Do the ${key} part` })),
    budget: { maxCalls: 12, maxTokens: 8_000 },
  });
  return { parentId: parent.id, planId: plan.id, childIds: plan.data.childIds };
}

const isChild = (task: Entity<Task>): boolean => task.data.orchestration?.role === 'child';

test('a child side effect needs its own exact action approval', async () => {
  const store = new SqliteStore();
  const executed: string[] = [];
  const external: ToolDefinition = {
    name: 'plugin.call',
    description: 'Call a plugin.',
    inputSchema: { type: 'object', properties: {} },
    requiredCapabilities: [],
    sideEffect: 'external',
    async execute() {
      executed.push('plugin.call');
      return { content: 'sent' };
    },
  };
  const provider: ModelProvider = { id: 'model', locality: 'cloud', async chat(request) {
    return request.messages.at(-1)?.role === 'tool'
      ? { message: { role: 'assistant', content: 'sent' }, usage: { inputTokens: 1, outputTokens: 1 } }
      : {
          message: { role: 'assistant', content: '', toolCalls: [{ id: 'send', name: 'plugin.call', arguments: {} }] },
          usage: { inputTokens: 1, outputTokens: 1 },
        };
  } };
  const runtime = new AgentRuntime({
    providers: [provider],
    models: [{ id: 'model', providerId: 'model', locality: 'cloud', capabilities: ['streaming', 'tools'] }],
    tools: [external],
  });
  const coordinator = new AgentCoordinator(store);
  const service = new TaskService(store, createTaskRunner(store, runtime, [external], undefined, coordinator), {
    reauthorize: async (current) => current,
  });
  try {
    const { childIds } = await startDelegation(store, service, coordinator);
    await service.drain();
    const child = (await store.get<Task>('task', childIds[0]!, principal.id))!;
    assert.equal(child.data.state, 'waiting_for_approval');
    assert.deepEqual(executed, []);
    await assert.rejects(service.control(principal.id, child.id, 'resume', ['0'.repeat(64)], principal),
      (error: unknown) => error instanceof Error && 'code' in error && error.code === 'invalid_approval');
    await service.control(principal.id, child.id, 'resume', child.data.pendingActions.map((action) => action.hash), principal);
    await service.drain();
    assert.deepEqual(executed, ['plugin.call']);
  } finally {
    await service.close();
    await store.close();
  }
});

test('child side effects inventory normalizes changed paths and records confirmed external actions', async () => {
  const store = new SqliteStore();
  const coordinator = new AgentCoordinator(store);
  const service = new TaskService(store, async ({ task, onEvent }) => {
    if (isChild(task)) await emit(onEvent, task.id, [
      { tool: 'workspace.write', sideEffect: 'write', arguments: { path: './notes/../b.txt' } },
      { tool: 'workspace.write', sideEffect: 'write', arguments: { path: 'b.txt' } },
      { tool: 'workspace.patch', sideEffect: 'write', result: { content: JSON.stringify({ path: 'src\\a.ts' }) } },
      { tool: 'workspace.restore', sideEffect: 'write', result: { content: JSON.stringify({ restored: 'c.txt' }) } },
      { tool: 'terminal.run', sideEffect: 'external', arguments: { command: 'npm run build', shell: '/bin/sh' }, result: { content: JSON.stringify({ exitCode: 0 }) } },
      { tool: 'plugin.call', sideEffect: 'external', arguments: { to: 'list' }, failed: true },
    ]);
    return { text: 'done' };
  }, { reauthorize: async (current) => current });
  try {
    const { planId, childIds } = await startDelegation(store, service, coordinator);
    await service.drain();

    const effects = await coordinator.childSideEffects(principal.id, planId);

    assert.deepEqual(effects.changes.map((change) => [change.path, change.tool]), [
      ['b.txt', 'workspace.write'],
      ['c.txt', 'workspace.restore'],
      ['src/a.ts', 'workspace.patch'],
    ]);
    assert.equal(effects.changes[0]?.actionHash, `${childIds[0]}:1:workspace.write`);
    assert.deepEqual(effects.externalActions, [{
      taskId: childIds[0],
      tool: 'terminal.run',
      actionHash: `${childIds[0]}:4:terminal.run`,
      arguments: { command: 'npm run build', shell: '/bin/sh' },
      approval: 'missing',
    }]);
  } finally {
    await service.close();
    await store.close();
  }
});

function scriptedService(
  store: Store,
  coordinator: AgentCoordinator,
  parentSteps: Step[],
  childSteps: Step[] = [{ tool: 'workspace.write', sideEffect: 'write', arguments: { path: 'result.txt' } }],
): TaskService {
  return new TaskService(store, async ({ task, onEvent }) => {
    await emit(onEvent, task.id, isChild(task) ? childSteps : parentSteps);
    if (task.data.orchestration?.role === 'parent' && task.data.orchestration.phase === 'integration') {
      await coordinator.verifyIntegration(task.ownerId, task.data.orchestration.planId);
    }
    return { text: 'done' };
  }, { reauthorize: async (current) => current });
}

async function addConfirmedAction(
  store: Store,
  taskId: string,
  sequence: number,
  at: string,
  step: Step,
): Promise<void> {
  const actionHash = `${taskId}:manual:${sequence}`;
  await store.create('event', principal.id, {
    taskId,
    sequence,
    type: 'tool_dispatched',
    payload: {
      type: 'tool_dispatched', actionHash, sideEffect: step.sideEffect ?? 'read',
      toolCall: { id: actionHash, name: step.tool, arguments: step.arguments ?? {} },
    },
    at,
  }, `${taskId}:manual:${sequence}`);
  await store.create('event', principal.id, {
    taskId,
    sequence: sequence + 1,
    type: 'tool_result',
    payload: {
      type: 'tool_result', actionHash, toolCallId: actionHash,
      outcome: step.failed ? 'failed' : 'confirmed', isError: step.failed ?? false,
      ...(step.result === undefined ? {} : { result: step.result }),
    },
    at,
  }, `${taskId}:manual:${sequence + 1}`);
}

test('the integration boundary rejects a same-millisecond parent read made before child completion', async () => {
  for (const reread of [false, true]) {
    const store = new SqliteStore();
    const now = Date.now();
    const coordinator = new AgentCoordinator(store, undefined, () => now);
    const service = scriptedService(store, coordinator, reread
      ? [{
          tool: 'workspace.read',
          arguments: { path: 'result.txt' },
          result: { content: JSON.stringify({ path: 'result.txt', sha256: 'a'.repeat(64) }) },
        }]
      : []);
    try {
      const { parentId, planId } = await startDelegation(store, service, coordinator);
      const at = new Date(now).toISOString();
      await addConfirmedAction(store, parentId, 50, at, {
        tool: 'workspace.read', arguments: { path: 'result.txt' },
      });
      await service.drain();
      await coordinator.queueIntegration(principal.id, planId);
      await service.drain();

      const parent = (await store.get<Task>('task', parentId, principal.id))!;
      assert.equal(parent.data.state, reread ? 'completed' : 'failed', parent.data.error);
      assert.equal(parent.data.orchestration?.verification, reread ? 'passed' : 'failed');
      if (!reread) assert.match(parent.data.error ?? '', /Not verified: result\.txt$/);
    } finally {
      await service.close();
      await store.close();
    }
  }
});

test('a fast child may establish the boundary while its runner-transition parent is still running', async () => {
  const store = new SqliteStore();
  const coordinator = new AgentCoordinator(store);
  const service = new TaskService(store, async () => ({ text: 'child done' }));
  try {
    const conversation = await store.create<Conversation>('conversation', principal.id, {
      title: 'Fast child', scope: 'private', modelPolicy: 'cloud', strategy: 'single', mode: 'act', archived: false,
    });
    const parent = await service.enqueue(principal, conversation.id, 'Delegate');
    const plan = await coordinator.prepare(principal.id, parent.id, {
      key: 'fast-child',
      children: [{ key: 'worker', prompt: 'Finish quickly' }],
      budget: { maxCalls: 2, maxTokens: 100 },
    }, { parentTransition: 'runner' });
    const queued = (await store.get<Task>('task', parent.id, principal.id))!;
    await store.put('task', parent.id, principal.id, {
      ...queued.data,
      state: 'running',
      workerId: 'parent-worker',
      leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
    }, queued.revision);
    await service.drain();

    const stillRunning = (await store.get<Task>('task', parent.id, principal.id))!;
    assert.equal(stillRunning.data.state, 'running');
    assert.equal(stillRunning.data.orchestration?.phase, 'children');
    await coordinator.queueIntegration(principal.id, plan.id);
    const integrating = (await store.get<OrchestrationPlan>('agent_plan', plan.id, principal.id))!;
    assert.equal(integrating.data.state, 'integrating');
    assert.equal(typeof integrating.data.integrationBoundary?.parentEventSequence, 'number');
  } finally {
    await service.close();
    await store.close();
  }
});

test('only a safe terminal test with an explicit zero exit verifies every changed path', async () => {
  const cases: Array<[string, Step, boolean]> = [
    ['valid test', { tool: 'terminal.run', sideEffect: 'external', arguments: { command: 'CI=1 npm test 2>&1\n' }, result: { content: JSON.stringify({ exitCode: 0 }) } }, true],
    ['valid named test script', { tool: 'terminal.run', sideEffect: 'external', arguments: { command: 'npm run test:unit' }, result: { content: JSON.stringify({ exitCode: 0 }) } }, true],
    ['valid canonical chain', { tool: 'terminal.run', sideEffect: 'external', arguments: { command: 'npm test && pytest' }, result: { content: JSON.stringify({ exitCode: 0 }) } }, true],
    ['other workspace prefix', { tool: 'terminal.run', sideEffect: 'external', arguments: { command: 'cd /other && npm test' }, result: { content: JSON.stringify({ exitCode: 0 }) } }, false],
    ['missing exit', { tool: 'terminal.run', sideEffect: 'external', arguments: { command: 'npm test' }, result: { content: '{}' } }, false],
    ['nonzero exit', { tool: 'terminal.run', sideEffect: 'external', arguments: { command: 'npm test' }, result: { content: JSON.stringify({ exitCode: 1 }) } }, false],
    ['or fallback', { tool: 'terminal.run', sideEffect: 'external', arguments: { command: 'npm test || true' }, result: { content: JSON.stringify({ exitCode: 0 }) } }, false],
    ['semicolon', { tool: 'terminal.run', sideEffect: 'external', arguments: { command: 'npm test; echo done' }, result: { content: JSON.stringify({ exitCode: 0 }) } }, false],
    ['pipe', { tool: 'terminal.run', sideEffect: 'external', arguments: { command: 'npm test 2>&1 | tail -n 20' }, result: { content: JSON.stringify({ exitCode: 0 }) } }, false],
    ['echo', { tool: 'terminal.run', sideEffect: 'external', arguments: { command: 'echo npm test' }, result: { content: JSON.stringify({ exitCode: 0 }) } }, false],
    ['newline injection', { tool: 'terminal.run', sideEffect: 'external', arguments: { command: 'npm test\necho done' }, result: { content: JSON.stringify({ exitCode: 0 }) } }, false],
    ['pytest collection only', { tool: 'terminal.run', sideEffect: 'external', arguments: { command: 'pytest --co' }, result: { content: JSON.stringify({ exitCode: 0 }) } }, false],
    ['swift list tests', { tool: 'terminal.run', sideEffect: 'external', arguments: { command: 'swift test --list-tests' }, result: { content: JSON.stringify({ exitCode: 0 }) } }, false],
    ['cargo list tests', { tool: 'terminal.run', sideEffect: 'external', arguments: { command: 'cargo test -- --list' }, result: { content: JSON.stringify({ exitCode: 0 }) } }, false],
    ['npm list tests', { tool: 'terminal.run', sideEffect: 'external', arguments: { command: 'npm test -- --listTests' }, result: { content: JSON.stringify({ exitCode: 0 }) } }, false],
    ['swift short list', { tool: 'terminal.run', sideEffect: 'external', arguments: { command: 'swift test -l' }, result: { content: JSON.stringify({ exitCode: 0 }) } }, false],
    ['swift list subcommand', { tool: 'terminal.run', sideEffect: 'external', arguments: { command: 'swift test list' }, result: { content: JSON.stringify({ exitCode: 0 }) } }, false],
    ['swift single-dash help', { tool: 'terminal.run', sideEffect: 'external', arguments: { command: 'swift test -help' }, result: { content: JSON.stringify({ exitCode: 0 }) } }, false],
  ];
  for (const [label, parentStep, passes] of cases) {
    const store = new SqliteStore();
    const coordinator = new AgentCoordinator(store);
    const service = scriptedService(store, coordinator, [parentStep], [
      { tool: 'workspace.write', sideEffect: 'write', arguments: { path: 'a.txt' } },
      { tool: 'workspace.write', sideEffect: 'write', arguments: { path: 'b.txt' } },
    ]);
    try {
      const { parentId, planId } = await startDelegation(store, service, coordinator);
      await service.drain();
      await coordinator.queueIntegration(principal.id, planId);
      await service.drain();
      assert.equal((await store.get<Task>('task', parentId, principal.id))?.data.state,
        passes ? 'completed' : 'failed', label);
    } finally {
      await service.close();
      await store.close();
    }
  }
});

test('shell path checks cannot hide failure behind compound commands', async () => {
  for (const [command, passes, cwd] of [
    ['test -f result.txt 2>&1', false, undefined],
    ['cat result.txt || true', false, undefined],
    ['cat result.txt; echo done', false, undefined],
    ['echo cat result.txt', false, undefined],
    ['cat > result.txt', false, undefined],
    ['cat result.txt', false, 'other'],
    ['cat --help result.txt', false, undefined],
    ['source /other && cat result.txt', false, undefined],
  ] as const) {
    const store = new SqliteStore();
    const coordinator = new AgentCoordinator(store);
    const service = scriptedService(store, coordinator, [{
      tool: 'terminal.run', sideEffect: 'external', arguments: { command, ...(cwd ? { cwd } : {}) },
      result: { content: JSON.stringify({ exitCode: 0 }) },
    }]);
    try {
      const { parentId, planId } = await startDelegation(store, service, coordinator);
      await service.drain();
      await coordinator.queueIntegration(principal.id, planId);
      await service.drain();
      assert.equal((await store.get<Task>('task', parentId, principal.id))?.data.state,
        passes ? 'completed' : 'failed', command);
    } finally {
      await service.close();
      await store.close();
    }
  }
});

interface Script {
  steps?: Step[];
  content?: string;
  emitFinal?: boolean;
}

const integrationMessage = (input: RunInput): string | undefined => input.messages
  ?.find((message) => message.role === 'user'
    && message.content.startsWith('Integrate these delegated results'))?.content;

function scriptedRuntime(script: (input: RunInput) => Script): { run(input: RunInput): Promise<RunResult> } {
  return {
    async run(input) {
      const { steps = [], content = 'done', emitFinal = true } = script(input);
      await emit(async (event) => {
        await input.onEvent?.({ ...event, taskId: input.taskId } as RuntimeEvent);
      }, input.taskId, steps);
      const result: RunResult = {
        status: 'completed',
        content,
        modelId: 'scripted',
        usage: { calls: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0 },
        strategy: 'single',
        messages: [...(input.messages ?? []), { role: 'assistant', content }],
      };
      if (emitFinal) await input.onEvent?.({ type: 'final', taskId: input.taskId, result });
      return result;
    },
  };
}

test('createTaskRunner rejects an unverified final before anything reports completion', async () => {
  const store = new SqliteStore();
  const coordinator = new AgentCoordinator(store);
  const runtime = scriptedRuntime((input) => integrationMessage(input) === undefined
    ? { steps: [{ tool: 'workspace.write', sideEffect: 'write', arguments: { path: 'result.txt' } }] }
    : { content: 'Unverified answer.' });
  const service = new TaskService(store, createTaskRunner(store, runtime, [], undefined, coordinator), {
    reauthorize: async (current) => current,
  });
  try {
    const { parentId, planId } = await startDelegation(store, service, coordinator);
    await service.drain();
    await coordinator.queueIntegration(principal.id, planId);
    await service.drain();

    const parent = (await store.get<Task>('task', parentId, principal.id))!;
    assert.equal(parent.data.state, 'failed');
    assert.equal(parent.data.orchestration?.verification, 'failed');
    assert.match(parent.data.error ?? '', /Not verified: result\.txt$/);
    assert.equal(await store.get('message', `${parentId}:assistant`, principal.id), undefined);
    const events = (await store.scan<{ taskId: string; type: string }>('event', principal.id))
      .filter((event) => event.data.taskId === parentId);
    assert.equal(events.some((event) => event.data.type === 'final' || event.data.type === 'completed'), false);
    const notifications = await store.scan<{ taskId?: string; type: string }>('notification', principal.id);
    assert.equal(notifications.some((notification) => notification.data.taskId === parentId
      && notification.data.type === 'task_completed'), false);
  } finally {
    await service.close();
    await store.close();
  }
});

test('createTaskRunner also verifies a completed runtime that emits no final event', async () => {
  const store = new SqliteStore();
  const coordinator = new AgentCoordinator(store);
  const runtime = scriptedRuntime((input) => integrationMessage(input) === undefined
    ? { steps: [{ tool: 'workspace.write', sideEffect: 'write', arguments: { path: 'result.txt' } }] }
    : { emitFinal: false });
  const service = new TaskService(store, createTaskRunner(store, runtime, [], undefined, coordinator), {
    reauthorize: async (current) => current,
  });
  try {
    const { parentId, planId } = await startDelegation(store, service, coordinator);
    await service.drain();
    await coordinator.queueIntegration(principal.id, planId);
    await service.drain();
    assert.equal((await store.get<Task>('task', parentId, principal.id))?.data.state, 'failed');
  } finally {
    await service.close();
    await store.close();
  }
});

test('a recovered queued parent uses the persisted integrating plan even if its task phase stayed children', async () => {
  const store = new SqliteStore();
  const coordinator = new AgentCoordinator(store);
  const runtime = scriptedRuntime((input) => integrationMessage(input) === undefined
    ? { steps: [{ tool: 'workspace.write', sideEffect: 'write', arguments: { path: 'result.txt' } }] }
    : { steps: [{
        tool: 'workspace.read', arguments: { path: 'result.txt' },
        result: { content: JSON.stringify({ path: 'result.txt', sha256: 'a'.repeat(64) }) },
      }] });
  const service = new TaskService(store, createTaskRunner(store, runtime, [], undefined, coordinator), {
    reauthorize: async (current) => current,
  });
  try {
    const { parentId, planId } = await startDelegation(store, service, coordinator);
    await service.drain();
    await coordinator.queueIntegration(principal.id, planId);
    const queued = (await store.get<Task>('task', parentId, principal.id))!;
    await store.put('task', parentId, principal.id, {
      ...queued.data,
      orchestration: { ...queued.data.orchestration!, phase: 'children' },
    }, queued.revision);

    await service.drain();

    const completed = (await store.get<Task>('task', parentId, principal.id))!;
    assert.equal(completed.data.state, 'completed', completed.data.error);
    assert.equal(completed.data.orchestration?.verification, 'passed');
    assert.equal((await store.get<OrchestrationPlan>('agent_plan', planId, principal.id))?.data.state, 'completed');
  } finally {
    await service.close();
    await store.close();
  }
});

test('an unconfirmed parent side effect remains unknown when verification also fails', async () => {
  const store = new SqliteStore();
  const coordinator = new AgentCoordinator(store);
  const runtime = scriptedRuntime((input) => integrationMessage(input) === undefined
    ? { steps: [{ tool: 'workspace.write', sideEffect: 'write', arguments: { path: 'result.txt' } }] }
    : { steps: [{ tool: 'plugin.call', sideEffect: 'external', unconfirmed: true }] });
  const service = new TaskService(store, createTaskRunner(store, runtime, [], undefined, coordinator), {
    reauthorize: async (current) => current,
  });
  try {
    const { parentId, planId } = await startDelegation(store, service, coordinator);
    await service.drain();
    await coordinator.queueIntegration(principal.id, planId);
    await service.drain();
    const parent = (await store.get<Task>('task', parentId, principal.id))!;
    assert.equal(parent.data.state, 'unknown');
    assert.equal(parent.data.orchestration?.verification, 'failed');
  } finally {
    await service.close();
    await store.close();
  }
});

test('the integration prompt lists changed paths and confirmed external child actions', async () => {
  const store = new SqliteStore();
  const coordinator = new AgentCoordinator(store);
  let prompt = '';
  const runtime = scriptedRuntime((input) => {
    const integration = integrationMessage(input);
    if (integration === undefined) return { steps: [
      { tool: 'workspace.write', sideEffect: 'write', arguments: { path: 'b.txt' } },
      { tool: 'workspace.patch', sideEffect: 'write', result: { content: JSON.stringify({ path: 'src/a.ts' }) } },
      { tool: 'plugin.call', sideEffect: 'external', arguments: { pluginId: 'mail' } },
    ] };
    prompt = integration;
    return { steps: [{
      tool: 'workspace.read', arguments: { path: 'b.txt' },
      result: { content: JSON.stringify({ path: 'b.txt', sha256: 'a'.repeat(64) }) },
    }, {
      tool: 'workspace.read', arguments: { path: 'src/a.ts' },
      result: { content: JSON.stringify({ path: 'src/a.ts', sha256: 'b'.repeat(64) }) },
    }] };
  });
  const service = new TaskService(store, createTaskRunner(store, runtime, [], undefined, coordinator), {
    reauthorize: async (current) => current,
  });
  try {
    const { parentId, planId, childIds } = await startDelegation(store, service, coordinator);
    await service.drain();
    const child = (await store.get<Task>('task', childIds[0]!, principal.id))!;
    await store.put('task', child.id, principal.id, {
      ...child.data,
      approvedActionHashes: [...child.data.approvedActionHashes, `${child.id}:2:plugin.call`],
    }, child.revision);
    await coordinator.queueIntegration(principal.id, planId);
    await service.drain();
    assert.match(prompt, /Child-changed workspace paths \(quoted data\): \["b\.txt","src\/a\.ts"\]/);
    assert.match(prompt, /Confirmed external child actions \(quoted data\): \["plugin\.call/);
    assert.equal((await store.get<Task>('task', parentId, principal.id))?.data.state, 'completed');
  } finally {
    await service.close();
    await store.close();
  }
});

test('a result after the boundary cannot complete a verification dispatch from before it', async () => {
  const store = new SqliteStore();
  const coordinator = new AgentCoordinator(store);
  const service = scriptedService(store, coordinator, []);
  try {
    const { parentId, planId } = await startDelegation(store, service, coordinator);
    const actionHash = `${parentId}:split-read`;
    await store.create('event', principal.id, {
      taskId: parentId,
      sequence: 40,
      type: 'tool_dispatched',
      payload: {
        type: 'tool_dispatched', actionHash, sideEffect: 'read',
        toolCall: { id: actionHash, name: 'workspace.read', arguments: { path: 'result.txt' } },
      },
      at: new Date().toISOString(),
    }, `${parentId}:split-dispatch`);
    await service.drain();
    await coordinator.queueIntegration(principal.id, planId);
    await store.create('event', principal.id, {
      taskId: parentId,
      sequence: 41,
      type: 'tool_result',
      payload: {
        type: 'tool_result', actionHash, toolCallId: actionHash, outcome: 'confirmed', isError: false,
        result: { content: JSON.stringify({ path: 'result.txt', sha256: 'a'.repeat(64) }) },
      },
      at: new Date().toISOString(),
    }, `${parentId}:split-result`);
    await service.drain();
    assert.equal((await store.get<Task>('task', parentId, principal.id))?.data.state, 'failed');
  } finally {
    await service.close();
    await store.close();
  }
});

test('the boundary includes parent event sequences reserved before child completion', async () => {
  const store = new SqliteStore();
  const coordinator = new AgentCoordinator(store);
  const service = scriptedService(store, coordinator, []);
  try {
    const { parentId, planId } = await startDelegation(store, service, coordinator);
    const cursor = (await store.get<{ next: number }>('event_sequence', parentId, principal.id))!;
    await store.put('event_sequence', parentId, principal.id, { next: 4 }, cursor.revision);
    await service.drain();
    await coordinator.queueIntegration(principal.id, planId);
    assert.equal((await store.get<OrchestrationPlan>('agent_plan', planId, principal.id))
      ?.data.integrationBoundary?.parentEventSequence, 3);

    const actionHash = `${parentId}:reserved-read`;
    await store.create('event', principal.id, {
      taskId: parentId,
      sequence: 2,
      type: 'tool_dispatched',
      payload: {
        type: 'tool_dispatched', actionHash, sideEffect: 'read',
        toolCall: { id: actionHash, name: 'workspace.read', arguments: { path: 'result.txt' } },
      },
      at: new Date().toISOString(),
    }, `${parentId}:reserved-dispatch`);
    await store.create('event', principal.id, {
      taskId: parentId,
      sequence: 3,
      type: 'tool_result',
      payload: {
        type: 'tool_result', actionHash, toolCallId: actionHash, outcome: 'confirmed', isError: false,
        result: { content: JSON.stringify({ path: 'result.txt', sha256: 'a'.repeat(64) }) },
      },
      at: new Date().toISOString(),
    }, `${parentId}:reserved-result`);
    await service.drain();
    assert.equal((await store.get<Task>('task', parentId, principal.id))?.data.state, 'failed');
  } finally {
    await service.close();
    await store.close();
  }
});

test('a recovered queued children-phase parent integrates completed children and waits for nonterminal children', async () => {
  for (const childComplete of [true, false]) {
    const store = new SqliteStore();
    const coordinator = new AgentCoordinator(store);
    let parentRuns = 0;
    const runtime = scriptedRuntime((input) => {
      if (integrationMessage(input) !== undefined) {
        parentRuns += 1;
        return { steps: [{
          tool: 'workspace.read', arguments: { path: 'result.txt' },
          result: { content: JSON.stringify({ path: 'result.txt', sha256: 'a'.repeat(64) }) },
        }] };
      }
      return { steps: [{ tool: 'workspace.write', sideEffect: 'write', arguments: { path: 'result.txt' } }] };
    });
    const service = new TaskService(store, createTaskRunner(store, runtime, [], undefined, coordinator), {
      reauthorize: async (current) => current,
    });
    try {
      const { parentId, planId, childIds } = await startDelegation(store, service, coordinator);
      const preparedPlan = (await store.get<OrchestrationPlan>('agent_plan', planId, principal.id))!;
      await store.put('agent_plan', planId, principal.id, {
        ...preparedPlan.data,
        parentTransition: 'runner',
      }, preparedPlan.revision);
      if (childComplete) {
        await service.drain();
      } else {
        const child = (await store.get<Task>('task', childIds[0]!, principal.id))!;
        await store.put('task', child.id, principal.id, { ...child.data, state: 'paused' }, child.revision);
      }
      const parent = (await store.get<Task>('task', parentId, principal.id))!;
      await store.put('task', parent.id, principal.id, {
        ...parent.data,
        state: 'queued',
        orchestration: { ...parent.data.orchestration!, phase: 'children' },
      }, parent.revision);

      await service.drain();

      const after = (await store.get<Task>('task', parentId, principal.id))!;
      assert.equal(after.data.state, childComplete ? 'completed' : 'waiting_for_children', after.data.error);
      assert.equal(parentRuns, childComplete ? 1 : 0);
      assert.equal((await store.get<OrchestrationPlan>('agent_plan', planId, principal.id))?.data.state,
        childComplete ? 'completed' : 'waiting');
    } finally {
      await service.close();
      await store.close();
    }
  }
});

test('pause and resume preserve the integration plan and its event boundary', async () => {
  const store = new SqliteStore();
  let coordinator: AgentCoordinator;
  let service: TaskService;
  coordinator = new AgentCoordinator(store, (ownerId, taskId, action, actor) => service.control(
    ownerId, taskId, action, [], actor,
  ));
  service = scriptedService(store, coordinator, [{
    tool: 'workspace.read', arguments: { path: 'result.txt' },
    result: { content: JSON.stringify({ path: 'result.txt', sha256: 'a'.repeat(64) }) },
  }]);
  try {
    const { parentId, planId } = await startDelegation(store, service, coordinator);
    await service.drain();
    await coordinator.queueIntegration(principal.id, planId);
    const queued = (await store.get<OrchestrationPlan>('agent_plan', planId, principal.id))!;
    await service.control(principal.id, parentId, 'pause');
    await coordinator.propagateControl(principal.id, parentId, 'pause');
    const paused = (await store.get<OrchestrationPlan>('agent_plan', planId, principal.id))!;
    assert.equal(paused.data.state, 'integrating');
    assert.deepEqual(paused.data.integrationBoundary, queued.data.integrationBoundary);
    await service.control(principal.id, parentId, 'resume');
    await coordinator.propagateControl(principal.id, parentId, 'resume');
    const resumed = (await store.get<OrchestrationPlan>('agent_plan', planId, principal.id))!;
    assert.equal(resumed.data.state, 'integrating');
    assert.deepEqual(resumed.data.integrationBoundary, queued.data.integrationBoundary);
    await service.drain();
    assert.equal((await store.get<Task>('task', parentId, principal.id))?.data.state, 'completed');
  } finally {
    await service.close();
    await store.close();
  }
});

test('the reconciler closes failed plans, preserves unknown plans and leaves legacy completed rows untouched', async () => {
  for (const state of ['failed', 'unknown', 'completed'] as const) {
    const store = new SqliteStore();
    const coordinator = new AgentCoordinator(store);
    const service = scriptedService(store, coordinator, []);
    try {
      const { parentId, planId } = await startDelegation(store, service, coordinator);
      await service.drain();
      await coordinator.queueIntegration(principal.id, planId);
      const parent = (await store.get<Task>('task', parentId, principal.id))!;
      const stored = await store.put<Task>('task', parentId, principal.id, {
        ...parent.data,
        state,
        ...(state === 'completed' ? { result: 'Legacy answer.' } : {}),
      }, parent.revision);
      await reconcileAgentTasks(store, coordinator);
      const after = (await store.get<Task>('task', parentId, principal.id))!;
      assert.equal(after.revision, stored.revision, state);
      assert.equal(after.data.orchestration?.verification, 'pending', state);
      assert.equal((await store.get<OrchestrationPlan>('agent_plan', planId, principal.id))?.data.state,
        state === 'failed' ? 'cancelled' : 'integrating', state);
    } finally {
      await service.close();
      await store.close();
    }
  }
});

test('an integrating legacy plan without a boundary fails closed', async () => {
  const store = new SqliteStore();
  const coordinator = new AgentCoordinator(store);
  const service = scriptedService(store, coordinator, [{
    tool: 'workspace.read', arguments: { path: 'result.txt' },
    result: { content: JSON.stringify({ path: 'result.txt', sha256: 'a'.repeat(64) }) },
  }]);
  try {
    const { parentId, planId } = await startDelegation(store, service, coordinator);
    await service.drain();
    await coordinator.queueIntegration(principal.id, planId);
    const plan = (await store.get<OrchestrationPlan>('agent_plan', planId, principal.id))!;
    const { integrationBoundary: _boundary, ...legacy } = plan.data;
    await store.put('agent_plan', planId, principal.id, legacy, plan.revision);
    await service.drain();
    const parent = (await store.get<Task>('task', parentId, principal.id))!;
    assert.equal(parent.data.state, 'failed');
    assert.match(parent.data.error ?? '', /integration event boundary is missing/);
  } finally {
    await service.close();
    await store.close();
  }
});
