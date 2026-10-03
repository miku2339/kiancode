import assert from 'node:assert/strict';
import test from 'node:test';
import { DeviceService } from '../src/devices.js';
import { SqliteStore } from '../src/storage/sqlite.js';
import { isNotDispatched, type Principal, type ToolContext, type ToolResult, type Workspace } from '../src/contracts.js';

const owner: Principal = { id: 'owner', level: 1, scopes: ['*'] };
test('pairing is single-use, device grants cannot expand, and dispatched jobs are not replayed', async () => {
  const store = new SqliteStore(); const service = new DeviceService(store);
  try {
    const code = await service.createPairing(owner, ['workspace:read'], []);
    const paired = await service.pair({ code: code.code, name: 'Mac', capabilities: ['workspace:read'] });
    await assert.rejects(service.pair({ code: code.code, name: 'Clone', capabilities: [] }), /invalid|expired/);
    let device = await service.authenticate(`Bearer ${paired.token}`, paired.deviceId);
    await assert.rejects(service.heartbeat(device, ['shell:execute']), /cannot add/);
    const workspaceRow = await store.create('workspace', owner.id, { name: 'Project', root: '/example', deviceId: paired.deviceId, capabilities: ['workspace:read'], allowCloud: false });
    const workspace: Workspace = { ...workspaceRow.data, id: workspaceRow.id, ownerId: owner.id };
    await service.grant(owner, paired.deviceId, [workspace.id]);
    await store.create('task', owner.id, { state: 'running' }, 'task');
    const operation = service.remoteTool({ name: 'workspace.read', description: 'Read', inputSchema: {}, requiredCapabilities: ['workspace:read'], sideEffect: 'read' }).execute({ path: 'README.md' }, { principal: owner, workspace, taskId: 'task', signal: new AbortController().signal });
    let jobs: Awaited<ReturnType<typeof service.poll>>['jobs'] = [];
    for (let i = 0; i < 20 && !jobs.length; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
      device = await service.authenticate(`Bearer ${paired.token}`, paired.deviceId);
      jobs = (await service.poll(device)).jobs;
    }
    assert.equal(jobs.length, 1);
    assert.equal((await service.poll(device)).jobs.length, 0);
    const result: ToolResult = { content: 'Project instructions' };
    await service.submit(device, jobs[0]!.id, { status: 'confirmed', result });
    assert.deepEqual(await operation, result);
    await service.submit(device, jobs[0]!.id, { status: 'confirmed', result });
    await service.control(owner.id, paired.deviceId, 'revoke');
    await assert.rejects(service.authenticate(`Bearer ${paired.token}`, paired.deviceId), /revoked/);
  } finally { await store.close(); }
});

test('device tools mark refusals before a job reaches a device', async () => {
  const store = new SqliteStore();
  const service = new DeviceService(store);
  try {
    const code = await service.createPairing(owner, ['workspace:write'], []);
    const paired = await service.pair({ code: code.code, name: 'Mac', capabilities: ['workspace:write'] });
    const workspaceRow = await store.create('workspace', owner.id, {
      name: 'Project', root: '/example', deviceId: paired.deviceId, capabilities: ['workspace:write'], allowCloud: false,
    });
    const workspace: Workspace = { ...workspaceRow.data, id: workspaceRow.id, ownerId: owner.id };
    await service.grant(owner, paired.deviceId, [workspace.id]);
    await store.create('task', owner.id, { state: 'running' }, 'task');
    const tool = service.remoteTool({
      name: 'workspace.write', description: 'Write', inputSchema: {}, requiredCapabilities: ['workspace:write'], sideEffect: 'write',
    });
    const base: ToolContext = { principal: owner, workspace, taskId: 'task', signal: new AbortController().signal };
    const { workspace: _workspace, ...withoutWorkspace } = base;
    await assert.rejects(tool.execute({}, withoutWorkspace), (error: unknown) => isNotDispatched(error)
      && error.code === 'workspace_required');

    const controller = new AbortController();
    const operation = tool.execute({}, { ...base, signal: controller.signal });
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if ((await store.scan('device_job', owner.id)).length > 0) break;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    controller.abort();
    await assert.rejects(operation, (error: unknown) => isNotDispatched(error)
      && error.code === 'device_not_dispatched');
    const jobs = await store.scan<{ state: string }>('device_job', owner.id);
    assert.deepEqual(jobs.map((row) => row.data.state), ['cancelled']);
  } finally { await store.close(); }
});

