import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { bootstrap } from '../src/bootstrap.js';
import { configSchema } from '../src/config.js';
import { DeviceConnector, type DeviceTransport } from '../src/connectors/device.js';
import type { Conversation, Task } from '../src/domain.js';
import { browserToolSpecifications, macAppToolSpecifications } from '../src/tools/index.js';
import type { Principal, ToolDefinition, ToolSpecification, Workspace } from '../src/contracts.js';

const owner: Principal = { id: 'local-owner', level: 1, scopes: ['*'] };

test('bootstrap exposes browser and Mac tools to the model and dispatches them to the workspace device', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'kiancode-bootstrap-device-tools-'));
  const modelServer = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as {
        messages: Array<{ role: string; content: string }>;
        tools?: Array<{ function: { name: string } }>;
      };
      const names = new Set(body.tools?.map((tool) => tool.function.name));
      assert.ok(names.has(wireName('browser.snapshot')));
      assert.ok(names.has(wireName('mac.app.health')));
      const hasResult = body.messages.some((message) => message.role === 'tool');
      const wantsBrowser = body.messages.some((message) => String(message.content).includes('browser'));
      const payload = hasResult
        ? { message: { role: 'assistant', content: 'done' }, done: true, done_reason: 'stop' }
        : {
            message: {
              role: 'assistant', content: '',
              tool_calls: [{ function: { name: wireName(wantsBrowser ? 'browser.snapshot' : 'mac.app.health'), arguments: {} } }],
            },
            done: true, done_reason: 'tool_calls',
          };
      response.writeHead(200, { 'content-type': 'application/x-ndjson' });
      response.end(`${JSON.stringify(payload)}\n`);
    });
  });
  await new Promise<void>((resolve) => modelServer.listen(0, '127.0.0.1', resolve));
  const address = modelServer.address();
  assert.ok(address && typeof address === 'object');
  const priorToken = process.env.KIANCODE_BOOTSTRAP_DEVICE_TEST_TOKEN;
  process.env.KIANCODE_BOOTSTRAP_DEVICE_TEST_TOKEN = 'bootstrap-device-test-token-with-at-least-thirty-two-characters';
  const server = await bootstrap(configSchema.parse({
    mode: 'development',
    stateDirectory: path.join(directory, 'state'),
    checkpointDirectory: path.join(directory, 'checkpoints'),
    database: { sqlitePath: path.join(directory, 'core.sqlite') },
    auth: { developmentTokenEnv: 'KIANCODE_BOOTSTRAP_DEVICE_TEST_TOKEN' },
    providers: [{ id: 'fake', type: 'ollama', locality: 'local', baseUrl: `http://127.0.0.1:${address.port}` }],
    models: [{ id: 'fake-model', providerId: 'fake', locality: 'local', capabilities: ['tools'] }],
    attachments: { localDirectory: path.join(directory, 'attachments') },
  }));
  try {
    const pairing = await server.devices.createPairing(owner, ['browser:automation', 'desktop:read'], []);
    const paired = await server.devices.pair({ code: pairing.code, name: 'Test Mac', capabilities: ['browser:automation', 'desktop:read'] });
    const workspaceRow = await server.store.create<Omit<Workspace, 'id' | 'ownerId'>>('workspace', owner.id, {
      name: 'Mac', root: path.join(directory, 'workspace'), deviceId: paired.deviceId,
      capabilities: ['browser:automation', 'desktop:read'], allowCloud: false,
    });
    const workspace: Workspace = { ...workspaceRow.data, id: workspaceRow.id, ownerId: workspaceRow.ownerId };
    await server.devices.grant(owner, paired.deviceId, [workspace.id]);
    const transport: DeviceTransport = {
      pair: async () => paired,
      heartbeat: async () => ({ online: true, serverTime: new Date().toISOString() }),
      poll: async () => server.devices.poll(await server.devices.authenticate(`Bearer ${paired.token}`, paired.deviceId)),
      submitResult: async (_deviceId, jobId, result) => server.devices.submit(
        await server.devices.authenticate(`Bearer ${paired.token}`, paired.deviceId), jobId, result,
      ),
    };
    const connector = new DeviceConnector({
      deviceId: paired.deviceId,
      ownerId: owner.id,
      transport,
      capabilities: ['browser:automation', 'desktop:read'],
      workspaces: new Map([[workspace.id, workspace]]),
      journalPath: path.join(directory, 'journal.json'),
      tools: [
        localTool(browserToolSpecifications[1], 'browser snapshot'),
        localTool(macAppToolSpecifications[0], 'mac health'),
      ],
    });
    const tasks = await Promise.all([
      queueTask(server.store, workspace, 'use browser'),
      queueTask(server.store, workspace, 'use mac'),
    ]);
    const draining = server.tasks.drain();
    await waitFor(async () => {
      await connector.pollOnce();
      const rows = await Promise.all(tasks.map((task) => server.store.get<Task>('task', task.id, owner.id)));
      return rows.every((row) => row?.data.state === 'completed');
    });
    await draining;
    const jobs = await server.store.scan<{ job: { toolName: string }; state: string }>('device_job', owner.id);
    assert.deepEqual(new Set(jobs.map((row) => row.data.job.toolName)), new Set(['browser.snapshot', 'mac.app.health']));
    assert.ok(jobs.every((row) => row.data.state === 'confirmed'));
  } finally {
    await server.close();
    await new Promise<void>((resolve, reject) => modelServer.close((error) => error ? reject(error) : resolve()));
    if (priorToken === undefined) delete process.env.KIANCODE_BOOTSTRAP_DEVICE_TEST_TOKEN;
    else process.env.KIANCODE_BOOTSTRAP_DEVICE_TEST_TOKEN = priorToken;
    await rm(directory, { recursive: true, force: true });
  }
});

function localTool(specification: ToolSpecification, content: string): ToolDefinition {
  return {
    ...specification,
    requiredCapabilities: [...specification.requiredCapabilities],
    async execute() { return { content }; },
  };
}

async function queueTask(store: Awaited<ReturnType<typeof bootstrap>>['store'], workspace: Workspace, prompt: string) {
  const conversation = await store.create<Conversation>('conversation', owner.id, {
    title: prompt, scope: 'private', modelPolicy: 'local', strategy: 'single', mode: 'act',
    workspaceId: workspace.id, archived: false,
  });
  return store.create<Task>('task', owner.id, {
    conversationId: conversation.id,
    prompt,
    principal: owner,
    state: 'queued',
    grantExpiresAt: new Date(Date.now() + 60_000).toISOString(),
    pendingActions: [],
    approvedActionHashes: [],
    runtimeMessages: [{ role: 'user', content: prompt }],
  });
}

function wireName(name: string): string {
  return `kc_${createHash('sha256').update(name).digest('hex').slice(0, 40)}`;
}

async function waitFor(predicate: () => boolean | Promise<boolean>, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!await predicate()) {
    if (Date.now() >= deadline) throw new Error('Timed out waiting for bootstrap device tools');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}
