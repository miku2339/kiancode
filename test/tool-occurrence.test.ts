import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { DomainError, notDispatched, type Principal, type ToolDefinition } from '../src/contracts.js';
import {
  AgentRuntime,
  type ChatRequest,
  type ChatResponse,
  type ModelProvider,
} from '../src/runtime/index.js';

const principal: Principal = {
  id: 'owner-1',
  level: 3,
  scopes: ['*'],
};

class ScriptedProvider implements ModelProvider {
  public readonly id = 'scripted-occurrence';
  public readonly locality = 'local';

  public constructor(private readonly responses: ChatResponse[]) {}

  public async chat(_request: ChatRequest): Promise<ChatResponse> {
    const response = this.responses.shift();
    assert.ok(response, 'unexpected provider call');
    return response;
  }
}

function runtime(provider: ModelProvider, tool: ToolDefinition): AgentRuntime {
  return new AgentRuntime({
    providers: [provider],
    models: [{
      id: 'local-model',
      providerId: provider.id,
      locality: 'local',
      capabilities: ['tools'],
    }],
    tools: [tool],
  });
}

test('Core replaces provider occurrence ids and gives repeated raw tool ids distinct approvals', async () => {
  const provider = new ScriptedProvider([{
    message: {
      role: 'assistant',
      content: '',
      toolCalls: [{
        id: 'call-1',
        occurrenceId: 'provider-controlled',
        name: 'publish',
        arguments: { target: 'site' },
      }],
    },
    usage: { inputTokens: 1, outputTokens: 1 },
  }]);
  const tool: ToolDefinition = {
    name: 'publish',
    description: 'Publish',
    inputSchema: { type: 'object' },
    requiredCapabilities: [],
    sideEffect: 'external',
    async execute() { return { content: 'published' }; },
  };
  const agent = runtime(provider, tool);

  const first = await agent.run({
    principal,
    taskId: 'occurrence-task',
    prompt: 'publish',
    mode: 'act',
    approvedActionHashes: new Set(),
  });

  const firstCall = first.messages.at(-1)?.toolCalls?.[0];
  assert.ok(firstCall?.occurrenceId);
  assert.notEqual(firstCall.occurrenceId, 'provider-controlled');
  assert.equal(first.pendingActions?.[0]?.toolOccurrenceId, firstCall.occurrenceId);

  const secondProvider = new ScriptedProvider([{
    message: {
      role: 'assistant',
      content: '',
      toolCalls: [{ id: 'call-1', name: 'publish', arguments: { target: 'site' } }],
    },
    usage: { inputTokens: 1, outputTokens: 1 },
  }]);
  const second = await runtime(secondProvider, tool).run({
    principal,
    taskId: 'occurrence-task',
    prompt: 'publish again',
    mode: 'act',
    approvedActionHashes: new Set(),
  });

  assert.notEqual(second.messages.at(-1)?.toolCalls?.[0]?.occurrenceId, firstCall.occurrenceId);
  assert.notEqual(second.pendingActions?.[0]?.actionHash, first.pendingActions?.[0]?.actionHash);
});

test('a consumed legacy hash is not replayed when a later turn reuses its raw id', async () => {
  const input = { target: 'site' };
  const legacyHash = createHash('sha256')
    .update(`${principal.id}\0legacy-task\0call-1\0publish\0${JSON.stringify(input)}`)
    .digest('hex');
  const provider = new ScriptedProvider([{
    message: { role: 'assistant', content: 'done' },
    usage: { inputTokens: 1, outputTokens: 1 },
  }]);
  let executions = 0;
  const agent = runtime(provider, {
    name: 'publish',
    description: 'Publish',
    inputSchema: { type: 'object' },
    requiredCapabilities: [],
    sideEffect: 'external',
    async execute() {
      executions += 1;
      return { content: 'published' };
    },
  });

  const result = await agent.run({
    principal,
    taskId: 'legacy-task',
    messages: [
      { role: 'user', content: 'publish' },
      { role: 'assistant', content: '', toolCalls: [{ id: 'call-1', name: 'publish', arguments: input }] },
      { role: 'tool', content: 'first published', name: 'publish', toolCallId: 'call-1', toolOutcome: 'confirmed', actionHash: legacyHash },
      { role: 'assistant', content: '', toolCalls: [{ id: 'call-1', name: 'publish', arguments: input }] },
    ],
    mode: 'act',
    approvedActionHashes: new Set([legacyHash]),
  });

  assert.equal(result.status, 'completed');
  assert.equal(executions, 0);
  assert.equal(result.messages.at(-2)?.toolOutcome, 'not_replayed');
});

