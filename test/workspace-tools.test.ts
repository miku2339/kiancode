import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { access, chmod, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import { createWorkspaceTools } from '../src/tools/workspace.js';
import type { ToolContext, Workspace } from '../src/contracts.js';

const execFileAsync = promisify(execFile);

function context(root: string, taskId = 'task-1', principalId = 'user-1', workspaceId = 'workspace-1'): ToolContext {
  const workspace: Workspace = {
    id: workspaceId,
    ownerId: 'user-1',
    name: 'test',
    root,
    deviceId: 'device-1',
    capabilities: ['workspace:read', 'workspace:write'],
    allowCloud: false,
  };
  return {
    principal: { id: principalId, level: 4, scopes: ['workspace:read', 'workspace:write'] },
    workspace,
    taskId,
    signal: new AbortController().signal,
  };
}

test('workspace tools reject traversal and symlinks escaping the root', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'kiancode-workspace-'));
  const outside = await mkdtemp(path.join(tmpdir(), 'kiancode-outside-'));
  try {
    await writeFile(path.join(outside, 'secret.txt'), 'secret');
    await symlink(outside, path.join(root, 'escape'));
    const tools = await createWorkspaceTools({ checkpointDirectory: path.join(root, '.checkpoints') });
    const read = tools.find((tool) => tool.name === 'workspace.read');
    const write = tools.find((tool) => tool.name === 'workspace.write');
    assert.ok(read && write);
    await assert.rejects(read.execute({ path: '../secret.txt' }, context(root)), /outside workspace/i);
    await assert.rejects(read.execute({ path: 'escape/secret.txt' }, context(root)), /outside workspace/i);
    await assert.rejects(write.execute({ path: 'escape/new.txt', content: 'no' }, context(root)), /outside workspace/i);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test('workspace export returns one immutable descriptor for an explicitly authorized file', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'kiancode-workspace-export-'));
  try {
    const target = path.join(root, 'result.md');
    await writeFile(target, '# Result\n');
    await symlink(target, path.join(root, 'deliverable.md'));
    const tools = await createWorkspaceTools({ checkpointDirectory: path.join(root, '.checkpoints') });
    const exportTool = tools.find((tool) => tool.name === 'workspace.export');
    assert.ok(exportTool);
    const authorized = context(root);
    authorized.principal.scopes.push('workspace:export');
    authorized.workspace!.capabilities.push('workspace:export');

    const result = await exportTool.execute({ path: 'result.md' }, authorized);
    assert.deepEqual(result.artifacts, [{
      name: 'result.md',
      path: await realpath(target),
      mimeType: 'text/markdown',
      transient: false,
      sha256: createHash('sha256').update('# Result\n').digest('hex'),
    }]);
    assert.equal(await readFile(target, 'utf8'), '# Result\n');
    const alias = await exportTool.execute({ path: 'deliverable.md' }, authorized);
    assert.equal(alias.artifacts?.[0]?.name, 'deliverable.md');
    assert.equal(JSON.parse(alias.content).path, 'deliverable.md');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('workspace export rejects missing grants, escaped symlinks, oversized files, and unsupported types', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'kiancode-workspace-export-'));
  const outside = await mkdtemp(path.join(tmpdir(), 'kiancode-workspace-export-outside-'));
  try {
    await writeFile(path.join(root, 'large.txt'), '12345');
    await writeFile(path.join(root, 'script.sh'), 'x');
    await writeFile(path.join(root, 'bad\u0001.txt'), 'x');
    await writeFile(path.join(outside, 'secret.txt'), 'secret');
    await symlink(outside, path.join(root, 'escape'));
    const tools = await createWorkspaceTools({
      checkpointDirectory: path.join(root, '.checkpoints'),
      maxExportBytes: 4,
    });
    const exportTool = tools.find((tool) => tool.name === 'workspace.export');
    assert.ok(exportTool);
    await assert.rejects(exportTool.execute({ path: 'large.txt' }, context(root)), /workspace:export/);
    const authorized = context(root);
    authorized.principal.scopes.push('workspace:export');
    authorized.workspace!.capabilities.push('workspace:export');
    const foreignRead = context(root, 'task-1', 'delegate');
    foreignRead.principal.scopes = ['workspace:export', 'workspace:workspace-1:read'];
    foreignRead.workspace!.capabilities.push('workspace:export');
    await assert.rejects(exportTool.execute({ path: 'large.txt' }, foreignRead), /cannot access/i);
    foreignRead.principal.scopes.push('workspace:workspace-1:export');
    await assert.rejects(exportTool.execute({ path: 'large.txt' }, foreignRead), /not exceed 4 bytes/i);
    await assert.rejects(exportTool.execute({ path: '../secret.txt' }, authorized), /outside workspace/i);
    await assert.rejects(exportTool.execute({ path: 'escape/secret.txt' }, authorized), /outside workspace/i);
    await assert.rejects(exportTool.execute({ path: 'large.txt' }, authorized), /not exceed 4 bytes/i);
    await assert.rejects(exportTool.execute({ path: 'script.sh' }, authorized), /cannot be exported/i);
    await assert.rejects(exportTool.execute({ path: 'bad\u0001.txt' }, authorized), /not allowed/i);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test('workspace write detects conflicts and restore only reverts its unchanged write', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'kiancode-workspace-'));
  const checkpoints = await mkdtemp(path.join(tmpdir(), 'kiancode-checkpoints-'));
  try {
    const target = path.join(root, 'note.txt');
    await writeFile(target, 'before\n');
    const tools = await createWorkspaceTools({ checkpointDirectory: checkpoints });
    const read = tools.find((tool) => tool.name === 'workspace.read');
    const write = tools.find((tool) => tool.name === 'workspace.write');
    const restore = tools.find((tool) => tool.name === 'workspace.restore');
    assert.ok(read && write && restore);

    const snapshot = JSON.parse((await read.execute({ path: 'note.txt' }, context(root))).content) as { sha256: string };
    await assert.rejects(
      write.execute({ path: 'note.txt', content: 'after\n', expectedHash: 'stale' }, context(root)),
      /conflict/i,
    );
    const changed = JSON.parse((await write.execute({
      path: 'note.txt',
      content: 'after\n',
      expectedHash: snapshot.sha256,
    }, context(root))).content) as { checkpointId: string; restoreToken: string };

    await assert.rejects(restore.execute({ checkpointId: changed.checkpointId }, context(root, 'another-task')), /task/i);
    await writeFile(target, 'newer external edit\n');
    await assert.rejects(restore.execute({
      checkpointId: changed.checkpointId,
      restoreToken: changed.restoreToken,
    }, context(root, 'user-restore-operation')), /conflict/i);
    assert.equal(await readFile(target, 'utf8'), 'newer external edit\n');

    const newer = JSON.parse((await read.execute({ path: 'note.txt' }, context(root))).content) as { sha256: string };
    const restorable = JSON.parse((await write.execute({
      path: 'note.txt', content: 'temporary task edit\n', expectedHash: newer.sha256,
    }, context(root))).content) as { checkpointId: string; restoreToken: string };
    await assert.rejects(restore.execute({
      checkpointId: restorable.checkpointId,
      restoreToken: 'a'.repeat(43),
    }, context(root, 'user-restore-operation')), /token/i);
    await assert.rejects(restore.execute({
      checkpointId: restorable.checkpointId,
      restoreToken: restorable.restoreToken,
    }, context(root, 'user-restore-operation', 'user-2')), /access|principal/i);
    await assert.rejects(restore.execute({
      checkpointId: restorable.checkpointId,
      restoreToken: restorable.restoreToken,
    }, context(root, 'user-restore-operation', 'user-1', 'workspace-2')), /workspace/i);
    await restore.execute({
      checkpointId: restorable.checkpointId,
      restoreToken: restorable.restoreToken,
    }, context(root, 'user-restore-operation'));
    assert.equal(await readFile(target, 'utf8'), 'newer external edit\n');
    await assert.rejects(restore.execute({
      checkpointId: restorable.checkpointId,
      restoreToken: restorable.restoreToken,
    }, context(root, 'user-restore-operation')), /not found/i);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(checkpoints, { recursive: true, force: true });
  }
});

