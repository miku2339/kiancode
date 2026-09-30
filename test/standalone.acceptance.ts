import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, realpath, rm } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { bootstrap } from '../src/bootstrap.js';
import { loadConfig } from '../src/config.js';
import { MemoryConflictService } from '../src/memory-conflicts.js';
import type { Principal } from '../src/contracts.js';
import type { Conversation, PendingAction, Task, TaskEvent } from '../src/domain.js';
import type { Entity } from '../src/storage/store.js';

type BootstrappedService = Awaited<ReturnType<typeof bootstrap>>;

interface ToolEventPayload {
  actionHash?: string;
  toolCallId?: string;
  outcome?: string;
  isError?: boolean;
  toolCall?: { id?: string; name?: string; arguments?: Record<string, unknown> };
  result?: { content?: string };
}

interface TerminalResult {
  exitCode: number | null;
  stderr: string;
  timedOut: boolean;
  aborted: boolean;
  isolation: string;
  network: string;
}

function payload(event: Entity<TaskEvent>): ToolEventPayload {
  return event.data.payload as ToolEventPayload;
}

function eventKey(event: Entity<TaskEvent>): string | undefined {
  const data = payload(event);
  return data.actionHash ?? data.toolCallId ?? data.toolCall?.id;
}

function confirmedToolResult(
  events: Array<Entity<TaskEvent>>,
  toolName: string,
  matches: (event: ToolEventPayload) => boolean = () => true,
): ToolEventPayload {
  for (const dispatch of events.filter((event) => event.data.type === 'tool_dispatched'
    && payload(event).toolCall?.name === toolName
    && matches(payload(event)))) {
    const key = eventKey(dispatch);
    const result = events.find((event) => event.data.sequence > dispatch.data.sequence
      && event.data.type === 'tool_result'
      && eventKey(event) === key
      && payload(event).outcome === 'confirmed'
      && payload(event).isError === false);
    if (result) return payload(result);
  }
  assert.fail(`No confirmed ${toolName} result was persisted`);
}

function exactContentCommand(file: string, marker: string): string {
  return `test "$(cat ${file})" = '${marker}' && test "$(wc -c < ${file} | tr -d ' ')" -eq ${Buffer.byteLength(`${marker}\n`)}`;
}

function isExactContentTestCommand(value: unknown, file: string, marker: string): boolean {
  const command = typeof value === 'string' ? value : '';
  return /\btest\b/.test(command)
    && /\bwc\s+-c\b/.test(command)
    && command.includes(file)
    && command.includes(marker)
    && command.includes(String(Buffer.byteLength(`${marker}\n`)));
}

function terminalDiagnostics(events: Array<Entity<TaskEvent>>): string {
  const details: string[] = [];
  for (const dispatch of events.filter((event) => event.data.type === 'tool_dispatched'
    && payload(event).toolCall?.name === 'terminal.run')) {
    const key = eventKey(dispatch);
    const result = events.find((event) => event.data.sequence > dispatch.data.sequence
      && event.data.type === 'tool_result'
      && eventKey(event) === key);
    const resultPayload = result ? payload(result) : undefined;
    let terminal: Partial<TerminalResult> | undefined;
    try {
      terminal = resultPayload?.result?.content ? JSON.parse(resultPayload.result.content) as TerminalResult : undefined;
    } catch {
      terminal = undefined;
    }
    details.push(`command=${JSON.stringify(payload(dispatch).toolCall?.arguments?.command)} outcome=${resultPayload?.outcome ?? 'missing'} exit=${terminal?.exitCode ?? 'missing'} stderr=${JSON.stringify(terminal?.stderr ?? '')}`);
  }
  return details.join('; ') || 'no terminal.run result';
}

function confirmedTerminalResult(
  events: Array<Entity<TaskEvent>>,
  file: string,
  marker: string,
): TerminalResult {
  const matching = events.filter((event) => event.data.type === 'tool_dispatched'
    && payload(event).toolCall?.name === 'terminal.run'
    && isExactContentTestCommand(payload(event).toolCall?.arguments?.command, file, marker));
  for (const dispatch of matching) {
    const key = eventKey(dispatch);
    const result = events.find((event) => event.data.sequence > dispatch.data.sequence
      && event.data.type === 'tool_result'
      && eventKey(event) === key
      && payload(event).outcome === 'confirmed'
      && payload(event).isError === false);
    const content = result ? payload(result).result?.content : undefined;
    if (content) return JSON.parse(content) as TerminalResult;
  }
  assert.fail(`Exact-content terminal test did not pass: ${terminalDiagnostics(events)}`);
}

