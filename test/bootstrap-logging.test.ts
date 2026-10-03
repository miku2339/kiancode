import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { bootstrap } from '../src/bootstrap.js';
import { configSchema } from '../src/config.js';

test('bootstrap enables the server logger at warn level', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'kiancode-bootstrap-logging-'));
  const tokenName = 'KIANCODE_BOOTSTRAP_LOGGING_TEST_TOKEN';
  const previousToken = process.env[tokenName];
  process.env[tokenName] = 'test-owner-token-with-at-least-thirty-two-characters';
  let server: Awaited<ReturnType<typeof bootstrap>> | undefined;
  try {
    server = await bootstrap(configSchema.parse({
      stateDirectory: path.join(directory, 'state'),
      checkpointDirectory: path.join(directory, 'checkpoints'),
      database: { sqlitePath: path.join(directory, 'core.sqlite') },
      auth: { developmentTokenEnv: tokenName },
      attachments: { localDirectory: path.join(directory, 'attachments') },
    }));
    assert.equal(server.app.log.level, 'warn');
  } finally {
    await server?.close();
    if (previousToken === undefined) delete process.env[tokenName];
    else process.env[tokenName] = previousToken;
    await rm(directory, { recursive: true, force: true });
  }
});
