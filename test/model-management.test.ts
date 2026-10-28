import assert from 'node:assert/strict';
import test from 'node:test';
import Fastify from 'fastify';
import { ModelManagement, type ModelManagementOptions, type ModelSettings, type ProviderSettings } from '../src/model-management.js';
import { SqliteStore } from '../src/storage/sqlite.js';
import type { Principal } from '../src/contracts.js';
import { DomainError } from '../src/contracts.js';
import { registerModelManagementRoutes } from '../src/http/model-management.js';
import type { ChatRequest, RunUsage } from '../src/runtime/index.js';
import { DeviceModelProvider } from '../src/runtime/index.js';
import { DeviceService } from '../src/devices.js';
import { TaskService } from '../src/tasks.js';
import type { Conversation, Task } from '../src/domain.js';

const owner: Principal = { id: 'one', level: 1, scopes: ['*'] };
const other: Principal = { ...owner, id: 'two' };
const settings: ProviderSettings = { name: 'Test', type: 'openai-compatible', locality: 'cloud', baseUrl: 'https://models.example/v1', enabled: true };
const modelSettings: ModelSettings = { providerId: 'custom', model: 'model', enabled: false, priority: 0, architecture: 'moe' };
const reply = (content: string) => ({ message: { role: 'assistant' as const, content }, usage: { inputTokens: 11, outputTokens: 4 } });
const toolProbeArguments = {
  value: 'TOOL_READY',
  path: '驗收/日本語-🙂.txt',
  content: '臺灣・日本語🙂\n',
  emptyContent: '',
  noNewlineContent: '沒有結尾換行',
  doubleNewlineContent: '兩個換行\n\n',
  crlfContent: 'CRLF\r\n',
};
const verifiedResponse = async (request: ChatRequest) => {
  if (request.messages[0]?.content === 'Reply exactly MODEL_READY.') {
    await request.onToken?.('MODEL_READY');
    return reply('MODEL_READY');
  }
  if (request.messages.at(-1)?.role === 'tool') return reply('TOOL_READY');
  if (request.tools.length) return { ...reply(''), message: { role: 'assistant' as const, content: '', toolCalls: [{ id: 'call', name: 'probe.echo', arguments: { ...toolProbeArguments } }] } };
  if (request.messages[0]?.attachments?.length) return reply('RED');
  return reply('answer');
};
function setup(overrides: Partial<ModelManagementOptions> = {}) {
  const store = new SqliteStore();
  const options: ModelManagementOptions = { store, providers: [], models: [], tools: [], credentialKey: Buffer.alloc(32, 7), createProvider: (provider) => ({ id: provider.id, locality: provider.locality, chat: verifiedResponse }), ...overrides };
  return { store: options.store, options, service: new ModelManagement(options) };
}
const code = (expected: string) => (error: unknown) => error instanceof DomainError && error.code === expected;
async function prepare(service: ModelManagement, actor = owner, extra: Partial<ModelSettings> = {}) {
  await service.saveProvider(actor, 'custom', settings, 0, 'test-key');
  await service.saveModel(actor, 'model', { ...modelSettings, ...extra }, 0);
  await service.probe(actor, 'model', ['tools', 'vision']);
  return service.saveModel(actor, 'model', { ...modelSettings, ...extra, enabled: true }, 2);
}

test('provider credentials stay encrypted, owner scoped and cannot follow a destination change', async (t) => {
  const { store, options, service } = setup(); t.after(() => store.close());
  await service.saveProvider(owner, 'same', settings, 0, 'secret-one');
  await service.saveProvider(other, 'same', settings, 0, 'secret-two');
  assert.equal((await store.scan('model_provider')).length, 2);
  assert.ok(!JSON.stringify(await store.scan('model_provider')).includes('secret-'));
  assert.ok(!JSON.stringify(await service.providers(owner.id)).includes('ciphertext'));
  const restored = new ModelManagement(options);
  assert.equal((await restored.providers(other.id))[0]?.id, 'same');
  await assert.rejects(service.saveProvider(owner, 'same', { ...settings, baseUrl: 'https://changed.example' }, 1), code('credential_confirmation_required'));
  await assert.rejects(service.saveProvider({ ...owner, level: 2 }, 'other', settings, 0), code('owner_required'));
  await assert.rejects(service.saveProvider({ ...owner, scopes: [] }, 'other', settings, 0), code('forbidden'));
  await assert.rejects(service.saveProvider(owner, 'same', settings, 0), code('conflict'));
  await service.saveProvider(owner, 'same', { ...settings, baseUrl: 'https://changed.example' }, 1, null);
  assert.equal((await service.providers(owner.id))[0]?.credentialConfigured, false);
  assert.equal((await service.providers(other.id))[0]?.credentialConfigured, true);
});

