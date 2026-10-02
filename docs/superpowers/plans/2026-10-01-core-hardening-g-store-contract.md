# Store Contract Suite and Acceptance Record Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Run one store contract suite against `SqliteStore` always and against `PostgresStore` when a disposable database is named, and make the standalone acceptance run leave a report file that says `passed` or `failed`.

**Architecture:** `test/store-contract.ts` holds store-agnostic cases registered through `storeContract(label, createHarness, skip)`; `test/store.test.ts` supplies a SQLite harness (temporary file) and a PostgreSQL harness (one throw-away schema per case, selected through the `PGOPTIONS` startup option so that the unmodified production `PostgresStore.connect` lands in it). `test/acceptance-report.ts` is a small writer used by `test/standalone.acceptance.ts`; it is unit-tested, so the report format is covered by `npm run check` even though the acceptance run itself is not. Nothing under `src/` changes.

**Tech Stack:** TypeScript (NodeNext modules, `.js` import suffixes), Node.js 24 `node:test` run through `tsx --test`, `node:sqlite`, `pg` 8.23.0 (`Pool`), no new dependencies.

**Spec:** `docs/superpowers/specs/2026-10-01-core-hardening-design.md` (section G)

## Global Constraints

- Node.js 24 or later. TypeScript with two-space indent, single quotes, semicolons and explicit public interfaces.
- Tests use `node:test` and run with `tsx --test`. Behaviour is tested through public interfaces. `npm run check` (typecheck, tests, build) passes before delivery.
- No new runtime dependencies.
- SQLite is for development and tests; PostgreSQL is production. Entities already stored in a deployed database must remain readable without a data rewrite.
- Errors are `DomainError(code, message, statusCode)` with snake_case codes. Existing codes and HTTP statuses do not change unless a workstream says so (this one changes none).
- The distinction between dispatched, confirmed and unknown external outcomes is preserved.
- No personal data, hostnames, secrets or production configuration in the repository.
- Line numbers in the plans refer to commit `17d571f`; function and symbol names are the stable anchors once earlier workstreams have landed.
- Workstream rule: this plan must not change any file under `src/`. If a contract case is red on PostgreSQL, stop and report it; do not patch `src/` here. Before every commit `git status --short src` must print nothing. The only exception is the mutation check in Step 2 of Tasks 3 and 4: one line under `src/` is changed temporarily to prove that the new cases can fail, and Step 3 of the same task restores the file with `git checkout` before anything is committed.
- Workstream rule: the value of `KIANCODE_TEST_DATABASE_URL` is handed to `pg` verbatim. Never parse it, rewrite it, log it or put it in an assertion message.

## Review Focus

1. `npm run check` on a machine without `KIANCODE_TEST_DATABASE_URL` — a reader of the green run expects the PostgreSQL cases to be counted as skipped, never as passed, and expects no fallback to `DATABASE_URL`. Pinned in Task 2 by `PostgreSQL cases are skipped only when KIANCODE_TEST_DATABASE_URL is unset or empty`.
2. `KIANCODE_TEST_DATABASE_URL` is set but the database is unreachable or the role lacks privileges — the cases must fail, not skip, and the process must still exit. Pinned in Task 2 by `an unreachable PostgreSQL database fails the harness instead of skipping` (this test also proves a Unix-socket connection string reaches `pg` unparsed). A privilege error is raised by the same `CREATE SCHEMA` statement and leaves the harness through the same `catch`; it cannot be reproduced without a server, so it has no test of its own.
3. An acceptance run fails, or is killed, after an earlier run passed — the report file must not still say `passed`. Pinned in Task 5 by `a report file starts incomplete and replaces a stale passed report` and `a failed report records the error message and the partial evidence`, and end to end in Task 6 by `a failed acceptance run replaces a stale passed report with the failure`.
4. `KIANCODE_TEST_DATABASE_URL` names a database that already contains a `kiancode_entities` table — each case must work only inside its own schema and leave nothing behind. Pinned in Task 2 by `PostgreSQL: connect bootstraps the table and index inside the case schema and keeps rows across reconnects` and `PostgreSQL: a disposed case leaves no schema behind and restores PGOPTIONS`.
5. Records whose owner ids, record ids or data contain quotes, `%`, `_`, backslashes, CJK text or emoji — they must be stored exactly, never interpreted as SQL or as a pattern, and never leak across owners, on both stores. Pinned in Task 3 by `identifiers are opaque values, never SQL or patterns` and `JSON data round-trips exactly`.

## File Structure

- Create `test/store-contract.ts` — the store contract: `ContractStore`, `StoreHarness`, `storeContract`. Store-agnostic; every case builds and disposes its own harness.
- Modify `test/store.test.ts` — the harnesses (`sqliteHarness`, `postgresHarness`), the environment gate (`postgresSkipReason`), the two `storeContract` registrations, the PostgreSQL-only cases and the `todo` records of known divergences.
- Create `test/acceptance-report.ts` — `openAcceptanceReport`: writes the acceptance report file (`incomplete`, then `passed` or `failed`).
- Create `test/acceptance-report.test.ts` — unit tests of the writer, process-level tests of the script wiring, pins for the `package.json` scripts and the README.
- Modify `test/standalone.acceptance.ts` — use the writer; nothing else about the run changes.
- Modify `package.json` — add the `acceptance` script; `test` and `check` stay as they are.
- Modify `README.md` — the paragraph under `## Verification`.

Files under `test/` that do not end in `.test.ts` are type-checked by `npm run typecheck` (`tsconfig.json` includes `test/**/*.ts`) but are not executed by `npm test` (`tsx --test test/*.test.ts`). That is why `test/store-contract.ts`, `test/acceptance-report.ts` and `test/standalone.acceptance.ts` never run on their own.

Conventions used by every task: local imports carry the `.js` suffix; tests are flat top-level `test(...)` calls, no `describe`; each case creates what it needs and removes it in `finally`. Run one file with `npx tsx --test test/<file>.test.ts`.

Expected-output blocks are abridged: the duration in parentheses after each test name, stack traces and some summary lines (`ℹ suites`, `ℹ cancelled`, `ℹ duration_ms`, sometimes a counter that is zero) are left out. The lines and counters that are shown must match.

---

### Task 1: Contract scaffold and SQLite harness

**Files:**
- Create: `test/store-contract.ts`
- Modify: `test/store.test.ts` (whole file, lines 1-29 as of commit `17d571f`)
- Test: `test/store.test.ts`

**Interfaces:**
- Consumes: `SqliteStore` (`new SqliteStore(path)`) from `src/storage/sqlite.ts`; `Store` from `src/storage/store.ts`; `DomainError` from `src/contracts.ts`.
- Produces (all in `test/store-contract.ts`):
  - `export type ContractStore = Store & { queryMemory: NonNullable<Store['queryMemory']> };`
  - `export interface StoreHarness { open(): Promise<ContractStore>; dispose(): Promise<void>; }`
  - `export function storeContract(label: string, createHarness: () => Promise<StoreHarness>, skip: string | false = false): void`
  - inside `storeContract`: `contract(name: string, body: (harness: StoreHarness) => Promise<void>): void`, the only way later tasks add cases; module-level helper `domainError(code: string, statusCode: number): (error: unknown) => boolean`.
- Produces (in `test/store.test.ts`): `async function sqliteHarness(): Promise<StoreHarness>`.

- [ ] **Step 1: Write the failing test**

Replace the whole of `test/store.test.ts` with:

```ts
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteStore } from '../src/storage/sqlite.js';
import { storeContract, type StoreHarness } from './store-contract.js';

async function sqliteHarness(): Promise<StoreHarness> {
  const directory = await mkdtemp(join(tmpdir(), 'kiancode-store-'));
  const path = join(directory, 'state.sqlite');
  let store: SqliteStore | undefined;
  return {
    async open() {
      await store?.close();
      store = new SqliteStore(path);
      return store;
    },
    async dispose() {
      await store?.close();
      await rm(directory, { recursive: true, force: true });
    },
  };
}

storeContract('SqliteStore', sqliteHarness);
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx --test test/store.test.ts`

Expected: FAIL, because the contract module does not exist yet:

```
Error [ERR_MODULE_NOT_FOUND]: Cannot find module '<repo>/test/store-contract.js' imported from <repo>/test/store.test.ts
ℹ pass 0
ℹ fail 1
```

- [ ] **Step 3: Write minimal implementation**

Create `test/store-contract.ts`. The single case is the old `test/store.test.ts` case, moved here unchanged in meaning; the message regexes become checks of the `DomainError` code and status, and "reopen" goes through the harness so the same case can run on any store.

```ts
import assert from 'node:assert/strict';
import test from 'node:test';
import { DomainError } from '../src/contracts.js';
import type { Store } from '../src/storage/store.js';

export type ContractStore = Store & { queryMemory: NonNullable<Store['queryMemory']> };

export interface StoreHarness {
  /** Closes the handle returned by the previous call, if any, and opens a new one on the same durable data. */
  open(): Promise<ContractStore>;
  /** Closes the current handle and deletes the data. */
  dispose(): Promise<void>;
}

const domainError = (code: string, statusCode: number) => (error: unknown): boolean =>
  error instanceof DomainError && error.code === code && error.statusCode === statusCode;

export function storeContract(label: string, createHarness: () => Promise<StoreHarness>, skip: string | false = false): void {
  const contract = (name: string, body: (harness: StoreHarness) => Promise<void>): void => {
    test(`${label}: ${name}`, { skip }, async () => {
      const harness = await createHarness();
      try {
        await body(harness);
      } finally {
        await harness.dispose();
      }
    });
  };

  contract('records survive reopening and stay owner-scoped', async (harness) => {
    let store = await harness.open();
    const record = await store.create('conversation', 'alice', { title: 'My project' });
    assert.equal(await store.get('conversation', record.id, 'bob'), undefined);
    assert.deepEqual(await store.scan('conversation', 'bob'), []);
    const updated = await store.put('conversation', record.id, 'alice', { title: 'Updated' }, record.revision);
    await assert.rejects(store.put('conversation', record.id, 'alice', { title: 'Stale' }, record.revision), domainError('conflict', 409));
    await assert.rejects(store.put('conversation', record.id, 'bob', { title: 'Intrusion' }, updated.revision), domainError('not_found', 404));
    store = await harness.open();
    const reopened = await store.get<{ title: string }>('conversation', record.id, 'alice');
    assert.equal(reopened?.data.title, 'Updated');
    assert.equal(reopened?.revision, updated.revision);
    assert.equal(await store.remove('conversation', record.id, 'bob', updated.revision), false);
    assert.equal((await store.get('conversation', record.id, 'alice'))?.revision, updated.revision);
    assert.equal(await store.remove('conversation', record.id, 'alice', updated.revision), true);
    assert.equal(await store.get('conversation', record.id, 'alice'), undefined);
  });
}
```

Rules for every case added to `storeContract` later: a case never calls `store.close()` (the harness owns the handle; `PostgresStore.close()` may only be called once); a case never passes a `concurrency` option or nests subtests (the PostgreSQL harness in Task 2 relies on cases running one after another).

- [ ] **Step 4: Run test to verify it passes**

Run: `npx tsx --test test/store.test.ts`

Expected:

```
✔ SqliteStore: records survive reopening and stay owner-scoped
ℹ tests 1
ℹ pass 1
ℹ fail 0
ℹ skipped 0
```

Run: `npx tsc --noEmit` — expected: no output.

- [ ] **Step 5: Commit**

