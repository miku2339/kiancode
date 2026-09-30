import assert from 'node:assert/strict';
import test from 'node:test';
import { developmentAuth } from '../src/auth.js';
import type { Conversation, Memory } from '../src/domain.js';
import { createServer } from '../src/http/server.js';
import { listMemoryRows } from '../src/memory-query.js';
import { createTaskRunner } from '../src/runtime-adapter.js';
import { AgentRuntime, type ChatRequest, type ModelProvider } from '../src/runtime/index.js';
import type { Store } from '../src/storage/store.js';
import { SqliteStore } from '../src/storage/sqlite.js';
import { TaskService } from '../src/tasks.js';

const current = '2026-09-27T12:00:00.000Z';
const active = (text: string, changes: Partial<Memory> = {}): Memory => ({
  type: 'document',
  text,
  scope: 'private',
  source: 'synthetic:test',
  validFrom: '2026-01-01T00:00:00.000Z',
  ...changes,
});

test('SQLite relevant memory matches CJK terms, replacements and private scope boundaries', async () => {
  const store = new SqliteStore();
  try {
    const old = await store.create('memory', 'owner', active('海事專案使用舊版法例。'), 'old');
    await store.create('memory', 'owner', active('海事專案引用更新後的香港法例。', { replacesId: old.id }), 'replacement');
    await store.create('memory', 'owner', active('工作區海事專案資料。', { scope: 'workspace', scopeId: 'workspace' }), 'workspace');
    await store.create('memory', 'owner', active('其他工作區海事專案資料。', { scope: 'workspace', scopeId: 'other' }), 'other-workspace');
    await store.create('memory', 'owner', active('群組海事專案資料。', { scope: 'group', scopeId: 'group' }), 'group');
    await store.create('memory', 'owner', active('已過期海事專案資料。', { validTo: current }), 'expired');
    await store.create('memory', 'other-owner', active('其他使用者海事專案資料。'), 'other-owner');

    const privatePage = await store.queryMemory({
      ownerId: 'owner',
      purpose: 'relevant',
      context: { scope: 'private', conversationId: 'private', workspaceId: 'workspace', prompt: '請找海事專案法例' },
      now: Date.parse(current) + 1,
      limit: 12,
    });
    assert.deepEqual(new Set(privatePage.rows.map((row) => row.id)), new Set(['replacement', 'workspace']));

    const groupPage = await store.queryMemory({
      ownerId: 'owner',
      purpose: 'relevant',
      context: { scope: 'group', conversationId: 'group', prompt: '海事專案' },
      now: Date.parse(current) + 1,
      limit: 12,
    });
    assert.deepEqual(groupPage.rows.map((row) => row.id), ['group']);
  } finally {
    await store.close();
  }
});

test('SQLite memory listing applies database-equivalent filters and stable cursor pagination', async () => {
  const store = new SqliteStore();
  try {
    for (let index = 0; index < 7; index += 1) {
      await store.create('memory', 'owner', active(`海事專案來源 ${index}`), `memory-${index}`);
    }
    await store.create('memory', 'owner', active('無關內容。'), 'unrelated');
    await store.create('memory', 'other-owner', active('海事專案不可見。'), 'isolated');
    const ids: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await store.queryMemory({
        ownerId: 'owner',
        purpose: 'list',
        q: '海事專案',
        scope: 'private',
        now: Date.parse(current),
        limit: 2,
        ...(cursor ? { cursor } : {}),
      });
      ids.push(...page.rows.map((row) => row.id));
      cursor = page.nextCursor;
    } while (cursor);
    assert.equal(ids.length, 7);
    assert.equal(new Set(ids).size, 7);
    assert.equal(ids.includes('isolated'), false);
    assert.equal(ids.includes('unrelated'), false);
  } finally {
    await store.close();
  }
});

test('memory cursor truncates sub-millisecond timestamps before the id tie-breaker', () => {
  const rows = [
    { id: 'a', ownerId: 'owner', revision: 1, createdAt: current, updatedAt: '2026-09-27T12:00:00.123789Z', data: active('cursor match') },
    { id: 'z', ownerId: 'owner', revision: 1, createdAt: current, updatedAt: '2026-09-27T12:00:00.123456Z', data: active('cursor match') },
  ];
  const first = listMemoryRows(rows, { ownerId: 'owner', purpose: 'list', q: 'cursor match', limit: 1 });
  assert.deepEqual(first.rows.map((row) => row.id), ['z']);
  assert.ok(first.nextCursor);
  const second = listMemoryRows(rows, { ownerId: 'owner', purpose: 'list', q: 'cursor match', limit: 1, cursor: first.nextCursor });
  assert.deepEqual(second.rows.map((row) => row.id), ['a']);
});