test('only verified capabilities enable a model and changing destination invalidates its verification', async (t) => {
  const { store, service } = setup(); t.after(() => store.close());
  await service.saveProvider(owner, 'custom', settings, 0);
  await assert.rejects(service.saveModel(owner, 'model', { ...modelSettings, enabled: true }, 0), code('model_probe_required'));
  await service.saveModel(owner, 'model', modelSettings, 0);
  assert.equal((await service.models(owner.id))[0]?.enabled, false);
  assert.deepEqual((await service.probe(owner, 'model', ['tools', 'vision'])).capabilities, ['text', 'streaming', 'tools', 'vision']);
  await service.saveModel(owner, 'model', { ...modelSettings, enabled: true }, 2);
  assert.equal((await service.models(owner.id))[0]?.enabled, true);
  await service.saveProvider(owner, 'custom', { ...settings, baseUrl: 'https://new.example' }, 1);
  const updated = (await service.models(owner.id))[0]!;
  assert.equal(updated.verificationRequired, true); assert.equal(updated.enabled, false); assert.deepEqual(updated.capabilities, []);
  assert.deepEqual(await service.models(other.id), []);
});

test('managed provider timeouts reach runtime construction', async (t) => {
  let observedTimeout: number | undefined;
  const { store, service } = setup({
    createProvider: (provider) => {
      observedTimeout = provider.timeoutMs;
      return { id: provider.id, locality: provider.locality, chat: verifiedResponse };
    },
  });
  t.after(() => store.close());
  await service.saveProvider(owner, 'custom', { ...settings, timeoutMs: 120_000 }, 0);
  await service.saveModel(owner, 'model', modelSettings, 0);
  await service.probe(owner, 'model');
  await service.saveModel(owner, 'model', { ...modelSettings, enabled: true }, 2);
  observedTimeout = undefined;

  await service.runtime(owner.id);

  assert.equal(observedTimeout, 120_000);
});

test('failed capability probe disables the candidate and records a safe failure code', async (t) => {
  const { store, service } = setup({ createProvider: (provider) => ({ ...provider, chat: async () => reply('not the probe') }) }); t.after(() => store.close());
  await service.saveProvider(owner, 'custom', settings, 0);
  await service.saveModel(owner, 'model', modelSettings, 0);
  await assert.rejects(service.probe(owner, 'model'), code('model_probe_failed'));
  assert.equal((await service.models(owner.id))[0]?.lastProbeError, 'model_probe_failed');
  assert.equal((await store.scan<{ state: string }>('model_probe'))[0]?.data.state, 'finished');
});

test('the tools probe checks primitive Unicode and raw string fields in the existing three calls', async (t) => {
  const calls: ChatRequest[] = [];
  const { store, service } = setup({ createProvider: (provider) => ({
    ...provider,
    async chat(request) {
      calls.push(request);
      if (!request.tools.length) return verifiedResponse(request);
      assert.equal(request.tools[0]?.name, 'probe.echo');
      const schema = request.tools[0]!.inputSchema;
      assert.equal(schema.type, 'object');
      assert.equal(schema.additionalProperties, false);
      assert.deepEqual([...(schema.required as string[])].sort(), Object.keys(toolProbeArguments).sort());
      const properties = schema.properties as Record<string, Record<string, unknown>>;
      for (const [name, value] of Object.entries(toolProbeArguments)) {
        assert.deepEqual(properties[name], { type: 'string', const: value });
      }
      assert.equal(Object.keys(properties).length, 7);
      const prompt = request.messages[0]!.content;
      assert.ok(prompt.includes('"content":"臺灣・日本語🙂\\n"'));
      assert.ok(prompt.includes('"emptyContent":""'));
      assert.ok(prompt.includes('"doubleNewlineContent":"兩個換行\\n\\n"'));
      assert.ok(prompt.includes('"crlfContent":"CRLF\\r\\n"'));
      return {
        ...reply(''),
        message: {
          role: 'assistant', content: '',
          toolCalls: [{ id: 'raw-call', name: 'probe.echo', arguments: Object.fromEntries(Object.entries(toolProbeArguments).reverse()) }],
        },
      };
    },
  }) });
  t.after(() => store.close());
  await service.saveProvider(owner, 'custom', settings, 0);
  await service.saveModel(owner, 'model', modelSettings, 0);
  assert.deepEqual((await service.probe(owner, 'model', ['tools'])).capabilities, ['text', 'streaming', 'tools']);
  assert.equal(calls.length, 3);
  assert.deepEqual(calls[0]?.tools, []);
  assert.equal(calls[2]?.messages.at(-1)?.role, 'tool');
  assert.equal(calls[2]?.messages.at(-1)?.content, 'TOOL_READY');
  await service.saveModel(owner, 'model', { ...modelSettings, enabled: true }, 2);
  assert.equal((await service.models(owner.id))[0]?.enabled, true);
});

