import assert from 'node:assert/strict';
import test from 'node:test';
import type { DeviceJob } from '../src/connectors/device.js';
import { DomainError, isNotDispatched, type Principal } from '../src/contracts.js';
import { createServer } from '../src/http/server.js';
import { SqliteStore } from '../src/storage/sqlite.js';

const owner: Principal = { id: 'owner', level: 1, scopes: ['*'] };
const headers = { authorization: 'Bearer owner' };

async function fixture(store = new SqliteStore()) {
  const actors: Record<string, Principal> = {
    owner,
    member: { ...owner, level: 2 },
    reader: { ...owner, scopes: ['model:generate'] },
    manager: { ...owner, scopes: ['device:write'] },
    stranger: { ...owner, id: 'stranger' },
  };
  const server = await createServer({
    store,
    authenticate: async (authorization) => {
      const actor = actors[authorization?.replace('Bearer ', '') ?? ''];
      if (!actor) throw new DomainError('unauthorized', 'Invalid test session', 401);
      return actor;
    },
    runner: async () => ({ text: 'unused' }),
  });
  const pairing = await server.devices.createPairing(owner, ['workspace:read', 'workspace:write'], []);
  const paired = await server.devices.pair({
    code: pairing.code, name: 'Existing Mac', capabilities: ['workspace:read', 'workspace:write'],
  });
  const workspace = await store.create('workspace', owner.id, {
    name: 'Existing project', root: '/project', deviceId: paired.deviceId,
    capabilities: ['workspace:read', 'workspace:write'], allowCloud: false,
  });
  await server.devices.grant(owner, paired.deviceId, [workspace.id]);
  await server.devices.control(owner.id, paired.deviceId, 'pause');
  const device = () => server.devices.authenticate(`Bearer ${paired.token}`, paired.deviceId);
  const url = `/v1/devices/${paired.deviceId}/model-access`;
  const update = (revision: number, enabled: boolean, actor = 'owner') => server.app.inject({
    method: 'PATCH', url, headers: { authorization: `Bearer ${actor}` }, payload: { revision, enabled },
  });
  return { store, server, paired, workspace, device, url, update };
}

test('model access updates the original device without changing credentials, workspace grants, or other capabilities', async (t) => {
  const f = await fixture();
  t.after(() => f.server.close());
  const before = await f.device();
  const credentials = await f.store.scan('device_token');
  const enabled = await f.update(before.revision, true);
  assert.equal(enabled.statusCode, 200, enabled.body);
  const after = await f.device();
  assert.equal(after.id, before.id);
  assert.equal(after.ownerId, before.ownerId);
  assert.equal(after.createdAt, before.createdAt);
  assert.deepEqual(after.data.workspaceIds, [f.workspace.id]);
  assert.deepEqual(after.data.capabilities, ['workspace:read', 'workspace:write', 'model:generate']);
  assert.deepEqual(after.data.reportedCapabilities, before.data.reportedCapabilities);
  assert.deepEqual(await f.store.scan('device_token'), credentials);

  await f.server.devices.heartbeat(after, after.data.capabilities);
  const reported = await f.device();
  const disabled = await f.update(reported.revision, false, 'manager');
  assert.equal(disabled.statusCode, 200, disabled.body);
  const removed = await f.device();
  assert.deepEqual(removed.data.capabilities, before.data.capabilities);
  assert.deepEqual(removed.data.reportedCapabilities, before.data.reportedCapabilities);
  assert.deepEqual(removed.data.workspaceIds, before.data.workspaceIds);
  await assert.rejects(f.server.devices.heartbeat(removed, ['model:generate']), /cannot add/);
  await assert.rejects(f.server.devices.heartbeat(reported, reported.data.reportedCapabilities), /conflict|revision/i);
  assert.deepEqual(await f.device(), removed);
  assert.deepEqual(await f.store.scan('device_token'), credentials);
  const status = await f.server.app.inject({ method: 'GET', url: f.url, headers });
  assert.equal(status.statusCode, 200, status.body);
  assert.deepEqual(status.json(), { data: removed, activeJobs: { queued: 0, dispatched: 0 } });
});

test('model access requires the same account owner and narrowly scoped permissions', async (t) => {
  const f = await fixture();
  t.after(() => f.server.close());
  const before = await f.device();
  for (const actor of ['member', 'reader', 'manager']) {
    const response = await f.update(before.revision, true, actor);
    assert.equal(response.statusCode, 403, `${actor}: ${response.body}`);
  }
  for (const actor of ['member', 'reader']) {
    const response = await f.server.app.inject({ method: 'GET', url: f.url, headers: { authorization: `Bearer ${actor}` } });
    assert.equal(response.statusCode, 403, `${actor}: ${response.body}`);
  }
  assert.equal((await f.update(before.revision, true, 'stranger')).statusCode, 404);
  assert.equal((await f.server.app.inject({ method: 'GET', url: f.url, headers: { authorization: 'Bearer stranger' } })).statusCode, 404);
  assert.deepEqual(await f.device(), before);
});

