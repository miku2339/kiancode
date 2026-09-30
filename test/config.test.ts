import assert from 'node:assert/strict';
import test from 'node:test';
import { configSchema } from '../src/config.js';

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
