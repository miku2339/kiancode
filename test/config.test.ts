import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { ZodError } from 'zod';
import { bootstrap } from '../src/bootstrap.js';
import { configSchema, requireOwnerSubject } from '../src/config.js';
import { PostgresStore } from '../src/storage/postgres.js';

test('runtime state paths default to writable deployment locations', () => {
  const development = configSchema.parse({});
  assert.equal(development.stateDirectory, '.runtime');
  assert.equal(development.checkpointDirectory, '.runtime/checkpoints');
  assert.deepEqual(development.automations, {
    eventTriggersEnabled: false,
    schedulerEnabled: false,
  });

  const production = configSchema.parse({
    mode: 'production',
    auth: { mode: 'account', issuer: 'https://account.example.com' },
    attachments: { url: 'https://storage.example.com' },
  });
  assert.equal(production.stateDirectory, '/var/lib/kiancode');
  assert.equal(production.checkpointDirectory, '/var/lib/kiancode/checkpoints');
});

test('runtime budgets use strict bounded defaults and accept partial operator overrides', () => {
  assert.deepEqual(configSchema.parse({}).runtime.budgets, {
    task: { maxCalls: 20, maxTokens: 100_000 },
    delegation: { maxCalls: 24, maxTokens: 128_000 },
  });
  assert.deepEqual(configSchema.parse({
    runtime: { budgets: { task: { maxTokens: 400_000 } } },
  }).runtime.budgets, {
    task: { maxCalls: 20, maxTokens: 400_000 },
    delegation: { maxCalls: 24, maxTokens: 128_000 },
  });
  for (const runtime of [
    { budgets: { task: { maxCalls: 0 } } },
    { budgets: { task: { maxCalls: 501 } } },
    { budgets: { delegation: { maxTokens: 0 } } },
    { budgets: { delegation: { maxTokens: 20_000_001 } } },
    { budgets: { task: { maxCalls: 1.5 } } },
    { budgets: { task: { maxTokens: '100000' } } },
    { budgets: { task: { maxToken: 100_000 } } },
    { budgets: { tasks: {} } },
    { budget: {} },
  ]) {
    assert.throws(() => configSchema.parse({ runtime }), ZodError);
  }
});

test('production rejects relative state paths', () => {
  assert.throws(() => configSchema.parse({
    mode: 'production',
    stateDirectory: '.runtime',
    auth: { mode: 'account', issuer: 'https://account.example.com' },
    attachments: { url: 'https://storage.example.com' },
  }), /absolute paths/);
});

test('account API endpoint permits loopback HTTP and rejects unsafe origins', () => {
  const local = configSchema.parse({
    auth: {
      mode: 'account',
      issuer: 'https://identity.example',
      accountApiUrl: 'http://127.0.0.1:8787',
    },
  });
  assert.equal(local.auth.issuer, 'https://identity.example');
  assert.equal(local.auth.accountApiUrl, 'http://127.0.0.1:8787');

  assert.throws(() => configSchema.parse({
    auth: {
      mode: 'account',
      issuer: 'https://identity.example',
      accountApiUrl: 'http://account-api.example',
    },
  }), /HTTPS or loopback HTTP/);
  assert.throws(() => configSchema.parse({
    auth: {
      mode: 'account',
      issuer: 'https://identity.example',
      accountApiUrl: 'https://user:secret@account-api.example',
    },
  }), /must not include user information/);
});

test('provider timeouts are bounded and apply only to network providers', () => {
  const config = configSchema.parse({
    providers: [{
      id: 'cloud',
      type: 'openai-compatible',
      locality: 'cloud',
      baseUrl: 'https://models.example/v1',
      timeoutMs: 120_000,
    }],
  });
  assert.equal(config.providers[0]?.timeoutMs, 120_000);
  for (const timeoutMs of [999, 120_001]) {
    assert.throws(() => configSchema.parse({
      providers: [{
        id: 'cloud',
        type: 'openai-compatible',
        locality: 'cloud',
        baseUrl: 'https://models.example/v1',
        timeoutMs,
      }],
    }), ZodError);
  }
  assert.throws(() => configSchema.parse({
    providers: [{ id: 'device', type: 'device', locality: 'local', timeoutMs: 60_000 }],
  }), ZodError);
});

