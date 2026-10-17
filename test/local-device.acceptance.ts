import assert from 'node:assert/strict';
import {
  createServer as createHttpServer,
  type IncomingMessage,
  type Server as HttpServer,
} from 'node:http';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { developmentAuth } from '../src/auth.js';
import { DeviceConnector } from '../src/connectors/device.js';
import { WebSocketDeviceTransport } from '../src/connectors/websocket.js';
import type { Workspace } from '../src/contracts.js';
import type { Message, Task, TaskEvent } from '../src/domain.js';
import { DeviceService } from '../src/devices.js';
import { createServer } from '../src/http/server.js';
import { createTaskRunner } from '../src/runtime-adapter.js';
import { AgentRuntime, DeviceModelProvider, createLocalModelTool } from '../src/runtime/index.js';
import { SqliteStore } from '../src/storage/sqlite.js';
import type { Entity } from '../src/storage/store.js';
import type { TaskRunner } from '../src/tasks.js';
import { createWorkspaceTools } from '../src/tools/workspace.js';
import { openAcceptanceReport } from './acceptance-report.js';

const ownerToken = `local-device-acceptance-${randomUUID()}`;
const headers = { authorization: `Bearer ${ownerToken}` };
const mainModelId = 'acceptance-main';
const controlledModelId = 'acceptance-controlled';

type AcceptanceMode = 'controlled' | 'live';

interface LiveModelConfig {
  baseUrl: string;
  model: string;
}

interface TaskPayload {
  actionHash?: string;
  toolCallId?: string;
  outcome?: string;
  isError?: boolean;
  toolCall?: {
    id?: string;
    name?: string;
    arguments?: Record<string, unknown>;
  };
}

interface ControlledRequest {
  scenario: 'tool_loop' | 'output_truncation' | 'token_budget';
  maxOutputTokens: number;
}

type ProviderClass = 'controlled_loopback' | 'live_loopback';

interface AcceptanceEvidence {
  schemaVersion: 1;
  mode: AcceptanceMode;
  isolation: 'sqlite_memory';
  productionCrossClient: false;
  workspaceCloudAllowed: false;
  temporaryWorkspaceRemoved: true;
  waitingForDevice: {
    observed: true;
    sameTaskResumed: true;
    resumeEventObserved: true;
    modelCallsBoundToSameTask: true;
  };
  toolLoop: {
    providerClass: ProviderClass;
    singleUserMessageObserved: true;
    modelCallsObserved: number;
    confirmedTools: string[];
    exactReadWriteRead: true;
  };
  controlledChecks: {
    outputTruncation: {
      providerClass: 'controlled_loopback';
      requestsObserved: 1;
      outputLimitForwarded: number;
      taskFailed: true;
    };
    modelBudget: {
      providerClass: 'controlled_loopback';
      requestsObserved: 1;
      taskFailed: true;
    };
  };
}

interface Fixture {
  server: Awaited<ReturnType<typeof createServer>>;
  connector: DeviceConnector;
  transport: WebSocketDeviceTransport;
  workspace: Workspace;
  deviceId: string;
  startPolling(): void;
  stopPolling(maximumMs: number): Promise<void>;
}

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function acceptanceMode(): AcceptanceMode {
  const value = argument('--mode') ?? 'controlled';
  if (value !== 'controlled' && value !== 'live') {
    throw new Error('--mode must be controlled or live');
  }
  return value;
}

function liveModelConfig(mode: AcceptanceMode): LiveModelConfig | undefined {
  if (mode === 'controlled') return undefined;
  const baseUrl = argument('--base-url');
  const model = argument('--model');
  if (!baseUrl || !model?.trim()) {
    throw new Error('Live mode requires --base-url and --model');
  }
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    throw new Error('--base-url must be an HTTP or HTTPS loopback URL');
  }
  if (!['http:', 'https:'].includes(url.protocol)
    || !['localhost', '127.0.0.1', '[::1]', '::1'].includes(url.hostname)
    || url.username || url.password || url.search || url.hash) {
    throw new Error('--base-url must be an HTTP or HTTPS loopback URL without credentials, query, or fragment');
  }
  return { baseUrl, model };
}