test('the tools probe rejects corrupted raw string arguments and disables a previously verified model', async (t) => {
  const cases: Array<{ name: string; corrupt: (args: Record<string, unknown>) => void }> = [
    { name: 'trimmed content LF', corrupt: (args) => { if (typeof args.content === 'string') args.content = args.content.trimEnd(); } },
    { name: 'missing empty field', corrupt: (args) => { delete args.emptyContent; } },
    { name: 'changed Unicode path', corrupt: (args) => { if (typeof args.path === 'string') args.path = args.path.replace('驗收', '验收'); } },
    { name: 'appended no-newline LF', corrupt: (args) => { if (typeof args.noNewlineContent === 'string') args.noNewlineContent += '\n'; } },
    { name: 'collapsed double LF', corrupt: (args) => { if (typeof args.doubleNewlineContent === 'string') args.doubleNewlineContent = args.doubleNewlineContent.replace('\n\n', '\n'); } },
    { name: 'normalized CRLF', corrupt: (args) => { if (typeof args.crlfContent === 'string') args.crlfContent = args.crlfContent.replace('\r\n', '\n'); } },
    { name: 'JSON-wrapped content', corrupt: (args) => { if (typeof args.content === 'string') args.content = JSON.stringify({ text: args.content }); } },
    { name: 'additional field', corrupt: (args) => { args.extra = 'unexpected'; } },
    { name: 'nonempty empty field', corrupt: (args) => { if ('emptyContent' in args) args.emptyContent = ' '; } },
    { name: 'wrong result value', corrupt: (args) => { args.value = 'WRONG'; } },
    { name: 'non-string content', corrupt: (args) => { if ('content' in args) args.content = 42; } },
  ];
  for (const { name, corrupt } of cases) {
    await t.test(name, async (t) => {
      let corrupting = false;
      const { store, service } = setup({ createProvider: (provider) => ({
        ...provider,
        async chat(request) {
          if (!request.tools.length) return verifiedResponse(request);
          const required = request.tools[0]!.inputSchema.required;
          assert.ok(Array.isArray(required));
          const args: Record<string, unknown> = {};
          for (const key of required) {
            assert.equal(typeof key, 'string');
            assert.ok(Object.hasOwn(toolProbeArguments, key));
            args[key] = toolProbeArguments[key as keyof typeof toolProbeArguments];
          }
          if (corrupting) corrupt(args);
          return {
            ...reply(''),
            message: { role: 'assistant', content: '', toolCalls: [{ id: 'raw-call', name: 'probe.echo', arguments: args }] },
          };
        },
      }) });
      t.after(() => store.close());
      await prepare(service);
      assert.equal((await service.models(owner.id))[0]?.enabled, true);
      const previousCalls = (await service.usage(owner.id))[0]!.calls;
      corrupting = true;
      await assert.rejects(service.probe(owner, 'model', ['tools']), code('model_probe_failed'));
      const candidate = (await service.models(owner.id))[0]!;
      assert.equal(candidate.enabled, false);
      assert.deepEqual(candidate.capabilities, []);
      assert.equal(candidate.verificationRequired, true);
      assert.equal(candidate.lastProbeError, 'model_probe_failed');
      assert.equal((await service.usage(owner.id))[0]!.calls, previousCalls + 2);
      assert.equal((await store.scan<{ state: string }>('model_probe')).every((row) => row.data.state === 'finished'), true);
      await assert.rejects(service.saveModel(owner, 'model', { ...modelSettings, enabled: true }, candidate.revision), code('model_probe_required'));
    });
  }
});

