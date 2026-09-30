import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { DomainError, type Principal, type ToolDefinition } from '../src/contracts.js';
import {
  AgentRuntime,
  type ChatRequest,
  type ChatResponse,
  type ModelProvider,
} from '../src/runtime/index.js';

const principal: Principal = {
  id: 'owner-1',
  level: 3,
  scopes: ['workspace:read', 'workspace:write'],
};

class ScriptedProvider implements ModelProvider {
  public readonly id = 'scripted';
  public readonly locality = 'local';
  public readonly calls: ChatRequest[] = [];

  public constructor(private readonly responses: ChatResponse[]) {}

  public async chat(request: ChatRequest): Promise<ChatResponse> {
    this.calls.push(request);
    const response = this.responses.shift();
    assert.ok(response, 'unexpected provider call');
    return response;
  }
}

function approvedActionHash(taskId: string, callId: string, tool: string, input: Record<string, unknown>): string {
  return createHash('sha256')
    .update(`${principal.id}\0${taskId}\0${callId}\0${tool}\0${JSON.stringify(input)}`)
    .digest('hex');
}

test('runs model tool calls until the model returns a final answer', async () => {
  const provider = new ScriptedProvider([
    {
      message: {
        role: 'assistant',
        content: '',
        toolCalls: [{ id: 'call-1', name: 'lookup', arguments: { query: 'Kian' } }],
      },
      usage: { inputTokens: 8, outputTokens: 3 },
    },
    {
      message: { role: 'assistant', content: '找到 Kian。' },
      usage: { inputTokens: 12, outputTokens: 5 },
    },
  ]);
  const seenContexts: Array<{ principalId: string; taskId: string }> = [];
  const tool: ToolDefinition = {
    name: 'lookup',
    description: 'Lookup a name',
    inputSchema: { type: 'object' },
    requiredCapabilities: [],
    sideEffect: 'read',
    async execute(_input, context) {
      seenContexts.push({ principalId: context.principal.id, taskId: context.taskId });
      return { content: 'Kian exists' };
    },
  };
  const runtime = new AgentRuntime({
    providers: [provider],
    models: [{
      id: 'local-model',
      providerId: provider.id,
      locality: 'local',
      capabilities: ['tools'],
    }],
    tools: [tool],
  });

  const result = await runtime.run({
    principal,
    taskId: 'task-1',
    prompt: '搵 Kian',
    mode: 'act',
    strategy: 'single',
    modelPolicy: 'local',
  });

  assert.equal(result.content, '找到 Kian。');
  assert.deepEqual(result.usage, { calls: 2, inputTokens: 20, outputTokens: 8, totalTokens: 28 });
  assert.deepEqual(seenContexts, [{ principalId: 'owner-1', taskId: 'task-1' }]);
  assert.equal(provider.calls.length, 2);
  assert.equal(provider.calls[1]?.messages.at(-1)?.role, 'tool');
  assert.equal(provider.calls[1]?.messages.at(-1)?.content, 'Kian exists');
});

test('act mode rejects completion after a failed terminal check and unrelated read', async () => {
  const taskId = 'failed-terminal-task';
  const command = 'test -f result.txt';
  const provider = new ScriptedProvider([
    {
      message: {
        role: 'assistant',
        content: '',
        toolCalls: [{ id: 'terminal-1', name: 'terminal.run', arguments: { command } }],
      },
      usage: { inputTokens: 2, outputTokens: 1 },
    },
    {
      message: {
        role: 'assistant',
        content: '',
        toolCalls: [{ id: 'read-1', name: 'workspace.read', arguments: { path: 'result.txt' } }],
      },
      usage: { inputTokens: 2, outputTokens: 1 },
    },
    {
      message: { role: 'assistant', content: 'Everything is complete.' },
      usage: { inputTokens: 2, outputTokens: 1 },
    },
  ]);
  const runtime = new AgentRuntime({
    providers: [provider],
    models: [{ id: 'local-model', providerId: provider.id, locality: 'local', capabilities: ['tools'] }],
    tools: [
      {
        name: 'terminal.run', description: 'Run a check', inputSchema: {}, requiredCapabilities: [], sideEffect: 'external',
        async execute() { return { content: JSON.stringify({ exitCode: 1, stderr: 'check failed' }), isError: true }; },
      },
      {
        name: 'workspace.read', description: 'Read a file', inputSchema: {}, requiredCapabilities: [], sideEffect: 'read',
        async execute() { return { content: 'unrelated read succeeded' }; },
      },
    ],
  });

  await assert.rejects(runtime.run({
    principal,
    taskId,
    prompt: 'Repair and verify the file',
    mode: 'act',
    strategy: 'single',
    approvedActionHashes: new Set([
      approvedActionHash(taskId, 'terminal-1', 'terminal.run', { command }),
    ]),
  }), (error: unknown) => error instanceof DomainError
    && error.code === 'verification_failed'
    && /terminal\.run/.test(error.message));
  assert.equal(provider.calls.length, 3);
});