test('memory HTTP list returns bounded pages and rejects malformed cursors', async () => {
  const store = new SqliteStore();
  const token = 'memory-query-test-token-with-thirty-two-characters';
  const server = await createServer({
    store,
    authenticate: developmentAuth(token),
    runner: async () => ({ text: 'unused' }),
  });
  const headers = { authorization: `Bearer ${token}` };
  try {
    for (let index = 0; index < 5; index += 1) {
      await store.create('memory', 'local-owner', active(`香港法例來源 ${index}`), `http-memory-${index}`);
    }
    const first = await server.app.inject({ method: 'GET', url: '/v1/memories?q=香港法例&scope=private&limit=2', headers });
    assert.equal(first.statusCode, 200);
    assert.equal(first.json().data.length, 2);
    assert.equal(typeof first.json().nextCursor, 'string');
    const second = await server.app.inject({
      method: 'GET',
      url: `/v1/memories?q=香港法例&scope=private&limit=2&cursor=${encodeURIComponent(first.json().nextCursor)}`,
      headers,
    });
    assert.equal(second.statusCode, 200);
    assert.equal(second.json().data.length, 2);
    assert.deepEqual(new Set([...first.json().data, ...second.json().data].map((row) => row.id)).size, 4);
    assert.equal((await server.app.inject({ method: 'GET', url: '/v1/memories?cursor=broken', headers })).statusCode, 400);
  } finally {
    await server.close();
  }
});

test('memory HTTP list keeps the custom Store scan fallback', async () => {
  const sqlite = new SqliteStore();
  const store: Store = {
    create: sqlite.create.bind(sqlite),
    get: sqlite.get.bind(sqlite),
    scan: sqlite.scan.bind(sqlite),
    put: sqlite.put.bind(sqlite),
    remove: sqlite.remove.bind(sqlite),
    close: sqlite.close.bind(sqlite),
  };
  const token = 'memory-fallback-test-token-with-thirty-two-characters';
  const server = await createServer({ store, authenticate: developmentAuth(token), runner: async () => ({ text: 'unused' }) });
  try {
    await store.create('memory', 'local-owner', active('自訂儲存記憶。'), 'custom-memory');
    const response = await server.app.inject({
      method: 'GET',
      url: '/v1/memories?q=自訂儲存&limit=10',
      headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.json().data.map((row: { id: string }) => row.id), ['custom-memory']);
  } finally {
    await server.close();
  }
});

test('task runtime uses the bounded Store memory query without scanning every memory', async () => {
  const sqlite = new SqliteStore();
  let queries = 0;
  const store: Store = {
    create: sqlite.create.bind(sqlite),
    get: sqlite.get.bind(sqlite),
    scan: async (kind, ownerId) => {
      if (kind === 'memory') throw new Error('unbounded_memory_scan');
      return sqlite.scan(kind, ownerId);
    },
    queryMemory: async (query) => {
      queries += 1;
      return sqlite.queryMemory(query);
    },
    put: sqlite.put.bind(sqlite),
    remove: sqlite.remove.bind(sqlite),
    close: sqlite.close.bind(sqlite),
  };
  const requests: ChatRequest[] = [];
  const provider: ModelProvider = {
    id: 'memory-model',
    locality: 'cloud',
    async chat(request) {
      requests.push(request);
      return { message: { role: 'assistant', content: '完成' }, usage: { inputTokens: 1, outputTokens: 1 } };
    },
  };
  const runtime = new AgentRuntime({
    providers: [provider],
    models: [{ id: 'memory-model', providerId: provider.id, locality: 'cloud', capabilities: [] }],
  });
  const tasks = new TaskService(store, createTaskRunner(store, runtime, []));
  try {
    await store.create('memory', 'owner', active('海事專案採用香港法例。'), 'runtime-memory');
    const conversation = await store.create<Conversation>('conversation', 'owner', {
      title: 'Memory', scope: 'private', modelPolicy: 'cloud', strategy: 'single', mode: 'ask', archived: false,
    }, 'runtime-conversation');
    await tasks.enqueue({ id: 'owner', level: 1, scopes: ['*'] }, conversation.id, '海事專案使用甚麼法例？');
    await tasks.drain();
    assert.equal(queries, 1);
    assert.match(requests[0]?.messages.find((message) => message.role === 'system')?.content ?? '', /海事專案採用香港法例/);
  } finally {
    await tasks.close();
    await store.close();
  }
});