test('concurrent calls reserve quota durably before dispatch, separately for each owner', async (t) => {
  let fail = false;
  let calls = 0;
  const { store, options, service } = setup({ createProvider: (provider) => ({ ...provider, chat: async (request) => {
    calls += 1;
    if (fail) throw new Error('network outcome unknown');
    return verifiedResponse(request);
  } }) }); t.after(() => store.close());
  await prepare(service, owner, { dailyTokenLimit: 5000 });
  await prepare(service, other, { dailyTokenLimit: 5000 });
  fail = true;
  const before = calls;
  const runtime = await service.runtime(owner.id);
  const failures = await Promise.allSettled([1, 2].map((index) => runtime.run({ principal: owner, taskId: `quota-${index}`, mode: 'ask', prompt: 'hello', modelPolicy: 'cloud', modelId: 'model' })));
  assert.equal(failures.filter((result) => result.status === 'rejected').length, 2);
  assert.equal(calls - before, 1);
  const usage = await new ModelManagement(options).usage(owner.id);
  assert.equal(usage[0]?.failedCalls, 1); assert.ok(usage[0]!.reservedTokens >= 4096);
  assert.equal((await service.usage(other.id))[0]?.failedCalls, 0);
  fail = false;
  assert.equal((await (await service.runtime(other.id)).run({ principal: other, taskId: 'independent', mode: 'ask', prompt: 'hello', modelPolicy: 'cloud', modelId: 'model' })).content, 'answer');
});

test('runtime refreshes preserve single local generation across configuration instances', async (t) => {
  let active = 0; let maximum = 0;
  const { store, service } = setup({ providers: [{ id: 'local', name: 'Local', type: 'ollama', locality: 'local', baseUrl: 'http://localhost:11434', enabled: true }], models: [{ id: 'local', providerId: 'local', locality: 'local', capabilities: ['text'] }], createProvider: (provider) => ({ ...provider, async chat() { active += 1; maximum = Math.max(maximum, active); await new Promise((resolve) => setTimeout(resolve, 20)); active -= 1; return reply('done'); } }) }); t.after(() => store.close());
  const first = await service.runtime(owner.id); const second = await service.runtime(other.id);
  await Promise.all([first.run({ principal: owner, taskId: 'first', mode: 'ask', prompt: 'hello', modelPolicy: 'local' }), second.run({ principal: other, taskId: 'second', mode: 'ask', prompt: 'hello', modelPolicy: 'local' })]);
  assert.equal(maximum, 1);
});

test('model HTTP management validates scopes and never exposes provider keys', async (t) => {
  const { store, service } = setup(); const app = Fastify(); t.after(async () => { await app.close(); await store.close(); });
  app.setErrorHandler((error, _request, response) => response.code(error instanceof Error && error.name === 'ZodError' ? 400 : 500).send({ error: 'invalid' }));
  registerModelManagementRoutes(app, service, () => owner);
  const timedSettings = { ...settings, timeoutMs: 120_000 };
  const created = await app.inject({ method: 'PUT', url: '/v1/providers/custom', payload: { revision: 0, settings: timedSettings, apiKey: 'private-key' } });
  assert.equal(created.statusCode, 200); assert.ok(!created.body.includes('private-key'));
  assert.equal(created.json().data.timeoutMs, 120_000);
  const list = await app.inject('/v1/providers');
  assert.equal(list.json().data[0].credentialConfigured, true);
  assert.equal(list.json().data[0].timeoutMs, 120_000);
  assert.equal((await app.inject({
    method: 'PUT',
    url: '/v1/providers/device',
    payload: { revision: 0, settings: { name: 'Device', type: 'device', locality: 'local', enabled: true, timeoutMs: 60_000 } },
  })).statusCode, 400);
  assert.equal((await app.inject({ method: 'DELETE', url: '/v1/providers/custom?revision=1' })).statusCode, 204);
  const disabled = await app.inject('/v1/providers');
  assert.equal(disabled.json().data[0].enabled, false);
  assert.equal(disabled.json().data[0].timeoutMs, 120_000);
  assert.equal((await app.inject({ method: 'PUT', url: '/v1/models/model', payload: { revision: 0, settings: { ...modelSettings, capabilities: ['vision'] } } })).statusCode, 400);
});

