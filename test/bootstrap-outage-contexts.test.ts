import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { bootstrap } from '../src/bootstrap.js';
import { configSchema } from '../src/config.js';
import { OutageService, tokenHash, type OutageContext } from '../src/outage/index.js';

test('bootstrap prunes expired outage contexts at startup and on its existing recovery interval', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'kiancode-bootstrap-outage-'));
  const tokenName = 'KIANCODE_BOOTSTRAP_OUTAGE_TEST_TOKEN';
  const keyName = 'KIANCODE_BOOTSTRAP_OUTAGE_TEST_KEY';
  const databaseName = 'KIANCODE_BOOTSTRAP_OUTAGE_TEST_DATABASE';
  const previous = new Map([tokenName, keyName, databaseName].map((name) => [name, process.env[name]]));
  const key = randomBytes(32);
  process.env[tokenName] = 'bootstrap-outage-token-at-least-thirty-two-characters';
  process.env[keyName] = key.toString('hex');
  delete process.env[databaseName];
  const outageDirectory = path.join(directory, 'outage');
  const past = Date.now() - 2_000;
  let application: Awaited<ReturnType<typeof bootstrap>> | undefined;
  try {
    const initial = new OutageService({ directory: outageDirectory, key, now: () => past,
      simpleChat: async () => { throw new Error('No model call expected'); } });
    await initial.cacheContext(cachedContext(past + 1_000));
    application = await bootstrap(configSchema.parse({
      stateDirectory: path.join(directory, 'state'),
      database: { urlEnv: databaseName, sqlitePath: path.join(directory, 'core.sqlite') },
      auth: { developmentTokenEnv: tokenName },
      attachments: { localDirectory: path.join(directory, 'attachments') },
      outage: { directory: outageDirectory, keyEnv: keyName, reconcileIntervalSeconds: 1 },
    }));
    assert.ok(application.outage);
    await waitForEmpty(application.outage);
    await application.outage.cacheContext(cachedContext(Date.now() + 50));
    assert.ok((await application.outage.stats()).bytesUsed > 0);
    await waitForEmpty(application.outage);
    const health = await application.app.inject({ method: 'GET', url: '/health/ready' });
    assert.equal(health.statusCode, 200);
    assert.equal(health.json().status, 'ready');
    assert.equal(health.json().outage.unsyncedRecords, 0);
  } finally {
    await application?.close();
    for (const [name, value] of previous) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    await rm(directory, { recursive: true, force: true });
  }
});

function cachedContext(expiresAt: number): OutageContext {
  return {
    principal: { id: 'local-owner', level: 1, scopes: ['*'] },
    tokenHash: tokenHash('bootstrap-outage-cached-session'),
    sessionExpiresAt: new Date(expiresAt).toISOString(),
    conversation: { id: 'private-chat', ownerId: 'local-owner', title: 'Private', scope: 'private',
      modelPolicy: 'cloud', strategy: 'single', mode: 'ask', privacy: 'standard', archived: false },
    history: [],
  };
}

async function waitForEmpty(outage: OutageService): Promise<void> {
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline) {
    if ((await outage.stats()).bytesUsed === 0) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
  assert.fail('Expired outage context was not pruned by bootstrap');
}
