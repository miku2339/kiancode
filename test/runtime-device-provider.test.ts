import assert from 'node:assert/strict';
import test from 'node:test';
import { DomainError, type Principal, type ToolContext, type ToolResult } from '../src/contracts.js';
import { DeviceService } from '../src/devices.js';
import {
  AgentRuntime,
  DeviceModelProvider,
  VisualContextStore,
  createLocalModelTool,
  type DeviceModelDispatcher,
} from '../src/runtime/index.js';
import { SqliteStore } from '../src/storage/sqlite.js';

const principal: Principal = { id: 'owner', level: 1, scopes: ['model:generate'] };

test('DeviceModelProvider dispatches model generation without workspace access', async () => {
  let received: { deviceId: string; input: Record<string, unknown>; context: ToolContext } | undefined;
  const dispatcher: DeviceModelDispatcher = {
    async executeModel(deviceId, input, context): Promise<ToolResult> {
      received = { deviceId, input, context };
      return {
        content: JSON.stringify({
          message: { role: 'assistant', content: 'device answer' },
          usage: { inputTokens: 3, outputTokens: 2 },
        }),
      };
    },
  };
  const provider = new DeviceModelProvider({ id: 'device-models', dispatcher });
  const runtime = new AgentRuntime({
    providers: [provider],
    models: [{
      id: 'qwen-local',
      providerId: provider.id,
      locality: 'local',
      deviceId: 'mac-device',
      model: 'qwen',
      capabilities: [],
    }],
  });

  const result = await runtime.run({
    principal,
    taskId: 'device-task',
    prompt: 'answer locally',
    mode: 'ask',
    modelPolicy: 'local',
    modelId: 'qwen-local',
  });

  assert.equal(result.content, 'device answer');
  assert.equal(received?.deviceId, 'mac-device');
  assert.equal(received?.context.principal, principal);
  assert.equal(received?.context.taskId, 'device-task');
  assert.equal(received?.context.workspace, undefined);
  assert.equal(received?.input.modelId, 'qwen-local');
});

test('device model readiness is owner-aware and rejects known unavailable devices before dispatch', async (t) => {
  let now = Date.now();
  const store = new SqliteStore();
  t.after(() => store.close());
  const devices = new DeviceService(store, () => now);
  const device = await store.create('device', principal.id, {
    name: 'Mac', capabilities: ['model:generate'], reportedCapabilities: ['model:generate'],
    workspaceIds: [], lastSeen: new Date(now).toISOString(), paused: true,
  }, 'readiness-device');
  const provider = new DeviceModelProvider({ id: 'device-models', dispatcher: devices });
  const runtime = new AgentRuntime({
    providers: [provider],
    models: [{
      id: 'local', providerId: provider.id, locality: 'local', deviceId: device.id, capabilities: [],
    }],
  });
  const assertBlocked = async (actor: Principal, expectedCode: string) => {
    const events: string[] = [];
    await assert.rejects(runtime.run({
      principal: actor,
      taskId: `blocked-${expectedCode}`,
      prompt: 'answer',
      mode: 'ask',
      modelId: 'local',
      onEvent: (event) => { events.push(event.type); },
    }), (error: unknown) => error instanceof DomainError && error.code === expectedCode);
    assert.equal(events.includes('model_call'), false);
    assert.equal((await store.scan('device_job', principal.id)).length, 0);
  };

  await assertBlocked(principal, 'waiting_for_device');
  let current = (await store.get<typeof device.data>('device', device.id, principal.id))!;
  await store.put('device', device.id, principal.id, {
    ...current.data, paused: false, reportedCapabilities: [],
  }, current.revision);
  await assertBlocked(principal, 'waiting_for_device');
  current = (await store.get<typeof device.data>('device', device.id, principal.id))!;
  await store.put('device', device.id, principal.id, {
    ...current.data, reportedCapabilities: ['model:generate'],
  }, current.revision);
  now += 45_001;
  await assertBlocked(principal, 'waiting_for_device');
  await assertBlocked({ ...principal, id: 'other-owner' }, 'device_revoked');
  current = (await store.get<typeof device.data>('device', device.id, principal.id))!;
  await store.put('device', device.id, principal.id, {
    ...current.data, revokedAt: new Date(now).toISOString(),
  }, current.revision);
  await assertBlocked(principal, 'device_revoked');
});