test('act mode allows a missing optional read to be reported without blocking completion', async () => {
  const provider = new ScriptedProvider([
    {
      message: {
        role: 'assistant',
        content: '',
        toolCalls: [{ id: 'read-missing', name: 'workspace.read', arguments: { path: 'missing.txt' } }],
      },
      usage: { inputTokens: 2, outputTokens: 1 },
    },
    {
      message: { role: 'assistant', content: 'The optional file is missing.' },
      usage: { inputTokens: 2, outputTokens: 1 },
    },
  ]);
  const runtime = new AgentRuntime({
    providers: [provider],
    models: [{ id: 'local-model', providerId: provider.id, locality: 'local', capabilities: ['tools'] }],
    tools: [{
      name: 'workspace.read', description: 'Read a file', inputSchema: {}, requiredCapabilities: [], sideEffect: 'read',
      async execute() { return { content: 'File not found', isError: true }; },
    }],
  });

  const result = await runtime.run({
    principal,
    taskId: 'missing-read-task',
    prompt: 'Inspect the optional file',
    mode: 'act',
    strategy: 'single',
  });
  assert.equal(result.status, 'completed');
  assert.equal(result.content, 'The optional file is missing.');
});

test('act mode rebuilds a failed check from checkpoint and completes after repair and passing retry', async () => {
  const taskId = 'repaired-terminal-task';
  const command = 'test -f result.txt';
  const provider = new ScriptedProvider([
    {
      message: {
        role: 'assistant',
        content: '',
        toolCalls: [{ id: 'terminal-1', name: 'terminal.run', arguments: { command } }],
      },
      usage: { inputTokens: 2, outputTokens: 1 },
    },
    {
      message: {
        role: 'assistant',
        content: '',
        toolCalls: [{ id: 'write-1', name: 'workspace.write', arguments: { path: 'result.txt' } }],
      },
      usage: { inputTokens: 2, outputTokens: 1 },
    },
    {
      message: {
        role: 'assistant',
        content: '',
        toolCalls: [{ id: 'terminal-2', name: 'terminal.run', arguments: { command } }],
      },
      usage: { inputTokens: 2, outputTokens: 1 },
    },
    {
      message: { role: 'assistant', content: 'Repair verified.' },
      usage: { inputTokens: 2, outputTokens: 1 },
    },
  ]);
  let terminalRuns = 0;
  let writes = 0;
  const runtime = new AgentRuntime({
    providers: [provider],
    models: [{ id: 'local-model', providerId: provider.id, locality: 'local', capabilities: ['tools'] }],
    tools: [
      {
        name: 'terminal.run', description: 'Run a check', inputSchema: {}, requiredCapabilities: [], sideEffect: 'external',
        async execute() {
          terminalRuns += 1;
          return terminalRuns === 1
            ? { content: JSON.stringify({ exitCode: 1, stderr: 'check failed' }), isError: true }
            : { content: JSON.stringify({ exitCode: 0, stderr: '' }) };
        },
      },
      {
        name: 'workspace.write', description: 'Repair a file', inputSchema: {}, requiredCapabilities: [], sideEffect: 'write',
        async execute() { writes += 1; return { content: 'written' }; },
      },
    ],
  });

  const failedCheckHash = approvedActionHash(taskId, 'terminal-1', 'terminal.run', { command });
  const repairHash = approvedActionHash(taskId, 'write-1', 'workspace.write', { path: 'result.txt' });
  const passingCheckHash = approvedActionHash(taskId, 'terminal-2', 'terminal.run', { command });
  const waiting = await runtime.run({
    principal,
    taskId,
    prompt: 'Repair and verify the file',
    mode: 'act',
    strategy: 'single',
    approvedActionHashes: new Set([failedCheckHash]),
  });
  assert.equal(waiting.status, 'waiting_for_approval');
  assert.equal(waiting.pendingActions?.[0]?.toolCallId, 'write-1');
  assert.equal(waiting.messages.some((message) => message.role === 'tool'
    && message.name === 'terminal.run' && message.toolOutcome === 'failed'), true);

  const completed = await runtime.run({
    principal,
    taskId,
    messages: waiting.messages,
    mode: 'act',
    strategy: 'single',
    priorUsage: waiting.usage,
    approvedActionHashes: new Set([repairHash, passingCheckHash]),
  });
  assert.equal(completed.status, 'completed');
  assert.equal(completed.content, 'Repair verified.');
  assert.equal(terminalRuns, 2);
  assert.equal(writes, 1);
  assert.equal(provider.calls.length, 4);
});

