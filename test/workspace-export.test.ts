import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { ArtifactService } from '../src/artifacts.js';
import { developmentAuth } from '../src/auth.js';
import type { Task } from '../src/domain.js';
import { createServer } from '../src/http/server.js';
import { createTaskRunner } from '../src/runtime-adapter.js';
import { LocalBlobStore } from '../src/storage/blobs.js';
import { SqliteStore } from '../src/storage/sqlite.js';
import { createWorkspaceTools } from '../src/tools/workspace.js';

const token = 'workspace-export-development-token-at-least-thirty-two';
const headers = { authorization: `Bearer ${token}` };

test('workspace export operation creates a task-bound artifact without changing the source file', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'kiancode-workspace-export-api-'));
  const root = path.join(directory, 'workspace');
  const source = path.join(root, 'result.md');
  const store = new SqliteStore();
  const artifacts = new ArtifactService(store, new LocalBlobStore(path.join(directory, 'blobs')));
  try {
    await mkdir(root);
    await writeFile(source, '# Deliverable\n');
    const tools = await createWorkspaceTools({
      checkpointDirectory: path.join(directory, 'checkpoints'),
      exportArtifact: async (request) => ({ artifactId: (await artifacts.upload(
        request.ownerId,
        request.name,
        request.mimeType,
        request.bytes,
        `workspace-export:${request.taskId}:${request.sha256}`,
        'tool',
        request.taskId,
      )).id }),
    });
    const server = await createServer({
      store,
      artifacts,
      tools,
      authenticate: developmentAuth(token),
      runner: createTaskRunner(store, { run: async () => { throw new Error('model must not run'); } }, tools, artifacts),
      reauthorize: async (current) => current,
    });
    try {
      const workspace = await store.create('workspace', 'local-owner', {
        name: 'Local', root, deviceId: 'server', capabilities: ['workspace:read', 'workspace:export'], allowCloud: false,
      });
      const started = await server.app.inject({
        method: 'POST',
        url: `/v1/workspaces/${workspace.id}/operations`,
        headers,
        payload: { tool: 'workspace.export', input: { path: 'result.md' }, requestId: 'export-result-1' },
      });
      assert.equal(started.statusCode, 202, started.body);
      await server.tasks.drain();
      const taskId = started.json().data.id as string;
      const waiting = await server.app.inject({ method: 'GET', url: `/v1/tasks/${taskId}`, headers });
      assert.equal(waiting.statusCode, 200, waiting.body);
      const pendingTask = waiting.json().data as { data: Task };
      assert.equal(pendingTask.data.state, 'waiting_for_approval');
      assert.equal(pendingTask.data.resultArtifactIds, undefined);
      assert.equal((await store.scan('artifact', 'local-owner')).length, 0);
      const approved = await server.app.inject({
        method: 'POST',
        url: `/v1/tasks/${taskId}/approve`,
        headers,
        payload: { hashes: [pendingTask.data.pendingActions[0]!.hash] },
      });
      assert.equal(approved.statusCode, 200, approved.body);
      await server.tasks.drain();
      const response = await server.app.inject({ method: 'GET', url: `/v1/tasks/${taskId}`, headers });
      assert.equal(response.statusCode, 200, response.body);
      const task = response.json().data as { data: Task };
      assert.equal(task.data.state, 'completed', JSON.stringify(task.data));
      assert.equal(task.data.resultArtifactIds?.length, 1);
      const stored = await artifacts.read('local-owner', task.data.resultArtifactIds![0]!);
      assert.equal(stored.row.data.source, 'tool');
      assert.equal(stored.row.data.producerTaskId, taskId);
      assert.equal(Buffer.from(stored.bytes).toString('utf8'), '# Deliverable\n');
      assert.equal(await readFile(source, 'utf8'), '# Deliverable\n');

      const blockedWorkspace = await store.create('workspace', 'local-owner', {
        name: 'Not exportable', root, deviceId: 'server', capabilities: ['workspace:read'], allowCloud: false,
      });
      const blocked = await server.app.inject({
        method: 'POST',
        url: `/v1/workspaces/${blockedWorkspace.id}/operations`,
        headers,
        payload: { tool: 'workspace.export', input: { path: 'result.md' }, requestId: 'blocked-export-1' },
      });
      assert.equal(blocked.statusCode, 403, blocked.body);
      assert.match(blocked.body, /workspace:export/);
      assert.equal((await store.scan('artifact', 'local-owner')).length, 1);
    } finally {
      await server.close();
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