function timeoutMs(mode: AcceptanceMode): number {
  const fallback = mode === 'live' ? 10 * 60_000 : 30_000;
  const value = Number(argument('--main-task-timeout-ms') ?? fallback);
  if (!Number.isSafeInteger(value) || value < 10_000 || value > 15 * 60_000) {
    throw new Error('--main-task-timeout-ms must be an integer from 10000 to 900000');
  }
  return value;
}

async function bounded<T>(promise: Promise<T>, maximumMs: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out`)), maximumMs);
        timer.unref();
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function responseData<T>(response: { statusCode: number; body: string }, expected: number): T {
  assert.equal(response.statusCode, expected, response.body);
  return (JSON.parse(response.body) as { data: T }).data;
}

function taskPayload(event: Entity<TaskEvent>): TaskPayload {
  return event.data.payload as TaskPayload;
}

function eventKey(event: Entity<TaskEvent>): string | undefined {
  const payload = taskPayload(event);
  return payload.actionHash ?? payload.toolCallId ?? payload.toolCall?.id;
}

function confirmedToolNames(events: Array<Entity<TaskEvent>>): string[] {
  const confirmed: string[] = [];
  for (const dispatch of events.filter((event) => event.data.type === 'tool_dispatched')) {
    const key = eventKey(dispatch);
    const result = events.find((event) => event.data.sequence > dispatch.data.sequence
      && event.data.type === 'tool_result'
      && eventKey(event) === key
      && taskPayload(event).outcome === 'confirmed'
      && taskPayload(event).isError === false);
    if (result && taskPayload(dispatch).toolCall?.name) confirmed.push(taskPayload(dispatch).toolCall!.name!);
  }
  return confirmed;
}

function sse(payload: object): string {
  return `data: ${JSON.stringify(payload)}\n\ndata: [DONE]\n\n`;
}

async function readJsonBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
}

function toolByDescription(
  tools: Array<{ function?: { name?: string; description?: string } }>,
  prefix: string,
): string {
  const name = tools.find((tool) => tool.function?.description?.startsWith(prefix))?.function?.name;
  assert.ok(name, `Controlled provider did not receive the ${prefix} tool`);
  return name;
}

async function controlledProvider(marker: string): Promise<{
  server: HttpServer;
  baseUrl: string;
  requests: ControlledRequest[];
}> {
  const requests: ControlledRequest[] = [];
  const server = createHttpServer(async (request, response) => {
    try {
      assert.equal(request.method, 'POST');
      assert.equal(request.url, '/v1/chat/completions');
      const body = await readJsonBody(request);
      const messages = body.messages as Array<{ role?: string; content?: unknown }>;
      const tools = body.tools as Array<{ function?: { name?: string; description?: string } }>;
      const maxOutputTokens = body.max_tokens;
      if (typeof maxOutputTokens !== 'number') throw new Error('max_tokens was not numeric');
      const serialized = JSON.stringify(messages);
      const scenario = serialized.includes('[OUTPUT_TRUNCATION]')
        ? 'output_truncation'
        : serialized.includes('[TOKEN_BUDGET]') ? 'token_budget' : 'tool_loop';
      requests.push({ scenario, maxOutputTokens });
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      if (scenario === 'output_truncation') {
        response.end(sse({
          choices: [{ delta: { content: 'partial' }, finish_reason: 'length' }],
          usage: { prompt_tokens: 8, completion_tokens: maxOutputTokens },
        }));
        return;
      }
      if (scenario === 'token_budget') {
        response.end(sse({
          choices: [{ delta: { content: 'over budget' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 100_000, completion_tokens: 1 },
        }));
        return;
      }
      const toolMessages = messages.filter((message) => message.role === 'tool');
      if (toolMessages.length === 0) {
        response.end(sse({
          choices: [{
            delta: { tool_calls: [{ index: 0, id: 'read-seed', function: {
              name: toolByDescription(tools, 'Read a workspace file'),
              arguments: JSON.stringify({ path: 'seed.txt' }),
            } }] },
            finish_reason: 'tool_calls',
          }],
          usage: { prompt_tokens: 12, completion_tokens: 4 },
        }));
        return;
      }
      if (toolMessages.length === 1) {
        response.end(sse({
          choices: [{
            delta: { tool_calls: [{ index: 0, id: 'write-result', function: {
              name: toolByDescription(tools, 'Write a workspace file'),
              arguments: JSON.stringify({ path: 'result.txt', content: `${marker}\n` }),
            } }] },
            finish_reason: 'tool_calls',
          }],
          usage: { prompt_tokens: 16, completion_tokens: 6 },
        }));
        return;
      }
      if (toolMessages.length === 2) {
        response.end(sse({
          choices: [{
            delta: { tool_calls: [{ index: 0, id: 'read-result', function: {
              name: toolByDescription(tools, 'Read a workspace file'),
              arguments: JSON.stringify({ path: 'result.txt' }),
            } }] },
            finish_reason: 'tool_calls',
          }],
          usage: { prompt_tokens: 20, completion_tokens: 4 },
        }));
        return;
      }
      response.end(sse({
        choices: [{ delta: { content: 'VERIFIED' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 24, completion_tokens: 2 },
      }));
    } catch {
      response.writeHead(500, { 'content-type': 'application/json' });
      response.end('{"error":"controlled_provider_failure"}');
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  return { server, baseUrl: `http://127.0.0.1:${address.port}/v1`, requests };
}

