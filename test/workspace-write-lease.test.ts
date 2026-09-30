import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { DomainError, type ToolContext, type ToolDefinition } from '../src/contracts.js';
import { WorkspaceWriteLeaseService } from '../src/workspace-write-lease.js';
import { SqliteStore } from '../src/storage/sqlite.js';

function context(taskId: string): ToolContext {
  return {
    principal: { id: 'owner', level: 1, scopes: ['*'] }, taskId, signal: new AbortController().signal,
    workspace: { id: 'workspace', ownerId: 'owner', name: 'Project', root: '/project', deviceId: 'server', capabilities: ['workspace:write'], allowCloud: false },
  };
}

test('independent workers serialize workspace writes and fence a previous holder', async () => {
  const store = new SqliteStore();
  const first = new WorkspaceWriteLeaseService(store);
  const second = new WorkspaceWriteLeaseService(store);
  let concurrent = 0; let peak = 0;
  const leases: NonNullable<ToolContext['workspaceWriteLease']>[] = [];
  const tool: ToolDefinition = {
    name: 'workspace.write', description: 'Write', inputSchema: {}, requiredCapabilities: ['workspace:write'], requiresWorkspace: true, sideEffect: 'write',
    async execute(_input, execution) {
      leases.push(execution.workspaceWriteLease!); concurrent += 1; peak = Math.max(peak, concurrent);
      await delay(30); concurrent -= 1;
      return { content: 'saved' };
    },
  };
  try {
    await Promise.all([first.wrap(tool).execute({}, context('one')), second.wrap(tool).execute({}, context('two'))]);
    assert.equal(peak, 1);
    assert.deepEqual(leases.map((lease) => lease.epoch), [1, 2]);
    assert.equal(await second.validate('owner', 'workspace', 'one', leases[0]!), false);
    assert.equal((await first.get('owner', 'workspace'))?.data.state, 'released');
  } finally { await store.close(); }
});

test('a crashed or unknown writer blocks writes until stopped operation is verified', async () => {
  const store = new SqliteStore(); let now = Date.now();
  const original = new WorkspaceWriteLeaseService(store, () => now, 100);
  try {
    const stale = await original.acquire(context('crashed'));
    now += 101;
    const restarted = new WorkspaceWriteLeaseService(store, () => now, 100);
    await assert.rejects(restarted.acquire(context('next')), /must be verified/);
    const row = (await restarted.get('owner', 'workspace'))!;
    assert.equal(row.data.state, 'unknown');
    const task = await store.create('task', 'owner', { state: 'running' }, 'crashed');
    await assert.rejects(restarted.reconcile('owner', 'workspace', row.revision, 'checked'), /Stop or recover/);
    await store.put('task', task.id, task.ownerId, { state: 'unknown' }, task.revision);
    await store.create('device_job', 'owner', { job: { workspaceWriteLease: stale }, state: 'unknown' }, 'unknown-job');
    await assert.rejects(restarted.reconcile('owner', 'workspace', row.revision, 'checked'), /confirmed outcome/);
    const job = (await store.get<{ job: { workspaceWriteLease: typeof stale }; state: string }>('device_job', 'unknown-job', 'owner'))!;
    await store.put('device_job', job.id, job.ownerId, { ...job.data, state: 'confirmed' }, job.revision);
    await restarted.reconcile('owner', 'workspace', row.revision, 'Confirmed device receipt and read back the file');
    const next = await restarted.acquire(context('next'));
    assert.equal(next.epoch, 2);
    assert.equal(await restarted.validate('owner', 'workspace', 'crashed', stale), false);
  } finally { await store.close(); }
});

test('waiting for an offline device releases its unused lease; uncertain side effects retain the lock', async () => {
  const store = new SqliteStore(); const service = new WorkspaceWriteLeaseService(store);
  const tool: ToolDefinition = {
    name: 'terminal.run', description: 'Run', inputSchema: {}, requiredCapabilities: ['shell:execute'], requiresWorkspace: true, sideEffect: 'external',
    async execute() { throw new DomainError('waiting_for_device', 'Device offline'); },
  };
  try {
    await assert.rejects(service.wrap(tool).execute({}, context('offline')), /Device offline/);
    assert.equal((await service.get('owner', 'workspace'))?.data.state, 'released');
    await assert.rejects(service.wrap({ ...tool, async execute() { throw new DomainError('outcome_unknown', 'No receipt'); } }).execute({}, context('unknown')), /No receipt/);
    assert.equal((await service.get('owner', 'workspace'))?.data.state, 'unknown');
    await assert.rejects(service.acquire(context('retry')), /must be verified/);
  } finally { await store.close(); }
});

test('long writes renew their lease before another worker can claim it', async () => {
  const store = new SqliteStore(); const service = new WorkspaceWriteLeaseService(store, Date.now, 120);
  const tool: ToolDefinition = {
    name: 'workspace.write', description: 'Write', inputSchema: {}, requiredCapabilities: [], requiresWorkspace: true, sideEffect: 'write',
    async execute(_input, execution) {
      await delay(260);
      assert.equal(await service.validate('owner', 'workspace', execution.taskId, execution.workspaceWriteLease!), true);
      return { content: 'saved' };
    },
  };
  try { await service.wrap(tool).execute({}, context('long')); }
  finally { await store.close(); }
});

test('a stopped writer cannot renew or release a reconciled lease', async () => {
  const store = new SqliteStore(); let now = Date.now();
  const service = new WorkspaceWriteLeaseService(store, () => now, 300);
  let entered!: () => void; let leave!: () => void;
  const started = new Promise<void>((resolve) => { entered = resolve; });
  const stopped = new Promise<void>((resolve) => { leave = resolve; });
  const tool: ToolDefinition = {
    name: 'workspace.write', description: 'Write', inputSchema: {}, requiredCapabilities: [], requiresWorkspace: true, sideEffect: 'write',
    async execute(_input, execution) {
      entered();
      await stopped;
      execution.signal.throwIfAborted();
      return { content: 'saved' };
    },
  };
  const result = service.wrap(tool).execute({}, context('stale'));
  const rejected = assert.rejects(result, /no longer owns/);
  try {
    await started;
    now += 301;
    const row = (await service.get('owner', 'workspace'))!;
    await service.reconcile('owner', 'workspace', row.revision, 'Stopped writer and verified the resulting file');
    await delay(140);
    assert.equal((await service.get('owner', 'workspace'))?.data.state, 'released');
    const next = await service.acquire(context('next'));
    leave();
    await rejected;
    assert.equal(await service.validate('owner', 'workspace', 'next', next), true);
  } finally { leave(); await rejected; await store.close(); }
});
