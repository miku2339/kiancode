import assert from 'node:assert/strict';
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import type { Principal } from '../src/contracts.js';
import { createServer } from '../src/http/server.js';
import { PluginService } from '../src/plugins.js';
import { SqliteStore } from '../src/storage/sqlite.js';
import type { Conversation, Task } from '../src/domain.js';
import { TaskService } from '../src/tasks.js';

const principal: Principal = { id: 'owner', level: 1, scopes: ['plugin:manage', 'plugin:use'] };
const member: Principal = { id: 'member', level: 2, scopes: ['plugin:manage', 'plugin:use'] };
const skill = (instructions: string) => ({
  kind: 'skill' as const,
  files: { 'SKILL.md': `---\nname: reviewer\ndescription: Review safely\n---\n${instructions}\n` },
});

test('plugin management requires the owner and rejects visitor-controlled subprocess fields', async () => {
  const store = new SqliteStore();
  const plugins = new PluginService(store, { allowedOrigins: [], allowedCommands: [process.execPath] });
  try {
    await assert.rejects(
      plugins.install(member, 'reviewer', 'Reviewer', skill('Instructions')),
      (error: unknown) => error instanceof Error && 'code' in error && error.code === 'owner_required',
    );
    const installed = await plugins.install(principal, 'reviewer', 'Reviewer', skill('Instructions'));
    await assert.rejects(
      plugins.configure(member, 'reviewer', { enabled: true, revision: installed.revision }),
      (error: unknown) => error instanceof Error && 'code' in error && error.code === 'owner_required',
    );
    await assert.rejects(
      plugins.install(principal, 'unsafe', 'Unsafe', {
        kind: 'mcp',
        server: {
          id: 'unsafe', permission: 'configured', transport: 'stdio', profile: 'trusted',
          command: process.execPath, args: ['/tmp/visitor.mjs'], cwd: '/tmp',
        },
      } as never),
      /Unrecognized keys/,
    );
    await assert.rejects(
      plugins.install(principal, 'legacy', 'Legacy', {
        kind: 'mcp',
        server: { id: 'legacy', permission: 'configured', transport: 'stdio', command: process.execPath },
      } as never),
      /profile/,
    );
  } finally {
    await plugins.close();
    await store.close();
  }
});

test('MCP origin policy is revalidated when a configured plugin is used', async () => {
  const store = new SqliteStore();
  const installer = new PluginService(store, { allowedOrigins: ['https://mcp.example'], commandProfiles: [] });
  const installed = await installer.install(principal, 'remote', 'Remote', {
    kind: 'mcp',
    server: { id: 'remote', permission: 'configured', transport: 'http', url: 'https://mcp.example/api' },
  });
  await installer.configure(principal, 'remote', { enabled: true, revision: installed.revision });
  await installer.close();

  const restricted = new PluginService(store, { allowedOrigins: [], commandProfiles: [] });
  try {
    const tools = restricted.tools().find((tool) => tool.name === 'plugin.tools')!;
    await assert.rejects(
      tools.execute({ pluginId: 'remote', version: installed.data.activeVersion }, {
        principal, taskId: 'task', signal: new AbortController().signal,
        pluginVersions: { remote: installed.data.activeVersion },
      }),
      (error: unknown) => error instanceof Error && 'code' in error && error.code === 'origin_not_allowed',
    );
  } finally {
    await restricted.close();
    await store.close();
  }
});

