import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { Pool } from 'pg';
import { PostgresStore } from '../src/storage/postgres.js';
import { SqliteStore } from '../src/storage/sqlite.js';
import { storeContract, type StoreHarness } from './store-contract.js';

async function sqliteHarness(): Promise<StoreHarness> {
  const directory = await mkdtemp(join(tmpdir(), 'kiancode-store-'));
  const path = join(directory, 'state.sqlite');
  let store: SqliteStore | undefined;
  return {
    async open() {
      await store?.close();
      store = new SqliteStore(path);
      return store;
    },
    async dispose() {
      await store?.close();
      await rm(directory, { recursive: true, force: true });
    },
  };
}

function postgresSkipReason(environment: NodeJS.ProcessEnv): string | false {
  return environment.KIANCODE_TEST_DATABASE_URL ? false : 'KIANCODE_TEST_DATABASE_URL is not set';
}

interface PostgresHarness extends StoreHarness {
  admin: Pool;
  schema: string;
  has(name: string): Promise<boolean>;
}

async function postgresHarness(connectionString: string): Promise<PostgresHarness> {
  const schema = `kiancode_test_${randomBytes(16).toString('hex')}`;
  const admin = new Pool({ connectionString, max: 1, connectionTimeoutMillis: 5000 });
  try {
    await admin.query(`CREATE SCHEMA ${schema}`);
  } catch (error) {
    await admin.end();
    throw error;
  }
  let store: PostgresStore | undefined;
  const has = async (name: string): Promise<boolean> => {
    const result = await admin.query<{ present: boolean }>('SELECT to_regclass($1::text) IS NOT NULL AS present', [`${schema}.${name}`]);
    return result.rows[0]?.present === true;
  };
  return {
    admin,
    schema,
    has,
    async open() {
      const previous = store;
      store = undefined;
      await previous?.close();
      store = await PostgresStore.connect(connectionString, { schema });
      if (!await has('kiancode_entities')) throw new Error('PostgreSQL test isolation failed');
      return store;
    },
    async dispose() {
      try {
        await store?.close();
      } finally {
        try {
          await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
        } finally {
          await admin.end();
        }
      }
    },
  };
}

const postgresUrl = process.env.KIANCODE_TEST_DATABASE_URL ?? '';
const postgresSkip = postgresSkipReason(process.env);

storeContract('SqliteStore', sqliteHarness);
storeContract('PostgresStore', () => postgresHarness(postgresUrl), postgresSkip);

test('PostgreSQL cases are skipped only when KIANCODE_TEST_DATABASE_URL is unset or empty', () => {
  assert.equal(postgresSkipReason({}), 'KIANCODE_TEST_DATABASE_URL is not set');
  assert.equal(postgresSkipReason({ KIANCODE_TEST_DATABASE_URL: '' }), 'KIANCODE_TEST_DATABASE_URL is not set');
  assert.equal(postgresSkipReason({ DATABASE_URL: 'postgresql://production.invalid/database' }), 'KIANCODE_TEST_DATABASE_URL is not set');
  assert.equal(postgresSkipReason({ KIANCODE_TEST_DATABASE_URL: 'postgresql://disposable.invalid/database' }), false);
});

test('an unreachable PostgreSQL database fails the harness instead of skipping', async () => {
  await assert.rejects(postgresHarness('socket:/kiancode-test-no-such-directory?db=unused'), (error: unknown) => {
    const failure = error as NodeJS.ErrnoException & { address?: string };
    return failure.code === 'ENOENT' && failure.address?.startsWith('/kiancode-test-no-such-directory/.s.PGSQL.') === true;
  });
});

test('PostgreSQL: connect bootstraps an isolated table and index and keeps rows across reconnects', { skip: postgresSkip }, async () => {
  const harness = await postgresHarness(postgresUrl);
  try {
    let store = await harness.open();
    assert.equal(await harness.has('kiancode_entities'), true);
    assert.equal(await harness.has('kiancode_entities_owner_kind'), true);
    assert.equal(await harness.has('kiancode_entities_event_task'), true);
    const created = await store.create('note', 'alice', { value: 1 }, 'kept');
    store = await harness.open();
    assert.deepEqual(await store.get('note', 'kept', 'alice'), created);
  } finally {
    await harness.dispose();
  }
});