test('workspace Git status neither inherits service secrets nor inspects a parent repository', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'kiancode-workspace-git-'));
  const parent = await mkdtemp(path.join(tmpdir(), 'kiancode-workspace-parent-git-'));
  const nested = path.join(parent, 'assigned');
  const previousDatabase = process.env.DATABASE_URL;
  const previousTrace = process.env.GIT_TRACE2;
  try {
    await execFileAsync('git', ['init', root]);
    const hook = path.join(root, 'fsmonitor.sh');
    const hookMarker = `${hook}.called`;
    const trace = path.join(root, 'inherited-git-trace');
    await writeFile(hook, '#!/bin/sh\nprintf called > "$0.called"\nprintf "token\\n"\n');
    await chmod(hook, 0o700);
    await execFileAsync('git', ['-C', root, 'config', 'core.fsmonitor', hook]);
    await writeFile(path.join(root, 'note.txt'), 'changed\n');
    process.env.DATABASE_URL = 'must-not-reach-git';
    process.env.GIT_TRACE2 = trace;

    const tools = await createWorkspaceTools({ checkpointDirectory: path.join(root, '.checkpoints') });
    const status = tools.find((tool) => tool.name === 'workspace.status');
    assert.ok(status);
    const result = JSON.parse((await status.execute({}, context(root))).content) as { status: string };
    assert.match(result.status, /note\.txt/);
    await assert.rejects(access(hookMarker));
    await assert.rejects(access(trace));

    await mkdir(nested);
    await execFileAsync('git', ['init', parent]);
    await writeFile(path.join(parent, 'outside.txt'), 'private\n');
    await writeFile(path.join(nested, 'inside.txt'), 'workspace\n');
    const nestedTools = await createWorkspaceTools({ checkpointDirectory: path.join(nested, '.checkpoints') });
    const nestedStatus = nestedTools.find((tool) => tool.name === 'workspace.status');
    assert.ok(nestedStatus);
    const nestedResult = JSON.parse((await nestedStatus.execute({}, context(nested))).content) as { status: string };
    assert.equal(nestedResult.status, '');
  } finally {
    if (previousDatabase === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = previousDatabase;
    if (previousTrace === undefined) delete process.env.GIT_TRACE2;
    else process.env.GIT_TRACE2 = previousTrace;
    await rm(root, { recursive: true, force: true });
    await rm(parent, { recursive: true, force: true });
  }
});