```bash
git add test/store-contract.ts test/store.test.ts
git commit -m "測試：建立儲存層契約測試骨架並以 SQLite 執行"
```

---

### Task 2: PostgreSQL harness, environment gate and skip reporting

**Files:**
- Modify: `test/store.test.ts` (whole file as written in Task 1; symbols `sqliteHarness` and the `storeContract('SqliteStore', sqliteHarness)` registration stay)
- Test: `test/store.test.ts`

**Interfaces:**
- Consumes: `storeContract(label, createHarness, skip)` and `StoreHarness` from Task 1; `PostgresStore.connect(connectionString: string): Promise<PostgresStore>` from `src/storage/postgres.ts` (unchanged); `Pool` from `pg`.
- Produces (all local to `test/store.test.ts`):
  - `function postgresSkipReason(environment: NodeJS.ProcessEnv): string | false` — `false` when `KIANCODE_TEST_DATABASE_URL` is non-empty, otherwise the string `'KIANCODE_TEST_DATABASE_URL is not set'`.
  - `interface PostgresHarness extends StoreHarness { admin: Pool; schema: string; has(name: string): Promise<boolean>; }`
  - `async function postgresHarness(connectionString: string): Promise<PostgresHarness>`
  - `const postgresUrl: string` and `const postgresSkip: string | false` — used by Task 4 for its PostgreSQL-only case.
  - Environment variable `KIANCODE_TEST_DATABASE_URL` (tests only): any connection string `pg` accepts, including the Unix-socket forms `socket:/socket-dir?db=name`, `postgresql://user@/name?host=/socket-dir` and `/socket-dir name`.

How the isolation works, so that nobody "simplifies" it: `PostgresStore` uses the unqualified table name `kiancode_entities` everywhere, and its `connect` bootstraps the table wherever the session `search_path` points. `pg` reads the environment variable `PGOPTIONS` each time it opens a connection and sends it as the startup `options` parameter (`node_modules/pg/lib/connection-parameters.js`, `val('options', config)`). The harness creates a schema `kiancode_test_<32 hex>`, sets `PGOPTIONS` to `-c search_path=<schema>` for as long as the case's store is open, and then calls the production `connect` unchanged. The store's pool opens connections lazily, so `PGOPTIONS` must stay set until `dispose()`; that is safe only because the cases in this file run one after another. A connection string that carries its own `options=` parameter wins over `PGOPTIONS`; the harness detects that after connecting and fails the case before any row is written.

- [ ] **Step 1: Write the failing test**

Replace the whole of `test/store.test.ts` with the following. It is the Task 1 file plus: five more imports, the gate constants, the PostgreSQL registration and five new top-level tests. The two functions it calls (`postgresSkipReason` and `postgresHarness`) and the `PostgresHarness` type are added in Step 3.

```ts
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { Pool } from 'pg';
import { PostgresStore } from '../src/storage/postgres.js';
import { SqliteStore } from '../src/storage/sqlite.js';
import { storeContract, type StoreHarness } from './store-contract.js';

async function sqliteHarness(): Promise<StoreHarness> {
  const directory = await mkdtemp(join(tmpdir(), 'kiancode-store-'));
  const path = join(directory, 'state.sqlite');
  let store: SqliteStore | undefined;
  return {
    async open() {
      await store?.close();
      store = new SqliteStore(path);
      return store;
    },
    async dispose() {
      await store?.close();
      await rm(directory, { recursive: true, force: true });
    },
  };
}

// HARNESS FUNCTIONS GO HERE (Step 3)

const postgresUrl = process.env.KIANCODE_TEST_DATABASE_URL ?? '';
const postgresSkip = postgresSkipReason(process.env);

storeContract('SqliteStore', sqliteHarness);
storeContract('PostgresStore', () => postgresHarness(postgresUrl), postgresSkip);

test('PostgreSQL cases are skipped only when KIANCODE_TEST_DATABASE_URL is unset or empty', () => {
  assert.equal(postgresSkipReason({}), 'KIANCODE_TEST_DATABASE_URL is not set');
  assert.equal(postgresSkipReason({ KIANCODE_TEST_DATABASE_URL: '' }), 'KIANCODE_TEST_DATABASE_URL is not set');
  assert.equal(postgresSkipReason({ DATABASE_URL: 'socket:/run/postgresql?db=production' }), 'KIANCODE_TEST_DATABASE_URL is not set');
  assert.equal(postgresSkipReason({ KIANCODE_TEST_DATABASE_URL: 'socket:/run/postgresql?db=disposable' }), false);
});

test('an unreachable PostgreSQL database fails the harness instead of skipping', async () => {
  const before = process.env.PGOPTIONS;
  await assert.rejects(postgresHarness('socket:/kiancode-test-no-such-directory?db=unused'), (error: unknown) => {
    const failure = error as NodeJS.ErrnoException & { address?: string };
    return failure.code === 'ENOENT' && failure.address?.startsWith('/kiancode-test-no-such-directory/.s.PGSQL.') === true;
  });
  assert.equal(process.env.PGOPTIONS, before);
});

test('PostgreSQL: connect bootstraps the table and index inside the case schema and keeps rows across reconnects', { skip: postgresSkip }, async () => {
  const harness = await postgresHarness(postgresUrl);
  try {
    let store = await harness.open();
    assert.equal(await harness.has('kiancode_entities'), true);
    assert.equal(await harness.has('kiancode_entities_owner_kind'), true);
    const created = await store.create('note', 'alice', { value: 1 }, 'kept');
    store = await harness.open();
    assert.deepEqual(await store.get('note', 'kept', 'alice'), created);
  } finally {
    await harness.dispose();
  }
});

test('PostgreSQL: connect re-creates a missing owner index without touching rows', { skip: postgresSkip }, async () => {
  const harness = await postgresHarness(postgresUrl);
  try {
    let store = await harness.open();
    const created = await store.create('note', 'alice', { value: 1 }, 'kept');
    await harness.admin.query(`DROP INDEX ${harness.schema}.kiancode_entities_owner_kind`);
    assert.equal(await harness.has('kiancode_entities_owner_kind'), false);
    store = await harness.open();
    assert.equal(await harness.has('kiancode_entities_owner_kind'), true);
    assert.deepEqual(await store.get('note', 'kept', 'alice'), created);
  } finally {
    await harness.dispose();
  }
});

test('PostgreSQL: a disposed case leaves no schema behind and restores PGOPTIONS', { skip: postgresSkip }, async () => {
  const before = process.env.PGOPTIONS;
  const harness = await postgresHarness(postgresUrl);
  try {
    await harness.open();
    assert.equal(process.env.PGOPTIONS, `-c search_path=${harness.schema}`);
  } finally {
    await harness.dispose();
  }
  assert.equal(process.env.PGOPTIONS, before);
  const check = new Pool({ connectionString: postgresUrl, max: 1, connectionTimeoutMillis: 5000 });
  try {
    const result = await check.query<{ count: string }>('SELECT count(*) AS count FROM pg_namespace WHERE nspname = $1', [harness.schema]);
    assert.equal(Number(result.rows[0]?.count), 0);
  } finally {
    await check.end();
  }
});
```

The socket path `/kiancode-test-no-such-directory` does not exist on any machine, so that test never reaches a database; it proves two things at once: a connection failure rejects (it is not turned into a skip), and a `socket:` connection string, which `new URL` cannot represent correctly, reaches `pg` untouched (`pg` appends `/.s.PGSQL.<port>` to the directory it was given).

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx --test test/store.test.ts`

Expected: FAIL while loading the file:

```
const postgresSkip = postgresSkipReason(process.env);
                     ^

ReferenceError: postgresSkipReason is not defined
ℹ pass 0
ℹ fail 1
```

- [ ] **Step 3: Write minimal implementation**

In `test/store.test.ts`, replace the line

```ts
// HARNESS FUNCTIONS GO HERE (Step 3)
```

with:

```ts
function postgresSkipReason(environment: NodeJS.ProcessEnv): string | false {
  return environment.KIANCODE_TEST_DATABASE_URL ? false : 'KIANCODE_TEST_DATABASE_URL is not set';
}

interface PostgresHarness extends StoreHarness {
  /** One connection that never uses the test search path; every statement on it is schema-qualified. */
  admin: Pool;
  schema: string;
  /** Whether `<schema>.<name>` exists as a table or index. */
  has(name: string): Promise<boolean>;
}

