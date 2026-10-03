import assert from 'node:assert/strict';
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { bootstrap } from '../src/bootstrap.js';
import { configSchema } from '../src/config.js';
import type { Task } from '../src/domain.js';
import type { WorkspaceWriteLeaseRecord } from '../src/workspace-write-lease.js';

const tokenEnv = 'KIANCODE_BOOTSTRAP_SERVER_TOOLS_TEST_TOKEN';
const token = 'bootstrap-server-tools-test-token-with-thirty-two-characters';
const headers = { authorization: `Bearer ${token}` };

test('a server workspace the wrapper refuses ends the operation failed and leaves the workspace writable', async () => {
  const directory = await realpath(await mkdtemp(path.join(tmpdir(), 'kiancode-bootstrap-server-tools-')));
  const root = path.join(directory, 'root');
  await mkdir(path.join(root, 'inside'), { recursive: true });
  await mkdir(path.join(directory, 'outside'));
  const priorToken = process.env[tokenEnv];
  process.env[tokenEnv] = token;
  const server = await bootstrap(configSchema.parse({
    mode: 'development',
    stateDirectory: path.join(directory, 'state'),
    checkpointDirectory: path.join(directory, 'checkpoints'),
    database: { sqlitePath: path.join(directory, 'core.sqlite') },
    auth: { developmentTokenEnv: tokenEnv },
    serverWorkspaceRoots: [root],
    attachments: { localDirectory: path.join(directory, 'attachments') },
  }));
  const run = async (name: string, workspaceRoot: string): Promise<{ task: Task; lease?: WorkspaceWriteLeaseRecord }> => {
    const workspace = await server.store.create('workspace', 'local-owner', {
      name, root: workspaceRoot, deviceId: 'server', capabilities: ['shell:execute'], allowCloud: false,
    });
    const started = await server.app.inject({
      method: 'POST',
      url: `/v1/workspaces/${workspace.id}/operations`,
      headers,
      payload: { tool: 'terminal.run', input: { command: 'printf ok', shell: '/bin/sh' }, requestId: `run-${name}` },
    });
    assert.equal(started.statusCode, 202, started.body);
    await server.tasks.drain();
    const task = (await server.store.get<Task>('task', started.json().data.id as string, 'local-owner'))!.data;
    const lease = (await server.store.scan<WorkspaceWriteLeaseRecord>('workspace_write_lease', 'local-owner'))
      .find((row) => row.data.workspaceId === workspace.id)?.data;
    return { task, ...(lease ? { lease } : {}) };
  };
  try {
    const outside = await run('outside', path.join(directory, 'outside'));
    assert.equal(outside.task.state, 'failed');
    assert.equal(outside.task.error, 'Workspace is outside configured server roots');
    assert.equal(outside.lease?.state, 'released');

    const missing = await run('missing', path.join(root, 'missing'));
    assert.equal(missing.task.state, 'failed');
    assert.equal(missing.task.error, 'Workspace root is unavailable');
    assert.equal(missing.lease?.state, 'released');

    const inside = await run('inside', path.join(root, 'inside'));
    assert.equal(inside.task.state, 'completed', inside.task.error);
    assert.equal(JSON.parse(inside.task.result!).stdout, 'ok');
    assert.equal(inside.lease?.state, 'released');
  } finally {
    await server.close();
    if (priorToken === undefined) delete process.env[tokenEnv];
    else process.env[tokenEnv] = priorToken;
    await rm(directory, { recursive: true, force: true });
  }
});
