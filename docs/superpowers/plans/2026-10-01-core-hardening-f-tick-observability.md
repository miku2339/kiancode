# Tick Observability and One-Time Notification Publish (F) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A stalled task tick becomes visible (counted, logged, reported by `/health/ready` after three consecutive failures) without one failing reconcile phase stopping task execution, and the per-tick notification reconcile stops doing one store round trip per historical task.

**Architecture:** `TaskService` runs its three tick phases (notification reconcile, reconciler callback, claim loop) independently, keeps an in-memory count of consecutive failed ticks and reports each failed tick once through a callback. `createServer` turns that callback into thinned log lines on the Fastify logger and adds a `taskTick` block to `/health/ready` once three consecutive ticks have failed; `bootstrap` switches the logger on at warn level. `NotificationService.reconcile` keeps a process-local set of notification ids known to be stored, seeded by one scan of the existing dedupe records, and skips every task, schedule and event trigger whose notification id is in it. Nothing new is persisted.

**Tech Stack:** TypeScript (NodeNext modules), Node.js 24, Fastify 5 with its bundled pino logger, `node:test` run through `tsx --test`, in-memory `SqliteStore` for tests. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-10-01-core-hardening-design.md` (section F)

## Global Constraints

- Node.js 24 or later. TypeScript with two-space indent, single quotes, semicolons and explicit public interfaces.
- Tests use `node:test` and run with `tsx --test`. Behaviour is tested through public interfaces. `npm run check` (typecheck, tests, build) passes before delivery.
- No new runtime dependencies. (The logger is the pino instance Fastify already bundles.)
- SQLite is for development and tests; PostgreSQL is production. Entities already stored in a deployed database must remain readable without a data rewrite. (This plan adds no entity kind, no stored field and no write to an existing row.)
- Development authentication mode keeps its current behaviour.
- Errors are `DomainError(code, message, statusCode)` with snake_case codes. Existing codes and HTTP statuses do not change unless a workstream says so. (This plan adds no error code and changes no HTTP status; `/health/ready` stays 200 when it reports `degraded`.)
- The distinction between dispatched, confirmed and unknown external outcomes is preserved. (The `task_unknown` notification stays a separate type with its own dedupe key.)
- No personal data, hostnames, secrets or production configuration in the repository.
- Line numbers in this plan refer to commit `17d571f`; function and symbol names are the stable anchors once earlier workstreams have landed.
- Execution order is G, A, C, B1, B2, D, E, F. This plan runs last. Locate every edit by the quoted text, not by the line number: earlier plans move the lines of `src/tasks.ts`, `src/http/server.ts`, `src/bootstrap.ts`, `src/notifications.ts` and `README.md`, but every quoted block below was matched exactly once on a copy of the repository with plans G, A, C, B1, B2, D and E applied (and, for Tasks 1 to 5, on plain `17d571f` as well).
- Values fixed by the spec for this workstream: `/health/ready` reports degraded once **3** consecutive ticks have failed and returns to ready on the next successful tick; it exposes only the count and the time of the last failure. The server logger records the **first** failure of a streak, **every 60th** consecutive failure and **one** line on recovery; the counter itself is exact. `bootstrap` enables the logger at level **`warn`**.
- Commit subjects are in Traditional Chinese with a type prefix and a full-width colon (`修復：…`, `實現：…`, `測試：…`, `文件：…`).
- Run every command from the repository root.

How edits are written in this plan: "In `path`, replace:" is followed by the exact existing text and then "with:" and the replacement. Each quoted existing block occurs exactly once in its file. "Append to the end of `path`:" adds the block after one blank line. "Create `path` with:" is the whole file.

## Review Focus

1. **One bad stored notification or one failing agent reconcile.** Input: `notifications.reconcile()` or the reconciler callback throws on every tick (for example `idempotency_conflict` from one stored row). Expected: queued tasks are still claimed and run in that same tick, and the failure is still reported. Pinned in Task 1 by `a failing notification reconcile is reported by the tick but does not stop tasks from being claimed` and `a failing reconciler is reported by the tick but does not stop tasks from being claimed`.
2. **The tick fails for good while HTTP keeps answering.** Input: every tick throws (for example a statement timeout). Expected: from the third consecutive failure `/health/ready` answers `status: 'degraded'`, `degraded: true` with `taskTick: { consecutiveFailures, lastErrorAt }` and nothing else about the error; the next successful tick returns it to exactly `{ status: 'ready', degraded: false }`. Pinned in Task 3 by `readiness is degraded from the third consecutive failed tick, exposes only the count and the time, and recovers on the next successful tick`.
3. **A blip.** Input: one or two failed ticks followed by a successful one. Expected: readiness never leaves `ready`, so a monitor or a release activation does not react to a transient error. Pinned in Task 3 by `readiness stays ready while fewer than three consecutive ticks have failed`.
4. **An outage that lasts hours.** Input: thousands of consecutive failed ticks, one per second. Expected: the log has one line for the first failure, one for every 60th and one for the recovery, never a line per tick, and never a request URL or a bearer token; the counter in readiness is still exact. Pinned in Task 4 by `the server logger records the first failed tick, every sixtieth one and the recovery, and nothing about requests`.
5. **A long history, a restart, and a store error in the middle of publishing.** Input: a store full of terminal tasks; the process restarts; one `create('notification')` fails once. Expected: every terminal task gets exactly one notification, none is lost and none is duplicated; after the first reconcile of a process, a tick does no store call per historical task; no task row is written. Pinned in Task 6 by `reconcile publishes each terminal task once and later reconciles make no store call per task`, `a new process seeds from the stored notifications with one scan and publishes nothing twice`, `a notification that could not be stored is retried on the next reconcile and stored exactly once` and `approval, unknown and completion notifications of one task are each published once and no task row is written`.

## File Structure

| File | Action | Responsibility |
| --- | --- | --- |
| `src/tasks.ts` | modify | Run the tick phases independently; count consecutive failed ticks; report each failed tick and each recovery once; expose `tickStatus()`. |
| `src/http/server.ts` | modify | `/health/ready` reports a stalled tick; tick failures and recoveries are written to the Fastify logger, thinned; `ServerOptions.logger` accepts a level and an optional stream. |
| `src/bootstrap.ts` | modify | Enable the server logger at warn level for every bootstrapped deployment. |
| `src/notifications.ts` | modify | `reconcile()` publishes each notification key once per process, seeded from the stored notifications. |
| `README.md` | modify | State the readiness and logging contract in the Deployment section. |
| `test/task-tick.test.ts` | create | Phase isolation, tick counting and reporting, through `TaskService` only. |
| `test/health-ready.test.ts` | create | `/health/ready` with a failing tick, with and without an outage service; the log lines written by `createServer`. |
| `test/bootstrap-logging.test.ts` | create | `bootstrap` enables the warn-level logger. |
| `test/notification-reconcile.test.ts` | create | Once-only reconcile for tasks, schedules and event triggers; restart, retry and no task writes. |

No existing test file is edited.

---

### Task 1: Tick phases are isolated

A tick has three phases: `notifications.reconcile()`, the reconciler callback set by bootstrap (agent plans, scheduler, event triggers) and the claim loop. Today a throw in the first or second phase aborts the tick before any task is claimed, and it repeats every second, so task execution stops completely while HTTP keeps answering. After this task every phase runs in every tick and the tick rejects with the first failure after the claim loop has run.

**Files:**
- Create: `test/task-tick.test.ts`
- Modify: `src/tasks.ts` (`interface ActiveRun`, line 39; `tickInternal`, lines 521-524 as of commit 17d571f)
- Test: `test/task-tick.test.ts`

**Interfaces:**
- Consumes: `TaskService` constructor `(store: Store, runner: TaskRunner, options?: TaskServiceOptions)`, `TaskService.enqueue(principal, conversationId, prompt)`, `TaskService.drain(): Promise<void>`, `TaskService.setReconciler(reconciler: (() => Promise<void>) | undefined): void`, `TaskServiceOptions.notifications?: Pick<NotificationService, 'publishTask' | 'reconcile'>` (all existing).
- Produces: `export type TaskTickPhase = 'notifications' | 'reconciler' | 'tasks'` in `src/tasks.ts`; private `TaskService.runPhases(): Promise<TickPhaseFailure | undefined>` and private `TaskService.claimTasks(): Promise<void>` (Task 2 rewrites the body of `tickInternal` around `runPhases`). `drain()` and the timer still reject with the original thrown value. The test helper class `FaultStore` and the function `waitForState` in `test/task-tick.test.ts` are reused by Task 2.

- [ ] **Step 1: Write the failing test**

Create `test/task-tick.test.ts` with:

```ts
import assert from 'node:assert/strict';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { DomainError, type Principal } from '../src/contracts.js';
import type { Conversation, Task } from '../src/domain.js';
import { SqliteStore } from '../src/storage/sqlite.js';
import type { Entity, Store } from '../src/storage/store.js';
import { TaskService } from '../src/tasks.js';

const principal: Principal = { id: 'alice', level: 1, scopes: ['*'] };
const conversation: Conversation = {
  title: 'Tick',
  scope: 'private',
  modelPolicy: 'cloud',
  strategy: 'single',
  mode: 'ask',
  archived: false,
};

class FaultStore implements Store {
  public readonly failScan = new Map<string, unknown>();
  public scanDelayMs = 0;

  public constructor(private readonly delegate: Store) {}

  public create<T>(kind: string, ownerId: string, data: T, id?: string): Promise<Entity<T>> {
    return this.delegate.create(kind, ownerId, data, id);
  }

  public get<T>(kind: string, id: string, ownerId: string): Promise<Entity<T> | undefined> {
    return this.delegate.get(kind, id, ownerId);
  }

