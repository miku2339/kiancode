import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createWorkspaceTools } from '../src/tools/workspace.js';
import type { ToolContext, Workspace } from '../src/contracts.js';

function sha256(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

function context(root: string): ToolContext {
  const workspace: Workspace = {
    id: 'workspace-1',
    ownerId: 'user-1',
    name: 'test',
    root,
    deviceId: 'device-1',
    capabilities: ['workspace:read', 'workspace:write'],
    allowCloud: false,
  };
  return {
    principal: { id: 'user-1', level: 4, scopes: ['workspace:read', 'workspace:write'] },
    workspace,
    taskId: 'task-1',
    signal: new AbortController().signal,
  };
}

test('workspace patch applies a bounded context edit and creates a restorable checkpoint', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'kiancode-workspace-patch-'));
  const checkpoints = await mkdtemp(path.join(tmpdir(), 'kiancode-workspace-checkpoints-'));
  try {
    const target = path.join(root, 'message.txt');
    await writeFile(target, 'heading\nold value\nfooter\n');
    await chmod(target, 0o600);
    const tools = await createWorkspaceTools({ checkpointDirectory: checkpoints });
    const read = tools.find((tool) => tool.name === 'workspace.read');
    const patchTool = tools.find((tool) => tool.name === 'workspace.patch');
    const restore = tools.find((tool) => tool.name === 'workspace.restore');
    assert.ok(read && patchTool && restore);
    const before = JSON.parse((await read.execute({ path: 'message.txt' }, context(root))).content) as {
      sha256: string;
    };

    const result = JSON.parse((await patchTool.execute({
      expectedHash: before.sha256,
      patch: [
        '*** Begin Patch',
        '*** Update File: message.txt',
        '@@ heading',
        '-old value',
        '+new value',
        ' footer',
        '*** End Patch',
      ].join('\n'),
    }, context(root))).content) as { checkpointId: string; sha256: string };

    assert.equal(await readFile(path.join(root, 'message.txt'), 'utf8'), 'heading\nnew value\nfooter\n');
    assert.equal((await stat(target)).mode & 0o777, 0o600);
    await restore.execute({ checkpointId: result.checkpointId }, context(root));
    assert.equal(await readFile(path.join(root, 'message.txt'), 'utf8'), 'heading\nold value\nfooter\n');
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(checkpoints, { recursive: true, force: true });
  }
});

test('workspace patch rejects ambiguous context without changing the file', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'kiancode-workspace-patch-'));
  try {
    const original = 'same\nvalue\nsame\nvalue\n';
    await writeFile(path.join(root, 'message.txt'), original);
    const tools = await createWorkspaceTools({ checkpointDirectory: path.join(root, '.checkpoints') });
    const patchTool = tools.find((tool) => tool.name === 'workspace.patch');
    assert.ok(patchTool);

    await assert.rejects(patchTool.execute({
      expectedHash: sha256(original),
      patch: [
        '*** Begin Patch',
        '*** Update File: message.txt',
        '@@',
        '-same',
        '-value',
        '+changed',
        '*** End Patch',
      ].join('\n'),
    }, context(root)), /more than one location/i);
    assert.equal(await readFile(path.join(root, 'message.txt'), 'utf8'), original);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('workspace patch preserves CRLF and rejects stale hashes or paths outside the workspace', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'kiancode-workspace-patch-'));
  const outside = await mkdtemp(path.join(tmpdir(), 'kiancode-workspace-outside-'));
  try {
    const original = 'first\r\nold\r\nlast\r\n';
    await writeFile(path.join(root, 'message.txt'), original);
    await writeFile(path.join(outside, 'outside.txt'), 'private\n');
    const tools = await createWorkspaceTools({ checkpointDirectory: path.join(root, '.checkpoints') });
    const patchTool = tools.find((tool) => tool.name === 'workspace.patch');
    assert.ok(patchTool);
    const update = [
      '*** Begin Patch',
      '*** Update File: message.txt',
      '@@ first',
      '-old',
      '+new',
      ' last',
      '*** End Patch',
    ].join('\n');

    await assert.rejects(patchTool.execute({ patch: update, expectedHash: '0'.repeat(64) }, context(root)), /conflict/i);
    assert.equal(await readFile(path.join(root, 'message.txt'), 'utf8'), original);
    await patchTool.execute({ patch: update, expectedHash: sha256(original) }, context(root));
    assert.equal(await readFile(path.join(root, 'message.txt'), 'utf8'), 'first\r\nnew\r\nlast\r\n');

    const escape = [
      '*** Begin Patch',
      `*** Update File: ../${path.basename(outside)}/outside.txt`,
      '@@',
      '-private',
      '+exposed',
      '*** End Patch',
    ].join('\n');
    await assert.rejects(patchTool.execute({ patch: escape, expectedHash: sha256('private\n') }, context(root)), /outside workspace/i);
    assert.equal(await readFile(path.join(outside, 'outside.txt'), 'utf8'), 'private\n');
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test('workspace patch rejects oversized or multi-file input before mutation', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'kiancode-workspace-patch-'));
  try {
    const original = 'old\n';
    await writeFile(path.join(root, 'message.txt'), original);
    const tools = await createWorkspaceTools({
      checkpointDirectory: path.join(root, '.checkpoints'),
      maxPatchBytes: 180,
    });
    const patchTool = tools.find((tool) => tool.name === 'workspace.patch');
    assert.ok(patchTool);
    const multiple = [
      '*** Begin Patch',
      '*** Update File: message.txt',
      '@@',
      '-old',
      '+new',
      '*** Update File: other.txt',
      '@@',
      '-a',
      '+b',
      '*** End Patch',
    ].join('\n');
    await assert.rejects(patchTool.execute({ patch: multiple, expectedHash: sha256(original) }, context(root)), /invalid change line/i);
    const oversized = `${multiple}\n${'x'.repeat(181)}`;
    await assert.rejects(patchTool.execute({ patch: oversized, expectedHash: sha256(original) }, context(root)), /exceeds 180 bytes/i);
    assert.equal(await readFile(path.join(root, 'message.txt'), 'utf8'), original);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