test('private auto policy never falls back to a cloud model', async () => {
  const cloud = new ScriptedProvider([{
    message: { role: 'assistant', content: 'cloud answer' },
    usage: { inputTokens: 1, outputTokens: 1 },
  }]);
  Object.defineProperties(cloud, {
    id: { value: 'cloud' },
    locality: { value: 'cloud' },
  });
  const runtime = new AgentRuntime({
    providers: [cloud],
    models: [{ id: 'cloud-model', providerId: 'cloud', locality: 'cloud', capabilities: [] }],
  });

  await assert.rejects(
    runtime.run({
      principal,
      taskId: 'private-task',
      prompt: 'private input',
      mode: 'ask',
      strategy: 'single',
      modelPolicy: 'auto',
      privacy: 'private',
    }),
    (error: unknown) => error instanceof Error && 'code' in error
      && error.code === 'private_model_unavailable',
  );
  assert.equal(cloud.calls.length, 0);
});

test('model selection enforces requested capabilities', async () => {
  const provider = new ScriptedProvider([]);
  const runtime = new AgentRuntime({
    providers: [provider],
    models: [{ id: 'text-only', providerId: provider.id, locality: 'local', capabilities: [] }],
  });

  await assert.rejects(
    runtime.run({
      principal,
      taskId: 'vision-task',
      prompt: 'describe image',
      mode: 'ask',
      strategy: 'single',
      modelPolicy: 'local',
      requiredModelCapabilities: ['vision'],
    }),
    (error: unknown) => error instanceof Error && 'code' in error
      && error.code === 'model_unavailable',
  );
});

test('ask and plan modes do not expose or execute write tools', async () => {
  const provider = new ScriptedProvider([
    {
      message: {
        role: 'assistant',
        content: '',
        toolCalls: [{ id: 'write-1', name: 'replace_file', arguments: { path: 'a.txt' } }],
      },
      usage: { inputTokens: 1, outputTokens: 1 },
    },
    {
      message: { role: 'assistant', content: '不能寫入。' },
      usage: { inputTokens: 2, outputTokens: 1 },
    },
  ]);
  let executions = 0;
  const tool: ToolDefinition = {
    name: 'replace_file',
    description: 'Write a file',
    inputSchema: { type: 'object' },
    requiredCapabilities: [],
    sideEffect: 'write',
    async execute() {
      executions += 1;
      return { content: 'written' };
    },
  };
  const runtime = new AgentRuntime({
    providers: [provider],
    models: [{ id: 'local-model', providerId: provider.id, locality: 'local', capabilities: ['tools'] }],
    tools: [tool],
  });

  await runtime.run({
    principal,
    taskId: 'ask-task',
    prompt: 'write it',
    mode: 'ask',
    strategy: 'single',
    modelPolicy: 'local',
  });

  assert.equal(executions, 0);
  assert.deepEqual(provider.calls[0]?.tools, []);
  assert.match(provider.calls[1]?.messages.at(-1)?.content ?? '', /unavailable in ask mode/);
});

test('ask mode can use a text-only model when optional read tools are available', async () => {
  const provider = new ScriptedProvider([{
    message: { role: 'assistant', content: 'plain answer' },
    usage: { inputTokens: 2, outputTokens: 2 },
  }]);
  const readTool: ToolDefinition = {
    name: 'optional.read',
    description: 'Optional lookup',
    inputSchema: { type: 'object' },
    requiredCapabilities: [],
    sideEffect: 'read',
    async execute() { return { content: 'unused' }; },
  };
  const runtime = new AgentRuntime({
    providers: [provider],
    models: [{ id: 'text-only', providerId: provider.id, locality: 'local', capabilities: ['streaming'] }],
    tools: [readTool],
  });

  const result = await runtime.run({
    principal,
    taskId: 'plain-ask',
    prompt: 'hello',
    mode: 'ask',
    strategy: 'single',
  });

  assert.equal(result.content, 'plain answer');
  assert.deepEqual(provider.calls[0]?.tools, []);
});