test('device tool abort after polling records an unknown dispatched outcome', async () => {
  const store = new SqliteStore();
  const service = new DeviceService(store);
  try {
    const code = await service.createPairing(owner, ['workspace:write'], []);
    const paired = await service.pair({ code: code.code, name: 'Mac', capabilities: ['workspace:write'] });
    const workspaceRow = await store.create('workspace', owner.id, {
      name: 'Project', root: '/example', deviceId: paired.deviceId, capabilities: ['workspace:write'], allowCloud: false,
    });
    const workspace: Workspace = { ...workspaceRow.data, id: workspaceRow.id, ownerId: owner.id };
    await service.grant(owner, paired.deviceId, [workspace.id]);
    await store.create('task', owner.id, { state: 'running' }, 'task');
    const tool = service.remoteTool({
      name: 'workspace.write', description: 'Write', inputSchema: {}, requiredCapabilities: ['workspace:write'], sideEffect: 'write',
    });
    const controller = new AbortController();
    const operation = tool.execute({}, { principal: owner, workspace, taskId: 'task', signal: controller.signal });
    const device = await service.authenticate(`Bearer ${paired.token}`, paired.deviceId);
    let jobs: Awaited<ReturnType<typeof service.poll>>['jobs'] = [];
    for (let attempt = 0; attempt < 20 && !jobs.length; attempt += 1) {
      jobs = (await service.poll(device)).jobs;
      if (!jobs.length) await Promise.resolve();
    }
    assert.equal(jobs.length, 1);
    controller.abort();
    await assert.rejects(operation, (error: unknown) => {
      assert.equal(isNotDispatched(error), false);
      return true;
    });
    const row = await store.get<{ state: string; job: { dispatchedAt: string } }>('device_job', jobs[0]!.id, owner.id);
    assert.equal(row?.data.state, 'unknown');
    assert.notEqual(row?.data.job.dispatchedAt, '');
  } finally { await store.close(); }
});

test('device tool expiry before polling is marked not dispatched', async () => {
  const store = new SqliteStore();
  const baseNow = Date.parse('2026-10-04T00:00:00.000Z');
  let now = baseNow;
  const service = new DeviceService(store, () => now);
  try {
    const code = await service.createPairing(owner, ['workspace:write'], []);
    const paired = await service.pair({ code: code.code, name: 'Mac', capabilities: ['workspace:write'] });
    const workspaceRow = await store.create('workspace', owner.id, {
      name: 'Project', root: '/example', deviceId: paired.deviceId, capabilities: ['workspace:write'], allowCloud: false,
    });
    const workspace: Workspace = { ...workspaceRow.data, id: workspaceRow.id, ownerId: owner.id };
    await service.grant(owner, paired.deviceId, [workspace.id]);
    await store.create('task', owner.id, { state: 'running' }, 'task');
    const tool = service.remoteTool({
      name: 'workspace.write', description: 'Write', inputSchema: {}, requiredCapabilities: ['workspace:write'], sideEffect: 'write',
    });
    const operation = tool.execute({}, {
      principal: owner, workspace, taskId: 'task', signal: new AbortController().signal,
    });
    let jobs = await store.scan<{ state: string; job: { dispatchedAt: string } }>('device_job', owner.id);
    for (let attempt = 0; attempt < 20 && !jobs.length; attempt += 1) {
      await Promise.resolve();
      jobs = await store.scan<{ state: string; job: { dispatchedAt: string } }>('device_job', owner.id);
    }
    assert.equal(jobs.length, 1);
    now += 300_001;
    await assert.rejects(
      operation,
      (error: unknown) => isNotDispatched(error) && error.code === 'device_not_dispatched',
    );
    jobs = await store.scan<{ state: string; job: { dispatchedAt: string } }>('device_job', owner.id);
    assert.deepEqual(jobs.map((row) => ({ state: row.data.state, dispatchedAt: row.data.job.dispatchedAt })), [
      { state: 'cancelled', dispatchedAt: '' },
    ]);
  } finally { await store.close(); }
});
