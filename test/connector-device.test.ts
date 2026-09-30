import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { ToolDefinition, ToolResult } from '../src/contracts.js';
import {
  DeviceConnector,
  HttpDeviceTransport,
  type DeviceJob,
  type DeviceJobResult,
  type DevicePairRequest,
  type DevicePairResponse,
  type DeviceTransport,
} from '../src/connectors/device.js';

class MemoryTransport implements DeviceTransport {
  jobs: DeviceJob[] = [];
  results: Array<{ jobId: string; result: DeviceJobResult }> = [];
  online = true;
  failSubmissions = false;
  writeLeaseValid = true;

  async validateWriteLease(): Promise<{ valid: boolean }> { return { valid: this.writeLeaseValid }; }

  async pair(_request: DevicePairRequest): Promise<DevicePairResponse> {
    return { deviceId: 'device-1', token: 'x'.repeat(32), ownerId: 'user-1' };
  }
  async heartbeat(): Promise<{ online: true; serverTime: string }> {
    if (!this.online) throw new Error('offline');
    return { online: true, serverTime: new Date().toISOString() };
  }
  async poll(): Promise<{ jobs: DeviceJob[] }> {
    if (!this.online) throw new Error('offline');
    return { jobs: this.jobs };
  }
  async submitResult(_deviceId: string, jobId: string, result: DeviceJobResult): Promise<void> {
    if (this.failSubmissions) throw new Error('offline');
    this.results.push({ jobId, result });
  }
}

test('device writers reject stale fences before execution and abort when their lease is withdrawn', async () => {
  const transport = new MemoryTransport();
  let executions = 0;
  const writeJob = job({ workspaceWriteLease: { id: 'lease', epoch: 2, holderId: 'holder', expiresAt: new Date(Date.now() + 30_000).toISOString() } });
  const tool: ToolDefinition = {
    name: 'test.read', description: 'Write', inputSchema: {}, requiredCapabilities: ['workspace:read'], sideEffect: 'write',
    async execute(_input, context) {
      executions += 1;
      transport.writeLeaseValid = false;
      await new Promise<void>((resolve) => context.signal.addEventListener('abort', () => resolve(), { once: true }));
      return { content: 'stopped' };
    },
  };
  const connector = new DeviceConnector({ deviceId: 'device-1', ownerId: 'user-1', transport, capabilities: ['workspace:read'], workspaceIds: ['workspace-1'], tools: [tool] });
  transport.writeLeaseValid = false;
  transport.jobs = [{ ...writeJob, id: 'stale-writer' }];
  assert.equal((await connector.pollOnce()).rejected, 1);
  assert.equal(executions, 0);
  transport.writeLeaseValid = true;
  transport.jobs = [{ ...writeJob, id: 'withdrawn-writer' }];
  await connector.pollOnce();
  assert.equal(executions, 1);
  assert.deepEqual(transport.results.map((entry) => entry.result.status), ['failed', 'unknown']);
});

function job(overrides: Partial<DeviceJob> = {}): DeviceJob {
  return {
    id: 'job-1',
    deviceId: 'device-1',
    principal: { id: 'user-1', level: 4, scopes: ['workspace:read'] },
    taskId: 'task-1',
    workspace: {
      id: 'workspace-1', ownerId: 'user-1', name: 'test', root: '/tmp', deviceId: 'device-1',
      capabilities: ['workspace:read'], allowCloud: false,
    },
    toolName: 'test.read',
    input: {},
    requiredCapabilities: ['workspace:read'],
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    dispatchedAt: new Date().toISOString(),
    ...overrides,
  };
}

test('device connector rejects expired, unauthorized, and replayed jobs without executing them', async () => {
  const transport = new MemoryTransport();
  let executions = 0;
  const tool: ToolDefinition = {
    name: 'test.read', description: 'test', inputSchema: {}, requiredCapabilities: ['workspace:read'], sideEffect: 'external',
    async execute(): Promise<ToolResult> { executions += 1; return { content: 'ok' }; },
  };
  const connector = new DeviceConnector({
    deviceId: 'device-1', transport, capabilities: ['workspace:read'], workspaceIds: ['workspace-1'], tools: [tool],
  });

  transport.jobs = [job({ id: 'expired', expiresAt: new Date(Date.now() - 1).toISOString() })];
  await connector.pollOnce();
  transport.jobs = [job({ id: 'wrong-group', workspace: { ...job().workspace!, id: 'other' } })];
  await connector.pollOnce();
  transport.jobs = [job()];
  await connector.pollOnce();
  await connector.pollOnce();

  assert.equal(executions, 1);
  assert.deepEqual(transport.results.map((entry) => entry.result.status), ['failed', 'failed', 'confirmed']);
});