test('enforces model call and token budgets', async () => {
  const callProvider = new ScriptedProvider([{
    message: {
      role: 'assistant',
      content: '',
      toolCalls: [{ id: 'read-1', name: 'read', arguments: {} }],
    },
    usage: { inputTokens: 2, outputTokens: 1 },
  }]);
  const readTool: ToolDefinition = {
    name: 'read',
    description: 'Read',
    inputSchema: { type: 'object' },
    requiredCapabilities: [],
    sideEffect: 'read',
    async execute() {
      return { content: 'data' };
    },
  };
  const callRuntime = new AgentRuntime({
    providers: [callProvider],
    models: [{ id: 'local-model', providerId: callProvider.id, locality: 'local', capabilities: ['tools'] }],
    tools: [readTool],
  });
  await assert.rejects(
    callRuntime.run({
      principal,
      taskId: 'call-budget',
      prompt: 'read',
      mode: 'act',
      strategy: 'single',
      budgets: { maxCalls: 1 },
    }),
    (error: unknown) => error instanceof Error && 'code' in error
      && error.code === 'call_budget_exceeded',
  );

  const tokenProvider = new ScriptedProvider([{
    message: { role: 'assistant', content: 'large answer' },
    usage: { inputTokens: 7, outputTokens: 6 },
  }]);
  const tokenRuntime = new AgentRuntime({
    providers: [tokenProvider],
    models: [{ id: 'local-model', providerId: tokenProvider.id, locality: 'local', capabilities: [] }],
  });
  await assert.rejects(
    tokenRuntime.run({
      principal,
      taskId: 'token-budget',
      prompt: 'answer',
      mode: 'ask',
      strategy: 'single',
      budgets: { maxTokens: 10 },
      maxOutputTokens: 1000,
    }),
    (error: unknown) => error instanceof Error && 'code' in error
      && error.code === 'budget_violation',
  );
  assert.equal(tokenProvider.calls[0]?.maxOutputTokens, 2);
});

test('propagates cancellation to an in-flight provider request', async () => {
  let receivedSignal: AbortSignal | undefined;
  let markStarted: (() => void) | undefined;
  const started = new Promise<void>((resolve) => {
    markStarted = resolve;
  });
  const provider: ModelProvider = {
    id: 'cancellable',
    locality: 'local',
    async chat(request) {
      receivedSignal = request.signal;
      markStarted?.();
      return new Promise((_resolve, reject) => {
        request.signal.addEventListener('abort', () => reject(request.signal.reason), { once: true });
      });
    },
  };
  const runtime = new AgentRuntime({
    providers: [provider],
    models: [{ id: 'local-model', providerId: provider.id, locality: 'local', capabilities: [] }],
  });
  const controller = new AbortController();
  const running = runtime.run({
    principal,
    taskId: 'cancel-task',
    prompt: 'wait',
    mode: 'ask',
    strategy: 'single',
    signal: controller.signal,
  });

  await started;
  controller.abort(new DOMException('cancelled', 'AbortError'));

  await assert.rejects(running, (error: unknown) => error instanceof DOMException
    && error.name === 'AbortError');
  assert.equal(receivedSignal, controller.signal);
});

