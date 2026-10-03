import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { Pool } from 'pg';
import { AgentCoordinator } from '../src/agents/coordinator.js';
import type { BudgetLedgerRecord } from '../src/agents/budget-ledger.js';
import type { Principal } from '../src/contracts.js';
import type { Conversation, Task, TaskEvent } from '../src/domain.js';
import { PostgresStore } from '../src/storage/postgres.js';
import { TaskService } from '../src/tasks.js';

type Checkpoint = 'task_reserve' | 'shared_reserve' | 'task_actual' | 'shared_settle';

interface FixtureIds {
  ownerId: string;
  conversationId: string;
  parentRequestId: string;
  planKey: string;
  childKey: string;
}

interface FixtureMessage {
  type: 'checkpoint' | 'complete' | 'error';
  checkpoint?: Checkpoint;
  parentTaskId?: string;
  childTaskId?: string;
  budgetId?: string;
  message?: string;
}

interface Probe {
  taskId: string;
  call: number;
}

interface RunUsage {
  calls: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  accountedTokens?: number;
}

const databaseUrl = process.env.KIANCODE_TEST_DATABASE_URL ?? '';
const runnerPath = fileURLToPath(new URL('./fixtures/budget-crash-runner.ts', import.meta.url));
const activeChildren = new Set<ChildProcess>();

function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function usageOf(task: Task): RunUsage {
  const usage = task.usage as RunUsage | undefined;
  assert.ok(usage);
  return usage;
}

function sanitized(text: string): string {
  return databaseUrl ? text.replaceAll(databaseUrl, '[redacted]') : text;
}

function startFixture(schema: string, ids: FixtureIds, checkpoint: Checkpoint | 'recover', clock: number): {
  child: ChildProcess;
  message: Promise<FixtureMessage>;
  exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
} {
  const child = spawn(process.execPath, ['--import', 'tsx', runnerPath], {
    cwd: fileURLToPath(new URL('..', import.meta.url)),
    env: {
      KIANCODE_FIXTURE_ISOLATION_DB: databaseUrl,
      KIANCODE_FIXTURE_SCHEMA: schema,
      KIANCODE_FIXTURE_IDS: JSON.stringify(ids),
      KIANCODE_FIXTURE_CHECKPOINT: checkpoint,
      KIANCODE_FIXTURE_CLOCK: String(clock),
    },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  activeChildren.add(child);
  child.once('exit', () => activeChildren.delete(child));
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    child.once('exit', (code, signal) => resolve({ code, signal }));
  });
  let stdout = '';
  let stderr = '';
  child.stdout?.on('data', (chunk: Buffer) => { stdout = `${stdout}${chunk.toString()}`.slice(-16_384); });
  child.stderr?.on('data', (chunk: Buffer) => { stderr = `${stderr}${chunk.toString()}`.slice(-16_384); });
  const message = new Promise<FixtureMessage>((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`Budget crash fixture timed out\n${sanitized(stdout)}\n${sanitized(stderr)}`));
    }, 60_000);
    const finish = (operation: () => void): void => {
      clearTimeout(timer);
      child.off('message', onMessage);
      child.off('exit', onExit);
      operation();
    };
    const onMessage = (raw: Serializable): void => {
      const value = raw as FixtureMessage;
      if (value.type === 'error') {
        finish(() => reject(new Error(`Budget crash fixture failed: ${sanitized(value.message ?? 'unknown error')}`)));
        return;
      }
      finish(() => resolve(value));
    };
    const onExit = (code: number | null, signal: NodeJS.Signals | null): void => {
      finish(() => reject(new Error(
        `Budget crash fixture exited before reporting (${String(code)}/${String(signal)})\n${sanitized(stdout)}\n${sanitized(stderr)}`,
      )));
    };
    child.on('message', onMessage);
    child.on('exit', onExit);
  });
  return { child, message, exited };
}

type Serializable = string | number | boolean | object | null;

async function stop(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
  child.kill('SIGKILL');
  await exited;
}

