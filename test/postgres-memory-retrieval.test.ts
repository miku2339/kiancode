import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import test from 'node:test';
import { Pool } from 'pg';
import type { Memory } from '../src/domain.js';
import { PostgresStore } from '../src/storage/postgres.js';

const databaseUrl = process.env.KIANCODE_TEST_DATABASE_URL ?? '';
const skip = databaseUrl ? false : 'KIANCODE_TEST_DATABASE_URL is not set';
const now = Date.parse('2026-09-27T12:00:00.000Z');

function memory(text: string, changes: Partial<Memory> = {}): Memory {
  return {
    type: 'document',
    text,
    scope: 'private',
    source: 'synthetic:postgres-memory-retrieval',
    validFrom: '2026-01-01T00:00:00.000Z',
    ...changes,
  };
}

test('PostgreSQL relevant memory keeps retrieval semantics at production-shaped volume', { skip, timeout: 60_000 }, async () => {
  const schema = `kiancode_test_${randomBytes(16).toString('hex')}`;
  const admin = new Pool({ connectionString: databaseUrl, max: 1, connectionTimeoutMillis: 5_000 });
  let store: PostgresStore | undefined;
  try {
    await admin.query(`CREATE SCHEMA ${schema}`);
    store = await PostgresStore.connect(databaseUrl, { schema });
    const terms = Array.from({ length: 64 }, (_, index) => `probe${String(index).padStart(2, '0')}`);
    await store.create('memory', 'owner', memory('default preference', { type: 'preference' }), 'preference');
    await store.create('memory', 'owner', memory('default persona', { type: 'persona' }), 'persona');
    await store.create('memory', 'owner', memory(terms.slice(0, 3).join(' ')), 'high');
    await store.create('memory', 'owner', memory(terms.slice(0, 4).join(' ')), 'old');
    await store.create('memory', 'owner', memory(terms.slice(0, 2).join(' '), { replacesId: 'old' }), 'replacement');
    await store.create('memory', 'owner', memory(terms[0]!), 'held-target');
    await store.create('memory', 'owner', memory(terms.join(' '), {
      replacesId: 'held-target',
      reviewStatus: 'held',
    }), 'held-replacer');
    await store.create('memory', 'owner', memory(terms[0]!), 'expired-target');
    await store.create('memory', 'owner', memory(terms.join(' '), {
      replacesId: 'expired-target',
      validTo: '2026-09-27T12:00:00.000Z',
    }), 'expired-replacer');
    await store.create('memory', 'owner', memory(terms[0]!), 'tie-a');
    await store.create('memory', 'owner', memory(terms[0]!), 'tie-z');
    await store.create('memory', 'owner', memory(terms[0]!, { scope: 'workspace', scopeId: 'workspace-1' }), 'workspace');
    await store.create('memory', 'owner', memory(terms.join(' '), { scope: 'workspace', scopeId: 'workspace-2' }), 'other-workspace');
    await store.create('memory', 'owner', memory(terms[0]!, { scope: 'agent', scopeId: 'agent-1' }), 'agent');
    await store.create('memory', 'owner', memory(terms.join(' '), { validFrom: 'not-a-time' }), 'invalid');
    await store.create('memory', 'other-owner', memory(terms.join(' ')), 'other-owner');

    await admin.query(`
      INSERT INTO ${schema}.kiancode_entities
        (kind, id, owner_id, revision, created_at, updated_at, data)
      SELECT 'memory', 'load-' || lpad(item::text, 4, '0'), 'owner', 1, NOW(), NOW(),
        jsonb_build_object(
          'type', 'document',
          'text', payload.text,
          'scope', 'private',
          'source', 'synthetic:postgres-memory-retrieval-load',
          'validFrom', '2026-01-01T00:00:00.000Z'
        )
      FROM generate_series(1, 6327) AS item
      CROSS JOIN LATERAL (
        SELECT string_agg(md5(item::text || ':' || part::text), '' ORDER BY part) AS text
        FROM generate_series(1, 120) AS part
      ) payload
    `);
    await admin.query(`
      UPDATE ${schema}.kiancode_entities
      SET updated_at = '2026-09-27T11:00:00.000Z'::timestamptz
      WHERE kind = 'memory' AND owner_id = 'owner' AND id NOT LIKE 'load-%'
    `);

    const started = performance.now();
    const page = await store.queryMemory({
      ownerId: 'owner',
      purpose: 'relevant',
      context: {
        scope: 'private',
        conversationId: 'private-conversation',
        workspaceId: 'workspace-1',
        agentId: 'agent-1',
        prompt: terms.join(' '),
      },
      now,
      limit: 12,
    });
    const elapsed = performance.now() - started;

    assert.deepEqual(page.rows.map((row) => row.id), [
      'preference',
      'persona',
      'high',
      'replacement',
      'workspace',
      'tie-z',
      'tie-a',
      'held-target',
      'expired-target',
      'agent',
    ]);
    assert.equal(page.rows.find((row) => row.id === 'high')?.data.text, terms.slice(0, 3).join(' '));
    assert.ok(elapsed < 10_000, `Relevant memory query took ${Math.round(elapsed)} ms`);
  } finally {
    await store?.close();
    try {
      await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    } finally {
      await admin.end();
    }
  }
});