test('write and external tools require a matching approved action hash', async () => {
  const provider = new ScriptedProvider([
    {
      message: {
        role: 'assistant',
        content: '',
        toolCalls: [{
          id: 'write-1',
          name: 'publish',
          arguments: { target: 'site' },
          actionHash: 'model-controlled-value',
        }],
      },
      usage: { inputTokens: 1, outputTokens: 1 },
    },
    {
      message: { role: 'assistant', content: '需要批准。' },
      usage: { inputTokens: 1, outputTokens: 1 },
    },
  ]);
  let executions = 0;
  const events: string[] = [];
  const tool: ToolDefinition = {
    name: 'publish',
    description: 'Publish',
    inputSchema: { type: 'object' },
    requiredCapabilities: [],
    sideEffect: 'external',
    async execute() {
      executions += 1;
      return { content: 'published' };
    },
  };
  const runtime = new AgentRuntime({
    providers: [provider],
    models: [{ id: 'local-model', providerId: provider.id, locality: 'local', capabilities: ['tools'] }],
    tools: [tool],
  });

  const waiting = await runtime.run({
    principal,
    taskId: 'approval-task',
    prompt: 'publish',
    mode: 'act',
    strategy: 'single',
    approvedActionHashes: new Set(),
    onEvent(event) {
      events.push(event.type);
    },
  });

  assert.equal(executions, 0);
  assert.ok(events.includes('approval_required'));
  assert.equal(waiting.status, 'waiting_for_approval');
  assert.equal(waiting.pendingActions?.[0]?.toolCallId, 'write-1');
  assert.equal(waiting.pendingActions?.[0]?.toolName, 'publish');
  assert.deepEqual(waiting.pendingActions?.[0]?.input, { target: 'site' });
  const actionHash = waiting.pendingActions?.[0]?.actionHash;
  assert.match(actionHash ?? '', /^[a-f0-9]{64}$/);

  const completed = await runtime.run({
    principal,
    taskId: 'approval-task',
    messages: waiting.messages,
    mode: 'act',
    strategy: 'single',
    approvedActionHashes: new Set([actionHash ?? '']),
  });
  assert.equal(completed.status, 'completed');
  assert.equal(executions, 1);
  assert.equal(provider.calls[1]?.messages.at(-1)?.content, 'published');
});

test('stops with outcome_unknown after an unconfirmed external dispatch', async () => {
  const approvedHash = createHash('sha256')
    .update('owner-1\0external-task\0send-1\0send\0{"message":"hello"}')
    .digest('hex');
  const provider = new ScriptedProvider([
    {
      message: {
        role: 'assistant',
        content: '',
        toolCalls: [{ id: 'send-1', name: 'send', arguments: { message: 'hello' }, actionHash: 'send-approved' }],
      },
      usage: { inputTokens: 1, outputTokens: 1 },
    },
  ]);
  let executions = 0;
  const events: Array<{ type: string; outcome?: string }> = [];
  const tool: ToolDefinition = {
    name: 'send',
    description: 'Send externally',
    inputSchema: { type: 'object' },
    requiredCapabilities: [],
    sideEffect: 'external',
    async execute() {
      executions += 1;
      throw new Error('connection lost after dispatch');
    },
  };
  const runtime = new AgentRuntime({
    providers: [provider],
    models: [{ id: 'local-model', providerId: provider.id, locality: 'local', capabilities: ['tools'] }],
    tools: [tool],
  });

  await assert.rejects(runtime.run({
    principal,
    taskId: 'external-task',
    prompt: 'send',
    mode: 'act',
    strategy: 'single',
    approvedActionHashes: new Set([approvedHash]),
    onEvent(event) { events.push(event); },
  }), (error: unknown) => error instanceof Error && 'code' in error && error.code === 'outcome_unknown');

  assert.equal(executions, 1);
  assert.deepEqual(events.filter((event) => event.type.startsWith('tool_')).map((event) => event.type), [
    'tool_call',
    'tool_dispatched',
    'tool_result',
  ]);
  assert.equal(events.at(-1)?.outcome, 'unknown');
});

test('preserves an unknown outcome reported by a dispatched write tool', async () => {
  const approvedHash = createHash('sha256')
    .update('owner-1\0unknown-write\0write-1\0write\0{}')
    .digest('hex');
  const provider = new ScriptedProvider([{
    message: {
      role: 'assistant',
      content: '',
      toolCalls: [{ id: 'write-1', name: 'write', arguments: {} }],
    },
    usage: { inputTokens: 1, outputTokens: 1 },
  }]);
  const events: Array<{ type: string; outcome?: string }> = [];
  const runtime = new AgentRuntime({
    providers: [provider],
    models: [{ id: 'local-model', providerId: provider.id, locality: 'local', capabilities: ['tools'] }],
    tools: [{
      name: 'write',
      description: 'Write remotely',
      inputSchema: { type: 'object' },
      requiredCapabilities: [],
      sideEffect: 'write',
      async execute() {
        throw new DomainError('outcome_unknown', 'Remote write result was lost', 409);
      },
    }],
  });

  await assert.rejects(runtime.run({
    principal,
    taskId: 'unknown-write',
    prompt: 'write',
    mode: 'act',
    strategy: 'single',
    approvedActionHashes: new Set([approvedHash]),
    onEvent(event) { events.push(event); },
  }), (error: unknown) => error instanceof DomainError && error.code === 'outcome_unknown');
  assert.equal(events.at(-1)?.outcome, 'unknown');
});

