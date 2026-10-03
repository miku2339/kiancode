import assert from 'node:assert/strict';
import test from 'node:test';
import type { Principal, ToolDefinition } from '../src/contracts.js';
import {
  AgentRuntime,
  reconcileToolCall,
  type ChatMessage,
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

function runtimeWith(provider: ModelProvider, executions: string[]): AgentRuntime {
  const send: ToolDefinition = {
    name: 'send',
    description: 'Send externally',
    inputSchema: { type: 'object' },
    requiredCapabilities: [],
    sideEffect: 'external',
    async execute(input) {
      executions.push(String(input.message));
      return { content: 'sent' };
    },
  };
  return new AgentRuntime({
    providers: [provider],
    models: [{ id: 'local-model', providerId: provider.id, locality: 'local', capabilities: ['tools'] }],
    tools: [send],
  });
}

const actionHash = 'a'.repeat(64);
const pendingSend: ChatMessage[] = [
  { role: 'user', content: 'send hello' },
  {
    role: 'assistant',
    content: '',
    toolCalls: [{
      id: 'provider-call-1',
      occurrenceId: 'occurrence-1',
      name: 'send',
      arguments: { message: 'hello' },
      actionHash,
    }],
  },
];

test('reconcileToolCall appends an occurrence-bound receipt without mutating the checkpoint', () => {
  const before = structuredClone(pendingSend);
  const result = reconcileToolCall(pendingSend, {
    toolCallId: 'provider-call-1',
    toolOccurrenceId: 'occurrence-1',
    actionHash,
    resolution: 'applied',
    note: '  seen in the outbox  ',
  });

  assert.deepEqual(pendingSend, before);
  assert.deepEqual(result?.slice(0, -1), pendingSend);
  assert.deepEqual(result?.at(-1), {
    role: 'tool',
    content: 'Reconciled by an operator: this action was applied. Its original output is unavailable; inspect the result before relying on it.\nOperator note: seen in the outbox',
    name: 'send',
    toolCallId: 'provider-call-1',
    toolOccurrenceId: 'occurrence-1',
    actionHash,
    toolOutcome: 'confirmed',
  });

  const failed = reconcileToolCall(pendingSend, {
    toolOccurrenceId: 'occurrence-1',
    actionHash,
    resolution: 'not_applied',
  })?.at(-1);
  assert.equal(failed?.toolOutcome, 'failed');
  assert.equal(failed?.toolOccurrenceId, 'occurrence-1');
  assert.equal('actionHash' in (failed ?? {}), false);
});

test('repeating the same reconciliation returns one byte-equivalent receipt', () => {
  const reconciliation = {
    toolCallId: 'provider-call-1',
    toolOccurrenceId: 'occurrence-1',
    actionHash,
    resolution: 'applied' as const,
    note: '  seen in the outbox  ',
  };
  const first = reconcileToolCall(pendingSend, reconciliation);
  assert.ok(first);
  const repeated = reconcileToolCall(first, reconciliation);

  assert.notEqual(repeated, first);
  assert.deepEqual(repeated, first);
  assert.equal(repeated?.filter((message) => message.role === 'tool').length, 1);
  assert.equal(reconcileToolCall(first, {
    ...reconciliation,
    resolution: 'not_applied',
  }), undefined);
  assert.equal(reconcileToolCall(first, {
    ...reconciliation,
    note: 'different note',
  }), undefined);
  assert.equal(reconcileToolCall(first, {
    ...reconciliation,
    actionHash: 'b'.repeat(64),
  }), undefined);
});

test('reconcileToolCall fails closed for mismatched selectors and non-current calls', () => {
  for (const reconciliation of [
    { toolCallId: 'wrong', toolOccurrenceId: 'occurrence-1', actionHash, resolution: 'applied' as const },
    { toolCallId: 'provider-call-1', toolOccurrenceId: 'wrong', actionHash, resolution: 'applied' as const },
    { toolCallId: 'provider-call-1', toolOccurrenceId: 'occurrence-1', actionHash: 'b'.repeat(64), resolution: 'applied' as const },
  ]) {
    assert.equal(reconcileToolCall(pendingSend, reconciliation), undefined);
  }

  const superseded: ChatMessage[] = [
    ...pendingSend,
    { role: 'assistant', content: 'Moving on.' },
  ];
  assert.equal(reconcileToolCall(superseded, {
    toolOccurrenceId: 'occurrence-1',
    resolution: 'applied',
  }), undefined);

  const answered: ChatMessage[] = [
    ...pendingSend,
    {
      role: 'tool',
      content: 'sent',
      name: 'send',
      toolCallId: 'provider-call-1',
      toolOccurrenceId: 'occurrence-1',
      toolOutcome: 'confirmed',
    },
  ];
  assert.equal(reconcileToolCall(answered, {
    toolOccurrenceId: 'occurrence-1',
    resolution: 'applied',
  }), undefined);
  assert.equal(reconcileToolCall(pendingSend, {
    toolOccurrenceId: '',
    resolution: 'applied',
  }), undefined);
  assert.equal(reconcileToolCall(pendingSend, {
    toolOccurrenceId: 'occurrence-1',
    resolution: 'invalid' as 'applied',
  }), undefined);
  const checkpointWithoutHash: ChatMessage[] = [{
    role: 'assistant',
    content: '',
    toolCalls: [{ id: 'call-1', occurrenceId: 'occurrence-1', name: 'send', arguments: {} }],
  }];
  assert.equal(reconcileToolCall(checkpointWithoutHash, {
    actionHash,
    resolution: 'applied',
  }), undefined);
});

test('raw provider ids select only a unique pending call', () => {
  const duplicateIds: ChatMessage[] = [{
    role: 'assistant',
    content: '',
    toolCalls: [
      { id: 'call-1', occurrenceId: 'occurrence-a', name: 'send', arguments: { message: 'a' } },
      { id: 'call-1', occurrenceId: 'occurrence-b', name: 'send', arguments: { message: 'b' } },
    ],
  }];
  assert.equal(reconcileToolCall(duplicateIds, {
    toolCallId: 'call-1',
    resolution: 'applied',
  }), undefined);
  assert.equal(reconcileToolCall(duplicateIds, {
    toolCallId: 'call-1',
    toolOccurrenceId: 'occurrence-b',
    resolution: 'applied',
  })?.at(-1)?.toolOccurrenceId, 'occurrence-b');

  const legacy: ChatMessage[] = [{
    role: 'assistant',
    content: '',
    toolCalls: [{ id: 'legacy-1', name: 'send', arguments: { message: 'legacy' } }],
  }];
  assert.equal(reconcileToolCall(legacy, {
    toolCallId: 'legacy-1',
    resolution: 'applied',
  })?.at(-1)?.toolCallId, 'legacy-1');
});

test('a legacy pending call is rejected when its action hash was already consumed', () => {
  const legacyHash = 'c'.repeat(64);
  const lonePending: ChatMessage[] = [{
    role: 'assistant',
    content: '',
    toolCalls: [{
      id: 'call-1',
      name: 'send',
      arguments: { message: 'hello' },
      actionHash: legacyHash,
    }],
  }];
  assert.equal(reconcileToolCall(lonePending, {
    toolCallId: 'call-1',
    actionHash: legacyHash,
    resolution: 'applied',
  })?.at(-1)?.actionHash, legacyHash);

  const collision: ChatMessage[] = [
    {
      role: 'assistant',
      content: '',
      toolCalls: [{ id: 'call-1', name: 'send', arguments: { message: 'hello' } }],
    },
    {
      role: 'tool',
      content: 'sent',
      name: 'send',
      toolCallId: 'call-1',
      actionHash: legacyHash,
      toolOutcome: 'confirmed',
    },
    ...lonePending,
  ];
  assert.equal(reconcileToolCall(collision, {
    toolCallId: 'call-1',
    actionHash: legacyHash,
    resolution: 'applied',
  }), undefined);
});

test('an applied reconciliation resumes without executing the action again', async () => {
  const executions: string[] = [];
  const waitingProvider = new ScriptedProvider([{
    message: {
      role: 'assistant',
      content: '',
      toolCalls: [{ id: 'provider-call-1', name: 'send', arguments: { message: 'hello' } }],
    },
    usage: { inputTokens: 1, outputTokens: 1 },
  }]);
  const waiting = await runtimeWith(waitingProvider, executions).run({
    principal,
    taskId: 'applied-task',
    prompt: 'send hello',
    mode: 'act',
    strategy: 'single',
    approvedActionHashes: new Set(),
  });
  const pending = waiting.pendingActions?.[0];
  assert.ok(pending?.actionHash);
  assert.ok(pending.toolOccurrenceId);
  const checkpointCall = waiting.messages.at(-1)?.toolCalls?.[0];
  assert.equal(checkpointCall?.actionHash, undefined);

  const messages = reconcileToolCall(waiting.messages, {
    toolCallId: pending.toolCallId,
    toolOccurrenceId: pending.toolOccurrenceId,
    actionHash: pending.actionHash,
    resolution: 'applied',
  });
  assert.ok(messages);
  const resumedProvider = new ScriptedProvider([{
    message: { role: 'assistant', content: 'The message was sent.' },
    usage: { inputTokens: 1, outputTokens: 1 },
  }]);

  const result = await runtimeWith(resumedProvider, executions).run({
    principal,
    taskId: 'applied-task',
    messages,
    mode: 'act',
    strategy: 'single',
    approvedActionHashes: new Set([pending.actionHash]),
  });

  assert.equal(result.status, 'completed');
  assert.deepEqual(executions, []);
  assert.equal(resumedProvider.calls[0]?.messages.at(-1)?.toolOutcome, 'confirmed');
});

test('a not-applied reconciliation requires fresh approval before a repeated provider id executes once', async () => {
  const executions: string[] = [];
  const waitingProvider = new ScriptedProvider([{
    message: {
      role: 'assistant',
      content: '',
      toolCalls: [{ id: 'provider-call-1', name: 'send', arguments: { message: 'hello' } }],
    },
    usage: { inputTokens: 1, outputTokens: 1 },
  }]);
  const initial = await runtimeWith(waitingProvider, executions).run({
    principal,
    taskId: 'retry-task',
    prompt: 'send hello',
    mode: 'act',
    strategy: 'single',
    approvedActionHashes: new Set(),
  });
  const firstPending = initial.pendingActions?.[0];
  assert.ok(firstPending?.actionHash);
  assert.ok(firstPending.toolOccurrenceId);
  assert.equal(initial.messages.at(-1)?.toolCalls?.[0]?.actionHash, undefined);
  const reconciled = reconcileToolCall(initial.messages, {
    toolCallId: firstPending.toolCallId,
    toolOccurrenceId: firstPending.toolOccurrenceId,
    actionHash: firstPending.actionHash,
    resolution: 'not_applied',
  });
  assert.ok(reconciled);

  const retryProvider = new ScriptedProvider([{
    message: {
      role: 'assistant',
      content: '',
      toolCalls: [{ id: 'provider-call-1', name: 'send', arguments: { message: 'hello' } }],
    },
    usage: { inputTokens: 1, outputTokens: 1 },
  }]);
  const waiting = await runtimeWith(retryProvider, executions).run({
    principal,
    taskId: 'retry-task',
    messages: reconciled,
    mode: 'act',
    strategy: 'single',
    approvedActionHashes: new Set(),
  });
  assert.equal(waiting.status, 'waiting_for_approval');
  assert.equal(waiting.pendingActions?.[0]?.toolCallId, 'provider-call-1');
  assert.notEqual(waiting.pendingActions?.[0]?.toolOccurrenceId, firstPending.toolOccurrenceId);
  assert.deepEqual(executions, []);

  const retryHash = waiting.pendingActions?.[0]?.actionHash;
  assert.ok(retryHash);
  assert.notEqual(retryHash, firstPending.actionHash);
  const secondProvider = new ScriptedProvider([{
    message: { role: 'assistant', content: 'Sent after verification.' },
    usage: { inputTokens: 1, outputTokens: 1 },
  }]);
  const completed = await runtimeWith(secondProvider, executions).run({
    principal,
    taskId: 'retry-task',
    messages: waiting.messages,
    mode: 'act',
    strategy: 'single',
    approvedActionHashes: new Set([retryHash]),
  });

  assert.equal(completed.status, 'completed');
  assert.deepEqual(executions, ['hello']);
});