  public async scan<T>(kind: string, ownerId?: string): Promise<Array<Entity<T>>> {
    if (this.failScan.has(kind)) {
      if (this.scanDelayMs) await delay(this.scanDelayMs);
      throw this.failScan.get(kind);
    }
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

async function waitForState(store: Store, taskId: string, state: Task['state'], timeoutMs = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while ((await store.get<Task>('task', taskId, principal.id))?.data.state !== state) {
    if (Date.now() >= deadline) break;
    await delay(5);
  }
  assert.equal((await store.get<Task>('task', taskId, principal.id))?.data.state, state);
}

test('a failing notification reconcile is reported by the tick but does not stop tasks from being claimed', async () => {
  const store = new SqliteStore();
  const failure = new DomainError('idempotency_conflict', 'Notification key belongs to another event.', 409);
  const service = new TaskService(store, async () => ({ text: 'done' }), {
    notifications: {
      publishTask: async () => undefined,
      reconcile: async () => { throw failure; },
    },
  });
  try {
    const thread = await store.create('conversation', principal.id, conversation);
    const task = await service.enqueue(principal, thread.id, 'run despite the notification failure');
    await assert.rejects(service.drain(), (error: unknown) => error === failure);
    await waitForState(store, task.id, 'completed');
  } finally { await service.close(); await store.close(); }
});

test('a failing reconciler is reported by the tick but does not stop tasks from being claimed', async () => {
  const store = new SqliteStore();
  const failure = new Error('agent reconcile failed');
  const service = new TaskService(store, async () => ({ text: 'done' }));
  service.setReconciler(async () => { throw failure; });
  try {
    const thread = await store.create('conversation', principal.id, conversation);
    const task = await service.enqueue(principal, thread.id, 'run despite the reconciler failure');
    await assert.rejects(service.drain(), (error: unknown) => error === failure);
    await waitForState(store, task.id, 'completed');
  } finally { await service.close(); await store.close(); }
});

test('the reconciler still runs after a notification failure and the tick rejects with the first failure', async () => {
  const store = new SqliteStore();
  const notificationFailure = new Error('notification reconcile failed');
  let reconcilerRuns = 0;
  const service = new TaskService(store, async () => ({ text: 'done' }), {
    notifications: {
      publishTask: async () => undefined,
      reconcile: async () => { throw notificationFailure; },
    },
  });
  service.setReconciler(async () => {
    reconcilerRuns += 1;
    throw new Error('agent reconcile failed');
  });
  try {
    await assert.rejects(service.drain(), (error: unknown) => error === notificationFailure);
    assert.equal(reconcilerRuns, 1);
  } finally { await service.close(); await store.close(); }
});

test('a storage failure in the claim loop still rejects the tick with the original error', async () => {
  const store = new FaultStore(new SqliteStore());
  const failure = new DomainError('storage_unavailable', 'Primary storage is unavailable.', 503);
  const service = new TaskService(store, async () => ({ text: 'done' }));
  try {
    store.failScan.set('task', failure);
    await assert.rejects(service.drain(), (error: unknown) => error === failure);
    store.failScan.clear();
    await service.drain();
  } finally { await service.close(); await store.close(); }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx --test test/task-tick.test.ts`

Expected: 4 tests, 1 pass, 3 fail. The fourth test passes already (it pins behaviour that must not change). The failures are:

```text
✖ a failing notification reconcile is reported by the tick but does not stop tasks from being claimed
  AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:
  + actual - expected
  + 'queued'
  - 'completed'
✖ a failing reconciler is reported by the tick but does not stop tasks from being claimed
  AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:
  + actual - expected
  + 'queued'
  - 'completed'
✖ the reconciler still runs after a notification failure and the tick rejects with the first failure
  AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:
  0 !== 1
```

- [ ] **Step 3: Write minimal implementation**

Two edits in `src/tasks.ts`. Nothing inside the claim loop changes; it only moves into its own method.

In `src/tasks.ts`, replace:

```ts
interface ActiveRun {
  ownerId: string;
```

with:

```ts
export type TaskTickPhase = 'notifications' | 'reconciler' | 'tasks';

interface TickPhaseFailure {
  phase: TaskTickPhase;
  error: unknown;
}

interface ActiveRun {
  ownerId: string;
```

In `src/tasks.ts`, replace:

```ts
  private async tickInternal(): Promise<void> {
    await this.options.notifications?.reconcile();
    await this.reconciler?.();
    let tasks = await this.store.scan<Task>('task');
```

with:

```ts
  private async tickInternal(): Promise<void> {
    const failure = await this.runPhases();
    if (failure) {
      throw failure.error;
    }
  }

  // Every phase runs in every tick. A failing phase never stops a later one; the first failure is the one reported.
  private async runPhases(): Promise<TickPhaseFailure | undefined> {
    let failure: TickPhaseFailure | undefined;
    const phase = async (name: TaskTickPhase, run: () => Promise<unknown>): Promise<void> => {
      try {
        await run();
      } catch (error) {
        failure ??= { phase: name, error };
      }
    };
    await phase('notifications', async () => this.options.notifications?.reconcile());
    await phase('reconciler', async () => this.reconciler?.());
    await phase('tasks', () => this.claimTasks());
    return failure;
  }

  private async claimTasks(): Promise<void> {
    let tasks = await this.store.scan<Task>('task');
```

The rest of the old `tickInternal` body (lease recovery and the claim loop, down to its closing brace) is now the body of `claimTasks` and is not edited.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx tsc --noEmit && npx tsx --test test/task-tick.test.ts`

Expected: no typecheck output; `ℹ tests 4`, `ℹ pass 4`, `ℹ fail 0`.

Then run the suites that drive the tick: `npx tsx --test test/tasks.test.ts test/notifications.test.ts test/api.test.ts`

Expected: `ℹ fail 0`.

- [ ] **Step 5: Commit**

```bash
git add src/tasks.ts test/task-tick.test.ts
git commit -m "修復：對帳階段失敗不再阻止同一 tick 認領任務"
```

### Task 2: TaskService counts and reports every failed tick

Today nothing records a tick outcome. `start()` attaches a `catch` on every timer firing, and `tick()` returns the in-flight promise, so one slow failing tick calls `onError` once per timer firing; `drain()` never calls it. After this task the outcome is recorded where the tick actually runs (`tickInternal`): exactly one count and one report per tick run, whoever started it.

**Files:**
- Modify: `src/tasks.ts` (`TaskServiceOptions`, lines 28-37; the `TaskTickPhase` type added by Task 1; class fields, line 214; `setReconciler`, lines 329-331; `start`, line 487; `tickInternal` as left by Task 1; a helper before `orderMessages`, line 1049, as of commit 17d571f)
- Test: `test/task-tick.test.ts`

**Interfaces:**
- Consumes: from Task 1, `TaskTickPhase`, `TickPhaseFailure { phase: TaskTickPhase; error: unknown }`, `TaskService.runPhases(): Promise<TickPhaseFailure | undefined>`, and the test helper `FaultStore`. Existing: `TaskServiceOptions.now?: () => number`, `TaskServiceOptions.onError?: (error: unknown) => void`.
- Produces (all exported from `src/tasks.ts`):
  - `interface TaskTickStatus { consecutiveFailures: number; lastErrorAt?: string }` — `consecutiveFailures` is 0 before the first tick and after any successful tick; `lastErrorAt` is the ISO time of the most recent failed tick and is kept after recovery. In memory only.
  - `interface TaskTickFailure { phase: TaskTickPhase; code: string; message: string; consecutiveFailures: number }` — `code` is the thrown value's string `code` property cut to 100 characters, else `'internal_error'`; `message` is `Error.message` cut to 500 characters, else `'Task tick failed'`.
  - `interface TaskTickRecovery { failedTicks: number }`
  - `TaskServiceOptions.onTickError?: (failure: TaskTickFailure) => void` — called once per failed tick run. When absent, the thrown value goes to `onError` once per failed tick run.
  - `TaskServiceOptions.onTickRecovered?: (recovery: TaskTickRecovery) => void` — called once when a tick succeeds after one or more consecutive failures.
  - `TaskService.tickStatus(): TaskTickStatus`
  - Nothing is counted or reported once `close()` has been called. `onError` keeps receiving the post-run notification and storage errors exactly as before.

- [ ] **Step 1: Write the failing test**

In `test/task-tick.test.ts`, replace:

```ts
import { TaskService } from '../src/tasks.js';
```

with:

```ts
import { TaskService, type TaskTickFailure, type TaskTickRecovery } from '../src/tasks.js';
```

Append to the end of `test/task-tick.test.ts`:

```ts
test('each failed tick is counted once, timestamped and reported, and a successful tick resets the count', async () => {
  const store = new FaultStore(new SqliteStore());
  let now = Date.parse('2026-10-01T12:00:00.000Z');
  const failures: TaskTickFailure[] = [];
  const recoveries: TaskTickRecovery[] = [];
  const otherErrors: unknown[] = [];
  const service = new TaskService(store, async () => ({ text: 'done' }), {
    now: () => now,
    onError: (error) => otherErrors.push(error),
    onTickError: (failure) => failures.push(failure),
    onTickRecovered: (recovery) => recoveries.push(recovery),
  });
  try {
    assert.deepEqual(service.tickStatus(), { consecutiveFailures: 0 });
    await service.drain();
    assert.deepEqual(service.tickStatus(), { consecutiveFailures: 0 });
    assert.deepEqual(recoveries, []);

    const failure = new DomainError('storage_unavailable', 'Primary storage is unavailable.', 503);
    store.failScan.set('task', failure);
    await assert.rejects(service.drain(), (error: unknown) => error === failure);
    assert.deepEqual(service.tickStatus(), { consecutiveFailures: 1, lastErrorAt: '2026-10-01T12:00:00.000Z' });
    now += 1_000;
    await assert.rejects(service.drain(), (error: unknown) => error === failure);
    assert.deepEqual(service.tickStatus(), { consecutiveFailures: 2, lastErrorAt: '2026-10-01T12:00:01.000Z' });
    assert.deepEqual(failures, [
      { phase: 'tasks', code: 'storage_unavailable', message: 'Primary storage is unavailable.', consecutiveFailures: 1 },
      { phase: 'tasks', code: 'storage_unavailable', message: 'Primary storage is unavailable.', consecutiveFailures: 2 },
    ]);

    store.failScan.clear();
    now += 1_000;
    await service.drain();
    assert.deepEqual(service.tickStatus(), { consecutiveFailures: 0, lastErrorAt: '2026-10-01T12:00:01.000Z' });
    assert.deepEqual(recoveries, [{ failedTicks: 2 }]);
    await service.drain();
    assert.deepEqual(recoveries, [{ failedTicks: 2 }]);
    assert.equal(failures.length, 2);
    assert.deepEqual(otherErrors, []);
  } finally { await service.close(); await store.close(); }
});

test('a tick failure report names the phase and carries a bounded code and message for any thrown value', async () => {
  const store = new FaultStore(new SqliteStore());
  const failures: TaskTickFailure[] = [];
  const reconcilerFailures: unknown[] = [];
  const service = new TaskService(store, async () => ({ text: 'done' }), {
    notifications: {
      publishTask: async () => undefined,
      reconcile: async () => { await store.scan('notification'); },
    },
    onTickError: (failure) => failures.push(failure),
  });
  service.setReconciler(async () => {
    if (reconcilerFailures.length) throw reconcilerFailures[0];
  });
  try {
    store.failScan.set('task', Object.assign(new Error('canceling statement due to statement timeout'), { code: '57014' }));
    await assert.rejects(service.drain());
    store.failScan.set('task', new Error(`first line\n${'x'.repeat(10_000)}`));
    await assert.rejects(service.drain());
    store.failScan.set('task', 'a thrown string');
    await assert.rejects(service.drain());
    store.failScan.set('task', undefined);
    await assert.rejects(service.drain());
    store.failScan.clear();
    reconcilerFailures.push(Object.assign(new Error('agent reconcile failed'), { code: 'c'.repeat(300) }));
    await assert.rejects(service.drain());
    reconcilerFailures.length = 0;
    store.failScan.set('notification', new DomainError('storage_unavailable', 'Primary storage is unavailable.', 503));
    await assert.rejects(service.drain());

    assert.deepEqual(failures.map((failure) => [failure.phase, failure.code, failure.consecutiveFailures]), [
      ['tasks', '57014', 1],
      ['tasks', 'internal_error', 2],
      ['tasks', 'internal_error', 3],
      ['tasks', 'internal_error', 4],
      ['reconciler', 'c'.repeat(100), 5],
      ['notifications', 'storage_unavailable', 6],
    ]);
    assert.equal(failures[0]?.message, 'canceling statement due to statement timeout');
    assert.equal(failures[1]?.message.length, 500);
    assert.equal(failures[1]?.message.startsWith('first line\nxxx'), true);
    assert.equal(failures[2]?.message, 'Task tick failed');
    assert.equal(failures[3]?.message, 'Task tick failed');
  } finally { await service.close(); await store.close(); }
});

test('a slow failing tick driven by the timer is reported once per tick run and never as an unhandled rejection', async () => {
  const store = new FaultStore(new SqliteStore());
  const failures: TaskTickFailure[] = [];
  const service = new TaskService(store, async () => ({ text: 'done' }), {
    onTickError: (failure) => failures.push(failure),
  });
  const silent = new TaskService(store, async () => ({ text: 'done' }));
  try {
    store.scanDelayMs = 30;
    store.failScan.set('task', new Error('slow failure'));
    service.start(2);
    silent.start(2);
    const deadline = Date.now() + 2_000;
    while (failures.length < 3 && Date.now() < deadline) await delay(5);
    await service.close();
    await silent.close();
    const reported = failures.map((failure) => failure.consecutiveFailures);
    assert.ok(reported.length >= 3, `expected at least three reports, saw ${reported.length}`);
    assert.deepEqual(reported, reported.map((_value, index) => index + 1));
    assert.equal(service.tickStatus().consecutiveFailures, reported.length);
    assert.ok(silent.tickStatus().consecutiveFailures >= 1);

    await delay(60);
    assert.equal(failures.length, reported.length, 'a tick that fails after close is not reported');
    assert.equal(service.tickStatus().consecutiveFailures, reported.length);
  } finally { await service.close(); await silent.close(); await store.close(); }
});

test('without onTickError the original tick error reaches onError exactly once per failed tick', async () => {
  const store = new FaultStore(new SqliteStore());
  const errors: unknown[] = [];
  const service = new TaskService(store, async () => ({ text: 'done' }), {
    onError: (error) => errors.push(error),
  });
  try {
    const failure = new Error('scan failed');
    store.failScan.set('task', failure);
    await assert.rejects(service.drain(), (error: unknown) => error === failure);
    await assert.rejects(service.drain(), (error: unknown) => error === failure);
    assert.deepEqual(errors, [failure, failure]);
    assert.equal(service.tickStatus().consecutiveFailures, 2);
  } finally { await service.close(); await store.close(); }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx --test test/task-tick.test.ts`

Expected: 8 tests, 4 pass, 4 fail (the timer-driven test, third in the list below, takes about two seconds before it gives up):

```text
✖ each failed tick is counted once, timestamped and reported, and a successful tick resets the count
  TypeError [Error]: service.tickStatus is not a function
✖ a tick failure report names the phase and carries a bounded code and message for any thrown value
  AssertionError [ERR_ASSERTION]: Expected values to be strictly deep-equal:
✖ a slow failing tick driven by the timer is reported once per tick run and never as an unhandled rejection
  AssertionError [ERR_ASSERTION]: expected at least three reports, saw 0
✖ without onTickError the original tick error reaches onError exactly once per failed tick
  AssertionError [ERR_ASSERTION]: Expected values to be strictly deep-equal:
```

- [ ] **Step 3: Write minimal implementation**

Seven edits in `src/tasks.ts`.

In `src/tasks.ts`, replace:

```ts
  onError?: (error: unknown) => void;
```

with:

```ts
  onError?: (error: unknown) => void;
  /** Called once per failed tick. When absent, the thrown value goes to `onError` instead. */
  onTickError?: (failure: TaskTickFailure) => void;
  /** Called once when a tick succeeds after one or more consecutive failed ticks. */
  onTickRecovered?: (recovery: TaskTickRecovery) => void;
```

In `src/tasks.ts`, replace:

```ts
export type TaskTickPhase = 'notifications' | 'reconciler' | 'tasks';
```

with:

```ts
export type TaskTickPhase = 'notifications' | 'reconciler' | 'tasks';

export interface TaskTickStatus {
  consecutiveFailures: number;
  lastErrorAt?: string;
}

export interface TaskTickFailure {
  phase: TaskTickPhase;
  code: string;
  message: string;
  consecutiveFailures: number;
}

export interface TaskTickRecovery {
  failedTicks: number;
}
```

In `src/tasks.ts`, replace:

```ts
  private reconciler?: () => Promise<void>;
```

with:

```ts
  private reconciler?: () => Promise<void>;
  private tickFailures = 0;
  private tickLastErrorAt?: string;
```

In `src/tasks.ts`, replace:

```ts
  public setReconciler(reconciler: (() => Promise<void>) | undefined): void {
    this.reconciler = reconciler;
  }
```

with:

```ts
  public setReconciler(reconciler: (() => Promise<void>) | undefined): void {
    this.reconciler = reconciler;
  }

  public tickStatus(): TaskTickStatus {
    return {
      consecutiveFailures: this.tickFailures,
      ...(this.tickLastErrorAt ? { lastErrorAt: this.tickLastErrorAt } : {}),
    };
  }
```

In `src/tasks.ts`, replace:

```ts
      void this.tick().catch((error) => this.options.onError?.(error));
```

with:

```ts
      // The failure was already counted and reported by tickInternal; this only prevents an unhandled rejection.
      void this.tick().catch(() => undefined);
```

In `src/tasks.ts`, replace:

```ts
    const failure = await this.runPhases();
    if (failure) {
      throw failure.error;
    }
  }
```

with:

```ts
    const failure = await this.runPhases();
    if (!failure) {
      if (!this.stopped && this.tickFailures > 0) {
        const failedTicks = this.tickFailures;
        this.tickFailures = 0;
        this.options.onTickRecovered?.({ failedTicks });
      }
      return;
    }
    if (!this.stopped) {
      this.tickFailures += 1;
      this.tickLastErrorAt = new Date(this.now()).toISOString();
      if (this.options.onTickError) {
        this.options.onTickError({
          phase: failure.phase,
          ...describeTickError(failure.error),
          consecutiveFailures: this.tickFailures,
        });
      } else {
        this.options.onError?.(failure.error);
      }
    }
    throw failure.error;
  }
```

In `src/tasks.ts`, replace:

```ts
export function orderMessages<T extends Entity<Message>>(messages: T[]): T[] {
```

with:

```ts
function describeTickError(error: unknown): { code: string; message: string } {
  const code = (error as { code?: unknown } | null | undefined)?.code;
  return {
    code: typeof code === 'string' && code ? code.slice(0, 100) : 'internal_error',
    message: error instanceof Error && error.message ? error.message.slice(0, 500) : 'Task tick failed',
  };
}

export function orderMessages<T extends Entity<Message>>(messages: T[]): T[] {
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx tsc --noEmit && npx tsx --test test/task-tick.test.ts`

Expected: no typecheck output; `ℹ tests 8`, `ℹ pass 8`, `ℹ fail 0`.

Then: `npx tsx --test test/tasks.test.ts test/notifications.test.ts test/api.test.ts`

Expected: `ℹ fail 0`.

- [ ] **Step 5: Commit**

```bash
git add src/tasks.ts test/task-tick.test.ts
git commit -m "實現：任務 tick 每次失敗只計數並回報一次"
```

### Task 3: `/health/ready` reports a stalled tick

`GET /health/ready` is public and today looks only at the store and the outage journal. After this task it also answers `status: 'degraded'`, `degraded: true` and adds `taskTick: { consecutiveFailures, lastErrorAt }` once three consecutive ticks have failed, and goes back to the unchanged healthy body on the next successful tick. The error code, message and phase are never exposed. The shared outage flag (`degraded` closure variable, `setDegraded`, `isDegraded`), `/health/live` and `/v1/health` are not touched.

**Files:**
- Create: `test/health-ready.test.ts`
- Modify: `src/http/server.ts` (`ServerOptions`, line 55; the `/health/ready` route, lines 245-257 as of commit 17d571f)
- Test: `test/health-ready.test.ts`

**Interfaces:**
- Consumes: from Task 2, `TaskService.tickStatus(): TaskTickStatus` with `TaskTickStatus { consecutiveFailures: number; lastErrorAt?: string }`. Existing: `createServer(options: ServerOptions)` returning `{ app, tasks, isDegraded(), close(), ... }`, `developmentAuth(token)`, `OutageService`, `createStoreReplaySink(store)`.
- Produces: the `/health/ready` response contract:
  - fewer than 3 consecutive failed ticks: unchanged, `200 { "status": "ready", "degraded": false }` plus `"outage"` when an outage service is configured;
  - 3 or more: `200 { "status": "degraded", "degraded": true, "taskTick": { "consecutiveFailures": <number>, "lastErrorAt": "<ISO time>" } }` plus `"outage"` when configured;
  - storage unavailable with an outage service: the existing degraded body plus `"taskTick"` when 3 or more ticks have failed;
  - storage unavailable without an outage service: unchanged `503 service_unavailable`.
  - Module constant `tickDegradedAfter = 3` in `src/http/server.ts`. The test helper class `FaultStore` and the functions `failTicks` and `failedTicks` in `test/health-ready.test.ts` are reused by Task 4.

- [ ] **Step 1: Write the failing test**

Create `test/health-ready.test.ts` with:

```ts
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { developmentAuth } from '../src/auth.js';
import { createServer } from '../src/http/server.js';
import { createStoreReplaySink, OutageService } from '../src/outage/index.js';
import { SqliteStore } from '../src/storage/sqlite.js';
import type { Entity, Store } from '../src/storage/store.js';

const token = 'test-owner-token-with-at-least-thirty-two-characters';
const headers = { authorization: `Bearer ${token}` };
const tickMessage = 'canceling statement due to statement timeout';
const tickCode = '57014';

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

function failTicks(store: FaultStore): void {
  store.failScan.set('task', Object.assign(new Error(tickMessage), { code: tickCode }));
}

async function failedTicks(server: { tasks: { drain(): Promise<void> } }, count: number): Promise<void> {
  for (let index = 0; index < count; index += 1) {
    await assert.rejects(server.tasks.drain(), new RegExp(tickMessage));
  }
}

test('readiness stays ready while fewer than three consecutive ticks have failed', async () => {
  const store = new FaultStore(new SqliteStore());
  const server = await createServer({ store, authenticate: developmentAuth(token), runner: async () => ({ text: 'unused' }) });
  const ready = () => server.app.inject({ method: 'GET', url: '/health/ready' });
  try {
    await server.tasks.drain();
    const healthy = await ready();
    assert.equal(healthy.statusCode, 200);
    assert.deepEqual(healthy.json(), { status: 'ready', degraded: false });

    failTicks(store);
    await failedTicks(server, 2);
    assert.equal(server.tasks.tickStatus().consecutiveFailures, 2);
    assert.deepEqual((await ready()).json(), { status: 'ready', degraded: false });

    store.failScan.clear();
    await server.tasks.drain();
    failTicks(store);
    await failedTicks(server, 2);
    assert.deepEqual((await ready()).json(), { status: 'ready', degraded: false });
  } finally { await server.close(); }
});

test('readiness is degraded from the third consecutive failed tick, exposes only the count and the time, and recovers on the next successful tick', async () => {
  const store = new FaultStore(new SqliteStore());
  const server = await createServer({ store, authenticate: developmentAuth(token), runner: async () => ({ text: 'unused' }) });
  const ready = () => server.app.inject({ method: 'GET', url: '/health/ready' });
  try {
    failTicks(store);
    const startedAt = Date.now();
    await failedTicks(server, 3);
    const degraded = await ready();
    assert.equal(degraded.statusCode, 200);
    const body = degraded.json() as { status: string; taskTick?: { lastErrorAt: string } };
    assert.equal(body.status, 'degraded');
    const lastErrorAt = body.taskTick?.lastErrorAt ?? '';
    assert.deepEqual(body, {
      status: 'degraded',
      degraded: true,
      taskTick: { consecutiveFailures: 3, lastErrorAt },
    });
    assert.match(lastErrorAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    assert.ok(Date.parse(lastErrorAt) >= startedAt);
    assert.ok(Date.parse(lastErrorAt) <= Date.now());
    assert.equal(degraded.body.includes(tickMessage), false);
    assert.equal(degraded.body.includes(tickCode), false);
    assert.equal(/"(error|code|message|phase)"/.test(degraded.body), false);

    await failedTicks(server, 1);
    assert.equal((await ready()).json().taskTick.consecutiveFailures, 4);

    assert.deepEqual((await server.app.inject({ method: 'GET', url: '/health/live' })).json(), { status: 'ok', degraded: false });
    assert.equal(server.isDegraded(), false);
    const detailed = await server.app.inject({ method: 'GET', url: '/v1/health', headers });
    assert.equal(detailed.statusCode, 200, detailed.body);
    assert.equal(detailed.json().status, 'ok');
    assert.equal(detailed.json().degraded, false);

    store.failScan.clear();
    await server.tasks.drain();
    assert.deepEqual((await ready()).json(), { status: 'ready', degraded: false });
  } finally { await server.close(); }
});

test('readiness without an outage service still answers 503 when the store itself is unavailable', async () => {
  const store = new FaultStore(new SqliteStore());
  const server = await createServer({ store, authenticate: developmentAuth(token), runner: async () => ({ text: 'unused' }) });
  try {
    failTicks(store);
    await failedTicks(server, 3);
    store.failScan.set('health', new Error('primary database is offline'));
    const response = await server.app.inject({ method: 'GET', url: '/health/ready' });
    assert.equal(response.statusCode, 503);
    assert.deepEqual(response.json(), {
      error: { code: 'service_unavailable', message: 'Service is temporarily unavailable' },
    });
  } finally { await server.close(); }
});

test('readiness with an outage service reports a failing tick next to the outage statistics in both storage branches', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'kiancode-health-ready-'));
  const store = new FaultStore(new SqliteStore());
  const outage = new OutageService({
    directory,
    key: randomBytes(32),
    simpleChat: async () => ({ content: 'unused' }),
    replaySink: createStoreReplaySink(store),
  });
  const server = await createServer({
    store,
    authenticate: developmentAuth(token),
    runner: async () => ({ text: 'unused' }),
    outage,
  });
  const ready = async () => (await server.app.inject({ method: 'GET', url: '/health/ready' })).json() as Record<string, unknown>;
  try {
    const healthy = await ready();
    assert.equal(healthy.status, 'ready');
    assert.equal(healthy.degraded, false);
    assert.ok(healthy.outage);
    assert.equal('taskTick' in healthy, false);

    failTicks(store);
    await failedTicks(server, 3);
    const connected = await ready();
    assert.equal(connected.status, 'degraded');
    assert.equal(connected.degraded, true);
    assert.equal('storage' in connected, false);
    assert.ok(connected.outage);
    assert.equal((connected.taskTick as { consecutiveFailures: number }).consecutiveFailures, 3);
    assert.equal(server.isDegraded(), false);

    store.failScan.set('health', new Error('primary database is offline'));
    const unavailable = await ready();
    assert.equal(unavailable.status, 'degraded');
    assert.equal(unavailable.degraded, true);
    assert.equal(unavailable.storage, 'unavailable');
    assert.ok(unavailable.outage);
    assert.equal((unavailable.taskTick as { consecutiveFailures: number }).consecutiveFailures, 3);
  } finally {
    await server.close();
    await rm(directory, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx --test test/health-ready.test.ts`

Expected: 4 tests, 2 pass, 2 fail. The first and third tests pass already (they pin behaviour that must not change). The failures are:

```text
✖ readiness is degraded from the third consecutive failed tick, exposes only the count and the time, and recovers on the next successful tick
  AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:
  + actual - expected
  + 'ready'
  - 'degraded'
✖ readiness with an outage service reports a failing tick next to the outage statistics in both storage branches
  AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:
  + actual - expected
  + 'ready'
  - 'degraded'
```

- [ ] **Step 3: Write minimal implementation**

Two edits in `src/http/server.ts`.

In `src/http/server.ts`, replace:

```ts
export interface ServerOptions {
```

with:

```ts
// /health/ready reports degraded once this many consecutive task ticks have failed.
const tickDegradedAfter = 3;

export interface ServerOptions {
```

In `src/http/server.ts`, replace:

```ts
  app.get('/health/ready', { config: { public: true } }, async () => {
    try {
      await store.scan('health');
      const outageStats = await options.outage?.stats();
      degraded = Boolean(outageStats?.unsyncedRecords);
      return { status: degraded ? 'degraded' : 'ready', degraded, ...(outageStats ? { outage: outageStats } : {}) };
    } catch (error) {
      if (!options.outage || !unavailable(error)) throw error;
      degraded = true;
      return { status: 'degraded', degraded: true, storage: 'unavailable', outage: await options.outage.stats() };
    }
  });
```

with:

```ts
  // A stalled task tick is reported in this response only; it never changes the outage `degraded` flag.
  app.get('/health/ready', { config: { public: true } }, async () => {
    const tick = tasks.tickStatus();
    const tickStalled = tick.consecutiveFailures >= tickDegradedAfter;
    const taskTick = tickStalled
      ? { taskTick: { consecutiveFailures: tick.consecutiveFailures, lastErrorAt: tick.lastErrorAt } }
      : {};
    try {
      await store.scan('health');
      const outageStats = await options.outage?.stats();
      degraded = Boolean(outageStats?.unsyncedRecords);
      const notReady = degraded || tickStalled;
      return { status: notReady ? 'degraded' : 'ready', degraded: notReady, ...(outageStats ? { outage: outageStats } : {}), ...taskTick };
    } catch (error) {
      if (!options.outage || !unavailable(error)) throw error;
      degraded = true;
      return { status: 'degraded', degraded: true, storage: 'unavailable', outage: await options.outage.stats(), ...taskTick };
    }
  });
```

Only the local `notReady` carries the tick state. The assignment `degraded = Boolean(outageStats?.unsyncedRecords)` must stay as it is: `degraded` is the outage flag read by `/health/live`, `/v1/health` and `isDegraded()`.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx tsc --noEmit && npx tsx --test test/health-ready.test.ts`

Expected: no typecheck output; `ℹ tests 4`, `ℹ pass 4`, `ℹ fail 0`.

Then: `npx tsx --test test/api.test.ts test/outage-http.test.ts`

Expected: `ℹ fail 0`.

- [ ] **Step 5: Commit**

```bash
git add src/http/server.ts test/health-ready.test.ts
git commit -m "實現：連續三次 tick 失敗時 readiness 回報 degraded"
```

### Task 4: `createServer` logs tick failures and recovery, thinned

`createServer` is called with `logger: false` by default, and every `app.log.*` call is then a no-op. This task lets a caller pass a level (and, for tests, a stream), and wires the Task 2 callbacks to the logger: one `error` line for the first failed tick of a streak, one for every 60th consecutive failure, and one `warn` line when the tick recovers. The raw error object and its stack are not logged for tick failures; only the phase, a bounded code and a bounded message. The default stays silent, so no existing caller or test starts printing.

**Files:**
- Modify: `src/http/server.ts` (the constants added by Task 3 above `ServerOptions`, line 55; `ServerOptions.logger`, line 60; the `TaskService` construction in `createServer`, lines 87-91 as of commit 17d571f)
- Test: `test/health-ready.test.ts`

**Interfaces:**
- Consumes: from Task 2, `TaskServiceOptions.onTickError?: (failure: TaskTickFailure) => void` with `TaskTickFailure { phase: TaskTickPhase; code: string; message: string; consecutiveFailures: number }`, and `TaskServiceOptions.onTickRecovered?: (recovery: TaskTickRecovery) => void` with `TaskTickRecovery { failedTicks: number }`. From Task 3, the constant `tickDegradedAfter` (only as the anchor of the first edit) and the test helpers `FaultStore`, `failTicks`, `failedTicks`, `token`, `headers`, `tickMessage`, `tickCode` in `test/health-ready.test.ts`.
- Produces (exported from `src/http/server.ts`):
  - `interface ServerLoggerOptions { level: 'fatal' | 'error' | 'warn' | 'info' | 'debug' | 'trace'; stream?: { write(line: string): void } }`
  - `ServerOptions.logger?: boolean | ServerLoggerOptions` (default `false`, passed straight to Fastify)
  - Log events, one JSON line each (pino also adds its standard `time`, `pid` and `hostname` fields to every line):
    - `{"level":50,"event":"task_tick_failed","phase":"notifications"|"reconciler"|"tasks","code":"<code>","consecutiveFailures":<n>,"msg":"<message>"}` when `n === 1` or `n % 60 === 0`;
    - `{"level":40,"event":"task_tick_recovered","failedTicks":<n>,"msg":"Task tick recovered."}` on the first successful tick after a streak.
  - Module constant `tickLogEvery = 60`.

- [ ] **Step 1: Write the failing test**

Append to the end of `test/health-ready.test.ts`:

```ts
test('the server logger records the first failed tick, every sixtieth one and the recovery, and nothing about requests', async () => {
  const store = new FaultStore(new SqliteStore());
  const lines: string[] = [];
  const server = await createServer({
    store,
    authenticate: developmentAuth(token),
    runner: async () => ({ text: 'unused' }),
    logger: { level: 'warn', stream: { write: (line) => { lines.push(line); } } },
  });
  const entries = () => lines.map((line) => JSON.parse(line) as Record<string, unknown>);
  try {
    await server.tasks.drain();
    assert.deepEqual(lines, []);

    failTicks(store);
    await failedTicks(server, 1);
    assert.equal(lines.length, 1);
    const first = entries()[0]!;
    assert.equal(first.level, 50);
    assert.equal(first.event, 'task_tick_failed');
    assert.equal(first.phase, 'notifications', 'the notification reconcile is the first phase that scans tasks');
    assert.equal(first.code, tickCode);
    assert.equal(first.consecutiveFailures, 1);
    assert.equal(first.msg, tickMessage);
    assert.equal('err' in first, false);
    assert.equal('stack' in first, false);

    await failedTicks(server, 58);
    assert.equal(lines.length, 1);
    await failedTicks(server, 1);
    assert.equal(lines.length, 2);
    assert.equal(entries()[1]!.consecutiveFailures, 60);
    await failedTicks(server, 60);
    assert.deepEqual(entries().map((entry) => entry.consecutiveFailures), [1, 60, 120]);
    assert.equal((await server.app.inject({ method: 'GET', url: '/health/ready' })).json().taskTick.consecutiveFailures, 120);

    store.failScan.clear();
    await server.tasks.drain();
    assert.equal(lines.length, 4);
    const recovery = entries()[3]!;
    assert.equal(recovery.level, 40);
    assert.equal(recovery.event, 'task_tick_recovered');
    assert.equal(recovery.failedTicks, 120);
    await server.tasks.drain();
    assert.equal(lines.length, 4);

    failTicks(store);
    await failedTicks(server, 1);
    assert.equal(entries()[4]!.event, 'task_tick_failed');
    assert.equal(entries()[4]!.consecutiveFailures, 1);

    assert.equal((await server.app.inject({ method: 'GET', url: '/v1/conversations?probe=request-logging', headers })).statusCode, 200);
    assert.equal((await server.app.inject({ method: 'GET', url: '/v1/conversations?probe=request-logging' })).statusCode, 401);
    assert.equal((await server.app.inject({ method: 'GET', url: '/v1/no-such-route?probe=request-logging', headers })).statusCode, 404);
    assert.equal(lines.length, 5);
    const output = lines.join('');
    assert.equal(output.includes('request-logging'), false);
    assert.equal(output.includes(token), false);
  } finally { await server.close(); }
});

test('without a logger a failing tick is still counted and reported by readiness', async () => {
  const store = new FaultStore(new SqliteStore());
  const server = await createServer({ store, authenticate: developmentAuth(token), runner: async () => ({ text: 'unused' }) });
  try {
    failTicks(store);
    await failedTicks(server, 3);
    assert.equal((await server.app.inject({ method: 'GET', url: '/health/ready' })).json().status, 'degraded');
  } finally { await server.close(); }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx --test test/health-ready.test.ts`

Expected: 6 tests, 5 pass, 1 fail. The last test passes already (it pins that the default stays silent and harmless). Before this task the only line written for a failed tick is the raw error from `onError`, so the failure is:

```text
✖ the server logger records the first failed tick, every sixtieth one and the recovery, and nothing about requests
  AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:
  + actual - expected
  + undefined
  - 'task_tick_failed'
```

`npx tsc --noEmit` also fails at this point, because `logger` only accepts a boolean:

```text
test/health-ready.test.ts(191,5): error TS2322: Type '{ level: string; stream: { write: (line: any) => void; }; }' is not assignable to type 'boolean | undefined'.
test/health-ready.test.ts(191,48): error TS7006: Parameter 'line' implicitly has an 'any' type.
```

- [ ] **Step 3: Write minimal implementation**

Three edits in `src/http/server.ts`.

In `src/http/server.ts`, replace:

```ts
const tickDegradedAfter = 3;

export interface ServerOptions {
```

with:

```ts
const tickDegradedAfter = 3;
// A streak of failed ticks is logged at its first failure and then at every multiple of this count.
const tickLogEvery = 60;

export interface ServerLoggerOptions {
  level: 'fatal' | 'error' | 'warn' | 'info' | 'debug' | 'trace';
  /** Receives each JSON log line. Default: standard output. */
  stream?: { write(line: string): void };
}

export interface ServerOptions {
```

In `src/http/server.ts`, replace:

```ts
  logger?: boolean;
```

with:

```ts
  logger?: boolean | ServerLoggerOptions;
```

In `src/http/server.ts`, replace:

```ts
    onError: (error) => app.log.error(error),
```

with:

```ts
    onError: (error) => app.log.error(error),
    onTickError: (failure) => {
      if (failure.consecutiveFailures !== 1 && failure.consecutiveFailures % tickLogEvery !== 0) return;
      app.log.error({
        event: 'task_tick_failed',
        phase: failure.phase,
        code: failure.code,
        consecutiveFailures: failure.consecutiveFailures,
      }, failure.message);
    },
    onTickRecovered: (recovery) => {
      app.log.warn({ event: 'task_tick_recovered', failedTicks: recovery.failedTicks }, 'Task tick recovered.');
    },
```

The existing line `const app = Fastify({ logger: options.logger ?? false, bodyLimit: 1024 * 1024, requestTimeout: 30000 });` is not edited: Fastify accepts the options object as it is. `onError` stays, because `TaskService` still sends it the errors that happen after a task run (notification and storage errors).

- [ ] **Step 4: Run test to verify it passes**

Run: `npx tsc --noEmit && npx tsx --test test/health-ready.test.ts`

Expected: no typecheck output; `ℹ tests 6`, `ℹ pass 6`, `ℹ fail 0`.

- [ ] **Step 5: Commit**

```bash
git add src/http/server.ts test/health-ready.test.ts
git commit -m "實現：伺服器 logger 記錄 tick 首次失敗、每六十次失敗及恢復"
```

### Task 5: `bootstrap` enables the warn-level logger; README states the contract

Both production entry points build the server through `bootstrap` (`src/cli.ts` and the embedding service that calls `bootstrap(config, { wrapTaskRunner })`), and `bootstrap` passes `logger: false`, so the Task 4 lines would never be written in a deployment. This task turns the logger on at warn level. Fastify writes request lines at info level, so no request, URL or token is logged. The three other existing `app.log.warn`/`app.log.error` calls in `src/http/server.ts` (outage context cache, unexpected request errors, maintenance audit) become visible on standard output as a side effect; that is intended. No config key and no `BootstrapOptions` change.

**Files:**
- Create: `test/bootstrap-logging.test.ts`
- Modify: `src/bootstrap.ts` (the `createServer({ ... })` call in `bootstrap`, line 240 as of commit 17d571f)
- Modify: `README.md` (section `## Deployment`, after the paragraph that starts "Production startup fails closed", line 80 as of commit 17d571f)
- Test: `test/bootstrap-logging.test.ts`

**Interfaces:**
- Consumes: from Task 4, `ServerOptions.logger?: boolean | ServerLoggerOptions` with `ServerLoggerOptions { level: 'fatal' | 'error' | 'warn' | 'info' | 'debug' | 'trace'; stream?: { write(line: string): void } }`. Existing: `bootstrap(config, options?)` returning the server object with `app`, `tasks` and `close()`, and `configSchema` from `src/config.ts`.
- Produces: a bootstrapped server has `server.app.log.level === 'warn'`. Nothing else changes for callers of `bootstrap`.

- [ ] **Step 1: Write the failing test**

Create `test/bootstrap-logging.test.ts` with:

```ts
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { bootstrap } from '../src/bootstrap.js';
import { configSchema } from '../src/config.js';

test('bootstrap enables the server logger at warn level and a healthy server stays ready', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'kiancode-bootstrap-logging-'));
  const tokenName = 'KIANCODE_BOOTSTRAP_LOGGING_TEST_TOKEN';
  const previousToken = process.env[tokenName];
  process.env[tokenName] = 'test-owner-token-with-at-least-thirty-two-characters';
  let server: Awaited<ReturnType<typeof bootstrap>> | undefined;
  try {
    server = await bootstrap(configSchema.parse({
      stateDirectory: path.join(directory, 'state'),
      checkpointDirectory: path.join(directory, 'checkpoints'),
      database: { sqlitePath: path.join(directory, 'core.sqlite') },
      auth: { developmentTokenEnv: tokenName },
      attachments: { localDirectory: path.join(directory, 'attachments') },
    }));
    assert.equal(server.app.log.level, 'warn');
    await server.tasks.drain();
    const ready = await server.app.inject({ method: 'GET', url: '/health/ready' });
    assert.equal(ready.statusCode, 200);
    assert.deepEqual(ready.json(), { status: 'ready', degraded: false });
  } finally {
    await server?.close();
    if (previousToken === undefined) delete process.env[tokenName];
    else process.env[tokenName] = previousToken;
    await rm(directory, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx --test test/bootstrap-logging.test.ts`

Expected: 1 test, 0 pass, 1 fail (with the logger off, Fastify's no-op logger has no `level`):

```text
✖ bootstrap enables the server logger at warn level and a healthy server stays ready
  AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:
  + actual - expected
  + undefined
  - 'warn'
```

- [ ] **Step 3: Write minimal implementation**

In `src/bootstrap.ts`, replace:

```ts
      logger: false,
```

with:

```ts
      // Warnings and errors only: Fastify logs requests at info level, so no request line, URL or token is written.
      logger: { level: 'warn' },
```

In `README.md`, replace:

```markdown
Production startup fails closed when that PostgreSQL environment variable is absent. `database.sqlitePath` is for development and tests only.
```

with:

```markdown
Production startup fails closed when that PostgreSQL environment variable is absent. `database.sqlitePath` is for development and tests only.

`GET /health/ready` needs no credentials. It answers `{"status":"ready","degraded":false}` while the store is reachable and the task loop is healthy. Once three consecutive task ticks have failed it answers `"status":"degraded"`, `"degraded":true` and adds `taskTick` with `consecutiveFailures` and `lastErrorAt`; the next successful tick returns it to ready. The HTTP status stays 200, so a probe must read the body. A tick that fails in the notification or automation reconcile still claims and runs queued tasks.

The service writes warnings and errors to standard output as JSON lines, which systemd keeps in the journal. `task_tick_failed` is written for the first failed tick of a streak and for every 60th consecutive failure, with the failing phase (`notifications`, `reconciler` or `tasks`), an error code and the count; `task_tick_recovered` is written once when the loop recovers. Requests are not logged.
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx tsc --noEmit && npx tsx --test test/bootstrap-logging.test.ts`

Expected: no typecheck output; `ℹ tests 1`, `ℹ pass 1`, `ℹ fail 0`.

Then run every suite that goes through `bootstrap`: `npx tsx --test test/bootstrap-*.test.ts`

Expected: `ℹ fail 0`. A test that provokes a storage failure may now print JSON log lines; they are output, not failures.

- [ ] **Step 5: Commit**

```bash
git add src/bootstrap.ts README.md test/bootstrap-logging.test.ts
git commit -m "實現：bootstrap 以 warn 級別啟用伺服器 logger 並記載 readiness 契約"
```

### Task 6: `NotificationService.reconcile` publishes each key once per process

`reconcile()` runs at the start of every tick. Today it calls `publishTask` for every task in state `completed`, `failed`, `unknown` or `waiting_for_approval`, and for every schedule and event trigger with `authorizationFailedAt`; each call does one `store.get('notification', …)` and compares the stored row with what it would publish. That is one store round trip per notifiable row per second, forever, and one stored row that differs makes every tick fail with `idempotency_conflict`.

After this task `reconcile()` keeps a process-local set of notification ids that are known to be stored. The first `reconcile()` of a process seeds it with one `scan('notification')`. A key whose id is in the set is skipped without any store call; an id is added only after `publishTask` returned, so a failed write is retried by the next tick. The notification row itself stays the durable dedupe record (id = SHA-256 of owner id, a NUL byte and the dedupe key), so a restart re-seeds from it. No marker is written to any task, schedule or trigger. `publish()` and `publishTask()` are not changed: a direct caller still gets `idempotency_conflict` for a different event under the same key.

**Files:**
- Create: `test/notification-reconcile.test.ts`
- Modify: `src/notifications.ts` (class field after `private readonly now`, line 70; `reconcile`, lines 405-419 as of commit 17d571f, plus the `event_trigger` loop that plan C appended to it)
- Test: `test/notification-reconcile.test.ts`

**Interfaces:**
- Consumes (existing): `NotificationService.publishTask(ownerId: string, input: NotificationInput, occurredAt: Date, destination?: NotificationDestination): Promise<Entity<Notification> | undefined>`, `NotificationService.publish(ownerId, input, occurredAt?, policy?)`, the module-private `digest(...parts: string[]): string`, `taskNotification(task)` and `AutomationScheduleNotification` in `src/notifications.ts`.
- Consumes (from plan C, already applied): `NotificationInput.eventTriggerId?: string`, `Notification.eventTriggerId?: string`, and the third loop of `reconcile()` over `event_trigger` rows with dedupe key `` `event-trigger:${trigger.id}:authorization:${trigger.data.authorizationFailedAt}` ``. If `reconcile()` in your checkout has no `event_trigger` loop, plan C has not been applied: stop and apply it first.
- Produces: `NotificationService.reconcile(): Promise<void>` keeps its signature. After the first call of a process it makes exactly three store calls when nothing new happened: `scan('task')`, `scan('automation_schedule')`, `scan('event_trigger')`. Private members `reconciledIds?: Set<string>` and `publishOnce(ownerId, input, occurredAt, destination?): Promise<void>`. No other public method changes.

- [ ] **Step 1: Write the failing test**

Create `test/notification-reconcile.test.ts` with:

```ts
import assert from 'node:assert/strict';
import test from 'node:test';
import { DomainError, type Principal } from '../src/contracts.js';
import type { Notification, NotificationDestination, PendingAction, Task, TaskState } from '../src/domain.js';
import { NotificationService } from '../src/notifications.js';
import { SqliteStore } from '../src/storage/sqlite.js';
import type { Entity, Store } from '../src/storage/store.js';

const principal: Principal = { id: 'alice', level: 1, scopes: ['*'] };

// Records every store call as "method kind" and can make one kind of call fail a given number of times.
class RecordingStore implements Store {
  public calls: string[] = [];
  public readonly failures = new Map<string, { error: unknown; times: number }>();

  public constructor(private readonly delegate: Store) {}

  private enter(method: string, kind: string): void {
    const call = `${method} ${kind}`;
    this.calls.push(call);
    const failure = this.failures.get(call);
    if (failure && failure.times > 0) {
      failure.times -= 1;
      throw failure.error;
    }
  }

  public async create<T>(kind: string, ownerId: string, data: T, id?: string): Promise<Entity<T>> {
    this.enter('create', kind);
    return this.delegate.create(kind, ownerId, data, id);
  }

  public async get<T>(kind: string, id: string, ownerId: string): Promise<Entity<T> | undefined> {
    this.enter('get', kind);
    return this.delegate.get(kind, id, ownerId);
  }

  public async scan<T>(kind: string, ownerId?: string): Promise<Array<Entity<T>>> {
    this.enter('scan', kind);
    return this.delegate.scan(kind, ownerId);
  }

  public async put<T>(kind: string, id: string, ownerId: string, data: T, revision: number): Promise<Entity<T>> {
    this.enter('put', kind);
    return this.delegate.put(kind, id, ownerId, data, revision);
  }

  public async remove(kind: string, id: string, ownerId: string, revision: number): Promise<boolean> {
    this.enter('remove', kind);
    return this.delegate.remove(kind, id, ownerId, revision);
  }

  public close(): Promise<void> {
    return this.delegate.close();
  }
}

// The three scans every reconcile makes. Anything else after the first reconcile is per-row work.
const steadyState = ['scan task', 'scan automation_schedule', 'scan event_trigger'];

function task(
  state: TaskState,
  extra: { pendingActions?: PendingAction[]; notificationDestination?: NotificationDestination } = {},
): Task {
  return {
    conversationId: 'conversation-1',
    prompt: 'stored task',
    principal,
    state,
    grantExpiresAt: '2026-10-01T13:00:00.000Z',
    pendingActions: extra.pendingActions ?? [],
    approvedActionHashes: [],
    ...(extra.notificationDestination ? { notificationDestination: extra.notificationDestination } : {}),
  };
}

function automation(authorizationFailedAt?: string): Record<string, unknown> {
  return {
    enabled: false,
    ...(authorizationFailedAt ? { authorizationFailedAt } : {}),
    settings: { notification: { type: 'in_app' } },
  };
}

function notificationRows(store: Store): Promise<Array<Entity<Notification>>> {
  return store.scan<Notification>('notification', principal.id);
}

test('reconcile publishes each terminal task once and later reconciles make no store call per task', async () => {
  const store = new RecordingStore(new SqliteStore());
  const notifications = new NotificationService(store);
  try {
    for (let index = 0; index < 40; index += 1) {
      await store.create<Task>('task', principal.id, task(index % 2 === 0 ? 'completed' : 'failed'));
    }
    await store.create<Task>('task', principal.id, task('cancelled'));
    await store.create<Task>('task', principal.id, task('queued'));
    await store.create<Task>('task', principal.id, task('completed', { notificationDestination: { type: 'none' } }));

    await notifications.reconcile();
    const published = await notificationRows(store);
    assert.equal(published.length, 40, 'one per completed or failed task; none for cancelled, queued or a muted task');
    assert.equal(published.filter((row) => row.data.type === 'task_completed').length, 20);
    assert.equal(published.filter((row) => row.data.type === 'task_failed').length, 20);
    assert.equal(new Set(published.map((row) => row.data.taskId)).size, 40);

    store.calls = [];
    await notifications.reconcile();
    assert.deepEqual(store.calls, steadyState);
    await notifications.reconcile();
    assert.deepEqual(store.calls, [...steadyState, ...steadyState]);
    assert.deepEqual(await notificationRows(store), published);
  } finally { await store.close(); }
});

test('a new process seeds from the stored notifications with one scan and publishes nothing twice', async () => {
  const store = new RecordingStore(new SqliteStore());
  try {
    for (let index = 0; index < 10; index += 1) {
      await store.create<Task>('task', principal.id, task('completed'));
    }
    await new NotificationService(store).reconcile();
    const published = await notificationRows(store);
    assert.equal(published.length, 10);

    const restarted = new NotificationService(store);
    store.calls = [];
    await restarted.reconcile();
    assert.deepEqual(store.calls, ['scan notification', ...steadyState]);
    store.calls = [];
    await restarted.reconcile();
    assert.deepEqual(store.calls, steadyState);
    assert.deepEqual(await notificationRows(store), published, 'no row was added or rewritten');
  } finally { await store.close(); }
});

test('a notification that could not be stored is retried on the next reconcile and stored exactly once', async () => {
  const store = new RecordingStore(new SqliteStore());
  const notifications = new NotificationService(store);
  try {
    const first = await store.create<Task>('task', principal.id, task('completed'));
    const second = await store.create<Task>('task', principal.id, task('failed'));
    const writeFailure = new Error('connection reset while writing');
    store.failures.set('create notification', { error: writeFailure, times: 1 });

    await assert.rejects(notifications.reconcile(), (error: unknown) => error === writeFailure);
    assert.deepEqual(await notificationRows(store), []);

    await notifications.reconcile();
    const published = await notificationRows(store);
    assert.deepEqual(published.map((row) => row.data.taskId).sort(), [first.id, second.id].sort());

    store.calls = [];
    await notifications.reconcile();
    assert.deepEqual(store.calls, steadyState);
    assert.deepEqual(await notificationRows(store), published);
  } finally { await store.close(); }
});

test('a failed seed scan fails that reconcile only and the next one publishes normally', async () => {
  const store = new RecordingStore(new SqliteStore());
  const notifications = new NotificationService(store);
  try {
    await store.create<Task>('task', principal.id, task('completed'));
    const scanFailure = new DomainError('storage_unavailable', 'Primary storage is unavailable.', 503);
    store.failures.set('scan notification', { error: scanFailure, times: 1 });

    await assert.rejects(notifications.reconcile(), (error: unknown) => error === scanFailure);
    assert.equal(store.calls.filter((call) => call === 'create notification').length, 0);

    await notifications.reconcile();
    await notifications.reconcile();
    assert.equal((await notificationRows(store)).length, 1);
  } finally { await store.close(); }
});

test('a stored notification that differs from what would be published today is left alone and does not fail reconcile', async () => {
  const store = new RecordingStore(new SqliteStore());
  try {
    const completed = await store.create<Task>('task', principal.id, task('completed'));
    // The dedupe record of an earlier release: same key, different wording, time and delivery policy.
    const legacy = await new NotificationService(store).publish(principal.id, {
      type: 'task_completed',
      dedupeKey: `task:${completed.id}:completed`,
      taskId: completed.id,
      conversationId: 'conversation-1',
      title: 'Done',
      body: 'An earlier release wrote this text.',
    }, new Date('2026-09-01T00:00:00.000Z'), { pushEligible: false });

    const notifications = new NotificationService(store);
    await notifications.reconcile();
    await notifications.reconcile();
    assert.deepEqual(await notificationRows(store), [legacy]);
  } finally { await store.close(); }
});

test('approval, unknown and completion notifications of one task are each published once and no task row is written', async () => {
  const store = new RecordingStore(new SqliteStore());
  const notifications = new NotificationService(store);
  const types = async (): Promise<string[]> => (await notificationRows(store)).map((row) => row.data.type).sort();
  try {
    const waiting = await store.create<Task>('task', principal.id, task('waiting_for_approval', {
      pendingActions: [{ hash: 'hash-1', tool: 'workspace.write', input: {} }],
    }));
    const unknown = await store.create<Task>('task', principal.id, task('unknown'));
    await notifications.reconcile();
    await notifications.reconcile();
    assert.deepEqual(await types(), ['approval_required', 'task_unknown']);

    const secondApproval = await store.put<Task>('task', waiting.id, principal.id, task('waiting_for_approval', {
      pendingActions: [{ hash: 'hash-2', tool: 'workspace.write', input: {} }],
    }), waiting.revision);
    await notifications.reconcile();
    await notifications.reconcile();
    assert.deepEqual(await types(), ['approval_required', 'approval_required', 'task_unknown']);

    const done = await store.put<Task>('task', waiting.id, principal.id, task('completed'), secondApproval.revision);
    store.calls = [];
    await notifications.reconcile();
    await notifications.reconcile();
    assert.deepEqual(await types(), ['approval_required', 'approval_required', 'task_completed', 'task_unknown']);
    assert.equal((await notificationRows(store)).filter((row) => row.data.type === 'task_failed').length, 0);

    assert.deepEqual(store.calls.filter((call) => call.endsWith(' task') && call !== 'scan task'), []);
    assert.deepEqual(await store.get<Task>('task', waiting.id, principal.id), done);
    assert.deepEqual(await store.get<Task>('task', unknown.id, principal.id), unknown);
  } finally { await store.close(); }
});

test('schedule and event trigger authorization failures are published once each and again only for a new failure time', async () => {
  const store = new RecordingStore(new SqliteStore());
  const notifications = new NotificationService(store);
  const failedAt = '2026-10-01T08:00:00.000Z';
  try {
    await store.create('automation_schedule', principal.id, automation(failedAt), 'schedule-1');
    await store.create('automation_schedule', principal.id, automation(), 'schedule-ok');
    const trigger = await store.create('event_trigger', principal.id, automation(failedAt), 'trigger-1');
    await store.create('event_trigger', principal.id, automation(), 'trigger-ok');

    await notifications.reconcile();
    const first = await notificationRows(store);
    assert.equal(first.length, 2);
    assert.equal(first.filter((row) => row.data.scheduleId === 'schedule-1').length, 1);
    assert.equal(first.filter((row) => row.data.eventTriggerId === 'trigger-1').length, 1);

    store.calls = [];
    await notifications.reconcile();
    assert.deepEqual(store.calls, steadyState);
    assert.deepEqual(await notificationRows(store), first);

    const later = '2026-10-01T09:30:00.000Z';
    await store.put('event_trigger', trigger.id, principal.id, automation(later), trigger.revision);
    await notifications.reconcile();
    await notifications.reconcile();
    const second = await notificationRows(store);
    assert.equal(second.length, 3);
    assert.deepEqual(
      second.filter((row) => row.data.eventTriggerId === 'trigger-1').map((row) => row.data.occurredAt).sort(),
      [failedAt, later],
    );
  } finally { await store.close(); }
});

test('two concurrent first reconciles publish one notification per task', async () => {
  const store = new RecordingStore(new SqliteStore());
  const notifications = new NotificationService(store);
  try {
    for (let index = 0; index < 5; index += 1) {
      await store.create<Task>('task', principal.id, task('completed'));
    }
    await Promise.all([notifications.reconcile(), notifications.reconcile()]);
    assert.equal((await notificationRows(store)).length, 5);
    store.calls = [];
    await notifications.reconcile();
    assert.deepEqual(store.calls, steadyState);
  } finally { await store.close(); }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx --test test/notification-reconcile.test.ts`

Expected: 8 tests, 1 pass, 7 fail. The test `approval, unknown and completion notifications of one task are each published once and no task row is written` passes already (it pins behaviour that must not change). The other seven fail; the assertion output is long because it lists every extra store call. The first lines of each failure are:

```text
✖ reconcile publishes each terminal task once and later reconciles make no store call per task
  AssertionError [ERR_ASSERTION]: Expected values to be strictly deep-equal:
  + actual - expected
    [
      'scan task',
  +   'get notification',
✖ a new process seeds from the stored notifications with one scan and publishes nothing twice
  AssertionError [ERR_ASSERTION]: Expected values to be strictly deep-equal:
  + actual - expected
    [
  -   'scan notification',
      'scan task',
  +   'get notification',
✖ a notification that could not be stored is retried on the next reconcile and stored exactly once
  AssertionError [ERR_ASSERTION]: Expected values to be strictly deep-equal:
✖ a failed seed scan fails that reconcile only and the next one publishes normally
  AssertionError [ERR_ASSERTION]: Missing expected rejection.
✖ a stored notification that differs from what would be published today is left alone and does not fail reconcile
  Error [DomainError]: Notification key belongs to another event.
✖ schedule and event trigger authorization failures are published once each and again only for a new failure time
  AssertionError [ERR_ASSERTION]: Expected values to be strictly deep-equal:
✖ two concurrent first reconciles publish one notification per task
  AssertionError [ERR_ASSERTION]: Expected values to be strictly deep-equal:
```

- [ ] **Step 3: Write minimal implementation**

Two edits in `src/notifications.ts`.

In `src/notifications.ts`, replace:

```ts
  private readonly now: () => Date;
```

with:

```ts
  private readonly now: () => Date;
  // Ids of notifications known to be stored, for reconcile(). Process-local; seeded once from the stored rows.
  private reconciledIds?: Set<string>;
```

In `src/notifications.ts`, replace:

```ts
  public async reconcile(): Promise<void> {
    const tasks = await this.store.scan<Task>('task');
    for (const task of tasks) {
      const input = taskNotification(task);
      if (input) await this.publishTask(task.ownerId, input, new Date(task.updatedAt), task.data.notificationDestination);
    }
    for (const schedule of await this.store.scan<AutomationScheduleNotification>('automation_schedule')) {
      if (!schedule.data.authorizationFailedAt) continue;
      await this.publishTask(schedule.ownerId, {
        type: 'schedule_authorization_failed',
        dedupeKey: `schedule:${schedule.id}:authorization:${schedule.data.authorizationFailedAt}`,
        scheduleId: schedule.id,
      }, new Date(schedule.data.authorizationFailedAt), schedule.data.settings.notification);
    }
    for (const trigger of await this.store.scan<AutomationScheduleNotification>('event_trigger')) {
      if (!trigger.data.authorizationFailedAt) continue;
      await this.publishTask(trigger.ownerId, {
        type: 'schedule_authorization_failed',
        dedupeKey: `event-trigger:${trigger.id}:authorization:${trigger.data.authorizationFailedAt}`,
        eventTriggerId: trigger.id,
      }, new Date(trigger.data.authorizationFailedAt), trigger.data.settings.notification);
    }
  }
```

with:

```ts
  public async reconcile(): Promise<void> {
    if (!this.reconciledIds) {
      const stored = await this.store.scan<Notification>('notification');
      this.reconciledIds ??= new Set(stored.map((row) => row.id));
    }
    const tasks = await this.store.scan<Task>('task');
    for (const task of tasks) {
      const input = taskNotification(task);
      if (input) await this.publishOnce(task.ownerId, input, new Date(task.updatedAt), task.data.notificationDestination);
    }
    for (const schedule of await this.store.scan<AutomationScheduleNotification>('automation_schedule')) {
      if (!schedule.data.authorizationFailedAt) continue;
      await this.publishOnce(schedule.ownerId, {
        type: 'schedule_authorization_failed',
        dedupeKey: `schedule:${schedule.id}:authorization:${schedule.data.authorizationFailedAt}`,
        scheduleId: schedule.id,
      }, new Date(schedule.data.authorizationFailedAt), schedule.data.settings.notification);
    }
    for (const trigger of await this.store.scan<AutomationScheduleNotification>('event_trigger')) {
      if (!trigger.data.authorizationFailedAt) continue;
      await this.publishOnce(trigger.ownerId, {
        type: 'schedule_authorization_failed',
        dedupeKey: `event-trigger:${trigger.id}:authorization:${trigger.data.authorizationFailedAt}`,
        eventTriggerId: trigger.id,
      }, new Date(trigger.data.authorizationFailedAt), trigger.data.settings.notification);
    }
  }

  // reconcile() only: skips a key whose notification is known to be stored, and remembers a key only after
  // publishTask returned, so a failed write is retried by the next reconcile.
  private async publishOnce(
    ownerId: string,
    input: NotificationInput,
    occurredAt: Date,
    destination?: NotificationDestination,
  ): Promise<void> {
    const id = digest(ownerId, input.dedupeKey);
    if (this.reconciledIds?.has(id)) return;
    await this.publishTask(ownerId, input, occurredAt, destination);
    this.reconciledIds?.add(id);
  }
```

The only differences inside `reconcile()` are the seeding block at the top and `publishTask` becoming `publishOnce` in all three loops. Keep the order of the two statements at the end of `publishOnce`: adding the id before `publishTask` returned would lose a notification whose write failed. If the seeding scan throws, `reconciledIds` stays unset and the next `reconcile()` seeds again. `Notification`, `NotificationDestination` and `NotificationInput` are already imported or declared in this file.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx tsc --noEmit && npx tsx --test test/notification-reconcile.test.ts test/notifications.test.ts`

Expected: no typecheck output; `ℹ fail 0` (8 tests in the new file, all passing, and the existing notification tests unchanged).

Then the full gate: `npm run check`

Expected: typecheck prints nothing, the test run ends with `ℹ fail 0`, and the build exits 0. On a checkout with plans G, A, C, B1, B2, D and E applied and `KIANCODE_TEST_DATABASE_URL` unset, the run reported 523 tests: 490 passed, 0 failed, 23 skipped (the PostgreSQL contract cases of plan G) and 10 `todo` cases recorded by plan G as known store divergences. Exact totals depend on how the earlier plans landed; what must hold is `ℹ fail 0`. This plan adds 23 tests (8 in `test/task-tick.test.ts`, 6 in `test/health-ready.test.ts`, 1 in `test/bootstrap-logging.test.ts`, 8 in `test/notification-reconcile.test.ts`).

- [ ] **Step 5: Commit**

```bash
git add src/notifications.ts test/notification-reconcile.test.ts
git commit -m "修復：通知對帳每個行程只發佈一次，不再逐任務查詢"
```

---

## F3 scope for a later plan

F3 is not implemented by this plan. This section records its scope so a later plan can start from it. Line numbers are as of commit `17d571f`.

**What remains after this plan.** Every tick still reads whole kinds from the store and filters in memory:

- `scan('task')` three times: `NotificationService.reconcile` (`src/notifications.ts:406`), lease recovery (`src/tasks.ts:524`) and the claim loop (`src/tasks.ts:550`).
- `scan('automation_schedule')` and `scan('event_trigger')` in `NotificationService.reconcile`.
- `scan('agent_plan')` in `reconcileAgentTasks` (`src/runtime-adapter.ts:310`).
- Only when automations are enabled: `scan('automation_schedule')` and `scan('schedule_occurrence')` (`src/scheduler.ts:217`, `:221`) and `scan('event_inbox')` (`src/event-triggers.ts:523`).
- Outside the tick, and probably the largest avoidable load at the current volume: every persisted runtime event, every SSE poll and `control()` scan all `event` rows of the owner and filter by task (`src/tasks.ts:337`, `:358`, `:371`; `src/agents/coordinator.ts:418`).

`PostgresStore.scan` is `SELECT * … WHERE kind=$1 [AND owner_id=$2] ORDER BY created_at,id` with no limit, on a pool with a 10 second statement timeout. The only indexes are the primary key `(kind, id)` and `(owner_id, kind)`.

**Smallest interface change.** An optional third argument on `Store.scan`, defined as a pushdown hint:

```ts
export interface ScanFilter {
  /** Top-level string fields of `data`; a row matches when each named field equals one of the listed values. */
  where?: Record<string, readonly string[]>;
  /** Only rows whose `updatedAt` is later than this ISO time. */
  updatedAfter?: string;
}

scan<T>(kind: string, ownerId?: string, filter?: ScanFilter): Promise<Array<Entity<T>>>;
```

An implementation may ignore the filter, and every caller keeps its in-memory predicate. That keeps every existing `Store` implementation and test double valid; only the stores that want the speed-up implement it.

**Implementation outline.**

- `PostgresStore.scan`: `AND data->>$n = ANY($m::text[])` per `where` field and `AND updated_at > $k` for `updatedAfter`. Expression indexes `(kind, (data->>'state'))`, `(kind, (data->>'status'))` and `(kind, (data->>'taskId'))`, created in `PostgresStore.connect` with the existing `to_regclass` check. Without the index PostgreSQL still has to detoast every row to evaluate the filter. Index creation runs under the same 10 second statement timeout, which matters if it is postponed until the table is large.
- `SqliteStore.scan`: `AND json_extract(data, ?) IN (SELECT value FROM json_each(?))`.
- `RecoveringPostgresStore` in `src/bootstrap.ts` forwards the third argument.
- Call sites: lease recovery (`state` = `running`), claim loop (`state` in `queued`, `waiting_for_device`), `schedule_occurrence` and `event_inbox` (`status` in `pending`, `processing`), `agent_plan` (plan state), the four `event` scans (`taskId`), and `NotificationService.reconcile` (`updatedAfter` with a process-local high-water mark, which also replaces the id set added by Task 6 of this plan).
- Tests: add filter cases to the store contract suite from plan G, so they run against `SqliteStore` always and `PostgresStore` when `KIANCODE_TEST_DATABASE_URL` is set, including "a store that ignores the filter is still correct because callers keep their predicate".

Size: about 60 lines in the stores and bootstrap, about 40 lines at call sites, about 150 lines of tests; six or seven tasks.

**Measurement needed on the deployed database before deciding when F3 must land.** The row count is not the risk; the payload size of `task` rows (`runtimeMessages`) scanned three times per second is, and it cannot be judged from the code. Run these read-only statements once against the deployed PostgreSQL, from the host the service runs on, and record the output:

```sql
SELECT kind,
       count(*) AS row_count,
       pg_size_pretty(sum(pg_column_size(data))::bigint) AS stored_data_size
FROM kiancode_entities
GROUP BY kind
ORDER BY sum(pg_column_size(data)) DESC;

EXPLAIN (ANALYZE, BUFFERS) SELECT * FROM kiancode_entities WHERE kind = 'task' ORDER BY created_at, id;
EXPLAIN (ANALYZE, BUFFERS) SELECT * FROM kiancode_entities WHERE kind = 'event' ORDER BY created_at, id;
EXPLAIN (ANALYZE, BUFFERS) SELECT * FROM kiancode_entities WHERE kind = 'notification' ORDER BY created_at, id;
```

`EXPLAIN ANALYZE` executes the query but does not send the rows, so the reported time is a lower bound: the service also pays for transferring and parsing every row. In `psql`, `\timing on` followed by `\o /dev/null` and the plain `SELECT` gives the time including the transfer.

Decision rule: if the full `task` scan including transfer is well under the one-second tick interval (roughly under 300 ms), F3 can wait for a later plan. If it is near or above one second, bring the `state` pushdown for the two task scans in `src/tasks.ts` forward, before production cutover. Whatever the result, after this plan a tick that hits the statement timeout is no longer silent: it is counted, logged as `task_tick_failed` and reported by `/health/ready` from the third consecutive failure.

**Related work for the same later plan, not part of F3 as specified.**

- A tick that is slow but never throws is not detected by this plan; only failures are counted.
- `reconcileAgentTasks`, the scheduler and the event triggers share one reconciler callback, so a failing agent reconcile skips the scheduler and trigger reconcile of that tick (the claim loop still runs).
- The Task 6 id set is rebuilt by one full `scan('notification')` per process start and grows with the number of notifications.