test('a single legacy pending call without a receipt executes once with its old hash', async () => {
  const input = { target: 'site' };
  const legacyHash = createHash('sha256')
    .update(`${principal.id}\0legacy-pending-task\0call-1\0publish\0${JSON.stringify(input)}`)
    .digest('hex');
  const provider = new ScriptedProvider([{
    message: { role: 'assistant', content: 'done' },
    usage: { inputTokens: 1, outputTokens: 1 },
  }]);
  let executions = 0;
  const agent = runtime(provider, {
    name: 'publish',
    description: 'Publish',
    inputSchema: { type: 'object' },
    requiredCapabilities: [],
    sideEffect: 'external',
    async execute() {
      executions += 1;
      return { content: 'published' };
    },
  });

  const result = await agent.run({
    principal,
    taskId: 'legacy-pending-task',
    messages: [
      { role: 'user', content: 'publish' },
      { role: 'assistant', content: '', toolCalls: [{ id: 'call-1', name: 'publish', arguments: input }] },
    ],
    mode: 'act',
    approvedActionHashes: new Set([legacyHash]),
  });

  assert.equal(result.status, 'completed');
  assert.equal(executions, 1);
});

test('two calls in one assistant batch may reuse a raw id but approve and execute by occurrence', async () => {
  const provider = new ScriptedProvider([
    {
      message: {
        role: 'assistant',
        content: '',
        toolCalls: [
          { id: 'call-1', name: 'publish', arguments: { target: 'first' } },
          { id: 'call-1', name: 'publish', arguments: { target: 'second' } },
        ],
      },
      usage: { inputTokens: 1, outputTokens: 1 },
    },
    { message: { role: 'assistant', content: 'done' }, usage: { inputTokens: 1, outputTokens: 1 } },
  ]);
  const executions: string[] = [];
  const agent = runtime(provider, {
    name: 'publish',
    description: 'Publish',
    inputSchema: { type: 'object' },
    requiredCapabilities: [],
    sideEffect: 'external',
    async execute(input) {
      executions.push(input.target as string);
      return { content: `published:${input.target as string}` };
    },
  });
  const first = await agent.run({
    principal,
    taskId: 'batch-task',
    prompt: 'publish both',
    mode: 'act',
    approvedActionHashes: new Set(),
  });
  const calls = first.messages.at(-1)?.toolCalls ?? [];
  assert.equal(calls.length, 2);
  assert.notEqual(calls[0]?.occurrenceId, calls[1]?.occurrenceId);

  const second = await agent.run({
    principal,
    taskId: 'batch-task',
    messages: first.messages,
    mode: 'act',
    approvedActionHashes: new Set([first.pendingActions?.[0]?.actionHash ?? '']),
  });
  assert.deepEqual(executions, ['first']);
  assert.equal(second.pendingActions?.[0]?.toolOccurrenceId, calls[1]?.occurrenceId);
  assert.notEqual(second.pendingActions?.[0]?.actionHash, first.pendingActions?.[0]?.actionHash);

  const completed = await agent.run({
    principal,
    taskId: 'batch-task',
    messages: second.messages,
    mode: 'act',
    approvedActionHashes: new Set([second.pendingActions?.[0]?.actionHash ?? '']),
  });
  assert.deepEqual(executions, ['first', 'second']);
  const receipts = completed.messages.filter((message) => message.role === 'tool');
  assert.deepEqual(receipts.map((message) => [message.toolCallId, message.toolOccurrenceId]), [
    ['call-1', calls[0]?.occurrenceId],
    ['call-1', calls[1]?.occurrenceId],
  ]);
});

