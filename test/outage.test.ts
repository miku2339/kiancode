import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { DomainError, type Principal } from '../src/contracts.js';
import {
  EncryptedBuffer,
  OutageService,
  tokenHash,
  type OutageContext,
  type OutageReplayRecord,
  type OutageReplaySink,
  type SimpleChat,
} from '../src/outage/index.js';

const principal: Principal = { id: 'owner-1', level: 1, scopes: ['chat:read', 'chat:write'] };
const token = 'cached-session-token';

test('outage chat durably queues encrypted input before restricted generation and survives restart', async () => {
  const directory = await temporaryDirectory();
  const key = randomBytes(32);
  let modelCalls = 0;
  let sawDurableInput = false;
  const simpleChat: SimpleChat = async (input) => {
    modelCalls += 1;
    const records = await readdir(path.join(directory, 'records'));
    sawDurableInput = records.some((name) => name.endsWith('.enc'));
    assert.equal(input.mode, 'ask');
    assert.equal(input.strategy, 'single');
    assert.equal(input.modelPolicy, 'cloud');
    assert.equal(input.modelId, 'cloud-model');
    assert.equal(input.privacy, 'standard');
    assert.deepEqual(input.tools, []);
    return { content: 'local response' };
  };
  try {
    const service = new OutageService({ directory, key, simpleChat });
    await service.cacheContext(context(Date.now() + 60_000));
    assert.ok((await service.stats()).bytesUsed > 0);
    const result = await service.run({ token, conversationId: 'conversation-1', prompt: 'private prompt' });
    assert.equal(result.state, 'completed');
    assert.equal(result.degraded, true);
    assert.equal(result.result, 'local response');
    assert.equal(result.workspaceId, 'workspace-1');
    assert.equal(sawDurableInput, true);

    const recordName = (await readdir(path.join(directory, 'records')))[0];
    assert.ok(recordName);
    const recordPath = path.join(directory, 'records', recordName);
    const raw = await readFile(recordPath, 'utf8');
    assert.doesNotMatch(raw, /private prompt|local response/);
    assert.equal((await stat(recordPath)).mode & 0o777, 0o600);

    const restarted = new OutageService({ directory, key, simpleChat });
    const tasks = await restarted.list(token, 'conversation-1');
    assert.equal(tasks[0]?.result, 'local response');
    assert.equal(modelCalls, 1);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('environment key encrypts with authenticated AES-GCM and rejects modified ciphertext', async () => {
  const directory = await temporaryDirectory();
  const encodedKey = randomBytes(32).toString('base64');
  const buffer = new EncryptedBuffer(directory, {
    env: { KIANCODE_OUTAGE_KEY: encodedKey },
  });
  try {
    await buffer.write('records/test.enc', { secret: 'not plaintext' });
    const target = path.join(directory, 'records', 'test.enc');
    const envelope = JSON.parse(await readFile(target, 'utf8')) as {
      version: number;
      iv: string;
      tag: string;
      ciphertext: string;
    };
    assert.equal(envelope.version, 1);
    assert.equal(Buffer.from(envelope.iv, 'base64').length, 12);
    assert.equal(Buffer.from(envelope.tag, 'base64').length, 16);
    assert.doesNotMatch(envelope.ciphertext, /not plaintext/);
    envelope.ciphertext = `${envelope.ciphertext.slice(0, -2)}AA`;
    await writeFile(target, JSON.stringify(envelope));
    await assert.rejects(
      buffer.read('records/test.enc'),
      (error: unknown) => error instanceof Error && 'code' in error && error.code === 'outage_buffer_corrupt',
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('reconcile keeps data through NAS outage and crash-before-ack, then deletes only after durable dedupe ack', async () => {
  const directory = await temporaryDirectory();
  const key = randomBytes(32);
  const persisted = new Map<string, OutageReplayRecord>();
  let attempts = 0;
  const sink: OutageReplaySink = {
    async replay(record) {
      attempts += 1;
      persisted.set(record.recordId, record);
      if (attempts === 1) throw new Error('connection lost before ack');
      assert.equal(persisted.get(record.recordId)?.recordId, record.recordId);
      return { recordId: record.recordId, durable: true, deduplicated: true };
    },
  };
  let modelCalls = 0;
  const simpleChat: SimpleChat = async () => {
    modelCalls += 1;
    return { content: 'saved once' };
  };
  try {
    const first = new OutageService({ directory, key, simpleChat, replaySink: sink });
    await first.cacheContext(context(Date.now() + 60_000));
    const task = await first.run({ token, conversationId: 'conversation-1', prompt: 'hello' });
    assert.deepEqual(await first.reconcile(), { acknowledged: 0, remaining: 1 });

    const restarted = new OutageService({ directory, key, simpleChat, replaySink: sink });
    assert.deepEqual(await restarted.reconcile(), { acknowledged: 1, remaining: 0 });
    assert.equal(attempts, 2);
    assert.equal(modelCalls, 1);
    assert.equal(persisted.size, 1);
    assert.deepEqual(persisted.get(task.id)?.messages.map((message) => message.id), [
      `${task.id}:user`,
      `${task.id}:assistant`,
    ]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('expired cached sessions and group conversations are denied without model calls', async () => {
  const directory = await temporaryDirectory();
  const key = randomBytes(32);
  let now = Date.now();
  let modelCalls = 0;
  const simpleChat: SimpleChat = async () => { modelCalls += 1; return { content: 'no' }; };
  try {
    const service = new OutageService({ directory, key, simpleChat, now: () => now });
    await service.cacheContext(context(now + 1_000));
    now += 1_001;
    await assert.rejects(
      service.run({ token, conversationId: 'conversation-1', prompt: 'hello' }),
      (error: unknown) => error instanceof Error && 'code' in error && error.code === 'session_expired',
    );
    const group = {
      ...context(now + 60_000),
      conversation: { ...context(now + 60_000).conversation, scope: 'group' },
    } as unknown as OutageContext;
    await assert.rejects(
      service.cacheContext(group),
      (error: unknown) => error instanceof Error && 'code' in error && error.code === 'outage_private_only',
    );
    assert.equal(modelCalls, 0);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('privacy policy forces local without cloud fallback and request IDs prevent duplicate generation', async () => {
  const directory = await temporaryDirectory();
  const key = randomBytes(32);
  let calls = 0;
  let deviceOnline = false;
  const simpleChat: SimpleChat = async (input) => {
    calls += 1;
    assert.equal(input.modelPolicy, 'local');
    assert.equal(input.privacy, 'private');
    if (!deviceOnline) {
      throw new DomainError('waiting_for_device', 'Mac is offline', 503);
    }
    return { content: 'local only' };
  };
  try {
    const service = new OutageService({ directory, key, simpleChat });
    const cached = context(Date.now() + 60_000);
    cached.conversation.privacy = 'private';
    await service.cacheContext(cached);
    const first = await service.run({
      token,
      conversationId: 'conversation-1',
      prompt: 'same prompt',
      requestId: 'phone-request-1',
    });
    assert.equal(first.state, 'waiting_for_device');

    const duplicate = await service.run({
      token,
      conversationId: 'conversation-1',
      prompt: 'same prompt',
      requestId: 'phone-request-1',
    });
    assert.equal(duplicate.id, first.id);
    assert.equal(calls, 1);
    await assert.rejects(
      service.run({
        token,
        conversationId: 'conversation-1',
        prompt: 'different prompt',
        requestId: 'phone-request-1',
      }),
      (error: unknown) => error instanceof Error && 'code' in error && error.code === 'idempotency_conflict',
    );

    await service.cacheContext(context(Date.now() + 60_000));
    deviceOnline = true;
    const resumed = await service.resumeQueued();
    assert.equal(resumed[0]?.state, 'completed');
    assert.equal(resumed[0]?.result, 'local only');
    assert.equal(calls, 2);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('size and first-unsynced age caps reject new data without deleting old unsynced records', async () => {
  const sizeDirectory = await temporaryDirectory();
  const ageDirectory = await temporaryDirectory();
  const key = randomBytes(32);
  const simpleChat: SimpleChat = async () => ({ content: 'ok' });
  try {
    const sizeLimited = new OutageService({
      directory: sizeDirectory,
      key,
      simpleChat,
      maxBytes: 5_000,
      maxResponseBytes: 128,
    });
    await sizeLimited.cacheContext(context(Date.now() + 60_000));
    await assert.rejects(
      sizeLimited.run({ token, conversationId: 'conversation-1', prompt: 'x'.repeat(4_000) }),
      (error: unknown) => error instanceof Error && 'code' in error && error.code === 'outage_buffer_full',
    );

    let now = Date.now();
    const ageLimited = new OutageService({
      directory: ageDirectory,
      key,
      simpleChat,
      now: () => now,
      maxAgeMs: 1_000,
    });
    await ageLimited.cacheContext(context(now + 72 * 60 * 60 * 1_000));
    await ageLimited.run({ token, conversationId: 'conversation-1', prompt: 'first' });
    now += 49 * 60 * 60 * 1_000;
    await assert.rejects(
      ageLimited.run({ token, conversationId: 'conversation-1', prompt: 'second' }),
      (error: unknown) => error instanceof Error && 'code' in error && error.code === 'outage_window_expired',
    );
    const stats = await ageLimited.stats();
    assert.equal(stats.unsyncedRecords, 1);
    assert.equal(stats.accepting, false);
    assert.equal((await readdir(path.join(ageDirectory, 'records'))).length, 1);
  } finally {
    await rm(sizeDirectory, { recursive: true, force: true });
    await rm(ageDirectory, { recursive: true, force: true });
  }
});

test('background resume joins an in-flight durable generation instead of rerunning the model', async () => {
  const directory = await temporaryDirectory();
  const key = randomBytes(32);
  let calls = 0;
  let release: (() => void) | undefined;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const simpleChat: SimpleChat = async () => { calls += 1; await gate; return { content: 'once' }; };
  try {
    const service = new OutageService({ directory, key, simpleChat });
    await service.cacheContext(context(Date.now() + 60_000));
    const running = service.run({ token, conversationId: 'conversation-1', prompt: 'hello', requestId: 'same' });
    while ((await service.stats()).unsyncedRecords === 0) await new Promise<void>((resolve) => setTimeout(resolve, 1));
    const resumed = service.resumeQueued();
    release?.();
    assert.equal((await running).state, 'completed');
    assert.equal((await resumed)[0]?.state, 'completed');
    assert.equal(calls, 1);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

function context(expiresAt: number): OutageContext {
  return {
    principal,
    tokenHash: tokenHash(token),
    sessionExpiresAt: new Date(expiresAt).toISOString(),
    conversation: {
      id: 'conversation-1',
      ownerId: principal.id,
      title: 'Private conversation',
      scope: 'private',
      modelPolicy: 'cloud',
      strategy: 'auto',
      mode: 'ask',
      modelId: 'cloud-model',
      workspaceId: 'workspace-1',
      privacy: 'standard',
      workspaceAllowCloud: true,
      archived: false,
    },
    history: [{
      id: 'history-1',
      role: 'assistant',
      content: 'existing private context',
      createdAt: new Date(expiresAt - 60_000).toISOString(),
    }],
  };
}

async function temporaryDirectory(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), 'kiancode-outage-'));
}