test('terminal credentials require explicit environment references', () => {
  const config = configSchema.parse({
    terminal: { environmentEnv: { GITHUB_TOKEN: 'KIANCODE_TOOL_GITHUB_TOKEN' } },
  });
  assert.deepEqual(config.terminal.environmentEnv, { GITHUB_TOKEN: 'KIANCODE_TOOL_GITHUB_TOKEN' });
  assert.throws(() => configSchema.parse({
    terminal: { environmentEnv: { 'invalid-name': 'SECRET' } },
  }));
  assert.throws(() => configSchema.parse({
    terminal: { environmentEnv: { HOME: 'KIANCODE_TOOL_HOME' } },
  }), /HOME is reserved/);
});

test('Bubblewrap configuration is explicit and cannot mount host credential paths', () => {
  const config = configSchema.parse({
    terminal: {
      isolation: 'bubblewrap',
      binary: '/usr/bin/bwrap',
      readOnlyPaths: ['/usr', '/opt/node'],
      allowNetwork: false,
    },
  });
  assert.equal(config.terminal.isolation, 'bubblewrap');
  assert.equal(config.terminal.binary, '/usr/bin/bwrap');
  assert.throws(() => configSchema.parse({
    terminal: { isolation: 'bubblewrap' },
  }), /absolute binary path/);
  assert.throws(() => configSchema.parse({
    terminal: {
      isolation: 'bubblewrap',
      binary: '/usr/bin/bwrap',
      readOnlyPaths: ['/var/lib/credentials'],
    },
  }), /system or \/opt paths/);
  assert.throws(() => configSchema.parse({
    mode: 'production',
    auth: { mode: 'account', issuer: 'https://account.example.com' },
    attachments: { url: 'https://storage.example.com' },
    serverWorkspaceRoots: ['/srv/kiancode/workspaces'],
  }), /require Bubblewrap/);
});

test('plugin subprocesses require fixed operator command profiles', () => {
  const config = configSchema.parse({
    plugins: {
      allowedCommands: ['/usr/bin/node'],
      commandProfiles: [{
        id: 'reviewer',
        command: '/usr/bin/node',
        args: ['/opt/plugins/reviewer.mjs'],
        cwd: '/opt/plugins',
        environmentEnv: { API_TOKEN: 'KIANCODE_PLUGIN_REVIEWER_API_TOKEN' },
      }],
    },
  });
  assert.deepEqual(config.plugins.commandProfiles[0], {
    id: 'reviewer',
    command: '/usr/bin/node',
    args: ['/opt/plugins/reviewer.mjs'],
    cwd: '/opt/plugins',
    environmentEnv: { API_TOKEN: 'KIANCODE_PLUGIN_REVIEWER_API_TOKEN' },
  });
  assert.throws(() => configSchema.parse({
    plugins: {
      commandProfiles: [
        { id: 'duplicate', command: '/usr/bin/true' },
        { id: 'duplicate', command: '/usr/bin/false' },
      ],
    },
  }), /must be unique/);
});

test('auth.levelCeilings defaults to no overrides and accepts non-owner levels', () => {
  assert.deepEqual(configSchema.parse({}).auth.levelCeilings, {});
  const config = configSchema.parse({
    auth: { levelCeilings: { 2: [], 3: ['chat:*'], 5: ['chat:read', 'mcp:MyPlugin'] } },
  });
  assert.deepEqual(config.auth.levelCeilings, {
    2: [], 3: ['chat:*'], 5: ['chat:read', 'mcp:MyPlugin'],
  });
});

test('auth.levelCeilings rejects unknown levels and malformed scope lists', () => {
  const rejected: unknown[] = [
    { 1: ['chat:read'] },
    { 6: ['chat:read'] },
    { 2: 'chat:read' },
    { 2: [''] },
    { 2: ['chat: read'] },
    { 2: [7] },
    { 2: ['x'.repeat(101)] },
    { 2: Array.from({ length: 101 }, (_, index) => `chat:${index}`) },
  ];
  for (const levelCeilings of rejected) {
    assert.throws(
      () => configSchema.parse({ auth: { levelCeilings } }),
      (error: unknown) => error instanceof ZodError,
    );
  }
});

function productionConfig(
  mode: 'account' | 'oidc',
  ownerSubjectEnv = 'CUSTOM_OWNER_SUBJECT',
  databaseUrlEnv = 'DATABASE_URL',
) {
  return configSchema.parse({
    mode: 'production',
    database: { urlEnv: databaseUrlEnv },
    auth: {
      mode,
      issuer: 'https://account.example.com',
      ...(mode === 'oidc' ? { jwksUri: 'https://account.example.com/jwks' } : {}),
      ownerSubjectEnv,
    },
    attachments: { url: 'https://storage.example.com' },
  });
}