test('MoA limits candidates to three and degrades when fewer than two succeed', async () => {
  let calls = 0;
  const provider: ModelProvider = {
    id: 'moa-provider',
    locality: 'cloud',
    async chat() {
      calls += 1;
      if (calls > 1) {
        throw new Error('candidate unavailable');
      }
      return {
        message: { role: 'assistant', content: 'only surviving candidate' },
        usage: { inputTokens: 2, outputTokens: 2 },
      };
    },
  };
  const runtime = new AgentRuntime({
    providers: [provider],
    models: [{ id: 'cloud-model', providerId: provider.id, locality: 'cloud', capabilities: [] }],
  });

  const result = await runtime.run({
    principal,
    taskId: 'moa-task',
    prompt: 'solve',
    mode: 'ask',
    strategy: 'moa',
    modelPolicy: 'cloud',
    profile: { candidateCount: 9 },
  });

  assert.equal(calls, 3);
  assert.equal(result.status, 'completed');
  assert.equal(result.strategy, 'moa');
  assert.equal(result.degraded, true);
  assert.equal(result.candidates?.length, 1);
  assert.equal(result.content, 'only surviving candidate');
});

test('caps active runs at three per owner', async () => {
  let active = 0;
  let maximum = 0;
  let release: (() => void) | undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const provider: ModelProvider = {
    id: 'concurrency-provider',
    locality: 'cloud',
    async chat() {
      active += 1;
      maximum = Math.max(maximum, active);
      await gate;
      active -= 1;
      return {
        message: { role: 'assistant', content: 'done' },
        usage: { inputTokens: 1, outputTokens: 1 },
      };
    },
  };
  const runtime = new AgentRuntime({
    providers: [provider],
    models: [{ id: 'cloud-model', providerId: provider.id, locality: 'cloud', capabilities: [] }],
  });
  const runs = Array.from({ length: 4 }, (_, index) => runtime.run({
    principal,
    taskId: `concurrent-${index}`,
    prompt: 'run',
    mode: 'ask',
    strategy: 'single',
    modelPolicy: 'cloud',
  }));
  for (let index = 0; index < 10 && active < 3; index += 1) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }

  assert.equal(active, 3);
  assert.equal(maximum, 3);
  release?.();
  await Promise.all(runs);
  assert.equal(maximum, 3);
});

test('serializes calls to local providers across owners', async () => {
  let active = 0;
  let maximum = 0;
  let release: (() => void) | undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const provider: ModelProvider = {
    id: 'local-serial',
    locality: 'local',
    async chat() {
      active += 1;
      maximum = Math.max(maximum, active);
      await gate;
      active -= 1;
      return {
        message: { role: 'assistant', content: 'done' },
        usage: { inputTokens: 1, outputTokens: 1 },
      };
    },
  };
  const runtime = new AgentRuntime({
    providers: [provider],
    models: [{ id: 'local-model', providerId: provider.id, locality: 'local', capabilities: [] }],
  });
  const secondPrincipal = { ...principal, id: 'owner-2' };
  const runs = [principal, secondPrincipal].map((owner, index) => runtime.run({
    principal: owner,
    taskId: `local-${index}`,
    prompt: 'run',
    mode: 'ask',
    strategy: 'single',
    modelPolicy: 'local',
  }));
  for (let index = 0; index < 5 && active < 1; index += 1) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }

  assert.equal(active, 1);
  assert.equal(maximum, 1);
  release?.();
  await Promise.all(runs);
  assert.equal(maximum, 1);
});

test('returns waiting_for_device when the selected local model is offline', async () => {
  let cloudCalls = 0;
  const local: ModelProvider = {
    id: 'offline-local',
    locality: 'local',
    async isAvailable() {
      return false;
    },
    async chat() {
      throw new Error('must not call offline provider');
    },
  };
  const cloud: ModelProvider = {
    id: 'available-cloud',
    locality: 'cloud',
    async chat() {
      cloudCalls += 1;
      return {
        message: { role: 'assistant', content: 'cloud' },
        usage: { inputTokens: 1, outputTokens: 1 },
      };
    },
  };
  const runtime = new AgentRuntime({
    providers: [local, cloud],
    models: [
      { id: 'local-model', providerId: local.id, locality: 'local', deviceId: 'mac-1', capabilities: [] },
      { id: 'cloud-model', providerId: cloud.id, locality: 'cloud', capabilities: [] },
    ],
  });

  await assert.rejects(
    runtime.run({
      principal,
      taskId: 'offline-task',
      prompt: 'answer',
      mode: 'ask',
      strategy: 'single',
      modelPolicy: 'auto',
    }),
    (error: unknown) => error instanceof Error && 'code' in error
      && error.code === 'waiting_for_device',
  );
  assert.equal(cloudCalls, 0);
});

