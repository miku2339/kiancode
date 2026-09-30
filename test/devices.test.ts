import assert from 'node:assert/strict';
import test from 'node:test';
import { DeviceService } from '../src/devices.js';
import { SqliteStore } from '../src/storage/sqlite.js';
import type { Principal, ToolResult, Workspace } from '../src/contracts.js';

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
