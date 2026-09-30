import assert from 'node:assert/strict';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createConfiguredScriptTool } from '../src/tools/script-adapter.js';

test('configured script adapter passes structured input without shell interpolation', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'kiancode-script-'));
  const script = path.join(directory, 'adapter.mjs');
  await writeFile(script, `let data=''; for await (const chunk of process.stdin) data += chunk; process.stdout.write(JSON.stringify({ received: JSON.parse(data) }));`);
  await chmod(script, 0o700);
  try {
    const tool = await createConfiguredScriptTool({
      id: 'desktop.inspect', description: 'Inspect through configured adapter', permission: 'configured',
      command: process.execPath, args: [script], capability: 'desktop:automation', sideEffect: 'external',
    });
    const result = JSON.parse((await tool.execute({ value: '`; touch /tmp/never; #' }, {
      principal: { id: 'user-1', level: 4, scopes: ['desktop:automation'] }, taskId: 'task-1', signal: new AbortController().signal,
    })).content) as { stdout: string; isolation: string };
    assert.deepEqual(JSON.parse(result.stdout), { received: { value: '`; touch /tmp/never; #' } });
    assert.equal(result.isolation, 'none');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
