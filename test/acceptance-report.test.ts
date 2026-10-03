import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { openAcceptanceReport } from './acceptance-report.js';

interface AcceptanceRun {
  code: number | null;
  stdout: string;
  stderr: string;
}

function spawnNode(arguments_: string[], environment: Record<string, string>): Promise<AcceptanceRun> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, arguments_, {
      env: { ...process.env, ...environment },
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 60_000,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => { stdout += chunk; });
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => { stderr += chunk; });
    child.once('error', reject);
    child.once('close', (code) => resolve({ code, stdout, stderr }));
  });
}

function runAcceptance(
  environment: Record<string, string>,
  arguments_: string[] = [],
): Promise<AcceptanceRun> {
  return spawnNode(
    ['--import', 'tsx', 'test/standalone.acceptance.ts', ...arguments_],
    {
      KIANCODE_ACCEPTANCE_CONFIG: '',
      KIANCODE_ACCEPTANCE_WORKSPACE: '',
      KIANCODE_ACCEPTANCE_REPORT: '',
      ...environment,
    },
  );
}

test('a report starts incomplete and replaces a stale passed result', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'kiancode-acceptance-report-'));
  try {
    const file = path.join(directory, 'report.json');
    await writeFile(file, '{"status":"passed","taskId":"stale"}\n');

    const report = await openAcceptanceReport(file);
    const written = JSON.parse(await readFile(file, 'utf8')) as Record<string, unknown>;

    assert.equal(report.path, file);
    assert.equal(written.status, 'incomplete');
    assert.equal(written.taskId, undefined);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('a successful report is finalized with its verified evidence', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'kiancode-acceptance-report-'));
  try {
    const file = path.join(directory, 'report.json');
    const report = await openAcceptanceReport(file);
    const started = JSON.parse(await readFile(file, 'utf8')) as { startedAt: string };
    await report.passed({ modelCalls: 3, durableReadback: true });

    const text = await readFile(file, 'utf8');
    const written = JSON.parse(text) as Record<string, unknown>;
    assert.equal(text.endsWith('\n'), true);
    assert.equal(text.indexOf('\n'), text.length - 1);
    assert.equal(written.status, 'passed');
    assert.equal(written.startedAt, started.startedAt);
    assert.match(String(written.finishedAt), /^\d{4}-\d{2}-\d{2}T/);
    const manifest = JSON.parse(await readFile('package.json', 'utf8')) as { version: string };
    assert.equal(written.packageVersion, manifest.version);
    assert.equal(written.modelCalls, 3);
    assert.equal(written.durableReadback, true);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('a failed atomic finish leaves the incomplete report in place', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'kiancode-acceptance-report-'));
  try {
    const file = path.join(directory, 'report.json');
    let renames = 0;
    const report = await openAcceptanceReport(file, {
      async rename(source, target) {
        renames += 1;
        if (renames === 2) throw new Error('simulated rename failure');
        await rename(source, target);
      },
    });

    await assert.rejects(report.passed({ durableReadback: true }), /simulated rename failure/);
    const written = JSON.parse(await readFile(file, 'utf8')) as Record<string, unknown>;
    assert.equal(written.status, 'incomplete');
    assert.equal(written.durableReadback, undefined);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('a failed report keeps partial evidence without secrets or private endpoints', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'kiancode-acceptance-report-'));
  try {
    const file = path.join(directory, 'report.json');
    const report = await openAcceptanceReport(file);
    await report.failed(
      new Error('\u001b[31mconnect failed at postgresql://owner:password@private.internal/db?token=secret\u001b[39m'),
      {
        taskId: 'task-1',
        durableReadback: false,
        databaseUrl: 'postgresql://owner:password@private.internal/db',
        nested: { apiToken: 'secret', endpoint: 'https://private.internal/api' },
      },
    );

    const text = await readFile(file, 'utf8');
    const written = JSON.parse(text) as Record<string, unknown>;
    assert.equal(written.status, 'failed');
    assert.equal(written.taskId, 'task-1');
    assert.equal(written.durableReadback, false);
    assert.doesNotMatch(text, /password|private\.internal|secret/);
    assert.match(String(written.error), /\[redacted endpoint\]/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('a process exit before finalization cannot leave a passed report', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'kiancode-acceptance-report-'));
  try {
    const file = path.join(directory, 'report.json');
    await writeFile(file, '{"status":"passed","taskId":"stale"}\n');
    const source = "import { openAcceptanceReport } from './test/acceptance-report.ts'; await openAcceptanceReport(process.env.REPORT_PATH); process.exit(17);";
    const run = await spawnNode(['--import', 'tsx', '--input-type=module', '--eval', source], { REPORT_PATH: file });
    assert.equal(run.code, 17);
    assert.equal(run.stderr, '');
    assert.equal((JSON.parse(await readFile(file, 'utf8')) as { status: string }).status, 'incomplete');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('npm run acceptance invokes the standalone acceptance script', async () => {
  const manifest = JSON.parse(await readFile('package.json', 'utf8')) as {
    scripts: Record<string, string>;
  };
  assert.equal(manifest.scripts.acceptance, 'tsx test/standalone.acceptance.ts');
  assert.equal(manifest.scripts.check, 'npm run typecheck && npm test && npm run build');
});

test('a failed acceptance run replaces stale passed evidence', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'kiancode-acceptance-run-'));
  try {
    const file = path.join(directory, 'report.json');
    await writeFile(file, '{"status":"passed","taskId":"stale"}\n');
    const run = await runAcceptance({ KIANCODE_ACCEPTANCE_REPORT: file });

    assert.equal(run.code, 1);
    assert.equal(run.stdout, '');
    assert.match(run.stderr, /Set KIANCODE_ACCEPTANCE_CONFIG/);
    const written = JSON.parse(await readFile(file, 'utf8')) as Record<string, unknown>;
    assert.equal(written.status, 'failed');
    assert.equal(written.error, 'Set KIANCODE_ACCEPTANCE_CONFIG to an isolated PostgreSQL configuration');
    assert.equal(written.taskId, undefined);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('a bootstrap failure records the evidence gathered so far without its private endpoint', async () => {
  const directory = await realpath(await mkdtemp(path.join(tmpdir(), 'kiancode-acceptance-run-')));
  try {
    const file = path.join(directory, 'report.json');
    const config = path.join(directory, 'config.json');
    const workspace = path.join(directory, 'workspace');
    await writeFile(config, JSON.stringify({
      database: { urlEnv: 'KIANCODE_ACCEPTANCE_TEST_DATABASE_URL' },
      serverWorkspaceRoots: [workspace],
      terminal: { isolation: 'bubblewrap', binary: '/usr/bin/bwrap' },
    }));
    const run = await runAcceptance({
      KIANCODE_ACCEPTANCE_CONFIG: config,
      KIANCODE_ACCEPTANCE_WORKSPACE: workspace,
      KIANCODE_ACCEPTANCE_REPORT: file,
      KIANCODE_ACCEPTANCE_TEST_DATABASE_URL: 'socket:/kiancode-private-no-such-directory?db=unused',
    });

    assert.equal(run.code, 1);
    const text = await readFile(file, 'utf8');
    const written = JSON.parse(text) as Record<string, unknown>;
    assert.equal(written.status, 'failed');
    assert.equal(written.modelCalls, 0);
    assert.deepEqual(written.tools, []);
    assert.equal(written.durableReadback, false);
    assert.doesNotMatch(text, /kiancode-private-no-such-directory|socket:/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('--report selects an acceptance report outside the repository', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'kiancode-acceptance-run-'));
  try {
    const file = path.join(directory, 'cli-report.json');
    const run = await runAcceptance({}, ['--report', file]);
    assert.equal(run.code, 1);
    assert.equal((JSON.parse(await readFile(file, 'utf8')) as { status: string }).status, 'failed');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('README documents the PostgreSQL, model, OS and report gates', async () => {
  const readme = await readFile('README.md', 'utf8');
  const start = readme.indexOf('## Verification');
  const verification = readme.slice(start, readme.indexOf('\n## ', start));
  for (const phrase of [
    'KIANCODE_TEST_DATABASE_URL',
    'npm run acceptance',
    'KIANCODE_ACCEPTANCE_CONFIG',
    'KIANCODE_ACCEPTANCE_WORKSPACE',
    'KIANCODE_ACCEPTANCE_REPORT',
    '--report',
    'real model',
    'Bubblewrap',
    '`incomplete`',
    '`passed`',
    '`failed`',
    'not part of `npm run check`',
  ]) {
    assert.ok(verification.includes(phrase), `Verification does not mention ${phrase}`);
  }
});
