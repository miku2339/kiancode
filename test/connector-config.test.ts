import assert from 'node:assert/strict';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { connectorConfig } from '../src/connector-cli.js';

const base = {
  url: 'https://core.example.invalid',
  deviceId: 'device-1',
  ownerId: 'owner-1',
  capabilities: ['workspace:read'],
  journalPath: '/tmp/connector/journal.json',
  checkpointDirectory: '/tmp/connector/checkpoints',
  workspaces: [],
};

test('connector accepts a secret environment reference without persisting the device token', () => {
  const parsed = connectorConfig.parse({ ...base, tokenEnv: 'KIANCODE_CONNECTOR_TOKEN' });
  assert.equal(parsed.tokenEnv, 'KIANCODE_CONNECTOR_TOKEN');
  assert.equal(parsed.tokenFile, undefined);
  assert.equal('token' in parsed, false);
});

test('connector requires exactly one token source and rejects unsafe terminal environment names', () => {
  assert.throws(() => connectorConfig.parse(base), /token source/i);
  assert.throws(() => connectorConfig.parse({ ...base, tokenEnv: 'TOKEN', tokenFile: '/tmp/token' }), /token source/i);
  assert.throws(() => connectorConfig.parse({
    ...base,
    tokenEnv: 'TOKEN',
    terminal: { environmentEnv: { HOME: 'SAFE_SOURCE' } },
  }), /reserved/i);
});

function connectorChild(configPath: string): ChildProcessWithoutNullStreams {
  return spawn(process.execPath, ['--import', 'tsx', 'src/connector-entry.ts', '--config', configPath], {
    cwd: process.cwd(),
    env: { ...process.env, KIANCODE_CONNECTOR_TOKEN: '0123456789abcdef0123456789abcdef' },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
}

function output(child: ChildProcessWithoutNullStreams) {
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8').on('data', (chunk: string) => { stdout += chunk; });
  child.stderr.setEncoding('utf8').on('data', (chunk: string) => { stderr += chunk; });
  return { stdout: () => stdout, stderr: () => stderr };
}

async function waitFor(predicate: () => boolean | Promise<boolean>, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!await predicate()) {
    if (Date.now() >= deadline) throw new Error('Timed out waiting for connector child');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

async function lockIsAvailable(lockPath: string): Promise<boolean> {
  const command = process.platform === 'darwin' ? '/usr/bin/lockf' : 'flock';
  const args = process.platform === 'darwin'
    ? ['-t', '0', lockPath, process.execPath, '-e', '']
    : ['-n', lockPath, process.execPath, '-e', ''];
  return new Promise((resolve) => {
    const probe = spawn(command, args, { stdio: 'ignore' });
    probe.once('error', () => resolve(false));
    probe.once('exit', (code) => resolve(code === 0));
  });
}

test('connector never clears a lock that may still be initializing', {
  timeout: 10_000,
  skip: !['darwin', 'linux'].includes(process.platform),
}, async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'kiancode-connector-initializing-'));
  const configPath = path.join(directory, 'config.json');
  const lockPath = path.join(directory, 'connector.lock');
  await writeFile(configPath, JSON.stringify({
    ...base,
    url: 'http://127.0.0.1:9',
    tokenEnv: 'KIANCODE_CONNECTOR_TOKEN',
    journalPath: path.join(directory, 'journal.json'),
    checkpointDirectory: path.join(directory, 'checkpoints'),
    lockPath,
  }));
  await writeFile(lockPath, '');
  const child = connectorChild(configPath);
  const stream = output(child);
  try {
    await waitFor(() => child.exitCode !== null || child.signalCode !== null || stream.stdout().includes('Device connector started'));
    assert.doesNotMatch(stream.stdout(), /Device connector started/);
    assert.match(stream.stderr(), /initializing|malformed/i);
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    if (child.exitCode === null && child.signalCode === null) await new Promise<void>((resolve) => child.once('exit', () => resolve()));
    await rm(directory, { recursive: true, force: true });
  }
});

test('concurrent connector processes admit one owner and recover after its crash', {
  timeout: 20_000,
  skip: !['darwin', 'linux'].includes(process.platform),
}, async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'kiancode-connector-lock-'));
  const configPath = path.join(directory, 'config.json');
  const lockPath = path.join(directory, 'connector.lock');
  await writeFile(configPath, JSON.stringify({
    ...base,
    url: 'http://127.0.0.1:9',
    tokenEnv: 'KIANCODE_CONNECTOR_TOKEN',
    journalPath: path.join(directory, 'journal.json'),
    checkpointDirectory: path.join(directory, 'checkpoints'),
    lockPath,
  }));
  await writeFile(lockPath, '99999999\n');

  const children: ChildProcessWithoutNullStreams[] = [];
  try {
    for (let index = 0; index < 4; index += 1) children.push(connectorChild(configPath));
    const streams = children.map(output);
    await waitFor(() => streams.some((stream) => stream.stdout().includes('Device connector started')));
    const winnerIndex = streams.findIndex((stream) => stream.stdout().includes('Device connector started'));
    await waitFor(() => children.every((child, index) => index === winnerIndex
      || child.exitCode !== null || child.signalCode !== null), 10_000);
    assert.equal(streams.filter((stream) => stream.stdout().includes('Device connector started')).length, 1);

    const winner = children[winnerIndex]!;
    winner.kill('SIGKILL');
    await new Promise<void>((resolve) => winner.once('exit', () => resolve()));
    await waitFor(() => lockIsAvailable(lockPath));

    const recovered = connectorChild(configPath);
    children.push(recovered);
    const recoveredOutput = output(recovered);
    await waitFor(() => recoveredOutput.stdout().includes('Device connector started'));
    assert.match(await readFile(lockPath, 'utf8'), new RegExp(`^${recovered.pid}(?:\\s|$)`));
  } finally {
    for (const child of children) {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    }
    await Promise.all(children.map((child) => child.exitCode !== null || child.signalCode !== null
      ? Promise.resolve()
      : new Promise<void>((resolve) => child.once('exit', () => resolve()))));
    await rm(directory, { recursive: true, force: true });
  }
});
