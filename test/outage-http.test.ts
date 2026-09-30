import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { bearer, developmentAuth, type Authenticator } from '../src/auth.js';
import { DomainError, type Principal } from '../src/contracts.js';
import { createServer } from '../src/http/server.js';
import { createStoreReplaySink, OutageService, type SimpleChat } from '../src/outage/index.js';
import { SqliteStore } from '../src/storage/sqlite.js';
import type { Entity, Store } from '../src/storage/store.js';

const token = 'outage-session-token-with-more-than-thirty-two-characters';
const headers = { authorization: `Bearer ${token}` };

class ToggleStore implements Store {
  public available = true;
  public constructor(private readonly delegate: Store) {}
  public create<T>(kind: string, ownerId: string, data: T, id?: string): Promise<Entity<T>> { this.check(); return this.delegate.create(kind, ownerId, data, id); }
  public get<T>(kind: string, id: string, ownerId: string): Promise<Entity<T> | undefined> { this.check(); return this.delegate.get(kind, id, ownerId); }
  public scan<T>(kind: string, ownerId?: string): Promise<Array<Entity<T>>> { this.check(); return this.delegate.scan(kind, ownerId); }
  public put<T>(kind: string, id: string, ownerId: string, data: T, revision: number): Promise<Entity<T>> { this.check(); return this.delegate.put(kind, id, ownerId, data, revision); }
  public remove(kind: string, id: string, ownerId: string, revision: number): Promise<boolean> { this.check(); return this.delegate.remove(kind, id, ownerId, revision); }
  public close(): Promise<void> { return this.delegate.close(); }
  private check(): void { if (!this.available) throw new Error('NAS unavailable'); }
}

