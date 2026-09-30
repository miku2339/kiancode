import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { bootstrap } from '../src/bootstrap.js';
import { configSchema } from '../src/config.js';
import type { Memory } from '../src/domain.js';
import { listMemoryRows, type MemoryQuery } from '../src/memory-query.js';
import { PostgresStore } from '../src/storage/postgres.js';
import { SqliteStore } from '../src/storage/sqlite.js';

test('memory pagination still uses the database query after startup storage recovery', async (context) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'kiancode-memory-recovery-'));
  const token = 'memory-recovery-test-token-at-least-thirty-two-characters';
  const environment = {
    KIANCODE_MEMORY_RECOVERY_DATABASE: 'postgres://unavailable-at-startup',
    KIANCODE_MEMORY_RECOVERY_TOKEN: token,
    KIANCODE_MEMORY_RECOVERY_KEY: randomBytes(32).toString('base64'),
  };
  const previous = new Map(Object.keys(environment).map((key) => [key, process.env[key]]));
  Object.assign(process.env, environment);
  const backing = new SqliteStore();
  const row = await backing.create<Memory>('memory', 'local-owner', {
    type: 'preference', text: '使用繁體中文', scope: 'private', source: 'test:recovery',
    validFrom: '2026-01-01T00:00:00.000Z',
  });
  const queries: MemoryQuery[] = [];
  const originalScan = backing.scan.bind(backing);
  backing.scan = async (kind, ownerId) => {
    assert.notEqual(kind, 'memory', 'recovered requests must not scan the entire memory history');
    return originalScan(kind, ownerId);
  };
  const recovered = Object.assign(backing, {
    async queryMemory(query: MemoryQuery) {
      queries.push(query);
      assert.equal(query.purpose, 'list');
      return listMemoryRows([row], query as Extract<MemoryQuery, { purpose: 'list' }>);
    },
  });
  let connects = 0;
  context.mock.method(PostgresStore, 'connect', async () => {
    if (++connects === 1) throw new Error('NAS is offline at startup');
    return recovered as unknown as PostgresStore;
  });
  let application: Awaited<ReturnType<typeof bootstrap>> | undefined;
  try {
    application = await bootstrap(configSchema.parse({
      stateDirectory: path.join(directory, 'state'),
      database: { urlEnv: 'KIANCODE_MEMORY_RECOVERY_DATABASE' },
      auth: { developmentTokenEnv: 'KIANCODE_MEMORY_RECOVERY_TOKEN' },
      attachments: { localDirectory: path.join(directory, 'attachments') },
      outage: { directory: path.join(directory, 'outage'), keyEnv: 'KIANCODE_MEMORY_RECOVERY_KEY' },
    }));
    const response = await application.app.inject({
      method: 'GET', url: '/v1/memories?limit=1', headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(response.statusCode, 200, response.body);
    assert.equal(queries.length, 1);
    assert.equal(queries[0]?.ownerId, 'local-owner');
    assert.equal(queries[0]?.limit, 1);
    assert.match(response.body, /使用繁體中文/);
    assert.equal(connects, 2);
  } finally {
    if (application) await application.close();
    else await backing.close();
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await rm(directory, { recursive: true, force: true });
  }
});