async function rows(store: PostgresStore, ids: FixtureIds, childTaskId: string) {
  const task = await store.get<Task>('task', childTaskId, ids.ownerId);
  assert.ok(task);
  const parentTaskId = digest(`${ids.ownerId}\0${ids.conversationId}\0${ids.parentRequestId}`);
  const budgetId = digest(`${ids.ownerId}\0${parentTaskId}\0budget`);
  const parent = await store.get<Task>('task', parentTaskId, ids.ownerId);
  const ledger = await store.get<BudgetLedgerRecord>('agent_budget', budgetId, ids.ownerId);
  assert.ok(parent);
  assert.ok(ledger);
  const events = (await store.scan<TaskEvent>('event', ids.ownerId))
    .filter((event) => event.data.taskId === childTaskId)
    .sort((left, right) => left.data.sequence - right.data.sequence);
  const probes = (await store.scan<Probe>('fixture_probe', ids.ownerId))
    .filter((probe) => probe.data.taskId === childTaskId)
    .sort((left, right) => left.data.call - right.data.call);
  return { task, parent, ledger, events, probes, budgetId };
}

function held(ledger: BudgetLedgerRecord): { calls: number; tokens: number } {
  return Object.values(ledger.reservations).reduce((total, reservation) => {
    if (reservation.state === 'reserved') {
      total.calls += reservation.requested.calls;
      total.tokens += reservation.requested.tokens;
    }
    return total;
  }, { calls: 0, tokens: 0 });
}

