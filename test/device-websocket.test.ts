import assert from 'node:assert/strict';
import test from 'node:test';
import { developmentAuth } from '../src/auth.js';
import { WebSocketDeviceTransport } from '../src/connectors/websocket.js';
import type { Principal, ToolResult } from '../src/contracts.js';
import { createServer } from '../src/http/server.js';
import { SqliteStore } from '../src/storage/sqlite.js';

const owner: Principal = { id: 'local-owner', level: 1, scopes: ['*'] };
const token = 'device-websocket-owner-token-at-least-thirty-two-characters';
const headers = { authorization: `Bearer ${token}` };

test('device WebSocket carries authenticated jobs, results, heartbeats, and cancellations', async () => {
  const store = new SqliteStore();
  const server = await createServer({
    store,
    authenticate: developmentAuth(token),
    reauthorize: async (actor) => actor,
    runner: async () => ({ text: 'unused' }),
    automations: { eventTriggersEnabled: true, schedulerEnabled: false },
  });
  const address = await server.app.listen({ host: '127.0.0.1', port: 0 });
  let transport: WebSocketDeviceTransport | undefined;
  try {
    const pairing = await server.app.inject({
      method: 'POST', url: '/v1/pairings', headers,
      payload: { capabilities: ['model:generate'], workspaceIds: [] },
    });
    assert.equal(pairing.statusCode, 201, pairing.body);
    const paired = await server.app.inject({
      method: 'POST', url: '/v1/devices/pair',
      payload: { code: pairing.json().code, name: 'Mac connector', capabilities: ['model:generate'] },
    });
    assert.equal(paired.statusCode, 201, paired.body);
    const deviceId = paired.json().deviceId as string;
    const conversation = await store.create('conversation', owner.id, {
      title: 'Device online automation', scope: 'private', modelPolicy: 'cloud', strategy: 'single', mode: 'ask', archived: false,
    });
    await server.eventTriggers.create(owner, {
      name: 'Mac online',
      prompt: 'Check the device.',
      enabled: true,
      type: 'device_online',
      filter: { deviceIds: [deviceId] },
      settings: {
        conversationId: conversation.id,
        permissions: ['model:read'],
        notification: { type: 'none' },
      },
    });
    const cancellations: string[] = [];
    transport = new WebSocketDeviceTransport({
      baseUrl: address,
      deviceId,
      token: paired.json().token,
      timeoutMs: 3_000,
      onCancel: (id) => cancellations.push(id),
    });
    const heartbeat = await transport.heartbeat(deviceId, ['model:generate']);
    assert.equal(heartbeat.online, true);
    await waitFor(async () => (await store.scan('event_inbox', owner.id)).length === 1, 3_000);
    await transport.heartbeat(deviceId, ['model:generate']);
    assert.equal((await store.scan('event_inbox', owner.id)).length, 1);

    await store.create('task', owner.id, { state: 'running' }, 'task-1');
    const first = server.devices.executeModel(deviceId, { modelId: 'local' }, {
      principal: owner,
      taskId: 'task-1',
      signal: new AbortController().signal,
    });
    const firstJob = await waitForJob(transport, deviceId);
    const result: ToolResult = { content: 'generated locally' };
    await transport.submitResult(deviceId, firstJob.id, { status: 'confirmed', result });
    assert.deepEqual(await first, result);

    const secondTask = await store.create('task', owner.id, { state: 'running' }, 'task-2');
    const second = server.devices.executeModel(deviceId, { modelId: 'local' }, {
      principal: owner,
      taskId: 'task-2',
      signal: new AbortController().signal,
    });
    const secondRejected = assert.rejects(second, /cancelled|outcome/i);
    const secondJob = await waitForJob(transport, deviceId);
    await store.put('task', secondTask.id, owner.id, { state: 'cancelled' }, secondTask.revision);
    await waitFor(() => cancellations.includes(secondJob.id), 3_000);
    await transport.submitResult(deviceId, secondJob.id, { status: 'cancelled', error: 'cancelled by owner' });
    await secondRejected;
  } finally {
    transport?.close();
    await server.close();
  }
});

async function waitForJob(transport: WebSocketDeviceTransport, deviceId: string) {
  let job;
  await waitFor(async () => {
    const jobs = (await transport.poll(deviceId)).jobs;
    job = jobs[0];
    return Boolean(job);
  }, 3_000);
  return job!;
}

async function waitFor(predicate: () => boolean | Promise<boolean>, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!await predicate()) {
    if (Date.now() >= deadline) throw new Error('Timed out waiting for condition');
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
  }
}
