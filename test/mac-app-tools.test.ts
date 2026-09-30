import assert from 'node:assert/strict';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { ToolContext, Workspace } from '../src/contracts.js';
import { MacAppToolProvider } from '../src/tools/mac-app.js';

test('Mac app tools enforce allowlists and return a bounded local screenshot', { skip: process.platform !== 'darwin' }, async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'kiancode-mac-app-'));
  try {
    const helper = path.join(directory, 'helper.mjs');
    await writeFile(helper, `#!/usr/bin/env node
const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const request = JSON.parse(Buffer.concat(chunks).toString('utf8'));
if (request.operation === 'screenshot') {
  await import('node:fs/promises').then(({ writeFile }) => writeFile(request.outputPath, Buffer.from([137,80,78,71,13,10,26,10])));
  process.stdout.write(JSON.stringify({ ok: true, data: { capturedAt: new Date().toISOString() } }));
} else if (request.operation === 'health') {
  process.stdout.write(JSON.stringify({ ok: true, data: { available: false, accessibility: false, screenCapture: false, enabled: false, paused: false, reason: 'stopped' } }));
} else {
  process.stdout.write(JSON.stringify({ ok: true, data: { bundleId: request.bundleId } }));
}
`);
    await chmod(helper, 0o700);
    const provider = await MacAppToolProvider.create({
      permission: 'configured', helperPath: helper, controlFile: path.join(directory, 'control.json'),
      screenshotDirectory: path.join(directory, 'screenshots'), allowedBundleIds: ['com.example.Allowed'], allowedActions: ['AXPress'],
    });
    const tools = new Map(provider.asToolDefinitions().map((tool) => [tool.name, tool]));
    assert.deepEqual([...tools].map(([name, tool]) => [name, tool.sideEffect]), [
      ['mac.app.health', 'read'], ['mac.app.list', 'read'], ['mac.app.snapshot', 'read'], ['mac.app.focus', 'write'],
      ['mac.app.window', 'write'], ['mac.app.action', 'external'], ['mac.app.menu', 'external'], ['mac.app.screenshot', 'external'],
    ]);
    const workspace: Workspace = {
      id: 'workspace', ownerId: 'owner', name: 'Mac', root: directory, deviceId: 'device',
      capabilities: ['desktop:read', 'desktop:write', 'desktop:external', 'screenshot:read'], allowCloud: false,
    };
    const context: ToolContext = {
      principal: { id: 'owner', level: 4, scopes: ['*'] }, workspace, taskId: 'task', signal: new AbortController().signal,
    };
    await assert.rejects(tools.get('mac.app.snapshot')!.execute({ bundleId: 'com.example.Other' }, context), /allowlist/);
    const result = await tools.get('mac.app.screenshot')!.execute({ bundleId: 'com.example.Allowed', windowIndex: 0 }, context);
    assert.equal(result.artifacts?.length, 1);
    assert.match(result.artifacts![0]!.path, /^\/.*\/screenshots\/mac-app-task-/);
    await rm(result.artifacts![0]!.path);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