for (const checkpoint of ['task_reserve', 'shared_reserve', 'task_actual', 'shared_settle'] as const) {
  test(`PostgreSQL: SIGKILL recovery closes the ${checkpoint} budget durability window`, {
    skip: databaseUrl ? false : 'KIANCODE_TEST_DATABASE_URL is not set',
    timeout: 180_000,
  }, async () => {
    const schema = `kiancode_test_${randomBytes(16).toString('hex')}`;
    const admin = new Pool({ connectionString: databaseUrl, max: 1, connectionTimeoutMillis: 5_000 });
    const clock = Date.parse('2026-10-04T00:00:00.000Z');
    const ids: FixtureIds = {
      ownerId: `budget-crash-owner-${checkpoint}`,
      conversationId: `budget-crash-conversation-${checkpoint}`,
      parentRequestId: `budget-crash-parent-${checkpoint}`,
      planKey: `budget-crash-plan-${checkpoint}`,
      childKey: 'worker',
    };
    let store: PostgresStore | undefined;
    let crashed: ChildProcess | undefined;
    let recovered: ChildProcess | undefined;
    try {
      await admin.query(`CREATE SCHEMA ${schema}`);
      const first = startFixture(schema, ids, checkpoint, clock);
      crashed = first.child;
      const marker = await first.message;
      assert.equal(marker.type, 'checkpoint');
      assert.equal(marker.checkpoint, checkpoint);
      assert.ok(marker.childTaskId);
      store = await PostgresStore.connect(databaseUrl, { schema });
      let snapshot = await rows(store, ids, marker.childTaskId);
      assert.equal(snapshot.parent.data.state, 'waiting_for_children');
      assert.equal(snapshot.task.data.state, 'running');
      assert.notEqual(snapshot.task.data.state, 'unknown');
      const interruptedUsage = usageOf(snapshot.task.data);
      assert.equal(interruptedUsage.calls, 1);
      if (checkpoint === 'task_reserve' || checkpoint === 'shared_reserve') {
        assert.equal(interruptedUsage.totalTokens, 0);
        assert.ok((interruptedUsage.accountedTokens ?? 0) > 0);
        assert.deepEqual(snapshot.probes, []);
      } else {
        assert.deepEqual(interruptedUsage, {
          calls: 1,
          inputTokens: 20,
          outputTokens: 5,
          totalTokens: 25,
        });
        assert.deepEqual(snapshot.probes.map((probe) => probe.data.call), [1]);
      }
      const interruptedModelCalls = snapshot.events
        .filter((event) => event.data.type === 'model_call')
        .map((event) => (event.data.payload as { call: number }).call);
      const interruptedUsageEvents = snapshot.events
        .filter((event) => event.data.type === 'usage')
        .map((event) => (event.data.payload as { usage: RunUsage }).usage.calls);
      assert.deepEqual(interruptedModelCalls, checkpoint === 'task_reserve' ? [] : [1]);
      assert.deepEqual(interruptedUsageEvents, checkpoint === 'shared_settle' ? [1] : []);
      const firstReservation = snapshot.ledger.data.reservations[`${marker.childTaskId}:model:1`];
      if (checkpoint === 'task_reserve') {
        assert.equal(firstReservation, undefined);
      } else if (checkpoint === 'shared_settle') {
        assert.equal(firstReservation?.state, 'charged');
        assert.deepEqual(firstReservation?.charged, { calls: 1, tokens: 25 });
      } else {
        assert.equal(firstReservation?.state, 'reserved');
      }

      await stop(crashed);
      crashed = undefined;
      await store.close();
      store = undefined;

      const second = startFixture(schema, ids, 'recover', clock + 2_000);
      recovered = second.child;
      const completion = await second.message;
      assert.equal(completion.type, 'complete');
      let exitTimer: ReturnType<typeof setTimeout> | undefined;
      const exit = await Promise.race([
        second.exited,
        new Promise<never>((_, reject) => {
          exitTimer = setTimeout(() => reject(new Error('Recovered fixture did not exit')), 5_000);
        }),
      ]).finally(() => clearTimeout(exitTimer));
      assert.deepEqual(exit, { code: 0, signal: null });
      recovered = undefined;

      store = await PostgresStore.connect(databaseUrl, { schema });
      snapshot = await rows(store, ids, marker.childTaskId);
      assert.equal(snapshot.parent.data.state, 'waiting_for_children');
      assert.equal(snapshot.task.data.state, 'completed', snapshot.task.data.error);
      assert.notEqual(snapshot.task.data.state, 'unknown');
      const finalUsage = usageOf(snapshot.task.data);
      assert.equal(finalUsage.calls, 2);
      const reserveWindow = checkpoint === 'task_reserve' || checkpoint === 'shared_reserve';
      assert.deepEqual(
        { inputTokens: finalUsage.inputTokens, outputTokens: finalUsage.outputTokens, totalTokens: finalUsage.totalTokens },
        reserveWindow
          ? { inputTokens: 20, outputTokens: 5, totalTokens: 25 }
          : { inputTokens: 40, outputTokens: 10, totalTokens: 50 },
      );
      const call1 = snapshot.ledger.data.reservations[`${marker.childTaskId}:model:1`];
      const call2 = snapshot.ledger.data.reservations[`${marker.childTaskId}:model:2`];
      assert.equal(call1?.state, reserveWindow ? 'reserved' : 'charged');
      assert.equal(call2?.state, 'charged');
      assert.deepEqual(call2?.charged, { calls: 1, tokens: 25 });
      if (reserveWindow) {
        assert.equal(call1?.requested.tokens, interruptedUsage.accountedTokens);
        assert.equal(finalUsage.accountedTokens, call1?.requested.tokens! + 25);
      } else {
        assert.equal(finalUsage.accountedTokens, undefined);
      }
      assert.deepEqual(snapshot.ledger.data.used, reserveWindow
        ? { calls: 1, tokens: 25 }
        : { calls: 2, tokens: 50 });
      const finalHeld = held(snapshot.ledger.data);
      assert.deepEqual(finalHeld, reserveWindow ? call1?.requested : { calls: 0, tokens: 0 });
      assert.deepEqual({
        calls: snapshot.ledger.data.limits.maxCalls - snapshot.ledger.data.used.calls - finalHeld.calls,
        tokens: snapshot.ledger.data.limits.maxTokens - snapshot.ledger.data.used.tokens - finalHeld.tokens,
      }, reserveWindow
        ? { calls: 4, tokens: 64_000 - 25 - call1!.requested.tokens }
        : { calls: 4, tokens: 63_950 });
      assert.deepEqual(snapshot.ledger.data.runtimeUsage[marker.childTaskId], {
        calls: 2,
        tokens: reserveWindow ? 25 : 50,
      });
      assert.deepEqual(snapshot.probes.map((probe) => probe.data.call), reserveWindow ? [2] : [1, 2]);
      const modelCalls = snapshot.events
        .filter((event) => event.data.type === 'model_call')
        .map((event) => (event.data.payload as { call: number }).call);
      assert.deepEqual(modelCalls, checkpoint === 'task_reserve' ? [2] : [1, 2]);
      const usageCalls = snapshot.events
        .filter((event) => event.data.type === 'usage')
        .map((event) => (event.data.payload as { usage: RunUsage }).usage.calls);
      assert.deepEqual(usageCalls, checkpoint === 'shared_settle' ? [1, 2] : [2]);
      for (const event of snapshot.events.filter((candidate) => candidate.data.type === 'usage')) {
        assert.deepEqual((event.data.payload as { providerTokenUsage?: unknown }).providerTokenUsage, {
          inputTokens: 20,
          outputTokens: 5,
        });
      }
      assert.equal(snapshot.events.some((event) => event.data.type === 'tool_dispatched'), false);
      assert.equal((await store.scan('workspace_write_lease', ids.ownerId)).length, 0);
      assert.equal((await store.scan<Task>('task', ids.ownerId)).some((task) => task.data.state === 'unknown'), false);
    } finally {
      if (crashed) await stop(crashed);
      if (recovered) await stop(recovered);
      await store?.close();
      try {
        await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      } finally {
        await admin.end();
      }
    }
  });
}