async function postgresHarness(connectionString: string): Promise<PostgresHarness> {
  const schema = `kiancode_test_${randomBytes(16).toString('hex')}`;
  const admin = new Pool({ connectionString, max: 1, connectionTimeoutMillis: 5000 });
  try {
    await admin.query(`CREATE SCHEMA ${schema}`);
  } catch (error) {
    await admin.end();
    throw error;
  }
  const previousOptions = process.env.PGOPTIONS;
  let store: PostgresStore | undefined;
  const has = async (name: string): Promise<boolean> => {
    const result = await admin.query<{ present: boolean }>('SELECT to_regclass($1::text) IS NOT NULL AS present', [`${schema}.${name}`]);
    return result.rows[0]?.present === true;
  };
  return {
    admin,
    schema,
    has,
    async open() {
      const previous = store;
      store = undefined;
      await previous?.close();
      // pg sends PGOPTIONS as the startup `options` parameter of every connection the store's pool opens,
      // so the unqualified `kiancode_entities` statements of the production store resolve inside the test schema.
      process.env.PGOPTIONS = `-c search_path=${schema}`;
      store = await PostgresStore.connect(connectionString);
      if (!await has('kiancode_entities')) {
        throw new Error('PostgreSQL test isolation failed: the store did not bootstrap inside its test schema. '
          + 'KIANCODE_TEST_DATABASE_URL must not carry an options parameter and must reach the server directly.');
      }
      return store;
    },
    async dispose() {
      try {
        await store?.close();
      } finally {
        if (previousOptions === undefined) delete process.env.PGOPTIONS;
        else process.env.PGOPTIONS = previousOptions;
        try {
          await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
        } finally {
          await admin.end();
        }
      }
    },
  };
}
```

Points a reviewer should check against this code: the schema name is built only from `kiancode_test_` and hex digits, so interpolating it into SQL is safe; `connectionString` goes to `new Pool` and to `PostgresStore.connect` and nowhere else; `open()` closes the previous store handle exactly once; `dispose()` restores `PGOPTIONS`, drops the schema and ends the admin pool even when closing the store throws; when `CREATE SCHEMA` fails the admin pool is ended before the error propagates, so the process can exit.

- [ ] **Step 4: Run test to verify it passes**

Run (without the variable): `env -u KIANCODE_TEST_DATABASE_URL npx tsx --test test/store.test.ts`

Expected — the PostgreSQL cases are listed with `﹣` and the reason, and counted under `skipped`, not `pass`:

```
✔ SqliteStore: records survive reopening and stay owner-scoped
﹣ PostgresStore: records survive reopening and stay owner-scoped # KIANCODE_TEST_DATABASE_URL is not set
✔ PostgreSQL cases are skipped only when KIANCODE_TEST_DATABASE_URL is unset or empty
✔ an unreachable PostgreSQL database fails the harness instead of skipping
﹣ PostgreSQL: connect bootstraps the table and index inside the case schema and keeps rows across reconnects # KIANCODE_TEST_DATABASE_URL is not set
﹣ PostgreSQL: connect re-creates a missing owner index without touching rows # KIANCODE_TEST_DATABASE_URL is not set
﹣ PostgreSQL: a disposed case leaves no schema behind and restores PGOPTIONS # KIANCODE_TEST_DATABASE_URL is not set
ℹ tests 7
ℹ pass 3
ℹ fail 0
ℹ skipped 4
```

Run (variable set, nothing listening): `KIANCODE_TEST_DATABASE_URL='socket:/kiancode-test-no-such-directory?db=unused' npx tsx --test test/store.test.ts`

Expected — the four PostgreSQL cases fail with `Error: connect ENOENT /kiancode-test-no-such-directory/.s.PGSQL.5432`, none is skipped, and the command returns promptly:

```
ℹ tests 7
ℹ pass 3
ℹ fail 4
ℹ skipped 0
```

Run: `npx tsc --noEmit` — expected: no output.

Not validated locally: the `PostgresStore:` contract case and the three `PostgreSQL:` cases need a reachable PostgreSQL server, and none is reachable from the machine this plan was written on. Everything above (skip reporting, failure on an unreachable database, typecheck) was run. If a disposable database is available, also run

```bash
KIANCODE_TEST_DATABASE_URL='socket:/path/to/socket-dir?db=DISPOSABLE_DB' npx tsx --test test/store.test.ts
```

and expect `ℹ tests 7`, `ℹ pass 7`, `ℹ fail 0`, `ℹ skipped 0`. The role must be allowed to `CREATE SCHEMA` in that database, the database encoding must be UTF8, and the string must not contain `options=`. If any PostgreSQL case is red, do not edit `src/`: record the case name and the error text in the commit message body or the review notes and stop for a decision. If the failure is the message `PostgreSQL test isolation failed`, the connection goes through a pooler that drops startup options or the string carries `options=`; use a direct server socket.

- [ ] **Step 5: Commit**

```bash
git status --short src
git add test/store.test.ts
git commit -m "測試：契約測試可選擇對 PostgreSQL 執行，未設定時回報為略過"
```

`git status --short src` must print nothing.

---

### Task 3: Entity contract cases and recorded entity divergences

**Files:**
- Modify: `test/store-contract.ts` (imports, one new module-level constant, eight cases added inside `storeContract` after the case `records survive reopening and stay owner-scoped`)
- Modify: `test/store.test.ts` (append the `divergence` helper and five `todo` records at the end of the file)
- Mutated in Step 2 and restored in Step 3, never committed: `src/storage/sqlite.ts`
- Test: `test/store.test.ts`

**Interfaces:**
- Consumes: `contract(name, body)`, `domainError(code, statusCode)`, `StoreHarness.open()` from Task 1. `Store` methods as they exist in `src/storage/store.ts`: `create<T>(kind, ownerId, data, id?)`, `get<T>(kind, id, ownerId)`, `scan<T>(kind, ownerId?)`, `put<T>(kind, id, ownerId, data, expectedRevision)`, `remove(kind, id, ownerId, expectedRevision)`.
- Produces: module-level `const timestamp: RegExp` in `test/store-contract.ts`; `function divergence(subject: string, description: string): void` in `test/store.test.ts` (Task 4 calls it again).

These cases pin behaviour that both stores already implement, so there is no production code to write. The red step is therefore a mutation check: break `SqliteStore` on purpose, watch the new cases catch it, then restore the file.

- [ ] **Step 1: Write the failing test**

In `test/store-contract.ts` replace

```ts
import test from 'node:test';
import { DomainError } from '../src/contracts.js';
```

with

```ts
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { DomainError } from '../src/contracts.js';
```

and replace

```ts
const domainError = (code: string, statusCode: number) => (error: unknown): boolean =>
```

with

```ts
const timestamp = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

const domainError = (code: string, statusCode: number) => (error: unknown): boolean =>
```

Then, inside `storeContract`, directly after the closing `});` of the case `records survive reopening and stay owner-scoped` and before the final `}` of the function, insert:

```ts

  contract('create assigns revision 1, millisecond timestamps and honours an explicit id', async (harness) => {
    const store = await harness.open();
    const generated = await store.create('note', 'alice', { value: 1 });
    assert.match(generated.id, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    assert.equal(generated.ownerId, 'alice');
    assert.strictEqual(generated.revision, 1);
    assert.match(generated.createdAt, timestamp);
    assert.equal(generated.updatedAt, generated.createdAt);
    const explicit = await store.create('note', 'alice', { value: 2 }, 'chosen-id');
    assert.equal(explicit.id, 'chosen-id');
    assert.deepEqual(await store.get('note', 'chosen-id', 'alice'), {
      id: 'chosen-id', ownerId: 'alice', revision: 1, createdAt: explicit.createdAt, updatedAt: explicit.updatedAt, data: { value: 2 },
    });
  });

  contract('put increments the revision, keeps createdAt and rejects stale or unknown writes', async (harness) => {
    const store = await harness.open();
    const created = await store.create('note', 'alice', { step: 1 }, 'note');
    await delay(5);
    const updated = await store.put('note', 'note', 'alice', { step: 2 }, created.revision);
    assert.strictEqual(updated.revision, 2);
    assert.equal(updated.createdAt, created.createdAt);
    assert.match(updated.updatedAt, timestamp);
    assert.ok(updated.updatedAt > created.updatedAt);
    assert.deepEqual(updated.data, { step: 2 });
    await assert.rejects(store.put('note', 'note', 'alice', { step: 3 }, created.revision), domainError('conflict', 409));
    assert.deepEqual(await store.get('note', 'note', 'alice'), updated);
    await assert.rejects(store.put('note', 'missing', 'alice', { step: 1 }, 1), domainError('not_found', 404));
    assert.equal(await store.get('note', 'missing', 'alice'), undefined);
  });

  contract('only one of several concurrent writers holding the same revision wins', async (harness) => {
    const store = await harness.open();
    const created = await store.create('note', 'alice', { writer: -1 }, 'note');
    const results = await Promise.allSettled(Array.from({ length: 8 }, (_, writer) => (
      store.put('note', 'note', 'alice', { writer }, created.revision)
    )));
    const winners = results.flatMap((result) => (result.status === 'fulfilled' ? [result.value] : []));
    const failures = results.flatMap((result) => (result.status === 'rejected' ? [result.reason as unknown] : []));
    assert.equal(winners.length, 1);
    assert.equal(failures.length, 7);
    assert.ok(failures.every(domainError('conflict', 409)));
    const stored = await store.get('note', 'note', 'alice');
    assert.strictEqual(stored?.revision, 2);
    assert.deepEqual(stored?.data, winners[0]?.data);
  });

  contract('create rejects an id already used in the same kind, whoever owns it', async (harness) => {
    const store = await harness.open();
    await store.create('note', 'alice', { value: 'original' }, 'shared');
    await assert.rejects(store.create('note', 'alice', { value: 'again' }, 'shared'), domainError('conflict', 409));
    await assert.rejects(store.create('note', 'bob', { value: 'intruder' }, 'shared'), domainError('conflict', 409));
    assert.deepEqual((await store.get('note', 'shared', 'alice'))?.data, { value: 'original' });
    assert.equal(await store.get('note', 'shared', 'bob'), undefined);
    const otherKind = await store.create('task', 'bob', { value: 'other kind' }, 'shared');
    assert.strictEqual(otherKind.revision, 1);
    const racing = await Promise.allSettled([
      store.create('note', 'alice', { value: 'first' }, 'raced'),
      store.create('note', 'alice', { value: 'second' }, 'raced'),
    ]);
    assert.equal(racing.filter((result) => result.status === 'fulfilled').length, 1);
    assert.equal((await store.scan('note')).length, 2);
  });

  contract('remove needs the current revision and frees the id', async (harness) => {
    const store = await harness.open();
    const created = await store.create('note', 'alice', { value: 1 }, 'note');
    const updated = await store.put('note', 'note', 'alice', { value: 2 }, created.revision);
    await assert.rejects(store.remove('note', 'note', 'alice', created.revision), domainError('conflict', 409));
    assert.deepEqual(await store.get('note', 'note', 'alice'), updated);
    assert.equal(await store.remove('note', 'missing', 'alice', 1), false);
    assert.equal(await store.remove('note', 'note', 'alice', updated.revision), true);
    assert.equal(await store.remove('note', 'note', 'alice', updated.revision), false);
    const recreated = await store.create('note', 'alice', { value: 3 }, 'note');
    assert.strictEqual(recreated.revision, 1);
  });

  contract('scan returns one kind, optionally one owner, in creation order', async (harness) => {
    const store = await harness.open();
    for (const id of ['c', 'b', 'a']) {
      await store.create('note', 'alice', { id }, id);
      await delay(5);
    }
    await store.create('note', 'bob', { id: 'd' }, 'd');
    await store.create('task', 'alice', { id: 'e' }, 'e');
    assert.deepEqual((await store.scan('note', 'alice')).map((row) => row.id), ['c', 'b', 'a']);
    assert.deepEqual((await store.scan('note', 'bob')).map((row) => row.id), ['d']);
    assert.deepEqual((await store.scan('note')).map((row) => row.id), ['c', 'b', 'a', 'd']);
    assert.deepEqual((await store.scan('note')).map((row) => row.ownerId), ['alice', 'alice', 'alice', 'bob']);
    assert.deepEqual(await store.scan('unknown-kind'), []);
    assert.deepEqual(await store.scan('unknown-kind', 'alice'), []);
  });

  contract('JSON data round-trips exactly', async (harness) => {
    let store = await harness.open();
    const data = {
      cjk: '海事專案：繁體中文と日本語のテキスト',
      emoji: '🙂 👩‍💻',
      quotes: `'single' "double" \`backtick\``,
      escapes: 'back\\slash\nnewline\ttab',
      wildcards: '100% _under_score_',
      nested: { list: [1, 'two', { three: 3 }, [4]], empty: {}, none: null },
      flags: [true, false],
      numbers: [0, 2.5, -7],
      blank: '',
    };
    const created = await store.create('note', 'alice', data, 'note');
    assert.deepEqual((await store.get('note', 'note', 'alice'))?.data, data);
    const changed = { ...data, nested: { list: [], empty: {}, none: null }, blank: ' ' };
    await store.put('note', 'note', 'alice', changed, created.revision);
    store = await harness.open();
    assert.deepEqual((await store.get('note', 'note', 'alice'))?.data, changed);
    assert.deepEqual((await store.scan('note', 'alice')).map((row) => row.data), [changed]);
  });

  contract('identifiers are opaque values, never SQL or patterns', async (harness) => {
    const store = await harness.open();
    const hostileOwner = `o'; DROP TABLE kiancode_entities; DROP TABLE entities; --`;
    const awkwardId = `id "quoted" 'single' 100% back\\slash and space`;
    await store.create('note', hostileOwner, { value: 'hostile owner' }, awkwardId);
    await store.create('note', 'alice', { value: 'upper' }, 'Record-A');
    await store.create('note', 'alice', { value: 'lower' }, 'record-a');
    assert.deepEqual((await store.get('note', awkwardId, hostileOwner))?.data, { value: 'hostile owner' });
    assert.equal(await store.get('note', awkwardId, 'alice'), undefined);
    assert.equal(await store.get('note', 'id%', hostileOwner), undefined);
    assert.equal(await store.get('note', awkwardId, '%'), undefined);
    assert.deepEqual((await store.scan('note', hostileOwner)).map((row) => row.id), [awkwardId]);
    assert.deepEqual(await store.scan('note', '%'), []);
    assert.deepEqual((await store.get('note', 'Record-A', 'alice'))?.data, { value: 'upper' });
    assert.deepEqual((await store.get('note', 'record-a', 'alice'))?.data, { value: 'lower' });
    assert.equal(await store.get('note', 'RECORD-A', 'alice'), undefined);
    assert.equal((await store.scan('note')).length, 3);
  });
```

What the cases deliberately avoid, because the two stores are known to differ there (see the `todo` records below): strings containing U+0000 or lone surrogates, `-0`, keys whose value is `undefined`, non-integer revisions, calling `close()` twice, comparing the object returned by `create` instead of reading back through `get`, and asserting the order of rows created less than a few milliseconds apart (hence the `delay(5)` calls).

At the end of `test/store.test.ts` append:

```ts

// Known differences between the two stores. They are recorded here, not fixed (spec G1): each one needs a
// decision about which behaviour is right before it can become a contract case.
function divergence(subject: string, description: string): void {
  test(`store divergence: ${subject}`, { todo: description });
}

divergence('strings containing U+0000 or a lone surrogate', 'SQLite stores them; PostgreSQL JSONB rejects the write with a raw driver error, not a DomainError');
divergence('closing a store twice', 'SqliteStore.close() is idempotent; PostgresStore.close() rejects on the second call');
divergence('scan order of rows created within the same millisecond', 'SQLite orders by millisecond text, then id; PostgreSQL orders by microsecond timestamp, then id');
divergence('the entity returned by create', 'SqliteStore returns the caller\'s data object as given; PostgresStore returns its JSONB round-trip');
divergence('a non-integer expectedRevision', 'SQLite reports conflict (409); PostgreSQL raises a raw bigint cast error');
```

A `todo` record has no body on purpose: it documents a difference in every test run without choosing which store is right. It is counted under `todo`, never under `fail`.

- [ ] **Step 2: Run test to verify it fails**

Mutation check. In `src/storage/sqlite.ts`, in the method `put`, temporarily change the end of the `UPDATE` statement from `AND revision=?')` to `AND revision>=?')` (this makes a stale writer succeed). Do not touch the `DELETE` statement in `remove`.

Run: `npx tsx --test test/store.test.ts`

Expected: FAIL in exactly these three cases:

```
✖ SqliteStore: records survive reopening and stay owner-scoped
  AssertionError [ERR_ASSERTION]: Missing expected rejection.