test('device connector cancellation aborts the active tool', async () => {
  const transport = new MemoryTransport();
  let wasAborted = false;
  const tool: ToolDefinition = {
    name: 'test.read', description: 'test', inputSchema: {}, requiredCapabilities: ['workspace:read'], sideEffect: 'external',
    async execute(_input, context): Promise<ToolResult> {
      await new Promise<void>((resolve) => context.signal.addEventListener('abort', () => { wasAborted = true; resolve(); }, { once: true }));
      return { content: 'cancelled', isError: true };
    },
  };
  const connector = new DeviceConnector({
    deviceId: 'device-1', transport, capabilities: ['workspace:read'], workspaceIds: ['workspace-1'], tools: [tool],
  });
  transport.jobs = [job()];
  const polling = connector.pollOnce();
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(connector.cancel('job-1'), true);
  await polling;
  assert.equal(wasAborted, true);
  assert.equal(transport.results.at(-1)?.result.status, 'unknown');
});

test('cancelled screenshot is unknown and its local artifact is discarded', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'kiancode-cancelled-screenshot-'));
  const screenshot = path.join(directory, 'capture.png');
  try {
    const transport = new MemoryTransport();
    const ready: Array<() => void> = [];
    const tool: ToolDefinition = {
      name: 'mac.app.screenshot', description: 'capture', inputSchema: {}, requiredCapabilities: ['workspace:read'], sideEffect: 'external',
      async execute(_input, context): Promise<ToolResult> {
        await new Promise<void>((resolve) => {
          ready.push(resolve);
          context.signal.addEventListener('abort', () => resolve(), { once: true });
        });
        await writeFile(screenshot, Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
        return { content: 'possibly captured', artifacts: [{ name: 'capture.png', path: screenshot, mimeType: 'image/png', transient: true }] };
      },
    };
    const connector = new DeviceConnector({
      deviceId: 'device-1', transport, capabilities: ['workspace:read'], workspaceIds: ['workspace-1'], tools: [tool],
    });
    transport.jobs = [job({ toolName: tool.name })];
    const polling = connector.pollOnce();
    while (ready.length === 0) await new Promise((resolve) => setTimeout(resolve, 1));
    connector.cancel('job-1');
    await polling;

    assert.equal(transport.results[0]?.result.status, 'unknown');
    assert.equal(transport.results[0]?.result.inlineArtifacts, undefined);
    await assert.rejects(access(screenshot));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('cancelled workspace export is unknown and never deletes the source file', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'kiancode-cancelled-export-'));
  const source = path.join(directory, 'result.md');
  try {
    const content = '# Result\n';
    await writeFile(source, content);
    const transport = new MemoryTransport();
    let started = false;
    const tool: ToolDefinition = {
      name: 'workspace.export', description: 'export', inputSchema: {}, requiredCapabilities: ['workspace:export'],
      requiresWorkspace: true, sideEffect: 'external',
      async execute(_input, context): Promise<ToolResult> {
        started = true;
        await new Promise<void>((resolve) => context.signal.addEventListener('abort', () => resolve(), { once: true }));
        return {
          content: 'possibly exported',
          artifacts: [{
            name: 'result.md', path: source, mimeType: 'text/markdown', transient: true,
            sha256: createHash('sha256').update(content).digest('hex'),
          }],
        };
      },
    };
    const workspace = {
      ...job().workspace!, root: directory, capabilities: ['workspace:export'], allowCloud: false,
    };
    const connector = new DeviceConnector({
      deviceId: 'device-1', transport, capabilities: ['workspace:export'], workspaces: { 'workspace-1': workspace }, tools: [tool],
    });
    transport.jobs = [job({
      toolName: tool.name,
      input: { path: 'result.md' },
      requiredCapabilities: ['workspace:export'],
      principal: { id: 'user-1', level: 4, scopes: ['workspace:export'] },
      workspace,
    })];
    const polling = connector.pollOnce();
    while (!started) await new Promise((resolve) => setTimeout(resolve, 1));
    connector.cancel('job-1');
    await polling;

    assert.equal(transport.results[0]?.result.status, 'unknown');
    assert.equal(transport.results[0]?.result.inlineArtifacts, undefined);
    assert.equal(await readFile(source, 'utf8'), content);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('device connector never reports a cancelled or thrown write as a known outcome', async () => {
  const transport = new MemoryTransport();
  const started: Array<() => void> = [];
  const tool: ToolDefinition = {
    name: 'test.write', description: 'test', inputSchema: {}, requiredCapabilities: ['workspace:read'], sideEffect: 'write',
    async execute(_input, context): Promise<ToolResult> {
      if (started.length === 0) {
        await new Promise<void>((_resolve, reject) => {
          started.push(() => reject(new DOMException('cancelled', 'AbortError')));
          context.signal.addEventListener('abort', started[0]!, { once: true });
        });
      }
      throw new Error('connection lost after write started');
    },
  };
  const connector = new DeviceConnector({
    deviceId: 'device-1', transport, capabilities: ['workspace:read'], workspaceIds: ['workspace-1'], tools: [tool],
  });

  transport.jobs = [job({ id: 'cancelled-write', toolName: 'test.write' })];
  const polling = connector.pollOnce();
  while (started.length === 0) await new Promise((resolve) => setTimeout(resolve, 1));
  connector.cancel('cancelled-write');
  await polling;
  transport.jobs = [job({ id: 'thrown-write', toolName: 'test.write' })];
  await connector.pollOnce();

  assert.deepEqual(transport.results.map((entry) => entry.result.status), ['unknown', 'unknown']);
});

test('device connector accepts core wildcard scopes and always uses its fixed local workspace root', async () => {
  const transport = new MemoryTransport();
  let executions = 0;
  const tool: ToolDefinition = {
    name: 'test.read', description: 'test', inputSchema: {}, requiredCapabilities: ['workspace:read'], sideEffect: 'read',
    async execute(_input, context): Promise<ToolResult> {
      assert.equal(context.workspace?.root, job().workspace!.root);
      executions += 1;
      return { content: 'ok' };
    },
  };
  const local = job().workspace!;
  const connector = new DeviceConnector({
    deviceId: 'device-1', transport, capabilities: ['workspace:read'], workspaces: { 'workspace-1': local }, tools: [tool],
  });
  transport.jobs = [job({ principal: { id: 'other-user', level: 4, scopes: ['*'] } })];
  await connector.pollOnce();
  transport.jobs = [job({ id: 'bad-root', workspace: { ...local, root: '/untrusted/root' } })];
  await connector.pollOnce();
  assert.equal(executions, 2);
  assert.equal(transport.results.at(-1)?.result.status, 'confirmed');
});

test('device connector runs owner-bound non-workspace tools and rejects missing required workspaces', async () => {
  const transport = new MemoryTransport();
  let executions = 0;
  const modelTool: ToolDefinition = {
    name: 'model.generate', description: 'generate', inputSchema: {}, requiredCapabilities: ['model:local'], sideEffect: 'read',
    async execute(_input, context): Promise<ToolResult> {
      assert.equal(context.workspace, undefined);
      executions += 1;
      return { content: 'ok' };
    },
  };
  const workspaceTool: ToolDefinition = {
    name: 'workspace.required', description: 'workspace', inputSchema: {}, requiredCapabilities: [], requiresWorkspace: true, sideEffect: 'read',
    async execute(): Promise<ToolResult> { executions += 1; return { content: 'unexpected' }; },
  };
  const connector = new DeviceConnector({
    deviceId: 'device-1', ownerId: 'user-1', transport, capabilities: ['model:local'], tools: [modelTool, workspaceTool],
  });

  transport.jobs = [job({ id: 'model-job', workspace: undefined, toolName: 'model.generate', requiredCapabilities: ['model:local'], principal: { id: 'user-1', level: 4, scopes: ['model:local'] } })];
  await connector.pollOnce();
  transport.jobs = [job({ id: 'wrong-owner', workspace: undefined, toolName: 'model.generate', requiredCapabilities: ['model:local'], principal: { id: 'other', level: 4, scopes: ['model:local'] } })];
  await connector.pollOnce();
  transport.jobs = [job({ id: 'missing-workspace', workspace: undefined, toolName: 'workspace.required', requiredCapabilities: [] })];
  await connector.pollOnce();

  assert.equal(executions, 1);
  assert.deepEqual(transport.results.map((entry) => entry.result.status), ['confirmed', 'failed', 'failed']);
});

test('device result journal survives restart and retries delivery without replaying the tool', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'kiancode-device-journal-'));
  const journalPath = path.join(directory, 'results.json');
  try {
    const transport = new MemoryTransport();
    let executions = 0;
    const tool: ToolDefinition = {
      name: 'test.read', description: 'test', inputSchema: {}, requiredCapabilities: ['workspace:read'], sideEffect: 'external',
      async execute(): Promise<ToolResult> { executions += 1; return { content: 'completed once' }; },
    };
    transport.jobs = [job()];
    transport.failSubmissions = true;
    await new DeviceConnector({
      deviceId: 'device-1', transport, capabilities: ['workspace:read'], workspaceIds: ['workspace-1'], tools: [tool], journalPath,
    }).pollOnce();
    transport.failSubmissions = false;
    await new DeviceConnector({
      deviceId: 'device-1', transport, capabilities: ['workspace:read'], workspaceIds: ['workspace-1'], tools: [tool], journalPath,
    }).pollOnce();
    assert.equal(executions, 1);
    assert.equal(transport.results.length, 1);
    assert.equal(transport.results[0]?.result.status, 'confirmed');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('HTTP device transport requires HTTPS except loopback and sends bearer without redirects', async () => {
  assert.throws(() => new HttpDeviceTransport({ baseUrl: 'http://example.com' }), /HTTPS/i);
  const requests: RequestInit[] = [];
  const transport = new HttpDeviceTransport({
    baseUrl: 'http://127.0.0.1:3000', token: 'x'.repeat(32),
    fetch: async (_input, init) => {
      requests.push(init ?? {});
      return new Response(JSON.stringify({ jobs: [] }), { status: 200, headers: { 'content-type': 'application/json' } });
    },
  });
  await transport.poll('device-1');
  assert.equal((requests[0]?.headers as Record<string, string>).authorization, `Bearer ${'x'.repeat(32)}`);
  assert.equal(requests[0]?.redirect, 'error');
  assert.ok(requests[0]?.signal);
});
