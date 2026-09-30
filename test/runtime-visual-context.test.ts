import assert from 'node:assert/strict';
import test from 'node:test';
import type { Principal } from '../src/contracts.js';
import type { Conversation, Task } from '../src/domain.js';
import { createTaskRunner } from '../src/runtime-adapter.js';
import { AgentRuntime, VisualContextStore, type ChatRequest, type ModelProvider } from '../src/runtime/index.js';
import { SqliteStore } from '../src/storage/sqlite.js';
import { TaskService } from '../src/tasks.js';

test('visual context is owner-bound, latest-only, consumed once, and cleared by stop or restart', () => {
  let now = 1_000;
  const contexts = new VisualContextStore({
    now: () => now,
    ttlMs: 500,
    maxFrameBytes: 32,
    maxBytes: 64,
    maxEntries: 2,
  });

  contexts.pushFrame({
    ownerId: 'alice',
    conversationId: 'conversation',
    sessionId: 'camera',
    mimeType: 'image/png',
    data: Buffer.from('first'),
  });
  now += 1;
  contexts.pushFrame({
    ownerId: 'alice',
    conversationId: 'conversation',
    sessionId: 'camera',
    mimeType: 'image/png',
    data: Buffer.from('latest'),
  });

  assert.equal(contexts.takeLatest('bob', 'conversation'), undefined);
  assert.equal(contexts.takeLatest('alice', 'conversation')?.data, Buffer.from('latest').toString('base64'));
  assert.equal(contexts.takeLatest('alice', 'conversation'), undefined);

  contexts.pushFrame({ ownerId: 'alice', conversationId: 'conversation', sessionId: 'screen', mimeType: 'image/jpeg', data: Buffer.from('screen') });
  contexts.clear('alice', 'conversation', 'screen');
  assert.equal(contexts.takeLatest('alice', 'conversation'), undefined);

  contexts.pushFrame({ ownerId: 'alice', conversationId: 'conversation', sessionId: 'screen', mimeType: 'image/webp', data: Buffer.from('expires') });
  now += 501;
  assert.equal(contexts.takeLatest('alice', 'conversation'), undefined);
  assert.equal(new VisualContextStore().takeLatest('alice', 'conversation'), undefined);
});

test('visual and device payload stores enforce byte bounds without returning mutable data', () => {
  const contexts = new VisualContextStore({ maxFrameBytes: 8, maxBytes: 12, maxEntries: 2 });
  assert.throws(() => contexts.pushFrame({
    ownerId: 'alice', conversationId: 'conversation', sessionId: 'screen', mimeType: 'text/plain' as never, data: Buffer.from('bad'),
  }), /image/i);
  assert.throws(() => contexts.pushFrame({
    ownerId: 'alice', conversationId: 'conversation', sessionId: 'screen', mimeType: 'image/png', data: Buffer.alloc(9),
  }), /large|limit/i);

  const reference = contexts.stagePayload('alice', 'task', {
    attachments: [{ messageIndex: 0, attachmentIndex: 0, mimeType: 'image/png', data: Buffer.from('secret').toString('base64') }],
  });
  assert.equal(contexts.consumePayload('bob', 'task', reference), undefined);
  const payload = contexts.consumePayload('alice', 'task', reference);
  assert.equal(payload?.attachments[0]?.data, Buffer.from('secret').toString('base64'));
  assert.equal(contexts.consumePayload('alice', 'task', reference), undefined);
});

test('the next utterance consumes one frame without persisting its bytes in tasks, events, or history', async () => {
  const secret = Buffer.from('ephemeral-camera-frame').toString('base64');
  const requests: ChatRequest[] = [];
  const provider: ModelProvider = {
    id: 'vision-provider',
    locality: 'cloud',
    async chat(request) {
      requests.push(request);
      return { message: { role: 'assistant', content: 'I can see it.' }, usage: { inputTokens: 2, outputTokens: 2 } };
    },
  };
  const runtime = new AgentRuntime({
    providers: [provider],
    models: [{ id: 'vision', providerId: provider.id, locality: 'cloud', capabilities: ['vision'] }],
  });
  const contexts = new VisualContextStore();
  const store = new SqliteStore();
  const principal: Principal = { id: 'alice', level: 1, scopes: ['*'] };
  const conversation: Conversation = {
    title: 'Camera', scope: 'private', modelPolicy: 'cloud', strategy: 'single', mode: 'ask', archived: false,
  };
  const thread = await store.create('conversation', principal.id, conversation, 'conversation');
  contexts.pushFrame({
    ownerId: principal.id,
    conversationId: thread.id,
    sessionId: 'camera-session',
    mimeType: 'image/png',
    data: Buffer.from('ephemeral-camera-frame'),
  });
  const service = new TaskService(store, createTaskRunner(store, runtime, [], undefined, undefined, contexts));
  try {
    const task = await service.enqueue(principal, thread.id, 'What is visible?', 'visual-request');
    await service.drain();
    assert.equal(requests[0]?.messages.some((message) => message.attachments?.some((attachment) => attachment.data === secret)), true);
    const persistedTask = await store.get<Task>('task', task.id, principal.id);
    assert.equal(JSON.stringify(persistedTask).includes(secret), false);
    assert.equal(JSON.stringify(await store.scan('event', principal.id)).includes(secret), false);
    assert.equal(JSON.stringify(await store.scan('message', principal.id)).includes(secret), false);

    await service.enqueue(principal, thread.id, 'And now?', 'plain-request');
    await service.drain();
    assert.equal(requests[1]?.messages.some((message) => message.attachments?.length), false);
  } finally {
    await service.close();
    await store.close();
  }
});
