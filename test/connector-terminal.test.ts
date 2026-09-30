import assert from 'node:assert/strict';
import { access, chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { ToolContext } from '../src/contracts.js';
import { createTerminalTool } from '../src/tools/terminal.js';

function context(root: string, signal: AbortSignal): ToolContext {
  return {
    principal: { id: 'user-1', level: 4, scopes: ['shell:execute'] },
    workspace: {
      id: 'workspace-1',
      ownerId: 'user-1',
      name: 'test',
      root,
      deviceId: 'device-1',
      capabilities: ['shell:execute'],
      allowCloud: false,
    },
    taskId: 'task-1',
    signal,
  };
}

test('terminal aborts a command and reports that cwd is not an OS sandbox', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'kiancode-terminal-'));
  try {
    const tool = createTerminalTool({ allowedShells: ['/bin/sh'], maxOutputBytes: 1_024 });
    const controller = new AbortController();
    const pending = tool.execute({ command: 'sleep 10', shell: '/bin/sh', timeoutMs: 20_000 }, context(root, controller.signal));
    setTimeout(() => controller.abort(), 50);
    const result = JSON.parse((await pending).content) as { aborted: boolean; isolation: string };
    assert.equal(result.aborted, true);
    assert.equal(result.isolation, 'none');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('terminal requires an explicit shell capability', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'kiancode-terminal-'));
  try {
    const tool = createTerminalTool({ allowedShells: ['/bin/sh'] });
    const denied = context(root, new AbortController().signal);
    denied.principal.scopes = [];
    await assert.rejects(tool.execute({ command: 'true', shell: '/bin/sh' }, denied), /capability/i);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('terminal exposes only the bounded environment and does not load login profiles', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'kiancode-terminal-'));
  const previousDatabase = process.env.DATABASE_URL;
  const previousAccountKey = process.env.KIANCODE_ACCOUNT_SERVICE_TOKEN;
  process.env.DATABASE_URL = 'must-not-reach-command';
  process.env.KIANCODE_ACCOUNT_SERVICE_TOKEN = 'must-not-reach-command';
  try {
    const runtimeDirectory = path.join(root, '.terminal-runtime');
    const tool = createTerminalTool({
      allowedShells: ['/bin/sh'],
      runtimeDirectory,
      environment: { TOOL_CREDENTIAL: 'explicit-value' },
    });
    const commandContext = context(root, new AbortController().signal);
    const first = JSON.parse((await tool.execute({
      command: 'test -z "${DATABASE_URL+x}" && test -z "${KIANCODE_ACCOUNT_SERVICE_TOKEN+x}" && printf "%s\\n%s\\n%s\\n" "$TOOL_CREDENTIAL" "$HOME" "$TMPDIR"',
      shell: '/bin/sh',
    }, commandContext)).content) as { exitCode: number; stdout: string };
    assert.equal(first.exitCode, 0);
    const [credential, home, temporary] = first.stdout.trim().split('\n');
    assert.equal(credential, 'explicit-value');
    const resolvedRuntimeDirectory = await realpath(runtimeDirectory);
    assert.ok(home?.startsWith(resolvedRuntimeDirectory));
    assert.ok(temporary?.startsWith(resolvedRuntimeDirectory));
    await writeFile(path.join(home!, '.profile'), 'export PROFILE_LEAKED=1\n');

    const second = JSON.parse((await tool.execute({
      command: 'test -z "${PROFILE_LEAKED+x}"',
      shell: '/bin/sh',
    }, commandContext)).content) as { exitCode: number };
    assert.equal(second.exitCode, 0);
  } finally {
    if (previousDatabase === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = previousDatabase;
    if (previousAccountKey === undefined) delete process.env.KIANCODE_ACCOUNT_SERVICE_TOKEN;
    else process.env.KIANCODE_ACCOUNT_SERVICE_TOKEN = previousAccountKey;
    await rm(root, { recursive: true, force: true });
  }
});