test('stdio plugins execute only the fixed operator command profile', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'kiancode-plugin-profile-'));
  const serverFile = path.join(directory, 'server.mjs');
  const sdkRoot = path.resolve('node_modules/@modelcontextprotocol/sdk/dist/esm');
  const serverUrl = pathToFileURL(path.join(sdkRoot, 'server/mcp.js')).href;
  const transportUrl = pathToFileURL(path.join(sdkRoot, 'server/stdio.js')).href;
  await writeFile(serverFile, `
import { McpServer } from ${JSON.stringify(serverUrl)};
import { StdioServerTransport } from ${JSON.stringify(transportUrl)};
const server = new McpServer({ name: 'profile-test', version: '1.0.0' });
server.registerTool('identity', { inputSchema: {} }, async () => ({ content: [{
  type: 'text',
  text: [process.argv[2], process.cwd(), process.env.PROFILE_VALUE, process.env.DATABASE_URL ?? 'absent'].join('|'),
}] }));
await server.connect(new StdioServerTransport());
`);
  const store = new SqliteStore();
  const plugins = new PluginService(store, {
    allowedOrigins: [],
    commandProfiles: [{
      id: 'trusted',
      command: process.execPath,
      args: [serverFile, 'fixed-argument'],
      cwd: directory,
      environmentEnv: { PROFILE_VALUE: 'KIANCODE_PLUGIN_PROFILE_VALUE' },
    }],
  });
  const previousProfileValue = process.env.KIANCODE_PLUGIN_PROFILE_VALUE;
  const previousDatabaseUrl = process.env.DATABASE_URL;
  process.env.KIANCODE_PLUGIN_PROFILE_VALUE = 'fixed-environment';
  process.env.DATABASE_URL = 'postgresql://should-not-reach-plugin';
  try {
    const installed = await plugins.install(principal, 'trusted-plugin', 'Trusted plugin', {
      kind: 'mcp',
      server: { id: 'trusted-plugin', permission: 'configured', transport: 'stdio', profile: 'trusted' },
    });
    const enabled = await plugins.configure(principal, 'trusted-plugin', { enabled: true, revision: installed.revision });
    const call = plugins.tools().find((tool) => tool.name === 'plugin.call')!;
    const result = JSON.parse((await call.execute({
      pluginId: 'trusted-plugin', version: enabled.data.activeVersion, tool: 'identity', arguments: {},
    }, {
      principal: { ...principal, scopes: [...principal.scopes, 'mcp:trusted-plugin'] },
      taskId: 'task', signal: new AbortController().signal,
      pluginVersions: { 'trusted-plugin': enabled.data.activeVersion },
    })).content) as { content: Array<{ text: string }> };
    assert.equal(result.content[0]?.text, `fixed-argument|${await realpath(directory)}|fixed-environment|absent`);
    const update = await plugins.install(principal, 'trusted-plugin', 'Trusted plugin', {
      kind: 'mcp',
      server: {
        id: 'trusted-plugin', permission: 'configured', transport: 'stdio', profile: 'trusted', timeoutMs: 2_000,
      },
    });
    const nextVersion = update.data.versions.find((version) => version !== enabled.data.activeVersion)!;
    const activated = await plugins.configure(principal, 'trusted-plugin', {
      version: nextVersion,
      revision: update.revision,
    });
    assert.equal(activated.data.activeVersion, nextVersion);
    assert.equal((await plugins.listVersions(principal, 'trusted-plugin')).length, 2);
  } finally {
    if (previousProfileValue === undefined) delete process.env.KIANCODE_PLUGIN_PROFILE_VALUE;
    else process.env.KIANCODE_PLUGIN_PROFILE_VALUE = previousProfileValue;
    if (previousDatabaseUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = previousDatabaseUrl;
    await plugins.close();
    await store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('plugin HTTP routes enforce owner management and the structured MCP schema', async () => {
  const store = new SqliteStore();
  const plugins = new PluginService(store, {
    allowedOrigins: [],
    commandProfiles: [{ id: 'trusted', command: process.execPath }],
  });
  const server = await createServer({
    store,
    plugins,
    authenticate: async (authorization) => authorization === 'Bearer owner' ? principal : member,
    runner: async () => ({ text: 'unused' }),
  });
  try {
    const nonOwner = await server.app.inject({
      method: 'POST', url: '/v1/plugins/reviewer/versions', headers: { authorization: 'Bearer member' },
      payload: { name: 'Reviewer', content: skill('Instructions') },
    });
    assert.equal(nonOwner.statusCode, 403, nonOwner.body);
    assert.equal(nonOwner.json().error.code, 'owner_required');

    const injected = await server.app.inject({
      method: 'POST', url: '/v1/plugins/unsafe/versions', headers: { authorization: 'Bearer owner' },
      payload: {
        name: 'Unsafe',
        content: {
          kind: 'mcp',
          server: {
            id: 'unsafe', permission: 'configured', transport: 'stdio', profile: 'trusted',
            args: ['/tmp/visitor.mjs'], cwd: '/tmp',
          },
        },
      },
    });
    assert.equal(injected.statusCode, 400, injected.body);
    assert.equal(injected.json().error.code, 'invalid_input');
  } finally {
    await plugins.close();
    await server.close();
  }
});

test('installing a new version does not silently activate an enabled plugin', async () => {
  const store = new SqliteStore();
  const plugins = new PluginService(store, { allowedOrigins: [], allowedCommands: [] });
  try {
    const first = await plugins.install(principal, 'reviewer', 'Reviewer', skill('Version one'));
    const enabled = await plugins.configure(principal, 'reviewer', { enabled: true, revision: first.revision });
    const second = await plugins.install(principal, 'reviewer', 'Reviewer', skill('Version two'));
    assert.equal(second.data.enabled, true);
    assert.equal(second.data.activeVersion, enabled.data.activeVersion);
    assert.equal(second.data.versions.length, 2);

    const read = plugins.tools().find((tool) => tool.name === 'skill.read')!;
    const context = {
      principal,
      taskId: 'task',
      signal: new AbortController().signal,
      pluginVersions: { reviewer: enabled.data.activeVersion },
    };
    assert.match((await read.execute({ pluginId: 'reviewer', version: enabled.data.activeVersion }, context)).content, /Version one/);
    await assert.rejects(
      read.execute({ pluginId: 'reviewer', version: second.data.versions.find((version) => version !== enabled.data.activeVersion)! }, context),
      hasCode('plugin_version_pinned'),
    );
  } finally {
    await plugins.close();
    await store.close();
  }
});

test('tasks pin enabled plugin versions and rollback only affects later tasks', async () => {
  const store = new SqliteStore();
  const plugins = new PluginService(store, { allowedOrigins: [] });
  const tasks = new TaskService(store, async () => ({ text: 'unused' }));
  try {
    const first = await plugins.install(principal, 'reviewer', 'Reviewer', skill('Version one'));
    const enabled = await plugins.configure(principal, 'reviewer', { enabled: true, revision: first.revision });
    const conversation = await store.create<Conversation>('conversation', principal.id, {
      title: 'Pinned plugins', scope: 'private', modelPolicy: 'cloud', strategy: 'single', mode: 'ask', archived: false,
    });
    const oldTask = await tasks.enqueue(principal, conversation.id, 'Use reviewer', 'old-task');
    const second = await plugins.install(principal, 'reviewer', 'Reviewer', skill('Version two'));
    const secondVersion = second.data.versions.find((version) => version !== enabled.data.activeVersion)!;
    const upgraded = await plugins.configure(principal, 'reviewer', { version: secondVersion, revision: second.revision });
    const retried = await tasks.enqueue(principal, conversation.id, 'Use reviewer', 'old-task');
    const newTask = await tasks.enqueue(principal, conversation.id, 'Use reviewer', 'new-task');
    assert.equal(retried.id, oldTask.id);
    assert.equal(oldTask.data.pluginVersions?.reviewer, enabled.data.activeVersion);
    assert.equal(newTask.data.pluginVersions?.reviewer, secondVersion);

    const read = plugins.tools().find((tool) => tool.name === 'skill.read')!;
    assert.match((await read.execute({ pluginId: 'reviewer' }, {
      principal, taskId: oldTask.id, signal: new AbortController().signal, pluginVersions: oldTask.data.pluginVersions,
    })).content, /Version one/);
    await assert.rejects(read.execute({ pluginId: 'reviewer', version: secondVersion }, {
      principal, taskId: oldTask.id, signal: new AbortController().signal, pluginVersions: oldTask.data.pluginVersions,
    }), hasCode('plugin_version_pinned'));

    const rolledBack = await plugins.configure(principal, 'reviewer', {
      version: enabled.data.activeVersion,
      revision: upgraded.revision,
    });
    const afterRollback = await tasks.enqueue(principal, conversation.id, 'Use reviewer', 'rollback-task');
    assert.equal(rolledBack.data.activeVersion, enabled.data.activeVersion);
    assert.equal(afterRollback.data.pluginVersions?.reviewer, enabled.data.activeVersion);
    assert.equal((await store.get<Task>('task', oldTask.id, principal.id))?.data.pluginVersions?.reviewer, enabled.data.activeVersion);
  } finally {
    await tasks.close();
    await plugins.close();
    await store.close();
  }
});

function hasCode(code: string): (error: unknown) => boolean {
  return (error) => error instanceof Error && 'code' in error && error.code === code;
}