test('device model probes have bounded execution records and flow through authorized device jobs', async (t) => {
  const { store, options } = setup(); t.after(() => store.close());
  const devices = new DeviceService(store);
  const pairing = await devices.createPairing(owner, ['model:generate'], []);
  const paired = await devices.pair({ code: pairing.code, name: 'Test Mac', capabilities: ['model:generate'] });
  const device = await devices.authenticate(`Bearer ${paired.token}`, paired.deviceId);
  const service = new ModelManagement({ ...options, createProvider: ({ id }) => new DeviceModelProvider({ id, dispatcher: devices }) });
  await service.saveProvider(owner, 'device', { name: 'Mac', type: 'device', locality: 'local', enabled: true }, 0);
  await service.saveModel(owner, 'local', { ...modelSettings, providerId: 'device', deviceId: paired.deviceId }, 0);
  const pending = service.probe(owner, 'local');
  let jobs = (await devices.poll(device)).jobs;
  for (let attempt = 0; jobs.length === 0 && attempt < 50; attempt += 1) { await new Promise((resolve) => setTimeout(resolve, 5)); jobs = (await devices.poll(device)).jobs; }
  assert.equal(jobs.length, 1); assert.equal(jobs[0]?.toolName, 'model.generate');
  await devices.submit(device, jobs[0]!.id, { status: 'confirmed', result: { content: JSON.stringify(reply('MODEL_READY')) } });
  assert.deepEqual((await pending).capabilities, ['text', 'streaming']);
  assert.equal((await store.scan<{ state: string }>('model_probe'))[0]?.data.state, 'finished');
  assert.equal((await store.scan('task')).length, 0);
});

test('paused device probes do not consume daily quota or create model jobs', async (t) => {
  const { store, options } = setup(); t.after(() => store.close());
  const devices = new DeviceService(store);
  const pairing = await devices.createPairing(owner, ['model:generate'], []);
  const paired = await devices.pair({ code: pairing.code, name: 'Paused Mac', capabilities: ['model:generate'] });
  const service = new ModelManagement({
    ...options,
    createProvider: ({ id }) => new DeviceModelProvider({ id, dispatcher: devices }),
  });
  await service.saveProvider(owner, 'device', { name: 'Mac', type: 'device', locality: 'local', enabled: true }, 0);
  await service.saveModel(owner, 'local', { ...modelSettings, providerId: 'device', deviceId: paired.deviceId }, 0);
  await devices.control(owner.id, paired.deviceId, 'pause');

  await assert.rejects(service.probe(owner, 'local'), code('waiting_for_device'));
  assert.deepEqual(await service.usage(owner.id), []);
  assert.equal((await store.scan('device_job', owner.id)).length, 0);
});

test('a queued local probe checks readiness before reserving daily quota', async (t) => {
  let otherAvailable = true;
  let ownerStarted = false;
  let releaseOwner: (() => void) | undefined;
  const ownerGate = new Promise<void>((resolve) => { releaseOwner = resolve; });
  const localSettings: ProviderSettings = {
    name: 'Local', type: 'ollama', locality: 'local', baseUrl: 'http://localhost:11434', enabled: true,
  };
  const { store, service } = setup({
    createProvider: (provider) => ({
      id: provider.id,
      locality: provider.locality,
      async isAvailable(_model, _workspace, _signal, context) {
        return context?.principal.id === owner.id || otherAvailable;
      },
      async chat(request) {
        if (request.context?.principal.id === owner.id) {
          ownerStarted = true;
          await ownerGate;
        }
        return verifiedResponse(request);
      },
    }),
  });
  t.after(() => store.close());
  for (const actor of [owner, other]) {
    await service.saveProvider(actor, 'local', localSettings, 0);
    await service.saveModel(actor, 'model', { ...modelSettings, providerId: 'local' }, 0);
  }

  const first = service.probe(owner, 'model');
  while (!ownerStarted) await new Promise<void>((resolve) => setImmediate(resolve));
  const second = service.probe(other, 'model');
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(await service.usage(other.id), []);

  otherAvailable = false;
  releaseOwner?.();
  await first;
  await assert.rejects(second, code('waiting_for_device'));
  assert.deepEqual(await service.usage(other.id), []);
});