test('model access rejects revoked devices, stale revisions, and additional changes', async (t) => {
  const f = await fixture();
  t.after(() => f.server.close());
  const before = await f.device();
  await f.server.devices.heartbeat(before, before.data.reportedCapabilities);
  assert.equal((await f.update(before.revision, true)).statusCode, 409);
  const current = await f.device();
  for (const payload of [
    { revision: 0, enabled: true },
    { revision: current.revision, enabled: true, capabilities: ['shell:execute'] },
    { revision: current.revision, enabled: 'yes' },
  ]) {
    const response = await f.server.app.inject({ method: 'PATCH', url: f.url, headers, payload });
    assert.equal(response.statusCode, 400, response.body);
  }
  assert.deepEqual(await f.device(), current);
  await f.server.devices.control(owner.id, f.paired.deviceId, 'revoke');
  assert.equal((await f.update(current.revision + 1, true)).statusCode, 404);
  assert.equal((await f.server.app.inject({ method: 'GET', url: f.url, headers })).statusCode, 404);
});

test('model access requires a paused idle device and reports only queued or dispatched work', async (t) => {
  const f = await fixture();
  t.after(() => f.server.close());
  await f.server.devices.control(owner.id, f.paired.deviceId, 'resume');
  assert.equal((await f.update((await f.device()).revision, true)).statusCode, 409);
  await f.server.devices.control(owner.id, f.paired.deviceId, 'pause');
  const before = await f.device();
  const rows = [];
  for (const [index, state] of ['queued', 'dispatched', 'unknown', 'confirmed'].entries()) {
    rows.push(await f.store.create('device_job', owner.id, {
      job: modelJob(f.paired.deviceId, `job-${index}`), state, result: { content: `${state} receipt` },
    }, `job-${index}`));
  }
  const status = await f.server.app.inject({ method: 'GET', url: f.url, headers });
  assert.equal(status.statusCode, 200, status.body);
  assert.deepEqual(status.json().activeJobs, { queued: 1, dispatched: 1 });
  assert.equal((await f.update(before.revision, true)).statusCode, 409);
  assert.deepEqual(await f.device(), before);
  for (const row of rows.slice(0, 2)) await f.store.remove('device_job', row.id, owner.id, row.revision);
  const retained = await f.store.scan('device_job', owner.id);
  assert.equal((await f.update(before.revision, true)).statusCode, 200);
  assert.deepEqual(await f.store.scan('device_job', owner.id), retained);
});

test('concurrent model access updates have a single CAS winner', async (t) => {
  const f = await fixture();
  t.after(() => f.server.close());
  const before = await f.device();
  const responses = await Promise.all([f.update(before.revision, true), f.update(before.revision, false)]);
  assert.deepEqual(responses.map((response) => response.statusCode).sort(), [200, 409]);
  assert.equal((await f.device()).revision, before.revision + 1);
});

test('resume and heartbeat changes between the idle check and CAS are preserved', async (t) => {
  for (const action of ['resume', 'heartbeat'] as const) {
    await t.test(action, async (t) => {
      const store = new SqliteStore();
      const f = await fixture(store);
      t.after(() => f.server.close());
      const before = await f.device();
      let notifyArrival!: () => void;
      let releaseChange!: () => void;
      const arrived = new Promise<void>((resolve) => { notifyArrival = resolve; });
      const release = new Promise<void>((resolve) => { releaseChange = resolve; });
      t.after(() => releaseChange());
      const put = store.put.bind(store);
      store.put = async <T>(kind: string, id: string, ownerId: string, data: T, revision: number) => {
        if (kind === 'device' && (data as { capabilities?: string[] }).capabilities?.includes('model:generate')) {
          notifyArrival();
          await release;
        }
        return put(kind, id, ownerId, data, revision);
      };
      const updating = f.update(before.revision, true).then((response) => response);
      await arrived;
      if (action === 'resume') await f.server.devices.control(owner.id, f.paired.deviceId, 'resume');
      else await f.server.devices.heartbeat(before, ['workspace:read']);
      const concurrent = await f.device();
      releaseChange();
      const response = await updating;
      assert.equal(response.statusCode, 409, response.body);
      assert.deepEqual(await f.device(), concurrent);
      assert.equal(concurrent.revision, before.revision + 1);
      assert.equal(concurrent.data.capabilities.includes('model:generate'), false);
      if (action === 'resume') assert.equal(concurrent.data.paused, false);
      else assert.deepEqual(concurrent.data.reportedCapabilities, ['workspace:read']);
    });
  }
});