test('production Account requires the raw acct subject rather than a principal hash', () => {
  const config = productionConfig('account');
  const valid = `acct_${'0'.repeat(32)}`;
  assert.equal(requireOwnerSubject(config, { CUSTOM_OWNER_SUBJECT: valid }), valid);
  for (const value of [
    undefined, '', '   ', ` ${valid}`, `${valid}\n`, '0'.repeat(64), `acct_${'A'.repeat(32)}`, 'opaque-user',
  ]) {
    assert.throws(
      () => requireOwnerSubject(config, value === undefined ? {} : { CUSTOM_OWNER_SUBJECT: value }),
      (error: unknown) => error instanceof Error
        && error.message === 'Production requires the owner subject in CUSTOM_OWNER_SUBJECT',
    );
  }
});

test('production OIDC preserves a valid raw sub and rejects empty, padded, or controlled values', () => {
  const config = productionConfig('oidc');
  for (const value of ['opaque-user-42', 'tenant user']) {
    assert.equal(requireOwnerSubject(config, { CUSTOM_OWNER_SUBJECT: value }), value);
  }
  for (const value of ['', ' ', ' padded', 'padded ', 'opaque\0user', 'opaque\nuser', 'x'.repeat(256)]) {
    assert.throws(() => requireOwnerSubject(config, { CUSTOM_OWNER_SUBJECT: value }), /CUSTOM_OWNER_SUBJECT$/);
  }
});

test('owner subject remains optional and verbatim outside production', () => {
  const config = configSchema.parse({ auth: { mode: 'account', issuer: 'https://account.example.com' } });
  assert.equal(requireOwnerSubject(config, {}), undefined);
  assert.equal(requireOwnerSubject(config, { KIANCODE_OWNER_SUBJECT: ' raw value ' }), ' raw value ');
});

test('bootstrap validates the production owner before touching PostgreSQL', async (context) => {
  const ownerEnv = 'KIANCODE_CONFIG_TEST_OWNER_SUBJECT';
  const databaseEnv = 'KIANCODE_CONFIG_TEST_DATABASE_URL';
  const previousOwner = process.env[ownerEnv];
  const previousDatabase = process.env[databaseEnv];
  const connect = context.mock.method(PostgresStore, 'connect', async () => {
    throw new Error('database connection attempted');
  });
  try {
    delete process.env[ownerEnv];
    process.env[databaseEnv] = 'postgres://unused';
    await assert.rejects(
      bootstrap(productionConfig('account', ownerEnv, databaseEnv)),
      { message: `Production requires the owner subject in ${ownerEnv}` },
    );
    assert.equal(connect.mock.callCount(), 0);

    process.env[ownerEnv] = `acct_${'0'.repeat(32)}`;
    await assert.rejects(bootstrap(productionConfig('account', ownerEnv, databaseEnv)), {
      message: 'database connection attempted',
    });
    assert.equal(connect.mock.callCount(), 1);
  } finally {
    if (previousOwner === undefined) delete process.env[ownerEnv];
    else process.env[ownerEnv] = previousOwner;
    if (previousDatabase === undefined) delete process.env[databaseEnv];
    else process.env[databaseEnv] = previousDatabase;
  }
});

test('config-check enforces the same production owner validation', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'kiancode-config-check-'));
  const ownerEnv = 'KIANCODE_CONFIG_CHECK_OWNER_SUBJECT';
  const file = path.join(directory, 'production.json');
  const repositoryRoot = fileURLToPath(new URL('..', import.meta.url));
  const run = promisify(execFile);
  const env = { ...process.env };
  delete env[ownerEnv];
  try {
    await writeFile(file, JSON.stringify({
      mode: 'production',
      auth: { mode: 'account', issuer: 'https://account.example.com', ownerSubjectEnv: ownerEnv },
      attachments: { url: 'https://storage.example.com' },
    }));
    await assert.rejects(
      run(process.execPath, ['--import', 'tsx', 'src/cli.ts', 'config-check', '--config', file], {
        cwd: repositoryRoot,
        env,
      }),
      (error: unknown) => {
        const failure = error as { code?: unknown; stdout?: string; stderr?: string };
        return failure.code === 1 && failure.stdout === ''
          && (failure.stderr ?? '').trim() === `Production requires the owner subject in ${ownerEnv}`;
      },
    );
    const passed = await run(process.execPath, ['--import', 'tsx', 'src/cli.ts', 'config-check', '--config', file], {
      cwd: repositoryRoot,
      env: { ...env, [ownerEnv]: `acct_${'0'.repeat(32)}` },
    });
    assert.equal(passed.stdout, 'Configuration valid\n');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