test('repeated device waits across runtime restarts preserve task and daily budgets until the device resumes', async (t) => {
  let now = Date.now();
  const { store, options } = setup({ now: () => now }); t.after(() => store.close());
  const devices = new DeviceService(store, () => now);
  const pairing = await devices.createPairing(owner, ['model:generate'], []);
  const paired = await devices.pair({ code: pairing.code, name: 'Restarting Mac', capabilities: ['model:generate'] });
  const managedOptions: ModelManagementOptions = {
    ...options,
    createProvider: ({ id }) => new DeviceModelProvider({ id, dispatcher: devices }),
  };
  const service = new ModelManagement(managedOptions);
  await service.saveProvider(owner, 'device', { name: 'Mac', type: 'device', locality: 'local', enabled: true }, 0);
  await service.saveModel(owner, 'local', { ...modelSettings, providerId: 'device', deviceId: paired.deviceId }, 0);
  const probing = service.probe(owner, 'local');
  let authenticated = await devices.authenticate(`Bearer ${paired.token}`, paired.deviceId);
  let jobs = (await devices.poll(authenticated)).jobs;
  for (let attempt = 0; jobs.length === 0 && attempt < 50; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
    jobs = (await devices.poll(authenticated)).jobs;
  }
  assert.equal(jobs.length, 1);
  await devices.submit(authenticated, jobs[0]!.id, {
    status: 'confirmed', result: { content: JSON.stringify(reply('MODEL_READY')) },
  });
  await probing;
  await service.saveModel(owner, 'local', {
    ...modelSettings, providerId: 'device', deviceId: paired.deviceId, enabled: true,
  }, 2);
  const conversation = await store.create<Conversation>('conversation', owner.id, {
    title: 'Local model', scope: 'private', modelPolicy: 'local', strategy: 'single', mode: 'ask',
    modelId: 'local', archived: false,
  });
  let pauseAfterModelCall = false;
  const createTasks = () => new TaskService(store, async ({ task, signal, onEvent }) => {
    const runtime = await new ModelManagement(managedOptions).runtime(owner.id);
    const result = await runtime.run({
      principal: task.data.principal,
      taskId: task.id,
      mode: 'ask',
      prompt: task.data.prompt,
      modelId: 'local',
      budgets: { maxCalls: 2, maxTokens: 8_000 },
      priorUsage: task.data.usage as RunUsage | undefined,
      signal,
      onEvent: async (event) => {
        await onEvent(event);
        if (pauseAfterModelCall && event.type === 'model_call') {
          pauseAfterModelCall = false;
          await devices.control(owner.id, paired.deviceId, 'pause');
        }
      },
    });
    return { text: result.content, messages: result.messages, usage: result.usage };
  }, { now: () => now });
  let tasks = createTasks();
  const task = await tasks.enqueue(owner, conversation.id, 'continue when ready', 'same-task');
  await devices.control(owner.id, paired.deviceId, 'pause');
  const usageBeforeWaits = await service.usage(owner.id);
  const jobsBeforeWaits = await store.scan('device_job', owner.id);

  for (let attempt = 0; attempt < 3; attempt += 1) {
    await tasks.drain();
    const waiting = await store.get<Task>('task', task.id, owner.id);
    assert.equal(waiting?.data.state, 'waiting_for_device');
    assert.equal(waiting?.data.usage, undefined);
    assert.equal((await tasks.events(owner.id, task.id)).some((event) => event.data.type === 'model_call'), false);
    await tasks.close();
    now += 10_001;
    tasks = createTasks();
  }
  assert.deepEqual(await service.usage(owner.id), usageBeforeWaits);
  assert.equal((await store.scan('device_job', owner.id)).length, jobsBeforeWaits.length);

  await devices.control(owner.id, paired.deviceId, 'resume');
  authenticated = await devices.authenticate(`Bearer ${paired.token}`, paired.deviceId);
  await devices.heartbeat(authenticated, ['model:generate']);
  authenticated = await devices.authenticate(`Bearer ${paired.token}`, paired.deviceId);
  const resumed = tasks.drain();
  jobs = (await devices.poll(authenticated)).jobs;
  for (let attempt = 0; jobs.length === 0 && attempt < 50; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
    jobs = (await devices.poll(authenticated)).jobs;
  }
  assert.equal(jobs.length, 1);
  await devices.submit(authenticated, jobs[0]!.id, {
    status: 'confirmed', result: { content: JSON.stringify(reply('resumed')) },
  });
  await resumed;
  const completed = await store.get<Task>('task', task.id, owner.id);
  assert.equal(completed?.data.state, 'completed');
  assert.equal(completed?.data.result, 'resumed');
  assert.equal((completed?.data.usage as { calls?: number } | undefined)?.calls, 1);
  const usageAfterResume = await service.usage(owner.id);
  assert.equal(usageAfterResume[0]!.calls, usageBeforeWaits[0]!.calls + 1);
  assert.equal((await store.scan('device_job', owner.id)).length, jobsBeforeWaits.length + 1);

  const usageBeforeRace = await service.usage(owner.id);
  const jobsBeforeRace = await store.scan('device_job', owner.id);
  const raceTask = await tasks.enqueue(owner, conversation.id, 'pause after reservation', 'race-task');
  pauseAfterModelCall = true;
  await tasks.drain();
  const raceWaiting = await store.get<Task>('task', raceTask.id, owner.id);
  assert.equal(raceWaiting?.data.state, 'waiting_for_device');
  assert.equal((raceWaiting?.data.usage as RunUsage | undefined)?.calls, 0);
  assert.deepEqual(await service.usage(owner.id), usageBeforeRace);
  assert.equal((await store.scan('device_job', owner.id)).length, jobsBeforeRace.length);
  assert.deepEqual(
    (await tasks.events(owner.id, raceTask.id))
      .filter((event) => ['model_call', 'model_call_released'].includes(event.data.type))
      .map((event) => event.data.type),
    ['model_call', 'model_call_released'],
  );

  await tasks.close();
  now += 10_001;
  await devices.control(owner.id, paired.deviceId, 'resume');
  authenticated = await devices.authenticate(`Bearer ${paired.token}`, paired.deviceId);
  await devices.heartbeat(authenticated, ['model:generate']);
  authenticated = await devices.authenticate(`Bearer ${paired.token}`, paired.deviceId);
  tasks = createTasks();
  const raceResumed = tasks.drain();
  jobs = (await devices.poll(authenticated)).jobs;
  for (let attempt = 0; jobs.length === 0 && attempt < 50; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
    jobs = (await devices.poll(authenticated)).jobs;
  }
  assert.equal(jobs.length, 1);
  await devices.submit(authenticated, jobs[0]!.id, {
    status: 'confirmed', result: { content: JSON.stringify(reply('race resumed')) },
  });
  await raceResumed;
  const raceCompleted = await store.get<Task>('task', raceTask.id, owner.id);
  assert.equal(raceCompleted?.data.state, 'completed');
  assert.equal((raceCompleted?.data.usage as RunUsage | undefined)?.calls, 1);
  assert.equal((await service.usage(owner.id))[0]!.calls, usageBeforeRace[0]!.calls + 1);
  assert.equal((await store.scan('device_job', owner.id)).length, jobsBeforeRace.length + 1);
  await tasks.close();
});

