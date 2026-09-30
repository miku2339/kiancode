import assert from 'node:assert/strict';
import test from 'node:test';
import Fastify from 'fastify';
import { ModelManagement, type ModelManagementOptions, type ModelSettings, type ProviderSettings } from '../src/model-management.js';
import { SqliteStore } from '../src/storage/sqlite.js';
import type { Principal } from '../src/contracts.js';
import { DomainError } from '../src/contracts.js';
import { registerModelManagementRoutes } from '../src/http/model-management.js';
import type { ChatRequest } from '../src/runtime/index.js';
import { DeviceModelProvider } from '../src/runtime/index.js';
import { DeviceService } from '../src/devices.js';

const owner: Principal = { id: 'one', level: 1, scopes: ['*'] };
const other: Principal = { ...owner, id: 'two' };
const settings: ProviderSettings = { name: 'Test', type: 'openai-compatible', locality: 'cloud', baseUrl: 'https://models.example/v1', enabled: true };
const modelSettings: ModelSettings = { providerId: 'custom', model: 'model', enabled: false, priority: 0, architecture: 'moe' };
const reply = (content: string) => ({ message: { role: 'assistant' as const, content }, usage: { inputTokens: 11, outputTokens: 4 } });
const verifiedResponse = async (request: ChatRequest) => {
  if (request.messages[0]?.content === 'Reply exactly MODEL_READY.') {
    await request.onToken?.('MODEL_READY');
    return reply('MODEL_READY');
  }
  if (request.messages.at(-1)?.role === 'tool') return reply('TOOL_READY');
  if (request.tools.length) return { ...reply(''), message: { role: 'assistant' as const, content: '', toolCalls: [{ id: 'call', name: 'probe.echo', arguments: { value: 'TOOL_READY' } }] } };
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

test('failed capability probe disables the candidate and records a safe failure code', async (t) => {
  const { store, service } = setup({ createProvider: (provider) => ({ ...provider, chat: async () => reply('not the probe') }) }); t.after(() => store.close());
  await service.saveProvider(owner, 'custom', settings, 0);
  await service.saveModel(owner, 'model', modelSettings, 0);
  await assert.rejects(service.probe(owner, 'model'), code('model_probe_failed'));
  assert.equal((await service.models(owner.id))[0]?.lastProbeError, 'model_probe_failed');
  assert.equal((await store.scan<{ state: string }>('model_probe'))[0]?.data.state, 'finished');
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
  const created = await app.inject({ method: 'PUT', url: '/v1/providers/custom', payload: { revision: 0, settings, apiKey: 'private-key' } });
  assert.equal(created.statusCode, 200); assert.ok(!created.body.includes('private-key'));
  const list = await app.inject('/v1/providers'); assert.equal(list.json().data[0].credentialConfigured, true);
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


test('unreported or invalid provider usage retains a conservative reservation', async (t) => {
  let probe = true;
  const { store, service } = setup({ createProvider: (provider) => ({ ...provider, chat: (request) => probe ? verifiedResponse(request) : Promise.resolve({ ...reply('answer'), usage: { inputTokens: -1, outputTokens: 0 } }) }) });
  t.after(() => store.close());
  await prepare(service); probe = false;
  await (await service.runtime(owner.id)).run({ principal: owner, taskId: 'unreported', mode: 'ask', prompt: 'hello', modelId: 'model' });
  const [usage] = await service.usage(owner.id);
  assert.equal(usage?.unreportedCalls, 1); assert.ok(usage!.reservedTokens > 4096); assert.equal(usage?.confirmedInputTokens, 44);
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