test('PostgreSQL: connect re-creates a missing owner index without touching rows', { skip: postgresSkip }, async () => {
  const harness = await postgresHarness(postgresUrl);
  try {
    let store = await harness.open();
    const created = await store.create('note', 'alice', { value: 1 }, 'kept');
    await harness.admin.query(`DROP INDEX ${harness.schema}.kiancode_entities_owner_kind`);
    assert.equal(await harness.has('kiancode_entities_owner_kind'), false);
    store = await harness.open();
    assert.equal(await harness.has('kiancode_entities_owner_kind'), true);
    assert.deepEqual(await store.get('note', 'kept', 'alice'), created);
  } finally {
    await harness.dispose();
  }
});

test('PostgreSQL: connect adds a missing task event index to an existing table without touching rows', { skip: postgresSkip }, async () => {
  const harness = await postgresHarness(postgresUrl);
  try {
    let store = await harness.open();
    const created = await store.create('event', 'alice', { taskId: 'task', sequence: 1, type: 'created', payload: {}, at: '2026-09-27T12:00:00.000Z' }, 'task:000000000001');
    await harness.admin.query(`DROP INDEX ${harness.schema}.kiancode_entities_event_task`);
    store = await harness.open();
    assert.equal(await harness.has('kiancode_entities_event_task'), true);
    assert.equal(await harness.has('kiancode_entities_owner_kind'), true);
    assert.deepEqual(await store.taskEvents('alice', 'task'), [created]);
  } finally {
    await harness.dispose();
  }
});

test('PostgreSQL: task event reads can use the task event index instead of scanning the owner', { skip: postgresSkip }, async () => {
  const harness = await postgresHarness(postgresUrl);
  try {
    await harness.open();
    const client = await harness.admin.connect();
    try {
      await client.query(`SET search_path = ${harness.schema}`);
      await client.query('SET enable_seqscan = off');
      await client.query('SET enable_bitmapscan = off');
      const plan = await client.query<{ 'QUERY PLAN': string }>(`EXPLAIN SELECT * FROM kiancode_entities
        WHERE kind='event' AND owner_id=$1 AND data->>'taskId'=$2 AND data->'sequence' > to_jsonb($3::numeric)
        ORDER BY data->'sequence',created_at,id`, ['alice', 'task', 0]);
      assert.match(plan.rows.map((row) => row['QUERY PLAN']).join('\n'), /kiancode_entities_event_task/);
    } finally {
      client.release();
    }
  } finally {
    await harness.dispose();
  }
});

test('PostgreSQL: a disposed case leaves no schema behind', { skip: postgresSkip }, async () => {
  const harness = await postgresHarness(postgresUrl);
  try {
    await harness.open();
  } finally {
    await harness.dispose();
  }
  const check = new Pool({ connectionString: postgresUrl, max: 1, connectionTimeoutMillis: 5000 });
  try {
    const result = await check.query<{ count: string }>('SELECT count(*) AS count FROM pg_namespace WHERE nspname = $1', [harness.schema]);
    assert.equal(Number(result.rows[0]?.count), 0);
  } finally {
    await check.end();
  }
});

test('PostgreSQL: memory paging keeps rows whose timestamps differ only below a millisecond', { skip: postgresSkip }, async () => {
  const harness = await postgresHarness(postgresUrl);
  try {
    const store = await harness.open();
    const data = { type: 'document' as const, text: 'cursor match', scope: 'private' as const, source: 'synthetic:test', validFrom: '2026-01-01T00:00:00.000Z' };
    await store.create('memory', 'owner', data, 'cursor-a');
    await store.create('memory', 'owner', data, 'cursor-z');
    for (const [id, updatedAt] of [['cursor-a', '2026-09-27T12:00:00.123789Z'], ['cursor-z', '2026-09-27T12:00:00.123456Z']]) {
      await harness.admin.query(`UPDATE ${harness.schema}.kiancode_entities SET updated_at = $1::timestamptz WHERE kind = 'memory' AND id = $2`, [updatedAt, id]);
    }
    const now = Date.parse('2026-09-27T12:00:01.000Z');
    const first = await store.queryMemory({ ownerId: 'owner', purpose: 'list', q: 'cursor match', now, limit: 1 });
    assert.deepEqual(first.rows.map((row) => row.id), ['cursor-z']);
    assert.ok(first.nextCursor);
    const second = await store.queryMemory({ ownerId: 'owner', purpose: 'list', q: 'cursor match', now, limit: 1, cursor: first.nextCursor });
    assert.deepEqual(second.rows.map((row) => row.id), ['cursor-a']);
    assert.equal(second.nextCursor, undefined);
  } finally {
    await harness.dispose();
  }
});