test('revoked device models can be disabled without weakening device or ownership checks', async (t) => {
  const { store, options } = setup();
  const devices = new DeviceService(store);
  const service = new ModelManagement({
    ...options,
    createProvider: ({ id }) => new DeviceModelProvider({ id, dispatcher: devices }),
  });
  const app = Fastify();
  let actor = owner;
  t.after(async () => { await app.close(); await store.close(); });
  app.setErrorHandler((error, _request, response) => {
    if (error instanceof DomainError) {
      return response.code(error.statusCode).send({ error: { code: error.code } });
    }
    return response.code(500).send({ error: { code: 'internal_error' } });
  });
  registerModelManagementRoutes(app, service, () => actor);
  const pairing = await devices.createPairing(owner, ['model:generate'], []);
  const paired = await devices.pair({ code: pairing.code, name: 'Test Mac', capabilities: ['model:generate'] });
  const device = await devices.authenticate(`Bearer ${paired.token}`, paired.deviceId);
  const deviceModel = {
    ...modelSettings,
    providerId: 'device',
    deviceId: paired.deviceId,
  };
  await service.saveProvider(owner, 'device', {
    name: 'Mac', type: 'device', locality: 'local', enabled: true,
  }, 0);
  await service.saveModel(owner, 'local', deviceModel, 0);
  const pending = service.probe(owner, 'local');
  let jobs = (await devices.poll(device)).jobs;
  for (let attempt = 0; jobs.length === 0 && attempt < 50; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
    jobs = (await devices.poll(device)).jobs;
  }
  assert.equal(jobs.length, 1);
  await devices.submit(device, jobs[0]!.id, {
    status: 'confirmed', result: { content: JSON.stringify(reply('MODEL_READY')) },
  });
  await pending;
  await service.saveModel(owner, 'local', { ...deviceModel, enabled: true }, 2);
  await devices.control(owner.id, paired.deviceId, 'revoke');

  actor = other;
  const wrongOwner = await app.inject({ method: 'DELETE', url: '/v1/models/local?revision=3' });
  assert.equal(wrongOwner.statusCode, 404);
  assert.equal(wrongOwner.json().error.code, 'not_found');

  actor = owner;
  const disabled = await app.inject({ method: 'DELETE', url: '/v1/models/local?revision=3' });
  assert.equal(disabled.statusCode, 204, disabled.body);
  assert.equal((await service.models(owner.id))[0]?.enabled, false);

  const stale = await app.inject({ method: 'DELETE', url: '/v1/models/local?revision=3' });
  assert.equal(stale.statusCode, 409);
  assert.equal(stale.json().error.code, 'conflict');
  const reenabled = await app.inject({
    method: 'PUT', url: '/v1/models/local',
    payload: { revision: 4, settings: { ...deviceModel, enabled: true } },
  });
  assert.equal(reenabled.statusCode, 404);
  assert.equal(reenabled.json().error.code, 'device_not_found');
  const retargeted = await app.inject({
    method: 'PUT', url: '/v1/models/local',
    payload: { revision: 4, settings: { ...deviceModel, model: 'other-model' } },
  });
  assert.equal(retargeted.statusCode, 404);
  assert.equal(retargeted.json().error.code, 'device_not_found');
  const created = await app.inject({
    method: 'PUT', url: '/v1/models/new-local',
    payload: { revision: 0, settings: deviceModel },
  });
  assert.equal(created.statusCode, 404);
  assert.equal(created.json().error.code, 'device_not_found');

  actor = { ...owner, scopes: ['model:read'] };
  const forbidden = await app.inject({ method: 'DELETE', url: '/v1/models/local?revision=4' });
  assert.equal(forbidden.statusCode, 403);
  assert.equal(forbidden.json().error.code, 'forbidden');

  const revokedDevice = await store.get('device', paired.deviceId, owner.id);
  assert.ok(revokedDevice);
  await store.remove('device', paired.deviceId, owner.id, revokedDevice.revision);
  actor = owner;
  const removedDevice = await app.inject({ method: 'DELETE', url: '/v1/models/local?revision=4' });
  assert.equal(removedDevice.statusCode, 204, removedDevice.body);
});


