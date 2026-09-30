import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { ArtifactService } from '../src/artifacts.js';
import { developmentAuth } from '../src/auth.js';
import type { Principal, ToolDefinition, Workspace } from '../src/contracts.js';
import { DeviceConnector } from '../src/connectors/device.js';
import { WebSocketDeviceTransport } from '../src/connectors/websocket.js';
import { DeviceService } from '../src/devices.js';
import type { Conversation, Task } from '../src/domain.js';
import { createServer } from '../src/http/server.js';
import { createTaskRunner } from '../src/runtime-adapter.js';
import { LocalBlobStore } from '../src/storage/blobs.js';
import { SqliteStore } from '../src/storage/sqlite.js';
import { createWorkspaceTools } from '../src/tools/workspace.js';

const owner: Principal = { id: 'local-owner', level: 4, scopes: ['*'] };
const token = 'device-artifact-owner-token-at-least-thirty-two-characters';
const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

test('Mac screenshot crosses the device boundary as an owner-bound server artifact', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'kiancode-device-artifact-'));
  const screenshot = path.join(directory, 'capture.png');
  const store = new SqliteStore();
  const artifacts = new ArtifactService(store, new LocalBlobStore(path.join(directory, 'blobs')));
  const service = new DeviceService(store, Date.now, undefined, artifacts);
  const remoteTool = service.remoteTool({
    name: 'mac.app.screenshot', description: 'Capture', inputSchema: {}, requiredCapabilities: ['screenshot:read'],
    requiresWorkspace: true, sideEffect: 'external',
  });
  const server = await createServer({
    store,
    devices: service,
    artifacts,
    authenticate: developmentAuth(token),
    runner: createTaskRunner(store, { run: async () => { throw new Error('runtime should not run'); } }, [remoteTool]),
    reauthorize: async (current) => current,
  });
  const address = await server.app.listen({ host: '127.0.0.1', port: 0 });
  let transport: WebSocketDeviceTransport | undefined;
  try {
    await writeFile(screenshot, png, { mode: 0o600 });
    const pairing = await service.createPairing(owner, ['screenshot:read'], []);
    const paired = await service.pair({ code: pairing.code, name: 'Mac', capabilities: ['screenshot:read'] });
    let authenticated = await service.authenticate(`Bearer ${paired.token}`, paired.deviceId);
    const workspaceRow = await store.create('workspace', owner.id, {
      name: 'Desktop', root: directory, deviceId: paired.deviceId, capabilities: ['screenshot:read'], allowCloud: false,
    });
    const workspace: Workspace = { ...workspaceRow.data, id: workspaceRow.id, ownerId: owner.id };
    await service.grant(owner, paired.deviceId, [workspace.id]);
    const conversation = await store.create<Conversation>('conversation', owner.id, {
      title: 'Screenshot', scope: 'private', modelPolicy: 'local', strategy: 'single', mode: 'act', archived: false,
      workspaceId: workspace.id, internalOperation: { tool: remoteTool.name, input: {} },
    });

    transport = new WebSocketDeviceTransport({ baseUrl: address, token: paired.token, deviceId: paired.deviceId, timeoutMs: 3_000 });
    const localTool: ToolDefinition = {
      name: 'mac.app.screenshot', description: 'Capture', inputSchema: {}, requiredCapabilities: ['screenshot:read'],
      requiresWorkspace: true, sideEffect: 'external',
      async execute() {
        return { content: 'captured', artifacts: [{ name: 'capture.png', path: screenshot, mimeType: 'image/png', transient: true }] };
      },
    };
    const connector = new DeviceConnector({
      deviceId: paired.deviceId,
      ownerId: owner.id,
      transport,
      capabilities: ['screenshot:read'],
      workspaces: new Map([[workspace.id, workspace]]),
      tools: [localTool],
      journalPath: path.join(directory, 'journal.json'),
    });
    const task = await server.tasks.enqueue(owner, conversation.id, 'Capture the screen');
    server.tasks.start(5);

    let pollResult;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      pollResult = await connector.pollOnce();
      if (pollResult.executed === 1) break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.equal(pollResult?.executed, 1);
    await server.tasks.drain();
    const completed = await store.get<Task>('task', task.id, owner.id);
    assert.equal(completed?.data.state, 'completed');
    assert.equal(completed?.data.resultArtifactIds?.length, 1);
    const response = await server.app.inject({
      method: 'GET', url: `/v1/tasks/${task.id}`, headers: { authorization: `Bearer ${token}` },
    });
    assert.deepEqual(response.json().data.data.resultArtifactIds, completed?.data.resultArtifactIds);
    const stored = await artifacts.read(owner.id, completed!.data.resultArtifactIds![0]!);
    assert.deepEqual(Buffer.from(stored.bytes), png);
    assert.equal(stored.row.data.source, 'tool');
    assert.equal(stored.row.data.producerTaskId, task.id);
    await assert.rejects(access(screenshot));
    const journal = await readFile(path.join(directory, 'journal.json'), 'utf8');
    assert.doesNotMatch(journal, /capture\.png|bytesBase64/);
    const jobs = await store.scan('device_job', owner.id);
    assert.doesNotMatch(JSON.stringify(jobs), /capture\.png|bytesBase64/);
    await assert.rejects(service.submit(authenticated, jobs[0]!.id, {
      status: 'confirmed',
      result: { content: 'captured' },
      inlineArtifacts: [{
        name: 'capture.png', mimeType: 'image/png', bytesBase64: png.toString('base64'),
        sha256: '0'.repeat(64), capturedAt: new Date().toISOString(),
      }],
    }), /checksum/);
  } finally {
    transport?.close();
    await server.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('workspace export crosses the WebSocket device boundary without deleting the local-only source', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'kiancode-device-export-'));
  const workspaceRoot = path.join(directory, 'workspace');
  const source = path.join(workspaceRoot, 'result.md');
  const store = new SqliteStore();
  const artifacts = new ArtifactService(store, new LocalBlobStore(path.join(directory, 'blobs')));
  const service = new DeviceService(store, Date.now, undefined, artifacts);
  let server: Awaited<ReturnType<typeof createServer>> | undefined;
  let transport: WebSocketDeviceTransport | undefined;
  try {
    await mkdir(workspaceRoot);
    await writeFile(source, 'x');
    const localTools = await createWorkspaceTools({ checkpointDirectory: path.join(directory, 'checkpoints') });
    const localTool = localTools.find((tool) => tool.name === 'workspace.export');
    assert.ok(localTool);
    const { execute: _execute, ...specification } = localTool;
    const remoteTool = service.remoteTool(specification);
    const pairing = await service.createPairing(owner, ['workspace:export'], []);
    const paired = await service.pair({ code: pairing.code, name: 'Mac', capabilities: ['workspace:export'] });
    const workspaceRow = await store.create('workspace', owner.id, {
      name: 'Private local model workspace', root: '/untrusted/server/path', deviceId: paired.deviceId,
      capabilities: ['workspace:export'], allowCloud: false,
    });
    const serverWorkspace: Workspace = { ...workspaceRow.data, id: workspaceRow.id, ownerId: owner.id };
    await service.grant(owner, paired.deviceId, [workspaceRow.id]);
    server = await createServer({
      store,
      devices: service,
      artifacts,
      tools: [remoteTool],
      authenticate: developmentAuth(token),
      runner: createTaskRunner(store, { run: async () => { throw new Error('runtime should not run'); } }, [remoteTool], artifacts),
      reauthorize: async (current) => current,
    });
    const address = await server.app.listen({ host: '127.0.0.1', port: 0 });
    transport = new WebSocketDeviceTransport({ baseUrl: address, token: paired.token, deviceId: paired.deviceId, timeoutMs: 3_000 });
    const localWorkspace: Workspace = { ...serverWorkspace, root: workspaceRoot };
    const connector = new DeviceConnector({
      deviceId: paired.deviceId,
      ownerId: owner.id,
      transport,
      capabilities: ['workspace:export'],
      workspaces: new Map([[workspaceRow.id, localWorkspace]]),
      tools: [localTool],
      journalPath: path.join(directory, 'journal.json'),
    });
    const started = await server.app.inject({
      method: 'POST',
      url: `/v1/workspaces/${workspaceRow.id}/operations`,
      headers: { authorization: `Bearer ${token}` },
      payload: { tool: 'workspace.export', input: { path: 'result.md' }, requestId: 'device-export-1' },
    });
    assert.equal(started.statusCode, 202, started.body);
    server.tasks.start(5);
    await server.tasks.drain();
    const taskId = started.json().data.id as string;
    const pending = await store.get<Task>('task', taskId, owner.id);
    assert.equal(pending?.data.state, 'waiting_for_approval');
    assert.equal((await store.scan('device_job', owner.id)).length, 0);
    const approved = await server.app.inject({
      method: 'POST',
      url: `/v1/tasks/${taskId}/approve`,
      headers: { authorization: `Bearer ${token}` },
      payload: { hashes: [pending!.data.pendingActions[0]!.hash] },
    });
    assert.equal(approved.statusCode, 200, approved.body);
    let pollResult;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      pollResult = await connector.pollOnce();
      if (pollResult.executed === 1) break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.equal(pollResult?.executed, 1);
    await server.tasks.drain();
    const completed = await store.get<Task>('task', taskId, owner.id);
    assert.equal(completed?.data.state, 'completed');
    assert.equal(completed?.data.resultArtifactIds?.length, 1);
    const stored = await artifacts.read(owner.id, completed!.data.resultArtifactIds![0]!);
    assert.equal(stored.row.data.source, 'tool');
    assert.equal(stored.row.data.producerTaskId, taskId);
    assert.equal(Buffer.from(stored.bytes).toString('utf8'), 'x');
    assert.equal(await readFile(source, 'utf8'), 'x');
    assert.equal(serverWorkspace.allowCloud, false);
    const authenticated = await service.authenticate(`Bearer ${paired.token}`, paired.deviceId);
    const jobs = await store.scan<{ job: { toolName: string } }>('device_job', owner.id);
    const exportJob = jobs.find((row) => row.data.job.toolName === 'workspace.export');
    assert.ok(exportJob);
    await assert.rejects(service.submit(authenticated, exportJob.id, {
      status: 'confirmed',
      result: { content: 'wrong file' },
      inlineArtifacts: [{
        name: 'other.md', mimeType: 'text/markdown', bytesBase64: Buffer.from('x').toString('base64'),
        sha256: createHash('sha256').update('x').digest('hex'), capturedAt: new Date().toISOString(),
      }],
    }), /selected workspace file/);
  } finally {
    transport?.close();
    await server?.close();
    await rm(directory, { recursive: true, force: true });
  }
});
