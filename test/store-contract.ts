import assert from 'node:assert/strict';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { DomainError } from '../src/contracts.js';
import type { Memory } from '../src/domain.js';
import type { Store } from '../src/storage/store.js';

export type ContractStore = Store & { queryMemory: NonNullable<Store['queryMemory']> };

export interface StoreHarness {
  open(): Promise<ContractStore>;
  dispose(): Promise<void>;
}

const timestamp = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const current = '2026-09-27T12:00:00.000Z';
const now = Date.parse(current);
const memory = (text: string, changes: Partial<Memory> = {}): Memory => ({
  type: 'document',
  text,
  scope: 'private',
  source: 'synthetic:test',
  validFrom: '2026-01-01T00:00:00.000Z',
  ...changes,
});
const ids = (rows: Array<{ id: string }>): string[] => rows.map((row) => row.id);

const domainError = (code: string, statusCode: number) => (error: unknown): boolean =>
  error instanceof DomainError && error.code === code && error.statusCode === statusCode;

export function storeContract(label: string, createHarness: () => Promise<StoreHarness>, skip: string | false = false): void {
  const contract = (name: string, body: (harness: StoreHarness) => Promise<void>): void => {
    test(`${label}: ${name}`, { skip }, async () => {
      const harness = await createHarness();
      try {
        await body(harness);
      } finally {
        await harness.dispose();
      }
    });
  };

  contract('records survive reopening and stay owner-scoped', async (harness) => {
    let store = await harness.open();
    const record = await store.create('conversation', 'alice', { title: 'My project' });
    assert.equal(await store.get('conversation', record.id, 'bob'), undefined);
    assert.deepEqual(await store.scan('conversation', 'bob'), []);
    const updated = await store.put('conversation', record.id, 'alice', { title: 'Updated' }, record.revision);
    await assert.rejects(store.put('conversation', record.id, 'alice', { title: 'Stale' }, record.revision), domainError('conflict', 409));
    await assert.rejects(store.put('conversation', record.id, 'bob', { title: 'Intrusion' }, updated.revision), domainError('not_found', 404));
    store = await harness.open();
    const reopened = await store.get<{ title: string }>('conversation', record.id, 'alice');
    assert.equal(reopened?.data.title, 'Updated');
    assert.equal(reopened?.revision, updated.revision);
    assert.equal(await store.remove('conversation', record.id, 'bob', updated.revision), false);
    assert.equal((await store.get('conversation', record.id, 'alice'))?.revision, updated.revision);
    assert.equal(await store.remove('conversation', record.id, 'alice', updated.revision), true);
    assert.equal(await store.get('conversation', record.id, 'alice'), undefined);
  });

  contract('create assigns revision 1, millisecond timestamps and honours an explicit id', async (harness) => {
    const store = await harness.open();
    const generated = await store.create('note', 'alice', { value: 1 });
    assert.match(generated.id, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    assert.equal(generated.ownerId, 'alice');
    assert.strictEqual(generated.revision, 1);
    assert.match(generated.createdAt, timestamp);
    assert.equal(generated.updatedAt, generated.createdAt);
    const explicit = await store.create('note', 'alice', { value: 2 }, 'chosen-id');
    assert.equal(explicit.id, 'chosen-id');
    assert.deepEqual(await store.get('note', 'chosen-id', 'alice'), {
      id: 'chosen-id', ownerId: 'alice', revision: 1, createdAt: explicit.createdAt, updatedAt: explicit.updatedAt, data: { value: 2 },
    });
  });

  contract('put increments the revision, keeps createdAt and rejects stale or unknown writes', async (harness) => {
    const store = await harness.open();
    const created = await store.create('note', 'alice', { step: 1 }, 'note');
    await delay(5);
    const updated = await store.put('note', 'note', 'alice', { step: 2 }, created.revision);
    assert.strictEqual(updated.revision, 2);
    assert.equal(updated.createdAt, created.createdAt);
    assert.match(updated.updatedAt, timestamp);
    assert.ok(updated.updatedAt > created.updatedAt);
    assert.deepEqual(updated.data, { step: 2 });
    await assert.rejects(store.put('note', 'note', 'alice', { step: 3 }, created.revision), domainError('conflict', 409));
    assert.deepEqual(await store.get('note', 'note', 'alice'), updated);
    await assert.rejects(store.put('note', 'missing', 'alice', { step: 1 }, 1), domainError('not_found', 404));
    assert.equal(await store.get('note', 'missing', 'alice'), undefined);
  });

  contract('only one of several concurrent writers holding the same revision wins', async (harness) => {
    const store = await harness.open();
    const created = await store.create('note', 'alice', { writer: -1 }, 'note');
    const results = await Promise.allSettled(Array.from({ length: 8 }, (_, writer) => (
      store.put('note', 'note', 'alice', { writer }, created.revision)
    )));
    const winners = results.flatMap((result) => (result.status === 'fulfilled' ? [result.value] : []));
    const failures = results.flatMap((result) => (result.status === 'rejected' ? [result.reason as unknown] : []));
    assert.equal(winners.length, 1);
    assert.equal(failures.length, 7);
    assert.ok(failures.every(domainError('conflict', 409)));
    const stored = await store.get('note', 'note', 'alice');
    assert.strictEqual(stored?.revision, 2);
    assert.deepEqual(stored?.data, winners[0]?.data);
  });

  contract('create rejects an id already used in the same kind, whoever owns it', async (harness) => {
    const store = await harness.open();
    await store.create('note', 'alice', { value: 'original' }, 'shared');
    await assert.rejects(store.create('note', 'alice', { value: 'again' }, 'shared'), domainError('conflict', 409));
    await assert.rejects(store.create('note', 'bob', { value: 'intruder' }, 'shared'), domainError('conflict', 409));
    assert.deepEqual((await store.get('note', 'shared', 'alice'))?.data, { value: 'original' });
    assert.equal(await store.get('note', 'shared', 'bob'), undefined);
    const otherKind = await store.create('task', 'bob', { value: 'other kind' }, 'shared');
    assert.strictEqual(otherKind.revision, 1);
    const racing = await Promise.allSettled([
      store.create('note', 'alice', { value: 'first' }, 'raced'),
      store.create('note', 'alice', { value: 'second' }, 'raced'),
    ]);
    assert.equal(racing.filter((result) => result.status === 'fulfilled').length, 1);
    assert.equal((await store.scan('note')).length, 2);
  });

  contract('remove needs the current revision and frees the id', async (harness) => {
    const store = await harness.open();
    const created = await store.create('note', 'alice', { value: 1 }, 'note');
    const updated = await store.put('note', 'note', 'alice', { value: 2 }, created.revision);
    await assert.rejects(store.remove('note', 'note', 'alice', created.revision), domainError('conflict', 409));
    assert.deepEqual(await store.get('note', 'note', 'alice'), updated);
    assert.equal(await store.remove('note', 'missing', 'alice', 1), false);
    assert.equal(await store.remove('note', 'note', 'alice', updated.revision), true);
    assert.equal(await store.remove('note', 'note', 'alice', updated.revision), false);
    const recreated = await store.create('note', 'alice', { value: 3 }, 'note');
    assert.strictEqual(recreated.revision, 1);
  });

  contract('scan returns one kind, optionally one owner, in creation order', async (harness) => {
    const store = await harness.open();
    for (const id of ['c', 'b', 'a']) {
      await store.create('note', 'alice', { id }, id);
      await delay(5);
    }
    await store.create('note', 'bob', { id: 'd' }, 'd');
    await store.create('task', 'alice', { id: 'e' }, 'e');
    assert.deepEqual(ids(await store.scan('note', 'alice')), ['c', 'b', 'a']);
    assert.deepEqual(ids(await store.scan('note', 'bob')), ['d']);
    assert.deepEqual(ids(await store.scan('note')), ['c', 'b', 'a', 'd']);
    assert.deepEqual((await store.scan('note')).map((row) => row.ownerId), ['alice', 'alice', 'alice', 'bob']);
    assert.deepEqual(await store.scan('unknown-kind'), []);
    assert.deepEqual(await store.scan('unknown-kind', 'alice'), []);
  });

  contract('JSON data round-trips exactly', async (harness) => {
    let store = await harness.open();
    const data = {
      cjk: '海事專案：繁體中文と日本語のテキスト',
      emoji: '🙂 👩‍💻',
      quotes: `'single' "double" \`backtick\``,
      escapes: 'back\\slash\nnewline\ttab',
      wildcards: '100% _under_score_',
      nested: { list: [1, 'two', { three: 3 }, [4]], empty: {}, none: null },
      flags: [true, false],
      numbers: [0, 2.5, -7],
      blank: '',
    };
    const created = await store.create('note', 'alice', data, 'note');
    assert.deepEqual((await store.get('note', 'note', 'alice'))?.data, data);
    const changed = { ...data, nested: { list: [], empty: {}, none: null }, blank: ' ' };
    await store.put('note', 'note', 'alice', changed, created.revision);
    store = await harness.open();
    assert.deepEqual((await store.get('note', 'note', 'alice'))?.data, changed);
    assert.deepEqual((await store.scan('note', 'alice')).map((row) => row.data), [changed]);
  });

  contract('data PostgreSQL cannot encode is rejected as a domain error', async (harness) => {
    const store = await harness.open();
    await assert.rejects(store.create('note', 'alice', { text: 'nul\0character' }, 'nul'), domainError('invalid_data', 400));
    await assert.rejects(store.create('note', 'alice', { text: 'lone\ud800surrogate' }, 'surrogate'), domainError('invalid_data', 400));
    await assert.rejects(store.create('note', 'alice', { text: '\ud800' }, 'trailing-surrogate'), domainError('invalid_data', 400));
    await assert.rejects(store.create('note', 'alice', { ['key\ud800']: 'value' }, 'surrogate-key'), domainError('invalid_data', 400));
    assert.equal(await store.get('note', 'nul', 'alice'), undefined);
    assert.equal(await store.get('note', 'surrogate', 'alice'), undefined);
    assert.equal(await store.get('note', 'trailing-surrogate', 'alice'), undefined);
    assert.equal(await store.get('note', 'surrogate-key', 'alice'), undefined);
  });

  contract('identifiers are opaque values, never SQL or patterns', async (harness) => {
    const store = await harness.open();
    const awkwardKind = `kind'; SELECT 1; -- 100%_`;
    const hostileOwner = `o'; DROP TABLE kiancode_entities; DROP TABLE entities; --`;
    const awkwardId = `id "quoted" 'single' 100% back\\slash and space`;
    await store.create('note', hostileOwner, { value: 'hostile owner' }, awkwardId);
    await store.create(awkwardKind, hostileOwner, { value: 'hostile kind' }, awkwardId);
    await store.create('note', 'alice', { value: 'upper' }, 'Record-A');
    await store.create('note', 'alice', { value: 'lower' }, 'record-a');
    assert.deepEqual((await store.get('note', awkwardId, hostileOwner))?.data, { value: 'hostile owner' });
    assert.equal(await store.get('note', awkwardId, 'alice'), undefined);
    assert.equal(await store.get('note', 'id%', hostileOwner), undefined);
    assert.equal(await store.get('note', awkwardId, '%'), undefined);
    assert.deepEqual(ids(await store.scan('note', hostileOwner)), [awkwardId]);
    assert.deepEqual(ids(await store.scan(awkwardKind, hostileOwner)), [awkwardId]);
    assert.deepEqual(await store.scan('note', '%'), []);
    assert.deepEqual((await store.get('note', 'Record-A', 'alice'))?.data, { value: 'upper' });
    assert.deepEqual((await store.get('note', 'record-a', 'alice'))?.data, { value: 'lower' });
    assert.equal(await store.get('note', 'RECORD-A', 'alice'), undefined);
    assert.equal((await store.scan('note')).length, 3);
  });

  contract('relevant memory honours replacement, scope, expiry and owner', async (harness) => {
    const store = await harness.open();
    await store.create('memory', 'owner', memory('海事專案引用香港法例的官方文件。'), 'maritime');
    await store.create('memory', 'owner', memory('今天午餐吃番茄炒蛋。'), 'unrelated');
    await store.create('memory', 'owner', memory('海事專案使用舊版法例。'), 'old');
    await store.create('memory', 'owner', memory('海事專案引用更新後的香港法例。', { replacesId: 'old' }), 'replacement');
    await store.create('memory', 'owner', memory('工作區海事專案資料。', { scope: 'workspace', scopeId: 'workspace' }), 'workspace');
    await store.create('memory', 'owner', memory('其他工作區海事專案資料。', { scope: 'workspace', scopeId: 'other' }), 'other-workspace');
    await store.create('memory', 'owner', memory('群組海事專案資料。', { scope: 'group', scopeId: 'group' }), 'group');
    await store.create('memory', 'owner', memory('已過期海事專案資料。', { validTo: current }), 'expired');
    await store.create('memory', 'other-owner', memory('其他使用者海事專案資料。'), 'other-owner');

    const privatePage = await store.queryMemory({
      ownerId: 'owner',
      purpose: 'relevant',
      context: { scope: 'private', conversationId: 'private', workspaceId: 'workspace', prompt: '可以講返海事專案嘅法例資料來源嗎？' },
      now: now + 1,
      limit: 12,
    });
    assert.deepEqual(new Set(ids(privatePage.rows)), new Set(['maritime', 'replacement', 'workspace']));
    assert.equal(privatePage.nextCursor, undefined);

    const groupPage = await store.queryMemory({
      ownerId: 'owner', purpose: 'relevant', context: { scope: 'group', conversationId: 'group', prompt: '海事專案' }, now: now + 1, limit: 12,
    });
    assert.deepEqual(ids(groupPage.rows), ['group']);
  });

  contract('relevant memory shows workspace and agent rows only to the matching context', async (harness) => {
    const store = await harness.open();
    await store.create('memory', 'owner', memory('parser notes, private'), 'private');
    await store.create('memory', 'owner', memory('parser notes, workspace', { scope: 'workspace', scopeId: 'workspace-1' }), 'workspace');
    await store.create('memory', 'owner', memory('parser notes, agent', { scope: 'agent', scopeId: 'agent-1' }), 'agent');
    const visible = async (context: { scope: 'private' | 'group'; workspaceId?: string; agentId?: string }): Promise<Set<string>> => new Set(ids((await store.queryMemory({
      ownerId: 'owner', purpose: 'relevant', context: { conversationId: 'workspace-1', prompt: 'parser notes', ...context }, now, limit: 12,
    })).rows));
    assert.deepEqual(await visible({ scope: 'private' }), new Set(['private']));
    assert.deepEqual(await visible({ scope: 'private', workspaceId: 'workspace-1' }), new Set(['private', 'workspace']));
    assert.deepEqual(await visible({ scope: 'private', workspaceId: 'workspace-2' }), new Set(['private']));
    assert.deepEqual(await visible({ scope: 'private', agentId: 'agent-1' }), new Set(['private', 'agent']));
    assert.deepEqual(await visible({ scope: 'private', agentId: 'agent-2' }), new Set(['private']));
    assert.deepEqual(await visible({ scope: 'group', workspaceId: 'workspace-1', agentId: 'agent-1' }), new Set());
  });

  contract('relevant memory ranks persona first, then by matched terms, ignoring ASCII case, within the limit', async (harness) => {
    const store = await harness.open();
    await store.create('memory', 'owner', memory('Speak Traditional Chinese.', { type: 'persona' }), 'persona');
    await store.create('memory', 'owner', memory('The parser uses PostgreSQL transactions.'), 'one-term');
    await store.create('memory', 'owner', memory('PostgreSQL durability notes.'), 'two-terms');
    await store.create('memory', 'owner', memory('Apple pie recipe.'), 'unrelated');
    const relevant = async (limit: number): Promise<string[]> => ids((await store.queryMemory({
      ownerId: 'owner', purpose: 'relevant', context: { scope: 'private', conversationId: 'chat', prompt: 'Explain POSTGRESQL durability.' }, now, limit,
    })).rows);
    assert.deepEqual(await relevant(12), ['persona', 'two-terms', 'one-term']);
    assert.deepEqual(await relevant(2), ['persona', 'two-terms']);
    assert.deepEqual(await relevant(1), ['persona']);
  });

  contract('held and rejected memories stay out of relevant results and the default list', async (harness) => {
    const store = await harness.open();
    await store.create('memory', 'owner', memory('parser notes'), 'unreviewed');
    await store.create('memory', 'owner', memory('parser notes', { reviewStatus: 'approved' }), 'approved');
    await store.create('memory', 'owner', memory('parser notes', { reviewStatus: 'held' }), 'held');
    await store.create('memory', 'owner', memory('parser notes', { reviewStatus: 'rejected' }), 'rejected');
    const relevant = await store.queryMemory({
      ownerId: 'owner', purpose: 'relevant', context: { scope: 'private', conversationId: 'chat', prompt: 'parser notes' }, now, limit: 12,
    });
    assert.deepEqual(new Set(ids(relevant.rows)), new Set(['unreviewed', 'approved']));
    const listed = await store.queryMemory({ ownerId: 'owner', purpose: 'list', now, limit: 12 });
    assert.deepEqual(new Set(ids(listed.rows)), new Set(['unreviewed', 'approved']));
    const approved = await store.queryMemory({ ownerId: 'owner', purpose: 'list', reviewStatus: 'approved', now, limit: 12 });
    assert.deepEqual(new Set(ids(approved.rows)), new Set(['unreviewed', 'approved']));
    const held = await store.queryMemory({ ownerId: 'owner', purpose: 'list', reviewStatus: 'held', now, limit: 12 });
    assert.deepEqual(ids(held.rows), ['held']);
    const rejected = await store.queryMemory({ ownerId: 'owner', purpose: 'list', reviewStatus: 'rejected', now, limit: 12 });
    assert.deepEqual(ids(rejected.rows), ['rejected']);
  });

  contract('memory outside its validity window is hidden unless expired rows are requested', async (harness) => {
    const store = await harness.open();
    await store.create('memory', 'owner', memory('parser notes', { validFrom: current }), 'starting-now');
    await store.create('memory', 'owner', memory('parser notes', { validFrom: '2026-09-27T12:00:00.001Z' }), 'future');
    await store.create('memory', 'owner', memory('parser notes', { validTo: current }), 'ending-now');
    await store.create('memory', 'owner', memory('parser notes', { validTo: '2026-09-27T12:00:00.001Z' }), 'ending-later');
    const relevant = await store.queryMemory({
      ownerId: 'owner', purpose: 'relevant', context: { scope: 'private', conversationId: 'chat', prompt: 'parser notes' }, now, limit: 12,
    });
    assert.deepEqual(new Set(ids(relevant.rows)), new Set(['starting-now', 'ending-later']));
    const listed = await store.queryMemory({ ownerId: 'owner', purpose: 'list', now, limit: 12 });
    assert.deepEqual(new Set(ids(listed.rows)), new Set(['starting-now', 'ending-later']));
    const everything = await store.queryMemory({ ownerId: 'owner', purpose: 'list', includeExpired: true, now, limit: 12 });
    assert.deepEqual(new Set(ids(everything.rows)), new Set(['starting-now', 'future', 'ending-now', 'ending-later']));
  });

  contract('memory validity compares ISO timestamps as instants', async (harness) => {
    const store = await harness.open();
    await store.create('memory', 'owner', memory('parser notes', { validFrom: '2026-09-27T12:00:00Z' }), 'started');
    await store.create('memory', 'owner', memory('parser notes', { validTo: '2026-09-27T12:00:00Z' }), 'expired');
    const queryNow = Date.parse('2026-09-27T12:00:00.500Z');
    const relevant = await store.queryMemory({
      ownerId: 'owner', purpose: 'relevant', context: { scope: 'private', conversationId: 'chat', prompt: 'parser notes' }, now: queryNow, limit: 12,
    });
    assert.deepEqual(ids(relevant.rows), ['started']);
    const listed = await store.queryMemory({ ownerId: 'owner', purpose: 'list', now: queryNow, limit: 12 });
    assert.deepEqual(ids(listed.rows), ['started']);
  });

  contract('malformed memory validity does not fail or enter active results', async (harness) => {
    const store = await harness.open();
    await store.create('memory', 'owner', memory('parser notes'), 'valid');
    await store.create('memory', 'owner', memory('parser notes', { validFrom: '2000-02-29T00:00:00Z' }), 'valid-leap-day');
    await store.create('memory', 'owner', memory('parser notes', { validFrom: 'not-a-time' }), 'invalid-from');
    await store.create('memory', 'owner', memory('parser notes', { validTo: 'not-a-time' }), 'invalid-to');
    await store.create('memory', 'owner', memory('parser notes', { validFrom: '2026-02-30T00:00:00Z' }), 'invalid-day');
    await store.create('memory', 'owner', memory('parser notes', { validFrom: '1900-02-29T00:00:00Z' }), 'invalid-leap-day');
    await store.create('memory', 'owner', memory('parser notes', { validFrom: '0000-01-01T00:00:00Z' }), 'invalid-year');
    await store.create('memory', 'owner', memory('parser notes', { validFrom: '2026-01-01T24:00:00Z' }), 'invalid-hour');
    await store.create('memory', 'owner', memory('parser notes', { validFrom: null as unknown as string }), 'invalid-null');
    await store.create('memory', 'owner', memory('parser notes', { validTo: 123 as unknown as string }), 'invalid-number');
    const relevant = await store.queryMemory({
      ownerId: 'owner', purpose: 'relevant', context: { scope: 'private', conversationId: 'chat', prompt: 'parser notes' }, now, limit: 12,
    });
    assert.deepEqual(new Set(ids(relevant.rows)), new Set(['valid', 'valid-leap-day']));
    const listed = await store.queryMemory({ ownerId: 'owner', purpose: 'list', now, limit: 12 });
    assert.deepEqual(new Set(ids(listed.rows)), new Set(['valid', 'valid-leap-day']));
    const recovery = await store.queryMemory({ ownerId: 'owner', purpose: 'list', includeExpired: true, now, limit: 12 });
    assert.deepEqual(new Set(ids(recovery.rows)), new Set([
      'valid', 'valid-leap-day', 'invalid-from', 'invalid-to', 'invalid-day', 'invalid-leap-day', 'invalid-year', 'invalid-hour',
      'invalid-null', 'invalid-number',
    ]));
  });

  contract('memory list filters by scope and scope id and never crosses owners', async (harness) => {
    const store = await harness.open();
    await store.create('memory', 'owner', memory('private note'), 'private');
    await store.create('memory', 'owner', memory('workspace one', { scope: 'workspace', scopeId: 'workspace-1' }), 'workspace-1');
    await store.create('memory', 'owner', memory('workspace two', { scope: 'workspace', scopeId: 'workspace-2' }), 'workspace-2');
    await store.create('memory', 'other-owner', memory('private note of another owner'), 'isolated');
    const list = async (filters: { ownerId?: string; scope?: Memory['scope']; scopeId?: string }): Promise<Set<string>> => new Set(ids((await store.queryMemory({
      ownerId: 'owner', purpose: 'list', now, limit: 12, ...filters,
    })).rows));
    assert.deepEqual(await list({}), new Set(['private', 'workspace-1', 'workspace-2']));
    assert.deepEqual(await list({ scope: 'workspace' }), new Set(['workspace-1', 'workspace-2']));
    assert.deepEqual(await list({ scope: 'workspace', scopeId: 'workspace-2' }), new Set(['workspace-2']));
    assert.deepEqual(await list({ scope: 'group' }), new Set());
    assert.deepEqual(await list({ ownerId: 'other-owner' }), new Set(['isolated']));
    assert.deepEqual(await list({ ownerId: 'nobody' }), new Set());
  });

  contract('memory list pages through every match exactly once in a stable order', async (harness) => {
    const store = await harness.open();
    for (let index = 0; index < 7; index += 1) await store.create('memory', 'owner', memory(`海事專案來源 ${index}`), `memory-${index}`);
    await store.create('memory', 'owner', memory('無關內容。'), 'unrelated');
    await store.create('memory', 'other-owner', memory('海事專案不可見。'), 'isolated');
    const paged: string[] = [];
    let pages = 0;
    let cursor: string | undefined;
    do {
      const page = await store.queryMemory({
        ownerId: 'owner', purpose: 'list', q: '海事專案', scope: 'private', now, limit: 2, ...(cursor ? { cursor } : {}),
      });
      assert.ok(page.rows.length <= 2);
      paged.push(...ids(page.rows));
      cursor = page.nextCursor;
      pages += 1;
    } while (cursor && pages < 10);
    assert.equal(pages, 4);
    assert.deepEqual([...paged].sort(), ['memory-0', 'memory-1', 'memory-2', 'memory-3', 'memory-4', 'memory-5', 'memory-6']);
    const whole = await store.queryMemory({ ownerId: 'owner', purpose: 'list', q: '海事專案', scope: 'private', now, limit: 100 });
    assert.equal(whole.nextCursor, undefined);
    assert.deepEqual(paged, ids(whole.rows));
  });

  contract('memory list without a query returns the most recently written rows first', async (harness) => {
    const store = await harness.open();
    const first = await store.create('memory', 'owner', memory('first'), 'first');
    await delay(5);
    await store.create('memory', 'owner', memory('second'), 'second');
    await delay(5);
    await store.create('memory', 'owner', memory('third'), 'third');
    assert.deepEqual(ids((await store.queryMemory({ ownerId: 'owner', purpose: 'list', now, limit: 12 })).rows), ['third', 'second', 'first']);
    await delay(5);
    await store.put('memory', 'first', 'owner', memory('first, edited'), first.revision);
    assert.deepEqual(ids((await store.queryMemory({ ownerId: 'owner', purpose: 'list', now, limit: 12 })).rows), ['first', 'third', 'second']);
  });

  contract('memory search terms are literal text, not patterns', async (harness) => {
    const store = await harness.open();
    await store.create('memory', 'owner', memory('discount is 100% today'), 'percent');
    await store.create('memory', 'owner', memory('snake_case naming'), 'underscore');
    await store.create('memory', 'owner', memory('nothing special here'), 'plain');
    const search = async (q: string): Promise<string[]> => ids((await store.queryMemory({ ownerId: 'owner', purpose: 'list', q, now, limit: 12 })).rows);
    assert.deepEqual(await search('%'), ['percent']);
    assert.deepEqual(await search('_'), ['underscore']);
    assert.deepEqual(await search('NOTHING'), ['plain']);
    assert.deepEqual(await search('absent'), []);
  });

  contract('memory limits are bounded and malformed cursors are rejected', async (harness) => {
    const store = await harness.open();
    for (let index = 0; index < 13; index += 1) {
      await store.create('memory', 'owner', memory(`note ${index}`), `memory-${String(index).padStart(2, '0')}`);
    }
    const zero = await store.queryMemory({ ownerId: 'owner', purpose: 'list', now, limit: 0 });
    assert.equal(zero.rows.length, 1);
    assert.ok(zero.nextCursor);
    const fractional = await store.queryMemory({ ownerId: 'owner', purpose: 'list', now, limit: 2.5 });
    assert.equal(fractional.rows.length, 12);
    assert.ok(fractional.nextCursor);
    const huge = await store.queryMemory({ ownerId: 'owner', purpose: 'list', now, limit: 1000 });
    assert.equal(huge.rows.length, 13);
    assert.equal(huge.nextCursor, undefined);
    const relevant = await store.queryMemory({
      ownerId: 'owner', purpose: 'relevant', context: { scope: 'private', conversationId: 'chat', prompt: 'note' }, now, limit: 0,
    });
    assert.equal(relevant.rows.length, 1);
    await assert.rejects(store.queryMemory({ ownerId: 'owner', purpose: 'list', now, limit: 2, cursor: 'broken' }), domainError('invalid_cursor', 400));
    const withoutId = Buffer.from(JSON.stringify({ score: 0, updatedAt: current })).toString('base64url');
    await assert.rejects(store.queryMemory({ ownerId: 'owner', purpose: 'list', now, limit: 2, cursor: withoutId }), domainError('invalid_cursor', 400));
  });
}