test('terminal fails closed when server execution requires an OS sandbox', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'kiancode-terminal-'));
  try {
    const tool = createTerminalTool({ allowedShells: ['/bin/sh'], requireSandbox: true });
    await assert.rejects(
      tool.execute({ command: 'true', shell: '/bin/sh' }, context(root, new AbortController().signal)),
      (error: unknown) => error instanceof Error
        && 'code' in error
        && error.code === 'terminal_sandbox_required',
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('Bubblewrap receives only the assigned workspace and isolated network arguments', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'kiancode-terminal-workspace-'));
  const otherWorkspace = await mkdtemp(path.join(tmpdir(), 'kiancode-terminal-other-'));
  const harness = await mkdtemp(path.join(tmpdir(), 'kiancode-bwrap-harness-'));
  const binary = path.join(harness, 'bwrap');
  const capture = path.join(harness, 'arguments.txt');
  const previousDatabase = process.env.DATABASE_URL;
  process.env.DATABASE_URL = 'must-not-reach-bubblewrap';
  try {
    await mkdir(path.join(root, 'nested'));
    await writeFile(binary, '#!/bin/sh\ntest -z "${DATABASE_URL+x}" || exit 90\nprintf "%s\\n" "$@" > "$BWRAP_CAPTURE"\n');
    await chmod(binary, 0o700);
    const tool = createTerminalTool({
      allowedShells: ['/bin/sh'],
      environment: { BWRAP_CAPTURE: capture },
      bubblewrap: { binary, readOnlyPaths: ['/usr'], allowNetwork: false },
    });
    const result = JSON.parse((await tool.execute({
      command: 'printf sandboxed',
      shell: '/bin/sh',
      cwd: 'nested',
    }, context(root, new AbortController().signal))).content) as {
      exitCode: number;
      isolation: string;
      network: string;
    };
    assert.equal(result.exitCode, 0);
    assert.equal(result.isolation, 'bubblewrap');
    assert.equal(result.network, 'isolated');
    const captured = (await readFile(capture, 'utf8')).trim().split('\n');
    assert.ok(captured.includes('--unshare-all'));
    assert.ok(!captured.includes('--share-net'));
    const bind = captured.indexOf('--bind');
    assert.deepEqual(captured.slice(bind, bind + 3), ['--bind', await realpath(root), '/workspace']);
    const chdir = captured.indexOf('--chdir');
    assert.deepEqual(captured.slice(chdir, chdir + 2), ['--chdir', '/workspace/nested']);
    assert.ok(captured.includes('--ro-bind'));
    assert.ok(captured.includes('/usr'));
    assert.ok(!captured.some((argument) => argument.includes(otherWorkspace)));
    assert.ok(!captured.includes('/etc'));
    assert.ok(!captured.some((argument) => argument.startsWith('/var/lib')));
    assert.deepEqual(captured.slice(-3), ['/bin/sh', '-c', 'printf sandboxed']);
  } finally {
    if (previousDatabase === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = previousDatabase;
    await rm(root, { recursive: true, force: true });
    await rm(otherWorkspace, { recursive: true, force: true });
    await rm(harness, { recursive: true, force: true });
  }
});

test('Bubblewrap shares network only with operator and workspace grants', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'kiancode-terminal-workspace-'));
  const harness = await mkdtemp(path.join(tmpdir(), 'kiancode-bwrap-harness-'));
  const binary = path.join(harness, 'bwrap');
  const capture = path.join(harness, 'arguments.txt');
  try {
    await writeFile(binary, '#!/bin/sh\nprintf "%s\\n" "$@" > "$BWRAP_CAPTURE"\n');
    await chmod(binary, 0o700);
    const tool = createTerminalTool({
      allowedShells: ['/bin/sh'],
      environment: { BWRAP_CAPTURE: capture },
      bubblewrap: { binary, readOnlyPaths: ['/usr'], allowNetwork: true },
    });
    const commandContext = context(root, new AbortController().signal);
    commandContext.workspace!.capabilities.push('network:access');
    commandContext.principal.scopes.push('network:access');
    const result = JSON.parse((await tool.execute({ command: 'true', shell: '/bin/sh' }, commandContext)).content) as { network: string };
    const captured = (await readFile(capture, 'utf8')).trim().split('\n');
    assert.equal(result.network, 'shared');
    assert.ok(captured.includes('--unshare-all'));
    assert.ok(captured.includes('--share-net'));
    assert.ok(captured.includes('/etc/resolv.conf'));
    assert.equal(captured.some((argument, index) => argument === '--ro-bind' && captured[index + 1] === '/etc'), false);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(harness, { recursive: true, force: true });
  }
});

test('Bubblewrap setup failure never falls back to the host shell', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'kiancode-terminal-workspace-'));
  const harness = await mkdtemp(path.join(tmpdir(), 'kiancode-bwrap-harness-'));
  const marker = path.join(root, 'must-not-exist');
  const binary = path.join(harness, 'bwrap');
  try {
    await writeFile(binary, '#!/bin/sh\nexit 1\n');
    await chmod(binary, 0o700);
    const tool = createTerminalTool({
      allowedShells: ['/bin/sh'],
      bubblewrap: { binary, readOnlyPaths: ['/usr'] },
    });
    const result = await tool.execute({ command: `touch ${marker}`, shell: '/bin/sh' }, context(root, new AbortController().signal));
    assert.equal(result.isError, true);
    await assert.rejects(access(marker));
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(harness, { recursive: true, force: true });
  }
});

test('Bubblewrap rejects host credential directories from read-only mounts', () => {
  assert.throws(() => createTerminalTool({
    bubblewrap: { binary: '/usr/bin/bwrap', readOnlyPaths: ['/var/lib/credentials'] },
  }), /read-only paths/);
  assert.throws(() => createTerminalTool({
    bubblewrap: { binary: '/usr/bin/bwrap', readOnlyPaths: ['/etc'] },
  }), /read-only paths/);
});