✖ SqliteStore: put increments the revision, keeps createdAt and rejects stale or unknown writes
  AssertionError [ERR_ASSERTION]: Missing expected rejection.
✖ SqliteStore: only one of several concurrent writers holding the same revision wins
  AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:
    actual: 8,
    expected: 1,
```

- [ ] **Step 3: Write minimal implementation**

No production change is needed; both stores already behave as the cases require. Undo the mutation:

```bash
git checkout -- src/storage/sqlite.ts
git status --short src
```

`git status --short src` must print nothing.

- [ ] **Step 4: Run test to verify it passes**

Run: `env -u KIANCODE_TEST_DATABASE_URL npx tsx --test test/store.test.ts`

Expected: nine `✔ SqliteStore: …` lines, nine `﹣ PostgresStore: …` lines, the two gate tests passing, three `﹣ PostgreSQL: …` lines, five `store divergence: …` lines each followed by `# <description>`, and:

```
ℹ tests 28
ℹ pass 11
ℹ fail 0
ℹ skipped 12
ℹ todo 5
```

Run: `npx tsc --noEmit` — expected: no output.

Not validated locally: the nine `PostgresStore:` cases (no PostgreSQL server reachable). They were written against a line-by-line reading of `src/storage/postgres.ts`: `create` maps unique violation `23505` to `conflict`/409 for any owner because the primary key is `(kind, id)`; `put` and `remove` return `not_found`/`false` when the owner sees no row and `conflict` when the row exists at another revision; concurrent `UPDATE … WHERE revision=$5` statements serialise on the row lock, so one succeeds and seven re-evaluate to zero rows; `created_at` and `updated_at` are `NOW()` rendered through `toISOString()`, hence millisecond strings; `BIGINT` revisions are converted with `Number()`. With a disposable database expect `ℹ tests 28`, `ℹ pass 23`, `ℹ skipped 0`, `ℹ todo 5`. A red PostgreSQL case is a finding to report, not something to fix under `src/` in this plan.

- [ ] **Step 5: Commit**

```bash
git status --short src
git add test/store-contract.ts test/store.test.ts
git commit -m "測試：契約測試涵蓋修訂衝突、建立衝突、刪除、排序與資料往返"
```

---

### Task 4: Memory query contract cases and recorded memory divergences

**Files:**
- Modify: `test/store-contract.ts` (one import, four module-level helpers, ten cases added inside `storeContract` after the case `identifiers are opaque values, never SQL or patterns`)
- Modify: `test/store.test.ts` (append one PostgreSQL-only case and five `todo` records at the end of the file)
- Mutated in Step 2 and restored in Step 3, never committed: `src/memory-query.ts`
- Test: `test/store.test.ts`

**Interfaces:**
- Consumes: `contract(name, body)`, `domainError(code, statusCode)`, `delay` from Tasks 1 and 3; `postgresHarness(connectionString)`, `PostgresHarness.admin`, `PostgresHarness.schema`, `postgresUrl`, `postgresSkip` from Task 2; `divergence(subject, description)` from Task 3. From `src/memory-query.ts` (unchanged): `store.queryMemory({ ownerId, purpose: 'relevant', context: { scope, conversationId, workspaceId?, agentId?, prompt }, now?, limit })` and `store.queryMemory({ ownerId, purpose: 'list', q?, scope?, scopeId?, reviewStatus?, includeExpired?, now?, limit, cursor? })`, both returning `{ rows: Array<Entity<Memory>>; nextCursor?: string }`. `Memory` from `src/domain.ts`.
- Produces: module-level helpers in `test/store-contract.ts`: `const current = '2026-09-27T12:00:00.000Z'`, `const now: number`, `memory(text: string, changes?: Partial<Memory>): Memory`, `ids(rows: Array<{ id: string }>): string[]`.

`SqliteStore.queryMemory` filters and sorts in JavaScript (`relevantMemory` and `listMemoryRows` in `src/memory-query.ts`); `PostgresStore.queryMemory` does the same work in SQL. These cases are the first to run both through one set of expectations. They always pass an explicit `now`, use millisecond ISO timestamps ending in `Z`, and use lowercase ids of one shape, because outside those inputs the two implementations are known to differ (recorded as `todo` below). The existing files `test/memory-query.test.ts` and `test/memory-retrieval.test.ts` are not touched.

- [ ] **Step 1: Write the failing test**

In `test/store-contract.ts` replace

```ts
import { DomainError } from '../src/contracts.js';
import type { Store } from '../src/storage/store.js';
```

with

```ts
import { DomainError } from '../src/contracts.js';
import type { Memory } from '../src/domain.js';
import type { Store } from '../src/storage/store.js';
```

and replace

```ts
const domainError = (code: string, statusCode: number) => (error: unknown): boolean =>
```

with

```ts
const current = '2026-09-27T12:00:00.000Z';
const now = Date.parse(current);
const memory = (text: string, changes: Partial<Memory> = {}): Memory => ({
  type: 'document',
  text,
  scope: 'private',
  source: 'synthetic:test',
  validFrom: '2026-01-01T00:00:00.000Z',
  ...changes,
});
const ids = (rows: Array<{ id: string }>): string[] => rows.map((row) => row.id);

const domainError = (code: string, statusCode: number) => (error: unknown): boolean =>
```

Then, inside `storeContract`, directly after the closing `});` of the case `identifiers are opaque values, never SQL or patterns` and before the final `}` of the function, insert:

```ts

  contract('relevant memory honours replacement, scope, expiry and owner', async (harness) => {
    const store = await harness.open();
    await store.create('memory', 'owner', memory('海事專案引用香港法例的官方文件。'), 'maritime');
    await store.create('memory', 'owner', memory('今天午餐吃番茄炒蛋。'), 'unrelated');
    await store.create('memory', 'owner', memory('海事專案使用舊版法例。'), 'old');
    await store.create('memory', 'owner', memory('海事專案引用更新後的香港法例。', { replacesId: 'old' }), 'replacement');
    await store.create('memory', 'owner', memory('工作區海事專案資料。', { scope: 'workspace', scopeId: 'workspace' }), 'workspace');
    await store.create('memory', 'owner', memory('其他工作區海事專案資料。', { scope: 'workspace', scopeId: 'other' }), 'other-workspace');
    await store.create('memory', 'owner', memory('群組海事專案資料。', { scope: 'group', scopeId: 'group' }), 'group');
    await store.create('memory', 'owner', memory('已過期海事專案資料。', { validTo: current }), 'expired');
    await store.create('memory', 'other-owner', memory('其他使用者海事專案資料。'), 'other-owner');

    const privatePage = await store.queryMemory({
      ownerId: 'owner',
      purpose: 'relevant',
      context: { scope: 'private', conversationId: 'private', workspaceId: 'workspace', prompt: '可以講返海事專案嘅法例資料來源嗎？' },
      now: now + 1,
      limit: 12,
    });
    assert.deepEqual(new Set(ids(privatePage.rows)), new Set(['maritime', 'replacement', 'workspace']));
    assert.equal(privatePage.nextCursor, undefined);

    const groupPage = await store.queryMemory({
      ownerId: 'owner',
      purpose: 'relevant',
      context: { scope: 'group', conversationId: 'group', prompt: '海事專案' },
      now: now + 1,
      limit: 12,
    });
    assert.deepEqual(ids(groupPage.rows), ['group']);
  });

  contract('relevant memory shows workspace and agent rows only to the matching context', async (harness) => {
    const store = await harness.open();
    await store.create('memory', 'owner', memory('parser notes, private'), 'private');
    await store.create('memory', 'owner', memory('parser notes, workspace', { scope: 'workspace', scopeId: 'workspace-1' }), 'workspace');
    await store.create('memory', 'owner', memory('parser notes, agent', { scope: 'agent', scopeId: 'agent-1' }), 'agent');
    const visible = async (context: { scope: 'private' | 'group'; workspaceId?: string; agentId?: string }): Promise<Set<string>> => new Set(ids((await store.queryMemory({
      ownerId: 'owner',
      purpose: 'relevant',
      context: { conversationId: 'workspace-1', prompt: 'parser notes', ...context },
      now,
      limit: 12,
    })).rows));
    assert.deepEqual(await visible({ scope: 'private' }), new Set(['private']));
    assert.deepEqual(await visible({ scope: 'private', workspaceId: 'workspace-1' }), new Set(['private', 'workspace']));
    assert.deepEqual(await visible({ scope: 'private', workspaceId: 'workspace-2' }), new Set(['private']));
    assert.deepEqual(await visible({ scope: 'private', agentId: 'agent-1' }), new Set(['private', 'agent']));
    assert.deepEqual(await visible({ scope: 'private', agentId: 'agent-2' }), new Set(['private']));
    assert.deepEqual(await visible({ scope: 'group', workspaceId: 'workspace-1', agentId: 'agent-1' }), new Set());
  });

  contract('relevant memory ranks persona first, then by matched terms, ignoring ASCII case, within the limit', async (harness) => {
    const store = await harness.open();
    await store.create('memory', 'owner', memory('Speak Traditional Chinese.', { type: 'persona' }), 'persona');
    await store.create('memory', 'owner', memory('The parser uses PostgreSQL transactions.'), 'one-term');
    await store.create('memory', 'owner', memory('PostgreSQL durability notes.'), 'two-terms');
    await store.create('memory', 'owner', memory('Apple pie recipe.'), 'unrelated');
    const relevant = async (limit: number): Promise<string[]> => ids((await store.queryMemory({
      ownerId: 'owner',
      purpose: 'relevant',
      context: { scope: 'private', conversationId: 'chat', prompt: 'Explain POSTGRESQL durability.' },
      now,
      limit,
    })).rows);
    assert.deepEqual(await relevant(12), ['persona', 'two-terms', 'one-term']);
    assert.deepEqual(await relevant(2), ['persona', 'two-terms']);
    assert.deepEqual(await relevant(1), ['persona']);
  });

  contract('held and rejected memories stay out of relevant results and the default list', async (harness) => {
    const store = await harness.open();
    await store.create('memory', 'owner', memory('parser notes'), 'unreviewed');
    await store.create('memory', 'owner', memory('parser notes', { reviewStatus: 'approved' }), 'approved');
    await store.create('memory', 'owner', memory('parser notes', { reviewStatus: 'held' }), 'held');
    await store.create('memory', 'owner', memory('parser notes', { reviewStatus: 'rejected' }), 'rejected');
    const relevant = await store.queryMemory({
      ownerId: 'owner', purpose: 'relevant', context: { scope: 'private', conversationId: 'chat', prompt: 'parser notes' }, now, limit: 12,
    });
    assert.deepEqual(new Set(ids(relevant.rows)), new Set(['unreviewed', 'approved']));
    const listed = await store.queryMemory({ ownerId: 'owner', purpose: 'list', now, limit: 12 });
    assert.deepEqual(new Set(ids(listed.rows)), new Set(['unreviewed', 'approved']));
    const approved = await store.queryMemory({ ownerId: 'owner', purpose: 'list', reviewStatus: 'approved', now, limit: 12 });
    assert.deepEqual(new Set(ids(approved.rows)), new Set(['unreviewed', 'approved']));
    const held = await store.queryMemory({ ownerId: 'owner', purpose: 'list', reviewStatus: 'held', now, limit: 12 });
    assert.deepEqual(ids(held.rows), ['held']);
    const rejected = await store.queryMemory({ ownerId: 'owner', purpose: 'list', reviewStatus: 'rejected', now, limit: 12 });
    assert.deepEqual(ids(rejected.rows), ['rejected']);
  });

  contract('memory outside its validity window is hidden unless expired rows are requested', async (harness) => {
    const store = await harness.open();
    await store.create('memory', 'owner', memory('parser notes', { validFrom: current }), 'starting-now');
    await store.create('memory', 'owner', memory('parser notes', { validFrom: '2026-09-27T12:00:00.001Z' }), 'future');
    await store.create('memory', 'owner', memory('parser notes', { validTo: current }), 'ending-now');
    await store.create('memory', 'owner', memory('parser notes', { validTo: '2026-09-27T12:00:00.001Z' }), 'ending-later');
    const relevant = await store.queryMemory({
      ownerId: 'owner', purpose: 'relevant', context: { scope: 'private', conversationId: 'chat', prompt: 'parser notes' }, now, limit: 12,
    });
    assert.deepEqual(new Set(ids(relevant.rows)), new Set(['starting-now', 'ending-later']));
    const listed = await store.queryMemory({ ownerId: 'owner', purpose: 'list', now, limit: 12 });
    assert.deepEqual(new Set(ids(listed.rows)), new Set(['starting-now', 'ending-later']));
    const everything = await store.queryMemory({ ownerId: 'owner', purpose: 'list', includeExpired: true, now, limit: 12 });
    assert.deepEqual(new Set(ids(everything.rows)), new Set(['starting-now', 'future', 'ending-now', 'ending-later']));
  });

  contract('memory list filters by scope and scope id and never crosses owners', async (harness) => {
    const store = await harness.open();
    await store.create('memory', 'owner', memory('private note'), 'private');
    await store.create('memory', 'owner', memory('workspace one', { scope: 'workspace', scopeId: 'workspace-1' }), 'workspace-1');
    await store.create('memory', 'owner', memory('workspace two', { scope: 'workspace', scopeId: 'workspace-2' }), 'workspace-2');
    await store.create('memory', 'other-owner', memory('private note of another owner'), 'isolated');
    const list = async (filters: { ownerId?: string; scope?: Memory['scope']; scopeId?: string }): Promise<Set<string>> => new Set(ids((await store.queryMemory({
      ownerId: 'owner', purpose: 'list', now, limit: 12, ...filters,
    })).rows));
    assert.deepEqual(await list({}), new Set(['private', 'workspace-1', 'workspace-2']));
    assert.deepEqual(await list({ scope: 'workspace' }), new Set(['workspace-1', 'workspace-2']));
    assert.deepEqual(await list({ scope: 'workspace', scopeId: 'workspace-2' }), new Set(['workspace-2']));
    assert.deepEqual(await list({ scope: 'group' }), new Set());
    assert.deepEqual(await list({ ownerId: 'other-owner' }), new Set(['isolated']));
    assert.deepEqual(await list({ ownerId: 'nobody' }), new Set());
  });

  contract('memory list pages through every match exactly once in a stable order', async (harness) => {
    const store = await harness.open();
    for (let index = 0; index < 7; index += 1) {
      await store.create('memory', 'owner', memory(`海事專案來源 ${index}`), `memory-${index}`);
    }
    await store.create('memory', 'owner', memory('無關內容。'), 'unrelated');
    await store.create('memory', 'other-owner', memory('海事專案不可見。'), 'isolated');
    const paged: string[] = [];
    let pages = 0;
    let cursor: string | undefined;
    do {
      const page = await store.queryMemory({
        ownerId: 'owner', purpose: 'list', q: '海事專案', scope: 'private', now, limit: 2, ...(cursor ? { cursor } : {}),
      });
      assert.ok(page.rows.length <= 2);
      paged.push(...ids(page.rows));
      cursor = page.nextCursor;
      pages += 1;
    } while (cursor && pages < 10);
    assert.equal(pages, 4);
    assert.deepEqual([...paged].sort(), ['memory-0', 'memory-1', 'memory-2', 'memory-3', 'memory-4', 'memory-5', 'memory-6']);
    const whole = await store.queryMemory({ ownerId: 'owner', purpose: 'list', q: '海事專案', scope: 'private', now, limit: 100 });
    assert.equal(whole.nextCursor, undefined);
    assert.deepEqual(paged, ids(whole.rows));
  });

  contract('memory list without a query returns the most recently written rows first', async (harness) => {
    const store = await harness.open();
    const first = await store.create('memory', 'owner', memory('first'), 'first');
    await delay(5);
    await store.create('memory', 'owner', memory('second'), 'second');
    await delay(5);
    await store.create('memory', 'owner', memory('third'), 'third');
    assert.deepEqual(ids((await store.queryMemory({ ownerId: 'owner', purpose: 'list', now, limit: 12 })).rows), ['third', 'second', 'first']);
    await delay(5);
    await store.put('memory', 'first', 'owner', memory('first, edited'), first.revision);
    assert.deepEqual(ids((await store.queryMemory({ ownerId: 'owner', purpose: 'list', now, limit: 12 })).rows), ['first', 'third', 'second']);
  });

  contract('memory search terms are literal text, not patterns', async (harness) => {
    const store = await harness.open();
    await store.create('memory', 'owner', memory('discount is 100% today'), 'percent');
    await store.create('memory', 'owner', memory('snake_case naming'), 'underscore');
    await store.create('memory', 'owner', memory('nothing special here'), 'plain');
    const search = async (q: string): Promise<string[]> => ids((await store.queryMemory({ ownerId: 'owner', purpose: 'list', q, now, limit: 12 })).rows);
    assert.deepEqual(await search('%'), ['percent']);
    assert.deepEqual(await search('_'), ['underscore']);
    assert.deepEqual(await search('NOTHING'), ['plain']);
    assert.deepEqual(await search('absent'), []);
  });

  contract('memory limits are bounded and malformed cursors are rejected', async (harness) => {
    const store = await harness.open();
    for (let index = 0; index < 13; index += 1) {
      await store.create('memory', 'owner', memory(`note ${index}`), `memory-${String(index).padStart(2, '0')}`);
    }
    const zero = await store.queryMemory({ ownerId: 'owner', purpose: 'list', now, limit: 0 });
    assert.equal(zero.rows.length, 1);
    assert.ok(zero.nextCursor);
    const fractional = await store.queryMemory({ ownerId: 'owner', purpose: 'list', now, limit: 2.5 });
    assert.equal(fractional.rows.length, 12);
    assert.ok(fractional.nextCursor);
    const huge = await store.queryMemory({ ownerId: 'owner', purpose: 'list', now, limit: 1000 });
    assert.equal(huge.rows.length, 13);
    assert.equal(huge.nextCursor, undefined);
    const relevant = await store.queryMemory({
      ownerId: 'owner', purpose: 'relevant', context: { scope: 'private', conversationId: 'chat', prompt: 'note' }, now, limit: 0,
    });
    assert.equal(relevant.rows.length, 1);
    await assert.rejects(store.queryMemory({ ownerId: 'owner', purpose: 'list', now, limit: 2, cursor: 'broken' }), domainError('invalid_cursor', 400));
    const withoutId = Buffer.from(JSON.stringify({ score: 0, updatedAt: current })).toString('base64url');
    await assert.rejects(store.queryMemory({ ownerId: 'owner', purpose: 'list', now, limit: 2, cursor: withoutId }), domainError('invalid_cursor', 400));
  });
```

At the end of `test/store.test.ts` append:

```ts

test('PostgreSQL: memory paging does not skip rows whose timestamps differ only below a millisecond', { skip: postgresSkip }, async () => {
  const harness = await postgresHarness(postgresUrl);
  try {
    const store = await harness.open();
    const data = { type: 'document', text: 'cursor match', scope: 'private', source: 'synthetic:test', validFrom: '2026-01-01T00:00:00.000Z' };
    await store.create('memory', 'owner', data, 'cursor-a');
    await store.create('memory', 'owner', data, 'cursor-z');
    for (const [id, updatedAt] of [['cursor-a', '2026-09-27T12:00:00.123789Z'], ['cursor-z', '2026-09-27T12:00:00.123456Z']]) {
      await harness.admin.query(`UPDATE ${harness.schema}.kiancode_entities SET updated_at = $1::timestamptz WHERE kind = 'memory' AND id = $2`, [updatedAt, id]);
    }
    const now = Date.parse('2026-09-27T12:00:01.000Z');
    const first = await store.queryMemory({ ownerId: 'owner', purpose: 'list', q: 'cursor match', now, limit: 1 });
    assert.deepEqual(first.rows.map((row) => row.id), ['cursor-z']);
    assert.ok(first.nextCursor);
    const second = await store.queryMemory({ ownerId: 'owner', purpose: 'list', q: 'cursor match', now, limit: 1, cursor: first.nextCursor });
    assert.deepEqual(second.rows.map((row) => row.id), ['cursor-a']);
    assert.equal(second.nextCursor, undefined);
  } finally {
    await harness.dispose();
  }
});

divergence('memory validity timestamps without fractional seconds', 'SQLite compares instants; PostgreSQL compares text, so the stores disagree for up to a second around validFrom and validTo');
divergence('case-insensitive matching of non-ASCII memory text', 'SQLite lower-cases with JavaScript toLowerCase(); PostgreSQL uses lower() under the database locale');
divergence('memory tie-breaking by id for mixed-case or punctuated ids', 'SQLite sorts with localeCompare but pages with code-unit comparison; PostgreSQL uses the database collation for both');
divergence('empty-string scopeId, workspaceId or agentId in memory queries', 'SQLite treats them as absent; PostgreSQL treats them as values to match');
divergence('a memory row without a text field', 'SQLite throws while scoring it; PostgreSQL treats the text as empty');
```