async function optionalRead(filePath: string): Promise<Buffer | undefined> {
  try {
    return await readFile(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

function assertDelegatedApproval(task: Entity<Task>, action: PendingAction, marker: string): void {
  const isChild = task.data.orchestration?.role === 'child';
  if (!isChild) assert.equal(task.data.orchestration?.phase, 'integration');
  if (action.tool === 'workspace.write') {
    assert.equal(isChild, true);
    assert.equal(action.input.path, 'delegated.txt');
    return;
  }
  if (action.tool === 'workspace.patch') {
    assert.equal(isChild, true);
    assert.match(String(action.input.patch), /delegated\.txt/);
    return;
  }
  assert.equal(action.tool, 'terminal.run');
  assert.equal(action.input.shell, '/bin/sh');
  assert.equal(
    isExactContentTestCommand(action.input.command, 'delegated.txt', marker),
    true,
    `terminal.run must test delegated.txt content and byte count; received ${JSON.stringify(action.input.command)}`,
  );
}

async function driveDelegatedTask(
  service: BootstrappedService,
  ownerId: string,
  parentTaskId: string,
  marker: string,
): Promise<number> {
  let approvals = 0;
  for (let round = 0; round < 32; round += 1) {
    await service.tasks.drain();
    const graph = (await service.store.scan<Task>('task', ownerId))
      .filter((task) => task.id === parentTaskId || task.data.orchestration?.rootTaskId === parentTaskId);
    const children = graph.filter((task) => task.id !== parentTaskId);
    assert.ok(children.length <= 3, 'Delegation exceeded the three temporary-agent limit');
    assert.ok(children.every((task) => (task.data.orchestration?.depth ?? 3) <= 2), 'Delegation exceeded depth two');
    let resumed = false;
    for (const pending of graph.filter((task) => task.data.state === 'waiting_for_approval')) {
      assert.ok(pending.data.pendingActions.length);
      for (const action of pending.data.pendingActions) assertDelegatedApproval(pending, action, marker);
      approvals += pending.data.pendingActions.length;
      await service.tasks.control(
        ownerId,
        pending.id,
        'resume',
        pending.data.pendingActions.map((action) => action.hash),
        principal,
      );
      resumed = true;
    }
    if (resumed) continue;
    const parent = (await service.store.get<Task>('task', parentTaskId, ownerId))!;
    if (parent.data.state === 'completed' && parent.data.orchestration?.verification === 'passed') return approvals;
    if (['failed', 'cancelled', 'unknown'].includes(parent.data.state)) {
      const diagnostics = (await Promise.all(graph.map(async (task) => terminalDiagnostics(
        await service.tasks.events(ownerId, task.id),
      )))).join(' | ');
      assert.fail(`${parent.data.error ?? parent.data.state}; terminal: ${diagnostics}`);
    }
    await delay(25);
  }
  assert.fail('Delegated task did not complete with verified integration');
}

const configPath = process.env.KIANCODE_ACCEPTANCE_CONFIG;
if (!configPath) throw new Error('Set KIANCODE_ACCEPTANCE_CONFIG to an isolated PostgreSQL configuration');
const config = await loadConfig(configPath);
if (!process.env[config.database.urlEnv]) throw new Error('Independent acceptance requires PostgreSQL');
const requestedRoot = process.env.KIANCODE_ACCEPTANCE_WORKSPACE;
if (!requestedRoot || !path.isAbsolute(requestedRoot)) throw new Error('Set an absolute isolated KIANCODE_ACCEPTANCE_WORKSPACE');
await mkdir(requestedRoot, { recursive: true, mode: 0o700 });
const root = await realpath(requestedRoot);
if (!config.serverWorkspaceRoots.includes(root) || config.terminal.isolation !== 'bubblewrap') {
  throw new Error('Independent acceptance requires an explicitly configured Bubblewrap workspace');
}

const resultPath = path.join(root, 'result.txt');
const delegatedPath = path.join(root, 'delegated.txt');
const marker = `KIANCODE_ACCEPTANCE_${randomUUID().replaceAll('-', '')}`;
const delegatedMarker = `KIANCODE_DELEGATED_${randomUUID().replaceAll('-', '')}`;
const singleTerminalCommand = exactContentCommand('result.txt', marker);
const delegatedTerminalCommand = exactContentCommand('delegated.txt', delegatedMarker);
const principal: Principal = { id: `acceptance-${randomUUID()}`, level: 1, scopes: ['*'] };
const report: {
  taskId?: string;
  modelCalls: number;
  tools: string[];
  approvals: number;
  artifactSha256?: string;
  durableReadback: boolean;
  wrongHashRejected: boolean;
  restartUnknownNoReplay: boolean;
  memoryReviewReadback: boolean;
  delegation: {
    taskId?: string;
    childTaskId?: string;
    approvals: number;
    childCount: number;
    maxDepth: number;
    budgetId?: string;
    budgetCalls?: number;
    verificationEvidence?: string;
    durableReadback: boolean;
  };
} = {
  modelCalls: 0,
  tools: [],
  approvals: 0,
  durableReadback: false,
  wrongHashRejected: false,
  restartUnknownNoReplay: false,
  memoryReviewReadback: false,
  delegation: {
    approvals: 0,
    childCount: 0,
    maxDepth: 0,
    durableReadback: false,
  },
};

let service: BootstrappedService | undefined;
try {
  service = await bootstrap(config);
  const memoryId = `acceptance-memory-${randomUUID()}`;
  const memorySource = `acceptance://knowledge/${marker}`;
  const memories = new MemoryConflictService(service.store);
  const importedMemory = await memories.import(principal, {
    id: memoryId,
    memory: { type: 'project', text: marker, scope: 'private', source: memorySource, validFrom: new Date().toISOString() },
  });
  assert.equal(importedMemory.outcome, 'held');
  assert.ok(importedMemory.review);
  const memoryQuery = {
    ownerId: principal.id, purpose: 'relevant' as const,
    context: { scope: 'private' as const, conversationId: 'acceptance', prompt: marker }, limit: 12,
  };
  assert.ok(service.store.queryMemory, 'PostgreSQL memory query support is required');
  assert.equal((await service.store.queryMemory(memoryQuery)).rows.length, 0);
  const approvedMemory = await memories.resolve(principal, importedMemory.review.id, {
    expectedRevision: importedMemory.review.revision, decision: 'approve',
  });
  assert.equal(approvedMemory.memory?.data.source, memorySource);
  assert.deepEqual((await service.store.queryMemory(memoryQuery)).rows.map((row) => row.id), [memoryId]);
  assert.equal((await service.store.queryMemory({
    ...memoryQuery, context: { ...memoryQuery.context, scope: 'group' },
  })).rows.length, 0);
  const workspace = await service.store.create('workspace', principal.id, {
    name: 'Independent acceptance',
    root,
    deviceId: 'server',
    capabilities: ['workspace:read', 'workspace:write', 'shell:execute'],
    allowCloud: true,
  });
  const conversation = await service.store.create<Conversation>('conversation', principal.id, {
    title: 'Independent model and tools',
    scope: 'private',
    modelPolicy: 'cloud',
    mode: 'act',
    strategy: 'single',
    archived: false,
    workspaceId: workspace.id,
  });
  const task = await service.tasks.enqueue(
    principal,
    conversation.id,
    `Complete this isolated coding task with your tools. Use workspace.write or workspace.patch to create result.txt containing exactly ${marker} followed by one newline. Use terminal.run with /bin/sh and exactly this command to test both the content and byte count: ${singleTerminalCommand}. Then read result.txt with workspace.read to verify it. Repair any failure before reporting completion. Do not access any other project or perform network operations.`,
    marker,
  );
  report.taskId = task.id;

  for (let round = 0; round < 16; round += 1) {
    await service.tasks.drain();
    const current: Entity<Task> = (await service.store.get<Task>('task', task.id, principal.id))!;
    if (current.data.state === 'waiting_for_approval') {
      assert.ok(current.data.pendingActions.length);
      for (const action of current.data.pendingActions) {
        assert.ok(['workspace.write', 'workspace.patch', 'terminal.run'].includes(action.tool), `Unexpected acceptance action: ${action.tool}`);
        if (action.tool === 'terminal.run') {
          assert.equal(action.input.shell, '/bin/sh');
          assert.equal(
            isExactContentTestCommand(action.input.command, 'result.txt', marker),
            true,
            `terminal.run must test result.txt content and byte count; received ${JSON.stringify(action.input.command)}`,
          );
        }
        else assert.ok(!action.input.path || action.input.path === 'result.txt');
      }
      if (!report.wrongHashRejected) {
        const bytesBefore = await optionalRead(resultPath);
        await assert.rejects(
          service.tasks.control(principal.id, task.id, 'resume', ['0'.repeat(64)], principal),
          (error: unknown) => (error as { code?: string }).code === 'invalid_approval',
        );
        const afterRejection: Entity<Task> = (await service.store.get<Task>('task', task.id, principal.id))!;
        assert.equal(afterRejection.revision, current.revision);
        assert.equal(afterRejection.data.state, 'waiting_for_approval');
        assert.deepEqual(afterRejection.data.pendingActions, current.data.pendingActions);
        assert.deepEqual(await optionalRead(resultPath), bytesBefore);
        report.wrongHashRejected = true;
      }
      report.approvals += current.data.pendingActions.length;
      await service.tasks.control(
        principal.id,
        task.id,
        'resume',
        current.data.pendingActions.map((action) => action.hash),
        principal,
      );
      continue;
    }
    if (current.data.state !== 'completed') {
      assert.fail(`${current.data.error ?? current.data.state}; terminal: ${terminalDiagnostics(
        await service.tasks.events(principal.id, task.id),
      )}`);
    }
    break;
  }

  const final = (await service.store.get<Task>('task', task.id, principal.id))!;
  assert.equal(final.data.state, 'completed');
  assert.ok(report.approvals > 0, 'The workflow must require at least one exact approval');
  assert.equal(report.wrongHashRejected, true);
  const events = await service.tasks.events(principal.id, task.id);
  const calls = events.filter((event) => event.data.type === 'tool_dispatched');
  report.tools = calls.map((event) => String(payload(event).toolCall?.name));
  report.modelCalls = (final.data.usage as { calls?: number } | undefined)?.calls ?? 0;
  assert.ok(report.modelCalls >= 2, 'The model must execute a multi-step tool loop');
  assert.ok(report.tools.includes('workspace.write') || report.tools.includes('workspace.patch'));
  assert.ok(report.tools.includes('terminal.run'));
  confirmedToolResult(events, report.tools.includes('workspace.write') ? 'workspace.write' : 'workspace.patch');
  confirmedToolResult(events, 'workspace.read');
  const terminal = confirmedTerminalResult(events, 'result.txt', marker);
  assert.equal(terminal.exitCode, 0);
  assert.equal(terminal.timedOut, false);
  assert.equal(terminal.aborted, false);
  assert.equal(terminal.isolation, 'bubblewrap');
  assert.equal(terminal.network, 'isolated');

  const bytes = await readFile(resultPath);
  assert.equal(bytes.toString(), `${marker}\n`);
  report.artifactSha256 = createHash('sha256').update(bytes).digest('hex');

  const delegatedConversation = await service.store.create<Conversation>('conversation', principal.id, {
    title: 'Independent delegated model and tools',
    scope: 'private',
    modelPolicy: 'cloud',
    mode: 'act',
    strategy: 'single',
    archived: false,
    workspaceId: workspace.id,
  });
  const childPrompt = `Use workspace.write to create delegated.txt containing exactly ${delegatedMarker} followed by one newline. Then use workspace.read to verify that exact content. Do not use terminal.run or delegate further; the parent will run the terminal test after you finish.`;
  const delegatedTask = await service.tasks.enqueue(
    principal,
    delegatedConversation.id,
    `Use agent.delegate exactly once with this literal child prompt: ${JSON.stringify(childPrompt)}. Stop while the durable child runs. When you resume for integration, personally read delegated.txt with workspace.read and use terminal.run with /bin/sh and exactly this command to test both the content and byte count: ${delegatedTerminalCommand}. Do not complete unless that test exits zero. Do not edit the file yourself unless verification proves a repair is required. Do not access any other project or perform network operations.`,
    delegatedMarker,
  );
  report.delegation.taskId = delegatedTask.id;
  report.delegation.approvals = await driveDelegatedTask(
    service,
    principal.id,
    delegatedTask.id,
    delegatedMarker,
  );
  assert.ok(report.delegation.approvals > 0, 'Delegated writes and terminal verification must require approval');

  const delegatedParent = (await service.store.get<Task>('task', delegatedTask.id, principal.id))!;
  assert.equal(delegatedParent.data.state, 'completed', delegatedParent.data.error);
  assert.equal(delegatedParent.data.orchestration?.verification, 'passed');
  const delegatedPlanId = delegatedParent.data.orchestration!.planId;
  const delegatedResults = await service.coordinator.results(principal.id, delegatedPlanId);
  assert.equal(delegatedResults.plan.data.state, 'completed');
  assert.equal(delegatedResults.children.length, 1);
  assert.equal(delegatedResults.children[0]!.state, 'completed', delegatedResults.children[0]!.error);
  const delegatedChildTaskId = delegatedResults.children[0]!.id;
  const delegatedChild = (await service.store.get<Task>('task', delegatedChildTaskId, principal.id))!;
  assert.equal(delegatedChild.data.orchestration?.parentTaskId, delegatedTask.id);
  assert.equal(delegatedChild.data.orchestration?.depth, 1);
  assert.equal(delegatedChild.data.orchestration?.budgetId, delegatedParent.data.orchestration?.budgetId);
  const delegatedGraphChildren = (await service.store.scan<Task>('task', principal.id))
    .filter((candidate) => candidate.data.orchestration?.rootTaskId === delegatedTask.id
      && candidate.id !== delegatedTask.id);
  assert.equal(delegatedGraphChildren.length, 1, 'The parent must create exactly one direct child');
  report.delegation.childTaskId = delegatedChildTaskId;
  report.delegation.childCount = delegatedGraphChildren.length;
  report.delegation.maxDepth = Math.max(...delegatedGraphChildren.map((candidate) => candidate.data.orchestration?.depth ?? 0));
  report.delegation.budgetId = delegatedResults.plan.data.budgetId;

  const delegatedParentEvents = await service.tasks.events(principal.id, delegatedTask.id);
  confirmedToolResult(delegatedParentEvents, 'agent.delegate');
  confirmedToolResult(
    delegatedParentEvents,
    'workspace.read',
    (event) => event.toolCall?.arguments?.path === 'delegated.txt',
  );
  const delegatedTerminal = confirmedTerminalResult(delegatedParentEvents, 'delegated.txt', delegatedMarker);
  assert.equal(delegatedTerminal.exitCode, 0);
  assert.equal(delegatedTerminal.timedOut, false);
  assert.equal(delegatedTerminal.aborted, false);
  assert.equal(delegatedTerminal.isolation, 'bubblewrap');
  assert.equal(delegatedTerminal.network, 'isolated');

  const delegatedChildEvents = await service.tasks.events(principal.id, delegatedChildTaskId);
  const childWrite = delegatedChildEvents.find((event) => event.data.type === 'tool_dispatched'
    && payload(event).toolCall?.name === 'workspace.write'
    && payload(event).toolCall?.arguments?.path === 'delegated.txt');
  assert.ok(childWrite, 'The durable child must write delegated.txt itself');
  confirmedToolResult(
    delegatedChildEvents,
    'workspace.write',
    (event) => event.toolCall?.arguments?.path === 'delegated.txt',
  );
  confirmedToolResult(
    delegatedChildEvents,
    'workspace.read',
    (event) => event.toolCall?.arguments?.path === 'delegated.txt',
  );
  assert.equal((await readFile(delegatedPath)).toString(), `${delegatedMarker}\n`);

  const verificationEvidence = delegatedResults.plan.data.verification?.evidence;
  assert.match(verificationEvidence ?? '', /delegated\.txt/);
  report.delegation.verificationEvidence = verificationEvidence;
  const delegatedBudget = await service.coordinator.budgets.get(principal.id, delegatedResults.plan.data.budgetId);
  assert.equal(delegatedBudget.rootTaskId, delegatedTask.id);
  assert.ok(delegatedBudget.used.calls > 0);
  assert.ok(delegatedBudget.used.calls <= delegatedBudget.limits.maxCalls);
  assert.ok(delegatedBudget.used.tokens <= delegatedBudget.limits.maxTokens);
  assert.deepEqual(delegatedBudget.reserved, { calls: 0, tokens: 0 });
  report.delegation.budgetCalls = delegatedBudget.used.calls;
  const delegatedParentEventCount = delegatedParentEvents.length;
  const delegatedChildEventCount = delegatedChildEvents.length;

  const recoveryConversation = await service.store.create<Conversation>('conversation', principal.id, {
    title: 'Independent restart recovery fixture',
    scope: 'private',
    modelPolicy: 'local',
    mode: 'act',
    strategy: 'single',
    archived: false,
  });
  const recoveryTaskId = randomUUID();
  const recoveryTask = await service.store.create<Task>('task', principal.id, {
    conversationId: recoveryConversation.id,
    prompt: 'Independent restart recovery fixture',
    principal,
    state: 'paused',
    grantExpiresAt: new Date(Date.now() + 60_000).toISOString(),
    pendingActions: [],
    approvedActionHashes: [],
  }, recoveryTaskId);
  const dispatchedId = randomUUID();
  await service.store.create<TaskEvent>('event', principal.id, {
    taskId: recoveryTaskId,
    sequence: 1,
    type: 'tool_dispatched',
    payload: {
      type: 'tool_dispatched',
      taskId: recoveryTaskId,
      toolCall: { id: dispatchedId, name: 'external.acceptance.fixture', arguments: {} },
      actionHash: dispatchedId,
      sideEffect: 'external',
    },
    at: new Date().toISOString(),
  }, `${recoveryTaskId}:000000000001`);
  const leaseExpiresAt = Date.now() + 2_000;
  await service.store.put<Task>('task', recoveryTaskId, principal.id, {
    ...recoveryTask.data,
    state: 'running',
    workerId: 'acceptance-stopped-worker',
    leaseExpiresAt: new Date(leaseExpiresAt).toISOString(),
  }, recoveryTask.revision);

  const finalResult = final.data.result;
  const eventCount = events.length;
  await service.close();
  service = undefined;
  await delay(Math.max(0, leaseExpiresAt - Date.now() + 50));

  service = await bootstrap(config);
  await service.tasks.drain();
  assert.ok(service.store.queryMemory, 'PostgreSQL memory query support is required after restart');
  const persistedMemories = await service.store.queryMemory(memoryQuery);
  assert.deepEqual(persistedMemories.rows.map((row) => row.id), [memoryId]);
  assert.equal(persistedMemories.rows[0]!.data.source, memorySource);
  assert.equal((await new MemoryConflictService(service.store).review(principal, { id: importedMemory.review.id }))[0]?.data.status, 'resolved');
  report.memoryReviewReadback = true;
  const persisted = (await service.store.get<Task>('task', task.id, principal.id))!;
  assert.equal(persisted.data.state, 'completed');
  assert.equal(persisted.data.result, finalResult);
  const persistedEvents = await service.tasks.events(principal.id, task.id);
  assert.equal(persistedEvents.length, eventCount);
  const persistedTerminal = confirmedTerminalResult(persistedEvents, 'result.txt', marker);
  assert.equal(persistedTerminal.exitCode, 0);
  assert.equal(persistedTerminal.isolation, 'bubblewrap');
  assert.equal(persistedTerminal.network, 'isolated');
  assert.equal((await readFile(resultPath)).toString(), `${marker}\n`);
  report.durableReadback = true;

  const persistedDelegatedParent = (await service.store.get<Task>('task', delegatedTask.id, principal.id))!;
  const persistedDelegatedChild = (await service.store.get<Task>('task', delegatedChildTaskId, principal.id))!;
  assert.equal(persistedDelegatedParent.data.state, 'completed');
  assert.equal(persistedDelegatedParent.data.orchestration?.verification, 'passed');
  assert.equal(persistedDelegatedChild.data.state, 'completed');
  assert.equal((await service.tasks.events(principal.id, delegatedTask.id)).length, delegatedParentEventCount);
  assert.equal((await service.tasks.events(principal.id, delegatedChildTaskId)).length, delegatedChildEventCount);
  const persistedDelegation = await service.coordinator.results(principal.id, delegatedPlanId);
  assert.equal(persistedDelegation.plan.data.state, 'completed');
  assert.match(persistedDelegation.plan.data.verification?.evidence ?? '', /delegated\.txt/);
  const persistedBudget = await service.coordinator.budgets.get(principal.id, persistedDelegation.plan.data.budgetId);
  assert.equal(persistedBudget.used.calls, report.delegation.budgetCalls);
  assert.equal((await readFile(delegatedPath)).toString(), `${delegatedMarker}\n`);
  report.delegation.durableReadback = true;

  const recovered = (await service.store.get<Task>('task', recoveryTaskId, principal.id))!;
  assert.equal(recovered.data.state, 'unknown');
  const recoveryEvents = await service.tasks.events(principal.id, recoveryTaskId);
  assert.equal(recoveryEvents.filter((event) => event.data.type === 'tool_dispatched').length, 1);
  assert.equal(recoveryEvents.filter((event) => event.data.type === 'tool_result').length, 0);
  assert.equal(eventKey(recoveryEvents[0]!), dispatchedId);
  report.restartUnknownNoReplay = true;

  process.stdout.write(`${JSON.stringify({ status: 'passed', ...report })}\n`);
} finally {
  await service?.close();
  await Promise.all([rm(resultPath, { force: true }), rm(delegatedPath, { force: true })]);
}