test('DeviceModelProvider keeps a valid answer when usage is missing or partial', async () => {
  for (const usage of [
    undefined,
    { inputTokens: 3 },
    { outputTokens: 3 },
    { inputTokens: 0, outputTokens: 0 },
    { inputTokens: -1, outputTokens: 2 },
    { inputTokens: Number.MAX_SAFE_INTEGER, outputTokens: 2 },
  ]) {
    const provider = new DeviceModelProvider({
      id: 'device-models',
      dispatcher: {
        async executeModel() {
          return { content: JSON.stringify({ message: { role: 'assistant', content: 'device answer' }, usage }) };
        },
      },
    });
    const response = await provider.chat({
      model: { id: 'local', providerId: provider.id, locality: 'local', deviceId: 'device', capabilities: [] },
      messages: [{ role: 'user', content: 'answer' }],
      tools: [],
      signal: new AbortController().signal,
      context: { principal, taskId: 'partial-usage' },
    });
    assert.equal(response.message.content, 'device answer');
    assert.equal(response.usage, undefined);
  }
});

test('local model tool only uses allowlisted models and loopback providers', async () => {
  const fetchImpl: typeof fetch = async () => new Response([
    'data: {"choices":[{"delta":{"content":"local"}}]}\n\n',
    'data: {"choices":[],"usage":{"prompt_tokens":4,"completion_tokens":1}}\n\n',
    'data: [DONE]\n\n',
  ].join(''), { status: 200 });
  const tool = createLocalModelTool({
    fetch: fetchImpl,
    models: [{
      id: 'allowed-model',
      type: 'openai',
      baseUrl: 'http://127.0.0.1:8080/v1',
      model: 'local-name',
      capabilities: ['tools'],
    }],
  });
  const context: ToolContext = {
    principal,
    taskId: 'local-tool-task',
    signal: new AbortController().signal,
  };
  const result = await tool.execute({
    operation: 'chat',
    modelId: 'allowed-model',
    messages: [{ role: 'user', content: 'hello' }],
    tools: [],
    requiredCapabilities: ['tools'],
  }, context);
  assert.deepEqual(JSON.parse(result.content), {
    message: { role: 'assistant', content: 'local' },
    usage: { inputTokens: 4, outputTokens: 1 },
  });
  await assert.rejects(tool.execute({
    operation: 'chat',
    modelId: 'not-allowed',
    messages: [],
    tools: [],
    requiredCapabilities: [],
  }, context), (error: unknown) => error instanceof Error && 'code' in error
    && error.code === 'model_not_allowed');
  assert.throws(() => createLocalModelTool({
    models: [{
      id: 'remote-http',
      type: 'openai',
      baseUrl: 'http://models.example.com/v1',
      model: 'bad',
      capabilities: [],
    }],
  }), /loopback|HTTPS/);
  assert.throws(() => createLocalModelTool({
    models: [{
      id: 'remote-https',
      type: 'openai',
      baseUrl: 'https://models.example.com/v1',
      model: 'bad',
      capabilities: [],
    }],
  }), /loopback/);
});

test('local model tool gives both provider types a bounded timeout and preserves caller cancellation', async (context) => {
  const timeouts: number[] = [];
  context.mock.method(AbortSignal, 'timeout', (milliseconds: number) => {
    timeouts.push(milliseconds);
    return new AbortController().signal;
  });

  for (const type of ['openai', 'ollama'] as const) {
    const controller = new AbortController();
    const reason = new Error(`${type} caller stopped`);
    let providerSignal: AbortSignal | null | undefined;
    const fetchImpl: typeof fetch = async (_url, init) => new Promise<Response>((_resolve, reject) => {
      providerSignal = init?.signal;
      assert.ok(providerSignal);
      providerSignal.addEventListener('abort', () => reject(providerSignal?.reason), { once: true });
    });
    const tool = createLocalModelTool({
      fetch: fetchImpl,
      models: [{
        id: `${type}-model`,
        type,
        baseUrl: type === 'openai' ? 'http://127.0.0.1:8080/v1' : 'http://127.0.0.1:11434',
        model: 'local-name',
        capabilities: [],
      }],
    });
    const pending = tool.execute({
      operation: 'chat',
      modelId: `${type}-model`,
      messages: [{ role: 'user', content: 'hello' }],
      tools: [],
      requiredCapabilities: [],
    }, { principal, taskId: `${type}-timeout`, signal: controller.signal });

    controller.abort(reason);

    await assert.rejects(pending, (error: unknown) => error === reason);
    assert.equal(providerSignal?.aborted, true);
  }
  assert.deepEqual(timeouts, [120_000, 120_000]);
});