async function closeHttpServer(server: HttpServer): Promise<void> {
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

async function waitForTask(
  fixture: Pick<Fixture, 'server'>,
  taskId: string,
  predicate: (task: Entity<Task>) => boolean,
  maximumMs: number,
): Promise<Entity<Task>> {
  const deadline = Date.now() + maximumMs;
  let last: Entity<Task> | undefined;
  while (Date.now() < deadline) {
    const response = await fixture.server.app.inject({
      method: 'GET', url: `/v1/tasks/${taskId}`, headers,
    });
    const task = responseData<Entity<Task>>(response, 200);
    last = task;
    if (predicate(task)) return task;
    await delay(20);
  }
  assert.fail(`Timed out waiting for task state; last=${last?.data.state ?? 'missing'} error=${last?.data.error ?? 'none'}`);
}

async function createConversation(
  fixture: Fixture,
  input: { mode: 'ask' | 'act'; modelId: string; workspaceId?: string },
): Promise<string> {
  const response = await fixture.server.app.inject({
    method: 'POST', url: '/v1/conversations', headers,
    payload: {
      title: 'Local device acceptance',
      scope: 'private',
      modelPolicy: 'local',
      strategy: 'single',
      mode: input.mode,
      modelId: input.modelId,
      ...(input.workspaceId ? { workspaceId: input.workspaceId } : {}),
      archived: false,
    },
  });
  return responseData<{ id: string }>(response, 201).id;
}

async function sendMessage(fixture: Fixture, conversationId: string, content: string): Promise<string> {
  const response = await fixture.server.app.inject({
    method: 'POST', url: `/v1/conversations/${conversationId}/messages`, headers,
    payload: { content, requestId: randomUUID() },
  });
  return responseData<{ id: string }>(response, 202).id;
}

async function driveTask(
  fixture: Fixture,
  taskId: string,
  maximumMs: number,
  approve?: (task: Entity<Task>) => void,
): Promise<Entity<Task>> {
  const deadline = Date.now() + maximumMs;
  while (Date.now() < deadline) {
    const current = await waitForTask(fixture, taskId, () => true, maximumMs);
    if (current.data.state === 'waiting_for_approval') {
      approve?.(current);
      const approved = await fixture.server.app.inject({
        method: 'POST', url: `/v1/tasks/${taskId}/approve`, headers,
        payload: { hashes: current.data.pendingActions.map((action) => action.hash) },
      });
      responseData(approved, 200);
    } else if (['completed', 'failed', 'cancelled', 'unknown'].includes(current.data.state)) {
      return current;
    }
    await delay(20);
  }
  assert.fail('Timed out driving task');
}

async function events(fixture: Fixture, taskId: string): Promise<Array<Entity<TaskEvent>>> {
  const response = await fixture.server.app.inject({
    method: 'GET', url: `/v1/tasks/${taskId}/events`, headers,
  });
  return responseData<Array<Entity<TaskEvent>>>(response, 200);
}

async function messages(fixture: Fixture, conversationId: string): Promise<Array<Entity<Message>>> {
  const response = await fixture.server.app.inject({
    method: 'GET', url: `/v1/conversations/${conversationId}/messages`, headers,
  });
  return responseData<Array<Entity<Message>>>(response, 200);
}

async function createFixture(
  root: string,
  controlledBaseUrl: string,
  live: LiveModelConfig | undefined,
): Promise<Fixture> {
  const store = new SqliteStore();
  const devices = new DeviceService(store);
  let runner: TaskRunner | undefined;
  let transport: WebSocketDeviceTransport | undefined;
  const server = await createServer({
    store,
    devices,
    authenticate: developmentAuth(ownerToken),
    reauthorize: async (principal) => principal,
    runner: (input) => {
      if (!runner) throw new Error('Acceptance runner is not ready');
      return runner(input);
    },
    models: [
      { id: mainModelId, locality: 'local', capabilities: ['tools'] },
      { id: controlledModelId, locality: 'local', capabilities: ['tools'] },
    ],
  });
  const address = await server.app.listen({ host: '127.0.0.1', port: 0 });
  try {
    const pairing = await server.app.inject({
      method: 'POST', url: '/v1/pairings', headers,
      payload: { capabilities: ['model:generate', 'workspace:read', 'workspace:write'], workspaceIds: [] },
    });
    assert.equal(pairing.statusCode, 201, pairing.body);
    const paired = await server.app.inject({
      method: 'POST', url: '/v1/devices/pair',
      payload: {
        code: (pairing.json() as { code: string }).code,
        name: 'Isolated acceptance connector',
        capabilities: ['model:generate', 'workspace:read', 'workspace:write'],
      },
    });
    assert.equal(paired.statusCode, 201, paired.body);
    const pairResult = paired.json() as { deviceId: string; token: string };
    const workspaceResponse = await server.app.inject({
      method: 'POST', url: '/v1/workspaces', headers,
      payload: {
        name: 'Isolated local device workspace',
        root: '/device-local/isolated-acceptance',
        deviceId: pairResult.deviceId,
        capabilities: ['workspace:read', 'workspace:write'],
        allowCloud: false,
      },
    });
    const workspaceRow = responseData<Entity<Workspace>>(workspaceResponse, 201);
    const grant = await server.app.inject({
      method: 'PUT', url: `/v1/devices/${pairResult.deviceId}/workspaces`, headers,
      payload: { workspaceIds: [workspaceRow.id] },
    });
    responseData(grant, 200);
    const paused = await server.app.inject({
      method: 'POST', url: `/v1/devices/${pairResult.deviceId}/control`, headers,
      payload: { action: 'pause' },
    });
    responseData(paused, 200);
    const localWorkspace: Workspace = {
      ...workspaceRow.data,
      id: workspaceRow.id,
      ownerId: workspaceRow.ownerId,
      root,
    };
    const localWorkspaceTools = (await createWorkspaceTools({
      checkpointDirectory: path.join(root, '.checkpoints'),
    })).filter((tool) => ['workspace.read', 'workspace.write'].includes(tool.name));
    const remoteTools = localWorkspaceTools.map(({ execute: _execute, ...tool }) => devices.remoteTool(tool));
    const provider = new DeviceModelProvider({ id: 'acceptance-device-provider', dispatcher: devices });
    const runtime = new AgentRuntime({
      providers: [provider],
      models: [
        {
          id: mainModelId,
          providerId: provider.id,
          locality: 'local',
          deviceId: pairResult.deviceId,
          capabilities: ['tools'],
        },
        {
          id: controlledModelId,
          providerId: provider.id,
          locality: 'local',
          deviceId: pairResult.deviceId,
          capabilities: ['tools'],
        },
      ],
      tools: remoteTools,
    });
    runner = createTaskRunner(store, runtime, remoteTools, undefined, undefined, undefined, {
      task: { maxCalls: 20, maxTokens: 100_000 },
    });
    let connector: DeviceConnector | undefined;
    transport = new WebSocketDeviceTransport({
      baseUrl: address,
      token: pairResult.token,
      deviceId: pairResult.deviceId,
      timeoutMs: 30_000,
      onCancel: (jobId) => connector?.cancel(jobId),
    });
    const modelTool = createLocalModelTool({
      models: [
        {
          id: mainModelId,
          type: 'openai',
          baseUrl: live?.baseUrl ?? controlledBaseUrl,
          model: live?.model ?? 'controlled-tool-loop',
          capabilities: ['tools'],
        },
        {
          id: controlledModelId,
          type: 'openai',
          baseUrl: controlledBaseUrl,
          model: 'controlled-limits',
          capabilities: ['tools'],
        },
      ],
    });
    connector = new DeviceConnector({
      deviceId: pairResult.deviceId,
      ownerId: workspaceRow.ownerId,
      transport,
      capabilities: ['model:generate', 'workspace:read', 'workspace:write'],
      workspaces: new Map([[workspaceRow.id, localWorkspace]]),
      tools: [...localWorkspaceTools, modelTool],
      journalPath: path.join(root, '.device-journal.json'),
    });
    let polling = false;
    let pollError: unknown;
    let pollingPromise: Promise<void> | undefined;
    const startPolling = (): void => {
      if (pollingPromise) return;
      polling = true;
      pollingPromise = (async () => {
        while (polling) {
          try {
            await connector.pollOnce();
          } catch (error) {
            pollError = error;
            break;
          }
          await delay(10);
        }
      })();
    };
    return {
      server,
      connector,
      transport,
      workspace: localWorkspace,
      deviceId: pairResult.deviceId,
      startPolling,
      async stopPolling(maximumMs: number) {
        polling = false;
        if (pollingPromise) await bounded(pollingPromise, maximumMs, 'Connector polling shutdown');
        if (pollError) throw pollError;
      },
    };
  } catch (error) {
    const failures: unknown[] = [];
    try { transport?.close(); } catch (cleanupError) { failures.push(cleanupError); }
    try { await bounded(server.close(), 5_000, 'Partial Core server shutdown'); } catch (cleanupError) { failures.push(cleanupError); }
    try { server.app.server.closeAllConnections(); } catch (cleanupError) { failures.push(cleanupError); }
    if (failures.length) throw new AggregateError([error, ...failures], 'Creating the local device fixture failed');
    throw error;
  }
}

async function cleanup(
  root: string,
  fixture: Fixture | undefined,
  controlled: Awaited<ReturnType<typeof controlledProvider>> | undefined,
): Promise<{ failures: unknown[]; temporaryWorkspaceRemoved: boolean }> {
  const failures: unknown[] = [];
  const attempt = async (step: () => void | Promise<void>): Promise<void> => {
    try {
      await step();
    } catch (error) {
      failures.push(error);
    }
  };
  if (fixture) {
    await attempt(() => fixture.transport.close());
    await attempt(() => fixture.stopPolling(5_000));
    await attempt(() => bounded(fixture.server.close(), 5_000, 'Core server shutdown'));
    await attempt(() => fixture.server.app.server.closeAllConnections());
  }
  if (controlled) {
    await attempt(() => bounded(closeHttpServer(controlled.server), 5_000, 'Controlled provider shutdown'));
    await attempt(() => controlled.server.closeAllConnections());
  }
  let temporaryWorkspaceRemoved = false;
  await attempt(async () => {
    await rm(root, { recursive: true, force: true });
    temporaryWorkspaceRemoved = true;
  });
  return { failures, temporaryWorkspaceRemoved };
}

async function main(progress: Partial<AcceptanceEvidence>): Promise<AcceptanceEvidence> {
  const mode = acceptanceMode();
  const live = liveModelConfig(mode);
  const maximumMs = timeoutMs(mode);
  const root = await mkdtemp(path.join(tmpdir(), 'kiancode-local-device-'));
  const marker = `LOCAL_DEVICE_${randomUUID().replaceAll('-', '')}`;
  let controlled: Awaited<ReturnType<typeof controlledProvider>> | undefined;
  let fixture: Fixture | undefined;
  let failure: unknown;
  try {
    await writeFile(path.join(root, 'seed.txt'), 'seed\n', { mode: 0o600 });
    controlled = await controlledProvider(marker);
    fixture = await createFixture(root, controlled.baseUrl, live);
    const conversationId = await createConversation(fixture, {
      mode: 'act', modelId: mainModelId, workspaceId: fixture.workspace.id,
    });
    const prompt = [
      'Complete one isolated local workspace task.',
      'First use workspace.read on seed.txt.',
      `Then use workspace.write to create result.txt with exactly ${marker} followed by one newline.`,
      'Then use workspace.read on result.txt to verify it before answering.',
      'Do not use any other path.',
    ].join(' ');
    const taskId = await sendMessage(fixture, conversationId, prompt);
    fixture.server.tasks.start(5);
    const waiting = await waitForTask(
      fixture,
      taskId,
      (task) => task.data.state === 'waiting_for_device',
      10_000,
    );
    assert.equal(waiting.data.state, 'waiting_for_device');
    const deviceResumed = await fixture.server.app.inject({
      method: 'POST', url: `/v1/devices/${fixture.deviceId}/control`, headers,
      payload: { action: 'resume' },
    });
    responseData(deviceResumed, 200);
    await fixture.connector.pollOnce();
    fixture.startPolling();
    const resumed = await fixture.server.app.inject({
      method: 'POST', url: `/v1/tasks/${taskId}/control`, headers,
      payload: { action: 'resume' },
    });
    responseData(resumed, 200);
    const completed = await driveTask(fixture, taskId, maximumMs, (task) => {
      assert.ok(task.data.pendingActions.length > 0);
      for (const action of task.data.pendingActions) {
        assert.equal(action.tool, 'workspace.write');
        assert.equal(action.input.path, 'result.txt');
        assert.equal(action.input.content, `${marker}\n`);
      }
    });
    assert.equal(completed.data.state, 'completed', completed.data.error);
    assert.equal(await readFile(path.join(root, 'result.txt'), 'utf8'), `${marker}\n`);
    const taskEvents = await events(fixture, taskId);
    assert.ok(taskEvents.every((event) => event.data.taskId === taskId));
    const modelCalls = taskEvents.filter((event) => event.data.type === 'model_call');
    assert.ok(modelCalls.every((event) => taskPayload(event).toolCallId === undefined
      && (event.data.payload as { taskId?: string }).taskId === taskId));
    const resumeEvents = taskEvents.filter((event) => event.data.type === 'resume');
    assert.ok(resumeEvents.length >= 2, 'Recovery and approval must resume the same task');
    const conversationMessages = await messages(fixture, conversationId);
    const userMessages = conversationMessages.filter((message) => message.data.role === 'user');
    assert.equal(userMessages.length, 1);
    assert.equal(userMessages[0]?.data.taskId, taskId);
    assert.equal(userMessages[0]?.data.content, prompt);
    const confirmed = confirmedToolNames(taskEvents);
    assert.deepEqual(confirmed, ['workspace.read', 'workspace.write', 'workspace.read']);
    const dispatched = taskEvents
      .filter((event) => event.data.type === 'tool_dispatched')
      .map((event) => taskPayload(event).toolCall);
    assert.deepEqual(dispatched.map((call) => [call?.name, call?.arguments?.path]), [
      ['workspace.read', 'seed.txt'],
      ['workspace.write', 'result.txt'],
      ['workspace.read', 'result.txt'],
    ]);

    const truncationConversation = await createConversation(fixture, {
      mode: 'ask', modelId: controlledModelId,
    });
    const truncationTaskId = await sendMessage(fixture, truncationConversation, '[OUTPUT_TRUNCATION]');
    const truncated = await driveTask(fixture, truncationTaskId, 30_000);
    assert.equal(truncated.data.state, 'failed');
    assert.equal(truncated.data.error, 'Device model generation failed.');

    const budgetConversation = await createConversation(fixture, {
      mode: 'ask', modelId: controlledModelId,
    });
    const budgetTaskId = await sendMessage(fixture, budgetConversation, '[TOKEN_BUDGET]');
    const overBudget = await driveTask(fixture, budgetTaskId, 30_000);
    assert.equal(overBudget.data.state, 'failed');
    assert.match(overBudget.data.error ?? '', /budget/i);

    const toolLoopRequests = controlled.requests.filter((request) => request.scenario === 'tool_loop');
    const truncationRequests = controlled.requests.filter((request) => request.scenario === 'output_truncation');
    const budgetRequests = controlled.requests.filter((request) => request.scenario === 'token_budget');
    if (mode === 'controlled') {
      assert.equal(toolLoopRequests.length, 4);
      assert.equal(modelCalls.length, 4);
    } else {
      assert.ok(modelCalls.length >= 3, 'The live local model must complete a multi-step tool loop');
      assert.equal(toolLoopRequests.length, 0);
    }
    assert.equal(truncationRequests.length, 1);
    assert.equal(budgetRequests.length, 1);
    const truncationRequest = truncationRequests[0]!;
    const budgetRequest = budgetRequests[0]!;
    assert.equal(truncationRequest.maxOutputTokens, 4096);
    assert.equal(budgetRequest.maxOutputTokens, 4096);
    Object.assign(progress, {
      schemaVersion: 1,
      mode,
      isolation: 'sqlite_memory',
      productionCrossClient: false,
      workspaceCloudAllowed: false,
      waitingForDevice: {
        observed: true,
        sameTaskResumed: true,
        resumeEventObserved: true,
        modelCallsBoundToSameTask: true,
      },
      toolLoop: {
        providerClass: mode === 'live' ? 'live_loopback' : 'controlled_loopback',
        singleUserMessageObserved: true,
        modelCallsObserved: modelCalls.length,
        confirmedTools: confirmed,
        exactReadWriteRead: true,
      },
      controlledChecks: {
        outputTruncation: {
          providerClass: 'controlled_loopback',
          requestsObserved: 1,
          outputLimitForwarded: truncationRequest.maxOutputTokens,
          taskFailed: true,
        },
        modelBudget: {
          providerClass: 'controlled_loopback',
          requestsObserved: 1,
          taskFailed: true,
        },
      },
    } satisfies Omit<AcceptanceEvidence, 'temporaryWorkspaceRemoved'>);
    if (process.argv.includes('--inject-failure')) {
      assert.fail('Injected acceptance failure');
    }
  } catch (error) {
    failure = error;
  }
  const cleaned = await cleanup(root, fixture, controlled);
  if (cleaned.temporaryWorkspaceRemoved) progress.temporaryWorkspaceRemoved = true;
  if (cleaned.failures.length > 0) {
    failure = new AggregateError(
      failure === undefined ? cleaned.failures : [failure, ...cleaned.failures],
      'Local device acceptance cleanup failed',
    );
  }
  if (failure !== undefined) throw failure;
  return progress as AcceptanceEvidence;
}

const progress: Partial<AcceptanceEvidence> = {
  schemaVersion: 1,
  mode: acceptanceMode(),
  isolation: 'sqlite_memory',
  productionCrossClient: false,
  workspaceCloudAllowed: false,
};
const acceptanceReport = await openAcceptanceReport(argument('--report'));
try {
  const evidence = await main(progress);
  await acceptanceReport.passed(evidence);
  process.stdout.write(`${JSON.stringify({ status: 'passed', ...evidence }, null, 2)}\n`);
} catch (error) {
  try {
    await acceptanceReport.failed(error, progress);
  } catch (reportError) {
    throw new AggregateError([error, reportError], 'Acceptance failed and its report could not be finalized');
  }
  throw error;
}