test('a pre-dispatch retry with a reused raw id needs fresh approval and resumes once from its checkpoint', async () => {
  const call = { id: 'call-1', name: 'publish', arguments: { target: 'site' } };
  const provider = new ScriptedProvider([
    { message: { role: 'assistant', content: '', toolCalls: [call] }, usage: { inputTokens: 1, outputTokens: 1 } },
    { message: { role: 'assistant', content: '', toolCalls: [call] }, usage: { inputTokens: 1, outputTokens: 1 } },
  ]);
  let executions = 0;
  const tool: ToolDefinition = {
    name: 'publish',
    description: 'Publish',
    inputSchema: { type: 'object' },
    requiredCapabilities: [],
    sideEffect: 'external',
    async execute() {
      executions += 1;
      if (executions === 1) throw notDispatched('offline', 'No request left this process', 503);
      return { content: 'published' };
    },
  };
  const firstRuntime = runtime(provider, tool);
  const first = await firstRuntime.run({
    principal,
    taskId: 'retry-task',
    prompt: 'publish',
    mode: 'act',
    approvedActionHashes: new Set(),
  });
  const firstHash = first.pendingActions?.[0]?.actionHash;
  assert.ok(firstHash);

  const retryWaiting = await firstRuntime.run({
    principal,
    taskId: 'retry-task',
    messages: first.messages,
    mode: 'act',
    approvedActionHashes: new Set([firstHash]),
  });
  const retryHash = retryWaiting.pendingActions?.[0]?.actionHash;
  const retryOccurrence = retryWaiting.pendingActions?.[0]?.toolOccurrenceId;
  assert.equal(executions, 1);
  assert.ok(retryHash);
  assert.ok(retryOccurrence);
  assert.notEqual(retryHash, firstHash);

  const dispatched: Array<{ actionHash?: string; toolOccurrenceId?: string }> = [];
  const rebuilt = runtime(new ScriptedProvider([{
    message: { role: 'assistant', content: 'complete' },
    usage: { inputTokens: 1, outputTokens: 1 },
  }]), tool);
  const completed = await rebuilt.run({
    principal,
    taskId: 'retry-task',
    messages: retryWaiting.messages,
    mode: 'act',
    approvedActionHashes: new Set([retryHash]),
    onEvent(event) {
      if (event.type === 'tool_dispatched') dispatched.push(event);
    },
  });

  assert.equal(completed.status, 'completed');
  assert.equal(executions, 2);
  assert.deepEqual(dispatched.map((event) => [event.actionHash, event.toolOccurrenceId]), [[retryHash, retryOccurrence]]);
});

test('an unmarked external error stays unknown even when its code looks harmless', async () => {
  const call = { id: 'call-1', name: 'publish', arguments: {} };
  const provider = new ScriptedProvider([{
    message: { role: 'assistant', content: '', toolCalls: [call] },
    usage: { inputTokens: 1, outputTokens: 1 },
  }]);
  const tool: ToolDefinition = {
    name: 'publish',
    description: 'Publish',
    inputSchema: { type: 'object' },
    requiredCapabilities: [],
    sideEffect: 'external',
    async execute() {
      throw new DomainError('invalid_input', 'Remote side rejected the request');
    },
  };
  const agent = runtime(provider, tool);
  const waiting = await agent.run({
    principal,
    taskId: 'unknown-task',
    prompt: 'publish',
    mode: 'act',
    approvedActionHashes: new Set(),
  });

  await assert.rejects(agent.run({
    principal,
    taskId: 'unknown-task',
    messages: waiting.messages,
    mode: 'act',
    approvedActionHashes: new Set([waiting.pendingActions?.[0]?.actionHash ?? '']),
  }), (error: unknown) => error instanceof DomainError && error.code === 'outcome_unknown');
});