test('polling a stale device snapshot cannot dispatch model work after model access is removed', async (t) => {
  const f = await fixture();
  t.after(() => f.server.close());
  assert.equal((await f.update((await f.device()).revision, true)).statusCode, 200);
  await f.server.devices.control(owner.id, f.paired.deviceId, 'resume');
  await f.server.devices.heartbeat(await f.device(), ['workspace:read', 'workspace:write', 'model:generate']);
  const stale = await f.device();
  await f.server.devices.control(owner.id, f.paired.deviceId, 'pause');
  assert.equal((await f.update((await f.device()).revision, false)).statusCode, 200);
  const job = modelJob(f.paired.deviceId, 'late-queued-model');
  await f.store.create('task', owner.id, { state: 'running' }, job.taskId);
  await f.store.create('device_job', owner.id, { job, state: 'queued' }, job.id);
  assert.deepEqual((await f.server.devices.poll(stale)).jobs, []);
  await f.server.devices.control(owner.id, f.paired.deviceId, 'resume');
  assert.deepEqual((await f.server.devices.poll(stale)).jobs, []);
  const row = await f.store.get<{ state: string; job: DeviceJob }>('device_job', job.id, owner.id);
  assert.equal(row?.data.state, 'cancelled');
  assert.equal(row.data.job.dispatchedAt, '');
});

test('stale polling snapshots cannot bypass a pause or full device revocation', async (t) => {
  const f = await fixture();
  t.after(() => f.server.close());
  const pairing = await f.server.devices.createPairing(owner, ['model:generate'], []);
  const paired = await f.server.devices.pair({ code: pairing.code, name: 'Model device', capabilities: ['model:generate'] });
  const stale = await f.server.devices.authenticate(`Bearer ${paired.token}`, paired.deviceId);
  const job = modelJob(paired.deviceId, 'paused-job');
  await f.store.create('task', owner.id, { state: 'running' }, job.taskId);
  await f.store.create('device_job', owner.id, { job, state: 'queued' }, job.id);
  await f.server.devices.control(owner.id, paired.deviceId, 'pause');
  assert.deepEqual((await f.server.devices.poll(stale)).jobs, []);
  await f.server.devices.control(owner.id, paired.deviceId, 'revoke');
  assert.deepEqual((await f.server.devices.poll(stale)).jobs, []);
  const row = await f.store.get<{ state: string }>('device_job', job.id, owner.id);
  assert.equal(row?.data.state, 'queued');
});

test('a model job created after the idle check is cancelled before delivery and remains not dispatched', async (t) => {
  const store = new SqliteStore();
  let notifyArrival!: () => void;
  let releaseQueue!: () => void;
  const arrived = new Promise<void>((resolve) => { notifyArrival = resolve; });
  const release = new Promise<void>((resolve) => { releaseQueue = resolve; });
  const create = store.create.bind(store);
  store.create = async <T>(kind: string, ownerId: string, data: T, id?: string) => {
    if (kind === 'device_job') {
      notifyArrival();
      await release;
    }
    return create(kind, ownerId, data, id);
  };
  const f = await fixture(store);
  t.after(() => f.server.close());
  assert.equal((await f.update((await f.device()).revision, true)).statusCode, 200);
  await f.server.devices.control(owner.id, f.paired.deviceId, 'resume');
  await f.server.devices.heartbeat(await f.device(), ['model:generate']);
  const stale = await f.device();
  await store.create('task', owner.id, { state: 'running' }, 'late-model-task');
  const controller = new AbortController();
  t.after(() => controller.abort());
  const operation = f.server.devices.executeModel(f.paired.deviceId, { modelId: 'local' }, {
    principal: owner, taskId: 'late-model-task', signal: controller.signal,
  });
  const rejected = assert.rejects(operation, (error: unknown) => isNotDispatched(error)
    && error.code === 'device_not_dispatched');
  await arrived;
  await f.server.devices.control(owner.id, f.paired.deviceId, 'pause');
  const disabled = await f.update((await f.device()).revision, false);
  assert.equal(disabled.statusCode, 200, disabled.body);
  releaseQueue();
  while (!(await store.scan('device_job', owner.id)).length) await Promise.resolve();
  assert.deepEqual((await f.server.devices.poll(stale)).jobs, []);
  await rejected;
  const [job] = await store.scan<{ state: string; job: DeviceJob }>('device_job', owner.id);
  assert.equal(job?.data.state, 'cancelled');
  assert.equal(job.data.job.dispatchedAt, '');
});

function modelJob(deviceId: string, id: string): DeviceJob {
  return {
    id, deviceId, principal: owner, taskId: `task-${id}`, toolName: 'model.generate',
    input: { modelId: 'local' }, requiredCapabilities: ['model:generate'],
    expiresAt: new Date(Date.now() + 60_000).toISOString(), dispatchedAt: '',
  };
}