test('PostgreSQL: first root ledger creation reconstructs one lost reservation from the next pre-dispatch snapshot', {
  skip: databaseUrl ? false : 'KIANCODE_TEST_DATABASE_URL is not set',
  timeout: 30_000,
}, async () => {
  const schema = `kiancode_test_${randomBytes(16).toString('hex')}`;
  const admin = new Pool({ connectionString: databaseUrl, max: 1, connectionTimeoutMillis: 5_000 });
  const ownerId = 'budget-root-gap-owner';
  const principal: Principal = {
    id: ownerId,
    level: 3,
    scopes: ['*'],
    expiresAt: '2100-01-01T00:00:00.000Z',
  };
  const finalUsage: RunUsage = {
    calls: 2,
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    accountedTokens: 11_000,
  };
  let store: PostgresStore | undefined;
  let service: TaskService | undefined;
  try {
    await admin.query(`CREATE SCHEMA ${schema}`);
    store = await PostgresStore.connect(databaseUrl, { schema });
    const conversation = await store.create<Conversation>('conversation', ownerId, {
      title: 'Root budget gap',
      scope: 'private',
      modelPolicy: 'local',
      strategy: 'single',
      mode: 'act',
      archived: false,
    }, 'budget-root-gap-conversation');
    service = new TaskService(store, async () => ({ text: 'unused' }), { now: () => Date.parse('2026-10-04T00:00:00.000Z') });
    let parent = await service.enqueue(principal, conversation.id, 'Create one child', 'budget-root-gap-parent');
    await store.create<TaskEvent>('event', ownerId, {
      taskId: parent.id,
      sequence: 2,
      type: 'model_call',
      payload: {
        type: 'model_call',
        taskId: parent.id,
        modelId: 'controlled-model',
        call: 2,
        reservedTokens: 6_000,
        usage: finalUsage,
      },
      at: '2026-10-04T00:00:00.000Z',
    }, `${parent.id}:gap-model-call-2`);
    parent = await store.put('task', parent.id, ownerId, { ...parent.data, usage: finalUsage }, parent.revision);
    const coordinator = new AgentCoordinator(store, undefined, () => Date.parse('2026-10-04T00:00:00.000Z'));
    const plan = await coordinator.prepare(ownerId, parent.id, {
      key: 'root-gap-plan',
      children: [{ key: 'worker', prompt: 'Do controlled work' }],
      budget: { maxCalls: 6, maxTokens: 64_000 },
    }, { parentRuntimeUsage: finalUsage });
    const budgetId = digest(`${ownerId}\0${parent.id}\0budget`);
    assert.equal(plan.data.budgetId, budgetId);
    let ledger = await store.get<BudgetLedgerRecord>('agent_budget', budgetId, ownerId);
    assert.ok(ledger);
    assert.deepEqual(ledger.data.used, { calls: 0, tokens: 0 });
    assert.deepEqual(ledger.data.runtimeUsage[parent.id], { calls: 2, tokens: 0 });
    assert.deepEqual(ledger.data.reservations[`${parent.id}:model:1`], {
      requested: { calls: 1, tokens: 5_000 },
      state: 'reserved',
    });
    assert.deepEqual(ledger.data.reservations[`${parent.id}:model:2`], {
      requested: { calls: 1, tokens: 6_000 },
      state: 'reserved',
    });
    assert.deepEqual(held(ledger.data), { calls: 2, tokens: 11_000 });
    const revision = ledger.revision;

    await service.close();
    service = undefined;
    for (let restart = 0; restart < 2; restart += 1) {
      await store.close();
      store = await PostgresStore.connect(databaseUrl, { schema });
      const restarted = new AgentCoordinator(store);
      await restarted.reconcileTaskBudget(ownerId, budgetId, parent.id, finalUsage);
      ledger = await store.get<BudgetLedgerRecord>('agent_budget', budgetId, ownerId);
      assert.ok(ledger);
      assert.equal(ledger.revision, revision);
      assert.deepEqual(ledger.data.runtimeUsage[parent.id], { calls: 2, tokens: 0 });
      assert.deepEqual(held(ledger.data), { calls: 2, tokens: 11_000 });
    }
  } finally {
    await service?.close();
    await store?.close();
    try {
      await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    } finally {
      await admin.end();
    }
  }
});

test.after(async () => {
  await Promise.all([...activeChildren].map((child) => stop(child)));
});
