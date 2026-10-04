import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { Pool } from 'pg';

const databaseUrl = process.env.KIANCODE_TEST_DATABASE_URL ?? '';
const runnerPath = fileURLToPath(new URL('./fixtures/postgres-idle-runner.ts', import.meta.url));

function nextMessage(child: ChildProcess): Promise<{ type: string; recovered?: boolean }> {
  return new Promise((resolve, reject) => {
    const finish = (operation: () => void): void => {
      clearTimeout(timer);
      child.off('message', onMessage);
      child.off('exit', onExit);
      operation();
    };
    const onMessage = (message: unknown): void => finish(() => resolve(message as { type: string; recovered?: boolean }));
    const onExit = (code: number | null): void => finish(() => reject(new Error(`PostgreSQL worker exited before recovery: ${code}`)));
    const timer = setTimeout(() => finish(() => reject(new Error('PostgreSQL worker timed out'))), 10_000);
    if (child.exitCode !== null) { onExit(child.exitCode); return; }
    child.once('message', onMessage);
    child.once('exit', onExit);
  });
}

test('PostgreSQL: an idle connection loss keeps the process alive and reconnects through the store', {
  skip: !databaseUrl ? 'KIANCODE_TEST_DATABASE_URL is not set' : false,
}, async () => {
  const schema = `kiancode_test_${randomBytes(16).toString('hex')}`;
  const application = `kiancode_idle_${randomBytes(16).toString('hex')}`;
  const admin = new Pool({ connectionString: databaseUrl, max: 1, connectionTimeoutMillis: 5_000 });
  let child: ChildProcess | undefined;
  let exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }> | undefined;
  try {
    await admin.query(`CREATE SCHEMA ${schema}`);
    const isolatedUrl = new URL(databaseUrl);
    isolatedUrl.searchParams.set('application_name', application);
    child = spawn(process.execPath, ['--import', 'tsx', runnerPath], {
      cwd: fileURLToPath(new URL('..', import.meta.url)),
      env: {
        KIANCODE_FIXTURE_DATABASE_URL: isolatedUrl.href,
        KIANCODE_FIXTURE_SCHEMA: schema,
        ...(process.env.NODE_EXTRA_CA_CERTS ? { NODE_EXTRA_CA_CERTS: process.env.NODE_EXTRA_CA_CERTS } : {}),
      },
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    });
    exited = new Promise((resolve) => child!.once('exit', (code, signal) => resolve({ code, signal })));
    assert.equal((await nextMessage(child)).type, 'idle');
    const backends = await admin.query<{ pid: number; state: string }>(`
      SELECT pid, state FROM pg_stat_activity
      WHERE application_name=$1 AND datname=current_database() AND usename=current_user AND pid<>pg_backend_pid()
    `, [application]);
    assert.equal(backends.rows.length, 1);
    assert.equal(backends.rows[0]!.state, 'idle');
    const terminated = await admin.query<{ terminated: boolean }>('SELECT pg_terminate_backend($1) AS terminated', [backends.rows[0]!.pid]);
    assert.equal(terminated.rows[0]!.terminated, true);
    await delay(100);
    const recovered = nextMessage(child);
    if (child.connected) child.send('recover');
    assert.deepEqual(await recovered, { type: 'recovered', recovered: true });
    const outcome = await Promise.race([exited, delay(5_000).then(() => { throw new Error('PostgreSQL worker did not close'); })]);
    assert.deepEqual(outcome, { code: 0, signal: null });
    const rows = await admin.query<{ data: { recovered: boolean } }>(`SELECT data FROM ${schema}.kiancode_entities WHERE kind='probe' AND id='recovery'`);
    assert.deepEqual(rows.rows.map((row) => row.data), [{ recovered: true }]);
  } finally {
    if (child && child.exitCode === null) child.kill('SIGKILL');
    await exited;
    await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await admin.end();
  }
});