The PostgreSQL-only case exists because only PostgreSQL stores microseconds: both rows fall in the same millisecond, the cursor carries a millisecond timestamp, and the SQL must truncate `updated_at` before comparing or the second row would be skipped. The SQLite equivalent is already pinned on the pure function in `test/memory-query.test.ts` (`memory cursor truncates sub-millisecond timestamps before the id tie-breaker`).

- [ ] **Step 2: Run test to verify it fails**

Mutation check. In `src/memory-query.ts`, in the function `afterCursor`, temporarily change the last comparison from `item.id < cursor.id` to `item.id <= cursor.id` (a page then starts again at the row the previous page ended on).

Run: `npx tsx --test test/store.test.ts`

Expected: FAIL in exactly one case:

```
✖ SqliteStore: memory list pages through every match exactly once in a stable order
  AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:

  6 !== 4
```

- [ ] **Step 3: Write minimal implementation**

No production change is needed. Undo the mutation:

```bash
git checkout -- src/memory-query.ts
git status --short src
```

`git status --short src` must print nothing.

- [ ] **Step 4: Run test to verify it passes**

Run: `env -u KIANCODE_TEST_DATABASE_URL npx tsx --test test/store.test.ts`

Expected: nineteen `✔ SqliteStore: …` lines, nineteen `﹣ PostgresStore: …` lines, four `﹣ PostgreSQL: …` lines, ten `store divergence: …` lines, and:

```
ℹ tests 54
ℹ pass 21
ℹ fail 0
ℹ skipped 23
ℹ todo 10
```

Run: `npx tsc --noEmit` — expected: no output.

Not validated locally: the ten `PostgresStore:` memory cases and the `PostgreSQL: memory paging …` case (no PostgreSQL server reachable). This would be the first execution of the SQL in `PostgresStore.relevantMemory` and `PostgresStore.listMemory` by this repository's tests. The expectations were derived by reading that SQL next to the JavaScript in `src/memory-query.ts`: both keep only `reviewStatus` approved-or-absent rows, both treat `validFrom <= now < validTo` as active, both drop a row that an in-scope row names in `replacesId`, both score with the same terms from `memoryQueryTerms`/`memorySearchTerms` and literal substring matching (`strpos` / `includes`), both order by score, then millisecond `updatedAt`, then id, all descending, and both use `boundedMemoryLimit` and `decodeMemoryCursor`. With a disposable database expect `ℹ tests 54`, `ℹ pass 44`, `ℹ skipped 0`, `ℹ todo 10`. If a PostgreSQL case is red, do not edit `src/`: record the case name and the assertion output and stop for a decision — a real difference between the stores is exactly what this suite exists to surface.

- [ ] **Step 5: Commit**

```bash
git status --short src
git add test/store-contract.ts test/store.test.ts
git commit -m "測試：契約測試涵蓋記憶查詢並記錄兩種儲存層的已知差異"
```

---

### Task 5: Acceptance report writer

**Files:**
- Create: `test/acceptance-report.ts`
- Create: `test/acceptance-report.test.ts`
- Test: `test/acceptance-report.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks. Reads `version` from the repository's `package.json` (`"version": "0.1.0"` at commit `17d571f`).
- Produces (in `test/acceptance-report.ts`):
  - `export interface AcceptanceReport { readonly path: string | undefined; passed(evidence: object): Promise<void>; failed(error: unknown, evidence: object): Promise<void>; }`
  - `export async function openAcceptanceReport(target: string | undefined): Promise<AcceptanceReport>`
  - Report file format — exactly one JSON object followed by `\n`, keys in this order:
    - after `openAcceptanceReport`: `{ status: 'incomplete', startedAt, packageVersion }`
    - after `passed(evidence)`: `{ status: 'passed', startedAt, finishedAt, packageVersion, ...evidence }`
    - after `failed(error, evidence)`: `{ status: 'failed', startedAt, finishedAt, packageVersion, error, ...evidence }`
    - `startedAt` and `finishedAt` are `Date.prototype.toISOString()` strings; `packageVersion` is the `version` field of `package.json`; `error` is the error's message with terminal colour codes removed.
- Produces (in `test/acceptance-report.test.ts`): module-level helpers `timestamp: RegExp`, `packageVersion(): Promise<string>` and `readReport(file: string): Promise<Record<string, unknown>>`, reused by Task 6.

Why the file is written twice per run: the `incomplete` write happens before the acceptance run does anything else. It proves the path is writable before a long model-driven run starts, and it destroys an older `passed` report, so a run that is killed or crashes (no chance to write `failed`) cannot leave stale evidence behind. A reader of the file therefore sees `passed` only if this very run passed. The spec names only `passed` and `failed`; `incomplete` is the one extra state, and it is required for that guarantee.

The writer only writes the file. What the acceptance script prints on standard output is not its business and does not change in this plan (Task 6).

- [ ] **Step 1: Write the failing test**

Create `test/acceptance-report.test.ts`:

```ts
import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { openAcceptanceReport } from './acceptance-report.js';

const timestamp = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

async function packageVersion(): Promise<string> {
  return (JSON.parse(await readFile('package.json', 'utf8')) as { version: string }).version;
}

async function readReport(file: string): Promise<Record<string, unknown>> {
  const text = await readFile(file, 'utf8');
  assert.equal(text.endsWith('\n'), true);
  assert.equal(text.indexOf('\n'), text.length - 1);
  return JSON.parse(text) as Record<string, unknown>;
}

