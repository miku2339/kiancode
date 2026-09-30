import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { bootstrap, type BootstrapOptions } from '../src/bootstrap.js';
import { configSchema } from '../src/config.js';
import type { Conversation, Message, Task } from '../src/domain.js';
import type { Store } from '../src/storage/store.js';
import type { Principal } from '../src/contracts.js';

const principal: Principal = { id: 'owner', level: 1, scopes: ['*'] };
const marker = '[[model-only-context]]';

test('bootstrap task runner wrappers isolate model context from persisted task behavior', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'kiancode-runner-hook-'));
  let interceptedEvent = false;
  let modelPrompt = '';
  let injectedStore: Store | undefined;
  const modelServer = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as {
        messages: Array<{ role: string; content: string }>;
      };
      modelPrompt = body.messages.findLast((message) => message.role === 'user')?.content ?? '';
      response.writeHead(200, { 'content-type': 'application/x-ndjson' });
      response.end(`${JSON.stringify({
        message: { role: 'assistant', content: `${marker}assistant result` },
        done: true, done_reason: 'stop',
      })}\n`);
    });
  });
  await new Promise<void>((resolve) => modelServer.listen(0, '127.0.0.1', resolve));
  const address = modelServer.address();
  assert.ok(address && typeof address === 'object');
  const tokenName = 'KIANCODE_RUNNER_HOOK_TEST_TOKEN';
  const previousToken = process.env[tokenName];
  process.env[tokenName] = 'runner-hook-test-token-at-least-thirty-two-characters';
  const options = {
    wrapTaskRunner(runner, hookStore) {
      injectedStore = hookStore;
      return async (input) => {
        const result = await runner({
          ...input,
          task: {
            ...input.task,
            data: {
              ...input.task.data,
              prompt: `${marker}\n${input.task.data.prompt}`,
            },
          },
          onEvent: async (event) => {
            interceptedEvent = true;
            await input.onEvent(sanitize(event));
          },
        });
        return sanitize(result);
      };
    },
  } satisfies BootstrapOptions;
  let server: Awaited<ReturnType<typeof bootstrap>> | undefined;
  try {
    server = await bootstrap(configSchema.parse({
      stateDirectory: path.join(directory, 'state'),
      checkpointDirectory: path.join(directory, 'checkpoints'),
      database: { sqlitePath: path.join(directory, 'core.sqlite') },
      auth: { developmentTokenEnv: tokenName },
      providers: [{ id: 'fake', type: 'ollama', locality: 'local', baseUrl: `http://127.0.0.1:${address.port}` }],
      models: [{ id: 'fake-model', providerId: 'fake', locality: 'local', capabilities: ['text'] }],
      attachments: { localDirectory: path.join(directory, 'attachments') },
    }), options);
    const { store, tasks: service } = server;
    assert.equal(injectedStore, store);
    const conversation = await store.create<Conversation>('conversation', principal.id, {
      title: 'Wrapped task',
      scope: 'private',
      modelPolicy: 'local',
      strategy: 'single',
      mode: 'ask',
      archived: false,
    });
    const task = await service.enqueue(principal, conversation.id, 'Original user prompt');
    await service.drain();

    assert.equal(modelPrompt, `${marker}\nOriginal user prompt`);
    assert.equal(interceptedEvent, true);

    const persistedTask = await store.get<Task>('task', task.id, principal.id);
    assert.equal(persistedTask?.data.prompt, 'Original user prompt');
    assert.equal(persistedTask?.data.result, 'assistant result');
    assert.equal(JSON.stringify(persistedTask?.data.runtimeMessages).includes(marker), false);

    const messages = await store.scan<Message>('message', principal.id);
    assert.deepEqual(
      messages.map((message) => [message.data.role, message.data.content]),
      [
        ['user', 'Original user prompt'],
        ['assistant', 'assistant result'],
      ],
    );
    assert.equal(JSON.stringify(await service.events(principal.id, task.id)).includes(marker), false);
  } finally {
    await server?.close();
    await new Promise<void>((resolve, reject) => modelServer.close((error) => error ? reject(error) : resolve()));
    if (previousToken === undefined) delete process.env[tokenName];
    else process.env[tokenName] = previousToken;
    await rm(directory, { recursive: true, force: true });
  }
});

function sanitize<T>(value: T): T {
  return JSON.parse(JSON.stringify(value).replaceAll(marker, '')) as T;
}