test('does not expose tools outside the principal scopes', async () => {
  const provider = new ScriptedProvider([
    {
      message: {
        role: 'assistant',
        content: '',
        toolCalls: [{ id: 'secret-1', name: 'read_secret', arguments: {} }],
      },
      usage: { inputTokens: 1, outputTokens: 1 },
    },
    {
      message: { role: 'assistant', content: 'access denied' },
      usage: { inputTokens: 1, outputTokens: 1 },
    },
  ]);
  let executions = 0;
  const tool: ToolDefinition = {
    name: 'read_secret',
    description: 'Read protected data',
    inputSchema: { type: 'object' },
    requiredCapabilities: ['secrets:read'],
    sideEffect: 'read',
    async execute() {
      executions += 1;
      return { content: 'secret' };
    },
  };
  const runtime = new AgentRuntime({
    providers: [provider],
    models: [{ id: 'local-model', providerId: provider.id, locality: 'local', capabilities: ['tools'] }],
    tools: [tool],
  });

  await runtime.run({
    principal,
    taskId: 'scope-task',
    prompt: 'read',
    mode: 'ask',
    strategy: 'single',
  });

  assert.deepEqual(provider.calls[0]?.tools, []);
  assert.equal(executions, 0);
});

test('experts uses the top two profiles and a parent aggregation pass', async () => {
  const requests: ChatRequest[] = [];
  const provider: ModelProvider = {
    id: 'experts-provider',
    locality: 'cloud',
    async chat(request) {
      requests.push(request);
      const call = requests.length;
      return {
        message: {
          role: 'assistant',
          content: call === 1 ? 'security answer' : call === 2 ? 'product answer' : 'combined answer',
        },
        usage: { inputTokens: 2, outputTokens: 2 },
      };
    },
  };
  const runtime = new AgentRuntime({
    providers: [provider],
    models: [{ id: 'cloud-model', providerId: provider.id, locality: 'cloud', capabilities: [] }],
  });

  const result = await runtime.run({
    principal,
    taskId: 'experts-task',
    prompt: 'review',
    mode: 'ask',
    strategy: 'experts',
    modelPolicy: 'cloud',
    profile: {
      experts: [
        { name: 'security', instruction: 'Review security.' },
        { name: 'product', instruction: 'Review product behavior.' },
        { name: 'extra', instruction: 'This expert must not run.' },
      ],
    },
  });

  assert.equal(requests.length, 3);
  assert.equal(result.content, 'combined answer');
  assert.equal(result.candidates?.length, 2);
  assert.equal(result.degraded, false);
  assert.match(requests[2]?.messages.at(-1)?.content ?? '', /security answer/);
  assert.match(requests[2]?.messages.at(-1)?.content ?? '', /product answer/);
});

test('honors an exact model id and workspace cloud prohibition', async () => {
  const first = new ScriptedProvider([]);
  Object.defineProperty(first, 'id', { value: 'first' });
  const second = new ScriptedProvider([{
    message: { role: 'assistant', content: 'selected' },
    usage: { inputTokens: 1, outputTokens: 1 },
  }]);
  Object.defineProperty(second, 'id', { value: 'second' });
  const runtime = new AgentRuntime({
    providers: [first, second],
    models: [
      { id: 'first-model', providerId: first.id, locality: 'local', capabilities: [] },
      { id: 'second-model', providerId: second.id, locality: 'local', capabilities: [] },
    ],
  });
  const result = await runtime.run({
    principal,
    taskId: 'exact-model',
    prompt: 'answer',
    mode: 'ask',
    modelId: 'second-model',
    modelPolicy: 'auto',
  });
  assert.equal(result.modelId, 'second-model');
  assert.equal(first.calls.length, 0);

  const cloud = new ScriptedProvider([]);
  Object.defineProperties(cloud, { id: { value: 'cloud-only' }, locality: { value: 'cloud' } });
  const privateRuntime = new AgentRuntime({
    providers: [cloud],
    models: [{ id: 'cloud-model', providerId: cloud.id, locality: 'cloud', capabilities: [] }],
  });
  await assert.rejects(privateRuntime.run({
    principal,
    workspace: {
      id: 'workspace-1',
      ownerId: principal.id,
      name: 'Private',
      root: '/workspace',
      deviceId: 'server',
      capabilities: [],
      allowCloud: false,
    },
    taskId: 'private-workspace',
    prompt: 'answer',
    mode: 'ask',
    modelPolicy: 'auto',
  }), (error: unknown) => error instanceof Error && 'code' in error
    && error.code === 'private_model_unavailable');
});