test('unreported or invalid provider usage retains a conservative reservation', async (t) => {
  let probe = true;
  const { store, service } = setup({ createProvider: (provider) => ({ ...provider, chat: (request) => probe ? verifiedResponse(request) : Promise.resolve({ ...reply('answer'), usage: { inputTokens: -1, outputTokens: 0 } }) }) });
  t.after(() => store.close());
  await prepare(service); probe = false;
  await (await service.runtime(owner.id)).run({ principal: owner, taskId: 'unreported', mode: 'ask', prompt: 'hello', modelId: 'model' });
  const [usage] = await service.usage(owner.id);
  assert.equal(usage?.unreportedCalls, 1); assert.ok(usage!.reservedTokens > 4096); assert.equal(usage?.confirmedInputTokens, 44);
});

test('daily quota reservation estimates CJK tokens instead of UTF-8 bytes', async (t) => {
  const { store, service } = setup();
  t.after(() => store.close());
  await prepare(service, owner, { dailyTokenLimit: 10_000 });
  const prompt = '海'.repeat(3_000);
  assert.equal(Buffer.byteLength(prompt, 'utf8'), 9_000);
  const result = await (await service.runtime(owner.id)).run({
    principal: owner,
    taskId: 'cjk-quota',
    mode: 'ask',
    prompt,
    modelId: 'model',
  });
  assert.equal(result.content, 'answer');
});

test('a persisted credential survives service restart and fails closed under the wrong encryption key', async (t) => {
  let actualKey: string | undefined;
  const { store, options, service } = setup({ createProvider: (provider) => { actualKey = provider.apiKey; return { ...provider, chat: verifiedResponse }; } });
  t.after(() => store.close());
  await prepare(service);
  await (await new ModelManagement(options).runtime(owner.id)).run({ principal: owner, taskId: 'reload', mode: 'ask', prompt: 'hello' });
  assert.equal(actualKey, 'test-key');
  await assert.rejects(new ModelManagement({ ...options, credentialKey: Buffer.alloc(32, 9) }).runtime(owner.id), code('credential_unavailable'));
});
