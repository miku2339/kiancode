import assert from 'node:assert/strict';
import test from 'node:test';
import { developmentAuth } from '../src/auth.js';
import { DomainError } from '../src/contracts.js';
import { createServer } from '../src/http/server.js';
import { SqliteStore } from '../src/storage/sqlite.js';
import type { Entity, Store } from '../src/storage/store.js';

const token = 'test-owner-token-with-at-least-thirty-two-characters';
const tickMessage = 'canceling statement due to statement timeout';

class FaultStore implements Store {
  public readonly failScan = new Map<string, unknown>();

  public constructor(private readonly delegate: Store) {}

  public create<T>(kind: string, ownerId: string, data: T, id?: string): Promise<Entity<T>> {
    return this.delegate.create(kind, ownerId, data, id);
  }

  public get<T>(kind: string, id: string, ownerId: string): Promise<Entity<T> | undefined> {
    return this.delegate.get(kind, id, ownerId);
  }

  public async scan<T>(kind: string, ownerId?: string): Promise<Array<Entity<T>>> {
    if (this.failScan.has(kind)) throw this.failScan.get(kind);
    return this.delegate.scan(kind, ownerId);
  }

  public put<T>(kind: string, id: string, ownerId: string, data: T, revision: number): Promise<Entity<T>> {
    return this.delegate.put(kind, id, ownerId, data, revision);
  }

  public remove(kind: string, id: string, ownerId: string, revision: number): Promise<boolean> {
    return this.delegate.remove(kind, id, ownerId, revision);
  }

  public close(): Promise<void> {
    return this.delegate.close();
  }
}

async function failedTicks(server: { tasks: { drain(): Promise<void> } }, count: number): Promise<void> {
  for (let index = 0; index < count; index += 1) {
    await assert.rejects(server.tasks.drain(), new RegExp(tickMessage));
  }
}

test('readiness degrades on the third failed tick and clears on recovery', async () => {
  const store = new FaultStore(new SqliteStore());
  const server = await createServer({
    store,
    authenticate: developmentAuth(token),
    runner: async () => ({ text: 'unused' }),
  });
  const ready = () => server.app.inject({ method: 'GET', url: '/health/ready' });
  try {
    store.failScan.set('task', Object.assign(new Error(tickMessage), { code: '57014' }));
    await failedTicks(server, 2);
    assert.deepEqual((await ready()).json(), { status: 'ready', degraded: false });
    await failedTicks(server, 1);
    const degraded = await ready();
    const body = degraded.json() as { taskTick: { lastErrorAt: string } };
    assert.deepEqual(body, {
      status: 'degraded',
      degraded: true,
      taskTick: { consecutiveFailures: 3, lastErrorAt: body.taskTick.lastErrorAt },
    });
    assert.equal(degraded.body.includes(tickMessage), false);
    assert.equal(degraded.body.includes('57014'), false);

    store.failScan.clear();
    await server.tasks.drain();
    assert.deepEqual((await ready()).json(), { status: 'ready', degraded: false });
  } finally {
    await server.close();
  }
});

test('tick logs are bounded and emitted only for the first, each sixtieth and recovery', async () => {
  const store = new FaultStore(new SqliteStore());
  const lines: string[] = [];
  const server = await createServer({
    store,
    authenticate: developmentAuth(token),
    runner: async () => ({ text: 'unused' }),
    logger: { level: 'warn', stream: { write: (line: string) => { lines.push(line); } } },
  });
  const entries = () => lines.map((line) => JSON.parse(line) as Record<string, unknown>);
  try {
    store.failScan.set('task', Object.assign(new Error(tickMessage), { code: '57014' }));
    await failedTicks(server, 120);
    assert.deepEqual(entries().map((entry) => entry.consecutiveFailures), [1, 60, 120]);
    assert.deepEqual(entries().map((entry) => entry.event), [
      'task_tick_failed',
      'task_tick_failed',
      'task_tick_failed',
    ]);
    for (const entry of entries()) {
      assert.equal('err' in entry, false);
      assert.equal('stack' in entry, false);
    }

    store.failScan.clear();
    await server.tasks.drain();
    const recovery = entries()[3]!;
    assert.equal(recovery.event, 'task_tick_recovered');
    assert.equal(recovery.failedTicks, 120);
  } finally {
    await server.close();
  }
});

test('tick logs never include a raw error URL, password or token', async () => {
  const store = new FaultStore(new SqliteStore());
  const lines: string[] = [];
  const server = await createServer({
    store,
    authenticate: developmentAuth(token),
    runner: async () => ({ text: 'unused' }),
    logger: { level: 'warn', stream: { write: (line: string) => { lines.push(line); } } },
  });
  try {
    store.failScan.set('task', Object.assign(
      new Error('database failed at https://alice:synthetic-password@example.invalid/private?token=synthetic-token'),
      { code: 'synthetic-secret-code' },
    ));
    await assert.rejects(server.tasks.drain());
    const output = lines.join('');
    assert.equal(output.includes('synthetic-password'), false);
    assert.equal(output.includes('synthetic-token'), false);
    assert.equal(output.includes('example.invalid'), false);
    assert.equal(output.includes('synthetic-secret-code'), false);
    assert.equal((JSON.parse(lines[0]!) as { code?: string }).code, 'internal_error');

    store.failScan.clear();
    await server.tasks.drain();
    store.failScan.set('task', new DomainError(
      'https://synthetic.invalid/private?token=domain-secret',
      'safe message',
    ));
    await assert.rejects(server.tasks.drain());
    const domainOutput = lines.join('');
    assert.equal(domainOutput.includes('synthetic.invalid'), false);
    assert.equal(domainOutput.includes('domain-secret'), false);
    assert.equal((JSON.parse(lines.at(-1)!) as { code?: string }).code, 'domain_error');
  } finally {
    await server.close();
  }
});