test('device model jobs persist only an opaque reference and hydrate visual data from bounded memory', async () => {
  const store = new SqliteStore();
  const visuals = new VisualContextStore();
  const devices = new DeviceService(store, Date.now, visuals);
  const device = await store.create('device', principal.id, {
    name: 'Mac', capabilities: ['model:generate'], reportedCapabilities: ['model:generate'],
    workspaceIds: [], lastSeen: new Date().toISOString(), paused: false,
  }, 'device');
  await store.create('task', principal.id, { state: 'running' }, 'visual-task');
  const provider = new DeviceModelProvider({ id: 'device-models', dispatcher: devices, ephemeralPayloads: visuals });
  const generated = provider.chat({
    model: { id: 'local', providerId: provider.id, locality: 'local', deviceId: device.id, capabilities: ['vision'] },
    messages: [{ role: 'user', content: 'What is visible?', attachments: [{ mimeType: 'image/png', data: Buffer.from('visual-secret').toString('base64'), ephemeral: true }] }],
    tools: [], signal: new AbortController().signal,
    context: { principal, taskId: 'visual-task' },
  });
  try {
    let persisted = (await store.scan<{ job: { input: Record<string, unknown> } }>('device_job', principal.id))[0];
    while (!persisted) {
      await new Promise<void>((resolve) => setTimeout(resolve, 5));
      persisted = (await store.scan<{ job: { input: Record<string, unknown> } }>('device_job', principal.id))[0];
    }
    assert.equal(JSON.stringify(persisted.data).includes(Buffer.from('visual-secret').toString('base64')), false);
    assert.equal(typeof persisted.data.job.input.ephemeralPayloadRef, 'string');

    const jobs = (await devices.poll(device)).jobs;
    assert.equal(jobs.length, 1);
    assert.equal(JSON.stringify(jobs[0]?.input).includes(Buffer.from('visual-secret').toString('base64')), true);
    await devices.submit(device, jobs[0]!.id, {
      status: 'confirmed',
      result: { content: JSON.stringify({ message: { role: 'assistant', content: 'seen' }, usage: { inputTokens: 2, outputTokens: 1 } }) },
    });
    assert.equal((await generated).message.content, 'seen');
  } finally {
    await store.close();
  }
});

test('device model fails closed when ephemeral visual data is missing after restart', async () => {
  const store = new SqliteStore();
  const devices = new DeviceService(store, Date.now, new VisualContextStore());
  const device = await store.create('device', principal.id, {
    name: 'Mac', capabilities: ['model:generate'], reportedCapabilities: ['model:generate'],
    workspaceIds: [], lastSeen: new Date().toISOString(), paused: false,
  }, 'device');
  await store.create('task', principal.id, { state: 'running' }, 'restart-task');
  const provider = new DeviceModelProvider({ id: 'device-models', dispatcher: devices, ephemeralPayloads: new VisualContextStore() });
  const generated = provider.chat({
    model: { id: 'local', providerId: provider.id, locality: 'local', deviceId: device.id, capabilities: ['vision'] },
    messages: [{ role: 'user', content: 'What is visible?', attachments: [{ mimeType: 'image/png', data: Buffer.from('gone').toString('base64'), ephemeral: true }] }],
    tools: [], signal: new AbortController().signal,
    context: { principal, taskId: 'restart-task' },
  });
  try {
    while ((await store.scan('device_job', principal.id)).length === 0) {
      await new Promise<void>((resolve) => setTimeout(resolve, 5));
    }
    assert.deepEqual((await devices.poll(device)).jobs, []);
    await assert.rejects(generated, (error: unknown) => error instanceof Error && 'code' in error
      && error.code === 'ephemeral_context_missing');
  } finally {
    await store.close();
  }
});