test('HTTP outage mode caches valid private sessions, fails closed, and replays shared IDs after NAS recovery', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'kiancode-outage-http-'));
  const store = new ToggleStore(new SqliteStore());
  const principal: Principal = {
    id: 'owner-1',
    level: 1,
    scopes: ['*'],
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  };
  let authOnline = true;
  const authenticate: Authenticator = async (authorization) => {
    if (!authOnline) throw new DomainError('identity_unavailable', 'Identity unavailable', 503);
    if (bearer(authorization) !== token) throw new DomainError('unauthorized', 'Invalid token', 401);
    return principal;
  };
  let modelCalls = 0;
  let sawDurablePrompt = false;
  const simpleChat: SimpleChat = async (input) => {
    modelCalls += 1;
    assert.equal(input.mode, 'ask');
    assert.equal(input.strategy, 'single');
    assert.deepEqual(input.tools, []);
    assert.equal(input.modelPolicy, 'cloud');
    sawDurablePrompt = (await readdir(path.join(directory, 'records'))).some((name) => name.endsWith('.enc'));
    return { content: 'degraded answer' };
  };
  const outage = new OutageService({
    directory,
    key: randomBytes(32),
    simpleChat,
    replaySink: createStoreReplaySink(store),
  });
  const server = await createServer({ store, authenticate, runner: async () => ({ text: 'normal' }), outage });
  try {
    const created = await server.app.inject({
      method: 'POST',
      url: '/v1/conversations',
      headers,
      payload: { title: 'Cached private chat', modelPolicy: 'cloud' },
    });
    assert.equal(created.statusCode, 201, created.body);
    const conversationId = created.json().data.id as string;
    assert.equal((await server.app.inject({ method: 'GET', url: `/v1/conversations/${conversationId}/messages`, headers })).statusCode, 200);
    const contextFile = (await readdir(path.join(directory, 'contexts')))[0];
    assert.ok(contextFile);
    assert.doesNotMatch(await readFile(path.join(directory, 'contexts', contextFile), 'utf8'), /Cached private chat/);

    authOnline = false;
    store.available = false;
    const sent = await server.app.inject({
      method: 'POST',
      url: `/v1/conversations/${conversationId}/messages`,
      headers,
      payload: { content: 'continue during outage', requestId: 'phone-request-1' },
    });
    assert.equal(sent.statusCode, 202, sent.body);
    assert.equal(sent.json().data.data.state, 'completed');
    assert.equal(sent.json().data.data.degraded, true);
    assert.equal(sawDurablePrompt, true);
    const taskId = sent.json().data.id as string;

    const retry = await server.app.inject({
      method: 'POST',
      url: `/v1/conversations/${conversationId}/messages`,
      headers,
      payload: { content: 'continue during outage', requestId: 'phone-request-1' },
    });
    assert.equal(retry.json().data.id, taskId);
    assert.equal(modelCalls, 1);
    const task = await server.app.inject({ method: 'GET', url: `/v1/tasks/${taskId}`, headers });
    assert.equal(task.json().data.data.result, 'degraded answer');
    const messages = await server.app.inject({ method: 'GET', url: `/v1/conversations/${conversationId}/messages`, headers });
    assert.deepEqual(messages.json().data.map((message: { data: { content: string } }) => message.data.content), [
      'continue during outage',
      'degraded answer',
    ]);
    assert.equal((await server.app.inject({ method: 'GET', url: '/v1/agents', headers })).statusCode, 503);
    assert.equal((await server.app.inject({ method: 'GET', url: '/v1/session', headers })).statusCode, 503);
    assert.equal((await server.app.inject({ method: 'GET', url: '/health/live' })).json().degraded, true);

    store.available = true;
    authOnline = true;
    assert.deepEqual(await outage.reconcile(), { acknowledged: 1, remaining: 0 });
    const replayedTask = await server.app.inject({ method: 'GET', url: `/v1/tasks/${taskId}`, headers });
    assert.equal(replayedTask.json().data.id, taskId);
    assert.equal(replayedTask.json().data.data.result, 'degraded answer');
    const replayedMessages = await server.app.inject({ method: 'GET', url: `/v1/conversations/${conversationId}/messages`, headers });
    assert.deepEqual(replayedMessages.json().data.map((message: { id: string }) => message.id), [
      `${taskId}:user`,
      `${taskId}:assistant`,
    ]);
    const normal = await server.app.inject({
      method: 'POST',
      url: `/v1/conversations/${conversationId}/messages`,
      headers,
      payload: { content: 'after recovery', requestId: 'phone-request-2' },
    });
    assert.equal(normal.statusCode, 202, normal.body);
    await server.tasks.drain();
    const ordered = await server.app.inject({ method: 'GET', url: `/v1/conversations/${conversationId}/messages`, headers });
    assert.deepEqual(ordered.json().data.map((message: { data: { sequence?: number } }) => message.data.sequence), [1, 2, 3, 4]);
  } finally {
    await server.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('group chats and development sessions without expiry are never outage-authorized', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'kiancode-outage-deny-'));
  const store = new ToggleStore(new SqliteStore());
  const outage = new OutageService({ directory, key: randomBytes(32), simpleChat: async () => ({ content: 'no' }) });
  const server = await createServer({ store, authenticate: developmentAuth(token), runner: async () => ({ text: 'normal' }), outage });
  try {
    const group = await server.app.inject({
      method: 'POST', url: '/v1/conversations', headers,
      payload: { title: 'Group', scope: 'group' },
    });
    const privateChat = await server.app.inject({
      method: 'POST', url: '/v1/conversations', headers,
      payload: { title: 'No expiry' },
    });
    for (const conversationId of [group.json().data.id, privateChat.json().data.id]) {
      await server.app.inject({ method: 'GET', url: `/v1/conversations/${conversationId}/messages`, headers });
    }
    store.available = false;
    for (const conversationId of [group.json().data.id, privateChat.json().data.id]) {
      const response = await server.app.inject({
        method: 'POST', url: `/v1/conversations/${conversationId}/messages`, headers,
        payload: { content: 'must fail closed', requestId: conversationId },
      });
      assert.equal(response.statusCode, 401, response.body);
    }
  } finally {
    store.available = true;
    await server.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('workspace cloud prohibition remains local through the HTTP outage fallback', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'kiancode-outage-local-'));
  const store = new ToggleStore(new SqliteStore());
  const principal: Principal = { id: 'owner-local', level: 1, scopes: ['*'], expiresAt: new Date(Date.now() + 60_000).toISOString() };
  let authOnline = true;
  const authenticate: Authenticator = async (authorization) => {
    if (!authOnline) throw new DomainError('identity_unavailable', 'Identity unavailable', 503);
    bearer(authorization);
    return principal;
  };
  let observedPolicy = '';
  const outage = new OutageService({
    directory,
    key: randomBytes(32),
    simpleChat: async (input) => { observedPolicy = input.modelPolicy; return { content: 'local' }; },
  });
  const server = await createServer({ store, authenticate, runner: async () => ({ text: 'normal' }), outage });
  try {
    const workspace = await store.create('workspace', principal.id, {
      name: 'Private workspace', root: '/private', deviceId: 'server', capabilities: [], allowCloud: false,
    });
    const conversation = await server.app.inject({
      method: 'POST', url: '/v1/conversations', headers,
      payload: { title: 'Private workspace chat', workspaceId: workspace.id, modelPolicy: 'auto' },
    });
    const conversationId = conversation.json().data.id as string;
    await server.app.inject({ method: 'GET', url: `/v1/conversations/${conversationId}/messages`, headers });
    authOnline = false;
    store.available = false;
    const response = await server.app.inject({
      method: 'POST', url: `/v1/conversations/${conversationId}/messages`, headers,
      payload: { content: 'stay local', requestId: 'local-only' },
    });
    assert.equal(response.statusCode, 202, response.body);
    assert.equal(observedPolicy, 'local');
  } finally {
    store.available = true;
    await server.close();
    await rm(directory, { recursive: true, force: true });
  }
});