test('wildcard principal scopes do not bypass per-workspace capabilities', async () => {
  const provider = new ScriptedProvider([
    {
      message: { role: 'assistant', content: '', toolCalls: [{ id: 'read-1', name: 'workspace.read', arguments: {} }] },
      usage: { inputTokens: 1, outputTokens: 1 },
    },
    { message: { role: 'assistant', content: 'denied' }, usage: { inputTokens: 1, outputTokens: 1 } },
  ]);
  let executions = 0;
  const tool: ToolDefinition = {
    name: 'workspace.read',
    description: 'Read workspace',
    inputSchema: { type: 'object' },
    requiredCapabilities: ['workspace:read'],
    sideEffect: 'read',
    async execute() { executions += 1; return { content: 'data' }; },
  };
  const runtime = new AgentRuntime({
    providers: [provider],
    models: [{ id: 'model', providerId: provider.id, locality: 'local', capabilities: ['tools'] }],
    tools: [tool],
  });
  await runtime.run({
    principal: { ...principal, scopes: ['*'] },
    workspace: {
      id: 'workspace', ownerId: principal.id, name: 'Workspace', root: '/workspace',
      deviceId: 'server', capabilities: [], allowCloud: false,
    },
    taskId: 'workspace-capability',
    prompt: 'read',
    mode: 'ask',
    modelPolicy: 'local',
  });
  assert.deepEqual(provider.calls[0]?.tools, []);
  assert.equal(executions, 0);
});

test('serializes workspace writes across tasks for the same workspace', async () => {
  let activeWrites = 0;
  let maximumWrites = 0;
  let release: (() => void) | undefined;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const provider: ModelProvider = {
    id: 'write-provider',
    locality: 'cloud',
    async chat(request) {
      if (request.messages.at(-1)?.role === 'tool') {
        return { message: { role: 'assistant', content: 'done' }, usage: { inputTokens: 1, outputTokens: 1 } };
      }
      return {
        message: {
          role: 'assistant',
          content: '',
          toolCalls: [{ id: 'write-1', name: 'workspace.write', arguments: { path: 'a' } }],
        },
        usage: { inputTokens: 1, outputTokens: 1 },
      };
    },
  };
  const tool: ToolDefinition = {
    name: 'workspace.write',
    description: 'Write workspace',
    inputSchema: { type: 'object' },
    requiredCapabilities: ['workspace:write'],
    requiresWorkspace: true,
    sideEffect: 'write',
    async execute() {
      activeWrites += 1;
      maximumWrites = Math.max(maximumWrites, activeWrites);
      await gate;
      activeWrites -= 1;
      return { content: 'written' };
    },
  };
  const runtime = new AgentRuntime({
    providers: [provider],
    models: [{ id: 'cloud', providerId: provider.id, locality: 'cloud', capabilities: ['tools'] }],
    tools: [tool],
  });
  const workspace = {
    id: 'shared-workspace', ownerId: principal.id, name: 'Shared', root: '/workspace',
    deviceId: 'server', capabilities: ['workspace:write'], allowCloud: true,
  };
  const writePrincipal = { ...principal, scopes: ['workspace:write'] };
  const run = (taskId: string) => runtime.run({
    principal: writePrincipal,
    workspace,
    taskId,
    prompt: 'write',
    mode: 'act' as const,
    modelPolicy: 'cloud' as const,
    approvedActionHashes: new Set([createHash('sha256')
      .update(`owner-1\0${taskId}\0write-1\0workspace.write\0{"path":"a"}`)
      .digest('hex')]),
  });
  const runs = [run('write-task-1'), run('write-task-2')];
  await waitForTest(() => activeWrites === 1);
  assert.equal(maximumWrites, 1);
  release?.();
  await Promise.all(runs);
  assert.equal(maximumWrites, 1);
});

async function waitForTest(predicate: () => boolean): Promise<void> {
  for (let index = 0; index < 50; index += 1) {
    if (predicate()) return;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  throw new Error('Timed out waiting for condition');
}