test('a report file starts incomplete and replaces a stale passed report', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'kiancode-acceptance-report-'));
  try {
    const file = path.join(directory, 'report.json');
    await writeFile(file, `${JSON.stringify({ status: 'passed', taskId: 'stale' })}\n`);
    const report = await openAcceptanceReport(file);
    assert.equal(report.path, file);
    const written = await readReport(file);
    assert.deepEqual(Object.keys(written), ['status', 'startedAt', 'packageVersion']);
    assert.equal(written.status, 'incomplete');
    assert.match(String(written.startedAt), timestamp);
    assert.equal(written.packageVersion, await packageVersion());
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('a relative report path is resolved against the working directory and missing parent directories are created', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'kiancode-acceptance-report-'));
  try {
    const file = path.join(directory, 'nested', 'deeper', 'report.json');
    const report = await openAcceptanceReport(path.relative(process.cwd(), file));
    assert.equal(report.path, file);
    assert.equal((await readReport(file)).status, 'incomplete');
    assert.equal((await stat(file)).mode & 0o777, 0o600);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('a passed report adds both timestamps and the package version to the evidence', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'kiancode-acceptance-report-'));
  try {
    const file = path.join(directory, 'report.json');
    const report = await openAcceptanceReport(file);
    const startedAt = (await readReport(file)).startedAt;
    const evidence = { taskId: 'task-1', modelCalls: 3, tools: ['workspace.write', 'terminal.run'], delegation: { approvals: 2, durableReadback: true } };
    await report.passed(evidence);
    const written = await readReport(file);
    assert.deepEqual(Object.keys(written), ['status', 'startedAt', 'finishedAt', 'packageVersion', 'taskId', 'modelCalls', 'tools', 'delegation']);
    assert.match(String(written.finishedAt), timestamp);
    assert.ok(String(written.finishedAt) >= String(startedAt));
    assert.deepEqual(written, {
      status: 'passed', startedAt, finishedAt: written.finishedAt, packageVersion: await packageVersion(), ...evidence,
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('a failed report records the error message and the partial evidence', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'kiancode-acceptance-report-'));
  try {
    const file = path.join(directory, 'report.json');
    await writeFile(file, `${JSON.stringify({ status: 'passed', taskId: 'stale' })}\n`);
    const report = await openAcceptanceReport(file);
    const startedAt = (await readReport(file)).startedAt;
    await report.failed(new Error('\u001b[31mThe model must execute a multi-step tool loop\u001b[39m'), { taskId: 'task-1', modelCalls: 1, durableReadback: false });
    const written = await readReport(file);
    assert.deepEqual(Object.keys(written), ['status', 'startedAt', 'finishedAt', 'packageVersion', 'error', 'taskId', 'modelCalls', 'durableReadback']);
    assert.match(String(written.finishedAt), timestamp);
    assert.deepEqual(written, {
      status: 'failed',
      startedAt,
      finishedAt: written.finishedAt,
      packageVersion: await packageVersion(),
      error: 'The model must execute a multi-step tool loop',
      taskId: 'task-1',
      modelCalls: 1,
      durableReadback: false,
    });
    await report.failed('thrown as a string', {});
    assert.equal((await readReport(file)).error, 'thrown as a string');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('without a report path no file is written and recording a result still succeeds', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'kiancode-acceptance-report-'));
  const previous = process.cwd();
  process.chdir(directory);
  try {
    for (const target of [undefined, '']) {
      const report = await openAcceptanceReport(target);
      assert.equal(report.path, undefined);
      await report.failed(new Error('not recorded'), { taskId: 'task-1' });
      await report.passed({ taskId: 'task-1' });
    }
    assert.deepEqual(await readdir('.'), []);
  } finally {
    process.chdir(previous);
    await rm(directory, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx --test test/acceptance-report.test.ts`

Expected: FAIL, because the writer module does not exist yet:

```
Error [ERR_MODULE_NOT_FOUND]: Cannot find module '<repo>/test/acceptance-report.js' imported from <repo>/test/acceptance-report.test.ts
ℹ tests 1
ℹ pass 0
ℹ fail 1
```

- [ ] **Step 3: Write minimal implementation**

Create `test/acceptance-report.ts`:

```ts
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { stripVTControlCharacters } from 'node:util';

export interface AcceptanceReport {
  /** Absolute path of the report file; undefined when no file was requested. */
  readonly path: string | undefined;
  /** Records a passed run, with its evidence, in the file, if any. */
  passed(evidence: object): Promise<void>;
  /** Records a failed run, with the error message and whatever evidence was collected, in the file, if any. */
  failed(error: unknown, evidence: object): Promise<void>;
}

/**
 * Starts an acceptance report. With a target, the file immediately holds `status: 'incomplete'`,
 * so an earlier `passed` report cannot outlive a run that fails or is killed.
 */
export async function openAcceptanceReport(target: string | undefined): Promise<AcceptanceReport> {
  const file = target ? path.resolve(target) : undefined;
  const startedAt = new Date().toISOString();
  const { version: packageVersion } = JSON.parse(
    await readFile(new URL('../package.json', import.meta.url), 'utf8'),
  ) as { version: string };
  const write = async (report: object): Promise<void> => {
    if (file) await writeFile(file, `${JSON.stringify(report)}\n`, { mode: 0o600 });
  };
  if (file) await mkdir(path.dirname(file), { recursive: true });
  await write({ status: 'incomplete', startedAt, packageVersion });
  return {
    path: file,
    passed: (evidence) => write({
      status: 'passed', startedAt, finishedAt: new Date().toISOString(), packageVersion, ...evidence,
    }),
    async failed(error, evidence) {
      const message = stripVTControlCharacters(error instanceof Error ? error.message : String(error));
      await write({
        status: 'failed', startedAt, finishedAt: new Date().toISOString(), packageVersion, error: message, ...evidence,
      });
    },
  };
}
```

Points a reviewer should check against this code: an unset or empty `target` writes nothing, and `passed` and `failed` still resolve; the parent directory is created before the first write; `{ mode: 0o600 }` applies only when the file is created (an existing file keeps its permissions); the fixed keys come before `...evidence` so the file always starts with `status`; `stripVTControlCharacters` is there because `node:assert` puts colour codes into an assertion message when standard error is a terminal; the package version is read relative to this module (`../package.json`), not relative to the working directory.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx tsx --test test/acceptance-report.test.ts`

Expected:

```
✔ a report file starts incomplete and replaces a stale passed report
✔ a relative report path is resolved against the working directory and missing parent directories are created
✔ a passed report adds both timestamps and the package version to the evidence
✔ a failed report records the error message and the partial evidence
✔ without a report path no file is written and recording a result still succeeds
ℹ tests 5
ℹ pass 5
ℹ fail 0
```

Run: `npx tsc --noEmit` — expected: no output.

- [ ] **Step 5: Commit**

```bash
git status --short src
git add test/acceptance-report.ts test/acceptance-report.test.ts
git commit -m "測試：新增驗收報告寫入器，檔案先標記未完成再寫入通過或失敗"
```

`git status --short src` must print nothing.

---

### Task 6: Acceptance script writes the report; `npm run acceptance`

**Files:**
- Modify: `test/standalone.acceptance.ts` (imports at lines 7 and 11; the pre-flight block at lines 188-198, which starts `const configPath = process.env.KIANCODE_ACCEPTANCE_CONFIG;`; the end of the main `try` at lines 546-547, which starts `process.stdout.write(`; line numbers as of commit `17d571f`)
- Modify: `package.json` (`scripts`, after the `test` entry at line 32)
- Modify: `test/acceptance-report.test.ts` (two imports; append one helper and four tests)
- Test: `test/acceptance-report.test.ts`

**Interfaces:**
- Consumes: `openAcceptanceReport(target: string | undefined): Promise<AcceptanceReport>`, `AcceptanceReport.passed(evidence: object): Promise<void>`, `AcceptanceReport.failed(error: unknown, evidence: object): Promise<void>` from Task 5; `timestamp`, `packageVersion()`, `readReport(file)` from the Task 5 test file; `loadConfig(file: string): Promise<Configuration>` and the type `Configuration` from `src/config.ts` (unchanged); `bootstrap(config)` from `src/bootstrap.ts` (unchanged).
- Produces:
  - Environment variable `KIANCODE_ACCEPTANCE_REPORT` (acceptance script only): optional path of the report file, resolved against the working directory. Unset or empty: no file.
  - `package.json` script `"acceptance": "tsx test/standalone.acceptance.ts"`. `test` and `check` are unchanged, so the acceptance run is not part of `npm run check`.
  - In `test/standalone.acceptance.ts`: `async function preflight(): Promise<{ config: Configuration; root: string }>` and the module-level constant `acceptanceReport`. A later plan that adds a field to the acceptance evidence adds it to the existing `report` object only: the file gets it through `acceptanceReport.passed(report)` and `acceptanceReport.failed(error, report)`, standard output through the existing `process.stdout.write` line. If the field has an initial value, that plan also adds it to the expected object in the test `an acceptance run that fails after its pre-flight checks records the evidence gathered so far`.
  - In `test/acceptance-report.test.ts`: `interface AcceptanceRun { code: number | null; stdout: string; stderr: string; }` and `function runAcceptance(environment: Record<string, string>): Promise<AcceptanceRun>`.
  - No behaviour change visible on the script's streams, whether or not `KIANCODE_ACCEPTANCE_REPORT` is set: standard output (the single `{"status":"passed",…}` line of a passing run), standard error and the exit code are what they are today. `startedAt`, `finishedAt` and `packageVersion` exist only in the report file.

The tests start the real script in a child process, the same way `test/connector-config.test.ts` starts the connector (`process.execPath --import tsx <script>`). None of the three child-process tests reaches a database, a model or the network: two stop at the first pre-flight check (with and without a report file); the other passes the pre-flight with a throw-away configuration and then fails inside `bootstrap` because its PostgreSQL socket directory does not exist.

- [ ] **Step 1: Write the failing test**

In `test/acceptance-report.test.ts` replace

```ts
import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
```

with

```ts
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readdir, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
```

and append at the end of the file:

```ts

interface AcceptanceRun {
  code: number | null;
  stdout: string;
  stderr: string;
}

/** Runs the acceptance script the way `npm run acceptance` does, with every KIANCODE_ACCEPTANCE_* variable under the test's control. */
function runAcceptance(environment: Record<string, string>): Promise<AcceptanceRun> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx', 'test/standalone.acceptance.ts'], {
      env: { ...process.env, KIANCODE_ACCEPTANCE_CONFIG: '', KIANCODE_ACCEPTANCE_WORKSPACE: '', KIANCODE_ACCEPTANCE_REPORT: '', ...environment },
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

test('npm run acceptance runs the standalone script and stays out of npm run check', async () => {
  const { scripts } = JSON.parse(await readFile('package.json', 'utf8')) as { scripts: Record<string, string> };
  assert.equal(scripts.acceptance, 'tsx test/standalone.acceptance.ts');
  assert.equal(scripts.test, 'tsx --test test/*.test.ts');
  assert.equal(scripts.check, 'npm run typecheck && npm test && npm run build');
});

test('a failed acceptance run replaces a stale passed report with the failure', { timeout: 90_000 }, async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'kiancode-acceptance-run-'));
  try {
    const file = path.join(directory, 'report.json');
    await writeFile(file, `${JSON.stringify({ status: 'passed', taskId: 'stale' })}\n`);
    const run = await runAcceptance({ KIANCODE_ACCEPTANCE_REPORT: file });
    assert.equal(run.code, 1);
    assert.equal(run.stdout, '');
    assert.match(run.stderr, /Set KIANCODE_ACCEPTANCE_CONFIG to an isolated PostgreSQL configuration/);
    const written = await readReport(file);
    assert.match(String(written.startedAt), timestamp);
    assert.match(String(written.finishedAt), timestamp);
    assert.deepEqual(written, {
      status: 'failed',
      startedAt: written.startedAt,
      finishedAt: written.finishedAt,
      packageVersion: await packageVersion(),
      error: 'Set KIANCODE_ACCEPTANCE_CONFIG to an isolated PostgreSQL configuration',
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('an acceptance run that fails after its pre-flight checks records the evidence gathered so far', { timeout: 90_000 }, async () => {
  const directory = await realpath(await mkdtemp(path.join(tmpdir(), 'kiancode-acceptance-run-')));
  try {
    const file = path.join(directory, 'report.json');
    const configPath = path.join(directory, 'config.json');
    const workspace = path.join(directory, 'workspace');
    await writeFile(configPath, JSON.stringify({
      database: { urlEnv: 'KIANCODE_ACCEPTANCE_REPORT_TEST_URL', sqlitePath: path.join(directory, 'unused.sqlite') },
      serverWorkspaceRoots: [workspace],
      terminal: { isolation: 'bubblewrap', binary: '/usr/bin/bwrap' },
    }));
    const run = await runAcceptance({
      KIANCODE_ACCEPTANCE_CONFIG: configPath,
      KIANCODE_ACCEPTANCE_WORKSPACE: workspace,
      KIANCODE_ACCEPTANCE_REPORT: file,
      KIANCODE_ACCEPTANCE_REPORT_TEST_URL: 'socket:/kiancode-test-no-such-directory?db=unused',
    });
    assert.equal(run.code, 1);
    assert.equal(run.stdout, '');
    assert.match(run.stderr, /ENOENT/);
    const written = await readReport(file);
    assert.match(String(written.error), /^connect ENOENT \/kiancode-test-no-such-directory\/\.s\.PGSQL\.\d+$/);
    assert.deepEqual(written, {
      status: 'failed',
      startedAt: written.startedAt,
      finishedAt: written.finishedAt,
      packageVersion: await packageVersion(),
      error: written.error,
      modelCalls: 0,
      tools: [],
      approvals: 0,
      durableReadback: false,
      wrongHashRejected: false,
      restartUnknownNoReplay: false,
      memoryReviewReadback: false,
      delegation: { approvals: 0, childCount: 0, maxDepth: 0, durableReadback: false },
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('an acceptance run without KIANCODE_ACCEPTANCE_REPORT fails the same way', { timeout: 90_000 }, async () => {
  const run = await runAcceptance({});
  assert.equal(run.code, 1);
  assert.equal(run.stdout, '');
  assert.match(run.stderr, /Set KIANCODE_ACCEPTANCE_CONFIG to an isolated PostgreSQL configuration/);
});
```

`realpath` is applied to the temporary directory in the test `an acceptance run that fails after its pre-flight checks records the evidence gathered so far` because the script compares the real path of the workspace with `serverWorkspaceRoots`, and on macOS the temporary directory is reached through a symbolic link. `/usr/bin/bwrap` only has to satisfy the configuration schema; nothing executes it.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx --test test/acceptance-report.test.ts`

Expected: the five Task 5 tests and `an acceptance run without KIANCODE_ACCEPTANCE_REPORT fails the same way` pass (the last one guards behaviour that must not change); three tests fail:

```
✖ npm run acceptance runs the standalone script and stays out of npm run check
  AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:
  + undefined
  - 'tsx test/standalone.acceptance.ts'
✖ a failed acceptance run replaces a stale passed report with the failure
  AssertionError [ERR_ASSERTION]: The input did not match the regular expression /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/. Input:
  'undefined'
✖ an acceptance run that fails after its pre-flight checks records the evidence gathered so far
  [Error: ENOENT: no such file or directory, open '<temporary directory>/report.json']
ℹ tests 9
ℹ pass 6
ℹ fail 3
```

(The second failure means the stale `{"status":"passed",…}` file was left untouched, which is exactly the defect.)

- [ ] **Step 3: Write minimal implementation**

In `package.json` replace

```json
    "test": "tsx --test test/*.test.ts",
```

with

```json
    "test": "tsx --test test/*.test.ts",
    "acceptance": "tsx test/standalone.acceptance.ts",
```

In `test/standalone.acceptance.ts` make four edits.

Edit 1 — replace

```ts
import { loadConfig } from '../src/config.js';
```

with

```ts
import { loadConfig, type Configuration } from '../src/config.js';
```

Edit 2 — replace

```ts
import type { Entity } from '../src/storage/store.js';
```

with

```ts
import type { Entity } from '../src/storage/store.js';
import { openAcceptanceReport } from './acceptance-report.js';
```

Edit 3 — replace the pre-flight block

```ts
const configPath = process.env.KIANCODE_ACCEPTANCE_CONFIG;
if (!configPath) throw new Error('Set KIANCODE_ACCEPTANCE_CONFIG to an isolated PostgreSQL configuration');
const config = await loadConfig(configPath);
if (!process.env[config.database.urlEnv]) throw new Error('Independent acceptance requires PostgreSQL');
const requestedRoot = process.env.KIANCODE_ACCEPTANCE_WORKSPACE;
if (!requestedRoot || !path.isAbsolute(requestedRoot)) throw new Error('Set an absolute isolated KIANCODE_ACCEPTANCE_WORKSPACE');
await mkdir(requestedRoot, { recursive: true, mode: 0o700 });
const root = await realpath(requestedRoot);
if (!config.serverWorkspaceRoots.includes(root) || config.terminal.isolation !== 'bubblewrap') {
  throw new Error('Independent acceptance requires an explicitly configured Bubblewrap workspace');
}
```

with (the same statements, moved into a function so that a failure in any of them can be recorded)

```ts
async function preflight(): Promise<{ config: Configuration; root: string }> {
  const configPath = process.env.KIANCODE_ACCEPTANCE_CONFIG;
  if (!configPath) throw new Error('Set KIANCODE_ACCEPTANCE_CONFIG to an isolated PostgreSQL configuration');
  const config = await loadConfig(configPath);
  if (!process.env[config.database.urlEnv]) throw new Error('Independent acceptance requires PostgreSQL');
  const requestedRoot = process.env.KIANCODE_ACCEPTANCE_WORKSPACE;
  if (!requestedRoot || !path.isAbsolute(requestedRoot)) throw new Error('Set an absolute isolated KIANCODE_ACCEPTANCE_WORKSPACE');
  await mkdir(requestedRoot, { recursive: true, mode: 0o700 });
  const root = await realpath(requestedRoot);
  if (!config.serverWorkspaceRoots.includes(root) || config.terminal.isolation !== 'bubblewrap') {
    throw new Error('Independent acceptance requires an explicitly configured Bubblewrap workspace');
  }
  return { config, root };
}

// Opened before anything else so that the report file never keeps an earlier run's `passed`.
const acceptanceReport = await openAcceptanceReport(process.env.KIANCODE_ACCEPTANCE_REPORT);
const { config, root } = await preflight().catch(async (error: unknown) => {
  await acceptanceReport.failed(error, {});
  throw error;
});
```

Edit 4 — at the end of the main `try`, replace

```ts
  process.stdout.write(`${JSON.stringify({ status: 'passed', ...report })}\n`);
} finally {
```

with

```ts
  await acceptanceReport.passed(report);
  process.stdout.write(`${JSON.stringify({ status: 'passed', ...report })}\n`);
} catch (error) {
  await acceptanceReport.failed(error, report);
  throw error;
} finally {
```

Nothing else in the script changes: the `report` object, every assertion, the `finally` block that closes the service and removes `result.txt` and `delegated.txt`, the messages on standard error and the exit code stay as they are. The error is always re-thrown, so a failed run still exits non-zero with its stack on standard error. The `process.stdout.write` line is kept exactly as it is; the only addition before it is the `acceptanceReport.passed(report)` call, so a `passed` line on standard output implies that the report file, when one was requested, already says `passed` with the same evidence.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx tsx --test test/acceptance-report.test.ts`

Expected:

```
✔ a report file starts incomplete and replaces a stale passed report
✔ a relative report path is resolved against the working directory and missing parent directories are created
✔ a passed report adds both timestamps and the package version to the evidence
✔ a failed report records the error message and the partial evidence
✔ without a report path no file is written and recording a result still succeeds
✔ npm run acceptance runs the standalone script and stays out of npm run check
✔ a failed acceptance run replaces a stale passed report with the failure
✔ an acceptance run that fails after its pre-flight checks records the evidence gathered so far
✔ an acceptance run without KIANCODE_ACCEPTANCE_REPORT fails the same way
ℹ tests 9
ℹ pass 9
ℹ fail 0
```

Run: `npx tsc --noEmit` — expected: no output.

Run the script through npm once, with no configuration, and look at what it leaves behind (replace `/tmp/kiancode-report-check` with any empty scratch directory outside the repository):

```bash
KIANCODE_ACCEPTANCE_CONFIG= KIANCODE_ACCEPTANCE_REPORT=/tmp/kiancode-report-check/report.json npm run acceptance; echo "exit=$?"
cat /tmp/kiancode-report-check/report.json
rm -r /tmp/kiancode-report-check
```

Expected: `Error: Set KIANCODE_ACCEPTANCE_CONFIG to an isolated PostgreSQL configuration` on standard error, `exit=1`, and the file contains one line of the form

```
{"status":"failed","startedAt":"<ISO time>","finishedAt":"<ISO time>","packageVersion":"0.1.0","error":"Set KIANCODE_ACCEPTANCE_CONFIG to an isolated PostgreSQL configuration"}
```

Not validated locally: a passing acceptance run. It needs an isolated PostgreSQL database, a Bubblewrap sandbox (Linux) and a configured model provider, none of which exist on the machine this plan was written on. What was run: both failure paths above, through the real script. The `passed` path is two lines (`acceptanceReport.passed(report)` and the write inside it) and its file format is pinned by the Task 5 test `a passed report adds both timestamps and the package version to the evidence`. At the next real acceptance run, confirm that the report file says `status: 'passed'`, carries `startedAt`, `finishedAt` and `packageVersion`, and that its remaining fields equal those of the line printed on standard output; attach the file to the review.

- [ ] **Step 5: Commit**

```bash
git status --short src
git add package.json test/standalone.acceptance.ts test/acceptance-report.test.ts
git commit -m "實現：驗收腳本將結果寫入報告檔，失敗時記錄錯誤，並提供 npm run acceptance"
```

`git status --short src` must print nothing.

---

### Task 7: README and final verification

**Files:**
- Modify: `README.md` (section `## Verification`, lines 110-112 as of commit `17d571f`; two paragraphs are added after the existing one, which stays as it is)
- Modify: `test/acceptance-report.test.ts` (append one test)
- Test: `test/acceptance-report.test.ts`

**Interfaces:**
- Consumes: the names fixed by earlier tasks, which the README must spell exactly: `KIANCODE_TEST_DATABASE_URL` (Task 2), `KIANCODE_ACCEPTANCE_REPORT` and `npm run acceptance` (Task 6), the report keys `status`, `startedAt`, `finishedAt`, `packageVersion`, `error` (Task 5), and the existing `KIANCODE_ACCEPTANCE_CONFIG` and `KIANCODE_ACCEPTANCE_WORKSPACE` read by `test/standalone.acceptance.ts`.
- Produces: nothing other plans rely on. A later plan that documents another check adds its own sentence or paragraph to `## Verification`; it must keep the phrases `reported as skipped` and ``not part of `npm run check` `` and the names listed in the test below.

- [ ] **Step 1: Write the failing test**

Append at the end of `test/acceptance-report.test.ts`:

```ts

test('README documents the PostgreSQL contract run and the acceptance report', async () => {
  const readme = await readFile('README.md', 'utf8');
  const start = readme.indexOf('## Verification');
  assert.notEqual(start, -1);
  const verification = readme.slice(start, readme.indexOf('\n## ', start));
  for (const name of [
    'npm run check',
    'KIANCODE_TEST_DATABASE_URL',
    'npm run acceptance',
    'KIANCODE_ACCEPTANCE_CONFIG',
    'KIANCODE_ACCEPTANCE_WORKSPACE',
    'KIANCODE_ACCEPTANCE_REPORT',
    'packageVersion',
  ]) {
    assert.ok(verification.includes(name), `the Verification section of README.md does not mention ${name}`);
  }
  assert.match(verification, /reported as skipped/);
  assert.match(verification, /not part of `npm run check`/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx --test test/acceptance-report.test.ts`

Expected: nine tests pass and one fails:

```
✖ README documents the PostgreSQL contract run and the acceptance report
  AssertionError [ERR_ASSERTION]: the Verification section of README.md does not mention KIANCODE_TEST_DATABASE_URL
ℹ tests 10
ℹ pass 9
ℹ fail 1
```

- [ ] **Step 3: Write minimal implementation**

In `README.md`, under `## Verification`, leave the existing paragraph

```md
`npm run check` runs TypeScript checking, behavior tests and the distributable build. Real deployment, PostgreSQL restore, provider capability, tool isolation, signed-device and external-adapter checks remain separate release gates.
```

exactly as it is, and insert after it (before `## License`) a blank line followed by these two paragraphs:

```md
The store contract suite in `test/store.test.ts` always runs against SQLite. It also runs against PostgreSQL when `KIANCODE_TEST_DATABASE_URL` holds a `pg` connection string for a disposable database, for example `KIANCODE_TEST_DATABASE_URL='socket:/path/to/socket-dir?db=kiancode_test' npm test`. The string is handed to `pg` unchanged, so Unix-socket forms work; it must not carry an `options` parameter, its role must be allowed to create schemas, and the database encoding must be UTF8. Each case works in its own `kiancode_test_*` schema and drops it afterwards. Without the variable the PostgreSQL cases are reported as skipped, never as passed; with it, a connection or privilege error fails the run. The suite never falls back to `DATABASE_URL`. Known differences between the two stores are listed as `todo` cases in the same file.

`npm run acceptance` runs the standalone acceptance script, `test/standalone.acceptance.ts`, against the isolated PostgreSQL configuration named by `KIANCODE_ACCEPTANCE_CONFIG` and the Bubblewrap workspace named by `KIANCODE_ACCEPTANCE_WORKSPACE`. It needs a source checkout with development dependencies and is not part of `npm run check`. Set `KIANCODE_ACCEPTANCE_REPORT` to a file path outside that workspace, for example `.runtime/acceptance-report.json`, to keep a record of the run. The file holds one JSON line: `status` is `incomplete` from the moment the run starts, and becomes `passed` or `failed` when it ends, together with `startedAt`, `finishedAt`, `packageVersion` and, for a failed run, the `error` message. A report left by an earlier run is overwritten as soon as a new run starts, so `incomplete` after the process has exited means the run was killed or crashed before it could record a result. The report can contain error text from the run; handle it like a log file.
```

The example connection string and the example report path are placeholders; do not replace them with a real socket directory, host name, database name or credential.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx tsx --test test/acceptance-report.test.ts`

Expected:

```
✔ README documents the PostgreSQL contract run and the acceptance report
ℹ tests 10
ℹ pass 10
ℹ fail 0
```

Then run the delivery gate without the PostgreSQL variable:

```bash
env -u KIANCODE_TEST_DATABASE_URL npm run check
```

Expected: `tsc --noEmit` prints nothing; the test run ends with `ℹ fail 0`, `ℹ skipped 23` or more and `ℹ todo 10`; `tsc -p tsconfig.build.json` prints nothing; the command exits 0. On the machine this plan was written on (macOS, commit `17d571f` plus this plan only) the summary was:

```
ℹ tests 280
ℹ pass 247
ℹ fail 0
ℹ cancelled 0
ℹ skipped 23
ℹ todo 10
```

The 23 skipped tests are the nineteen `PostgresStore: …` contract cases and the four `PostgreSQL: …` cases, each printed with `# KIANCODE_TEST_DATABASE_URL is not set`. The ten `todo` entries are the `store divergence: …` records. Other platforms may skip a few more tests that already depend on the platform. `test/standalone.acceptance.ts` is not executed by this command except through the three child-process tests of Task 6, which stop before reaching any database.

Finally confirm the workstream rule:

```bash
git status --short src
git diff --stat 17d571f -- src
```

Both must print nothing: this plan changes no file under `src/`.

Not validated locally: `npm run check` with `KIANCODE_TEST_DATABASE_URL` set (no PostgreSQL server reachable from the machine this plan was written on). When a disposable database is available, run

```bash
KIANCODE_TEST_DATABASE_URL='socket:/path/to/socket-dir?db=DISPOSABLE_DB' npx tsx --test test/store.test.ts
```

and expect `ℹ tests 54`, `ℹ pass 44`, `ℹ fail 0`, `ℹ skipped 0`, `ℹ todo 10`. Because the execution order puts this plan first so that the PostgreSQL contract gates the later ones, do that run before starting the next plan; if any PostgreSQL case is red, report the case name and the error text and stop — do not edit `src/` under this plan.

- [ ] **Step 5: Commit**

```bash
git status --short src
git add README.md test/acceptance-report.test.ts
git commit -m "文件：說明 PostgreSQL 契約測試與驗收報告檔的用法"
```

`git status --short src` must print nothing.
