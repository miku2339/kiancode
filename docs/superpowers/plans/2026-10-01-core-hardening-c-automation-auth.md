# Workstream C — Authorization Lifetime of Automations Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Schedules, event triggers and the tasks they start keep working unattended for as long as the owner's account stays valid, stop only on an explicit denial, and tell the owner when they stop.

**Architecture:** In account mode an automation stores its actor without `expiresAt` (a durable delegation); every dispatch and every model or tool step revalidates that actor through the existing `reauthorize` hook, which is the identity service authorization check plus `AccessService.authorize`, and a task started this way is revalidated instead of paused when its one-hour grant lapses. `AccessService.validateDelegation` keeps its `Promise<boolean>` signature: `false` now means only an explicit denial, and every other failure of the check is thrown as `identity_unavailable`, which schedules, triggers and tasks retry and report instead of disabling or failing. OIDC mode refuses to enable automations; development mode is untouched.

**Tech Stack:** TypeScript (NodeNext ESM), Node.js 24, Fastify 5, `node:test` run with `tsx --test`, in-memory `SqliteStore` in tests, no new dependencies.

**Spec:** `docs/superpowers/specs/2026-10-01-core-hardening-design.md` (section C)

## Global Constraints

- Node.js 24 or later. TypeScript with two-space indent, single quotes, semicolons and explicit public interfaces.
- Tests use `node:test` and run with `tsx --test`. Behaviour is tested through public interfaces. `npm run check` (typecheck, tests, build) passes before delivery.
- No new runtime dependencies.
- SQLite is for development and tests; PostgreSQL is production. Entities already stored in a deployed database must remain readable without a data rewrite.
- Development authentication mode keeps its current behaviour.
- Errors are `DomainError(code, message, statusCode)` with snake_case codes. Existing codes and HTTP statuses do not change unless a workstream says so.
- The distinction between dispatched, confirmed and unknown external outcomes is preserved.
- No personal data, hostnames, secrets or production configuration in the repository.
- Line numbers in this plan refer to commit `17d571f`; function and symbol names are the stable anchors once earlier workstreams have landed.
- Execution order is G, A, C, B1, B2, D, E, F. This plan runs after G and A. Plan A adds one line (`'access_required',`) at the top of `permanentAuthorizationCodes` in `src/scheduler.ts` and `src/event-triggers.ts` and of `authorizationPauseCodes` in `src/tasks.ts`, and rewrites `AccessService.authorize`/`grant` in `src/access.ts`; line numbers below those points are one or more lines later than stated. Always locate code by the quoted text.
- Tasks 1 to 12 are applied in order. Every "Replace … with …" block quotes the text exactly as it is at that point (as of commit `17d571f`, or as left by the earlier task that the step names).
- Commit subjects are in Traditional Chinese with a type prefix and a full-width colon (`修復：…`, `實現：…`, `測試：…`, `文件：…`).

## Review Focus

Most likely first. Each line names the test that pins it and the task that owns the code.

1. **A schedule or trigger fires long after the owner's sign-in session expired (16 minutes, 31 days), including rows saved before this change that still hold a stale `expiresAt`.** Expected: it runs, as long as the account is still valid. — Task 3, `account-mode automations store a durable actor and still dispatch 31 days later` and `a legacy actor with a stale expiresAt is dispatched in durable mode without rewriting stored rows`; Task 12, `account mode: a saved schedule has no expiresAt and dispatches through the Account check after the session expired`.
2. **The identity service is down, slow, or the core's own service credential or URL is wrong (network error, timeout, 5xx, 429, 401, 403, 404) at dispatch or in the middle of a task.** Expected: nothing is disabled, nothing fails; it is retried and reported, and continues when the service answers again. — Task 1, `401, 403, 404 and every other non-2xx status are identity_unavailable, never a denial`; Task 2, `a task whose revalidation is transiently unavailable is retried, not paused or failed`; Task 11, `a transient dispatch failure is reported through onError and retried; a permanent one is not reported there`; Task 12, `an Account outage never disables a schedule and the occurrence runs once the service is back`.
3. **The account really is revoked (HTTP 200 `active:false`, or the credential version changed).** Expected: the schedule or trigger is disabled, the owner gets exactly one notification for it, a running task pauses. — Task 6, `a permanent authorization failure stamps the trigger once and a transient one does not`; Task 7, `a trigger disabled for authorization produces one neutral notification`; Task 12, `an explicit denial disables the schedule, notifies the owner once and pauses a running task`.
4. **An unattended task is claimed again more than one hour after it was enqueued (device offline, children running long, crash recovery, a long outage).** Expected: it continues without a client sign-in. — Task 9, `a durable task is not paused when its one-hour grant lapses: it is revalidated and the grant is renewed`.
5. **The owner re-enables a schedule after an authorization failure, including a one-shot schedule that already produced its occurrence.** Expected: the stored authorisation is refreshed from the caller; an interval schedule runs again; a one-shot does not run twice and does not break the task tick for everyone. — Task 5, `enabling a schedule stores the caller as the new actor`; Task 4, `re-enabling a one-shot schedule that already fired neither runs it again nor aborts reconcile`.

Also pinned, because each would be a silent regression:

- A deployed database already holds authorization-failed notifications with the previous wording; the new wording must not make notification reconcile (and with it the task tick) fail. — Task 7, `a schedule notification stored with the previous wording does not break reconcile`.
- A durable actor that is not the configured owner subject is rejected at dispatch (plan A's level floor reaches stored actors). — Task 12, `a durable actor that is not the configured owner subject is rejected at dispatch`.
- OIDC mode refuses to save or enable an automation, and says so. — Task 8, `unsupported mode refuses to save or enable an automation but keeps drafts, listing and deletion`; Task 12, `oidc mode: enabling an automation is refused over HTTP while drafts, listing and deletion work`.
- A task approved or resumed from a client does not become bound to that client's session and does not gain the owner's full scopes. — Task 10, `resuming a durable task keeps it durable and inside its own scope ceiling`.
- A trigger has no enable-only route; saving it again after signing in must store that sign-in as its new durable actor. — Task 3, `account-mode automations store a durable actor and still dispatch 31 days later` (its last assertions).
- Three events refused in one reconcile leave one `authorizationFailedAt` (the first refusal), so the owner gets one notification, not three. — Task 6, `a permanent authorization failure stamps the trigger once and a transient one does not` (the test clock moves between the refusals).

## File Structure

| File | Change | Responsibility in this plan |
| --- | --- | --- |
| `src/access.ts` | modify | `validateDelegation`: explicit denial (`false`) versus `identity_unavailable` (Task 1); new `unattendedAuthorization()` (Task 12) |
| `src/tasks.ts` | modify | Re-queue a task on `identity_unavailable` (Task 2); `durableGrants` option: revalidate and renew a lapsed grant (Task 9), durable resume (Task 10) |
| `src/event-triggers.ts` | modify | `UnattendedAuthorization`, `automationActor`, `unattended` option, durable save and dispatch for triggers (Task 3); `authorizationFailedAt` on triggers (Task 6); refusal in unsupported mode (Task 8); `onError` option (Task 11) |
| `src/scheduler.ts` | modify | `unattended` option, durable save and dispatch for schedules (Task 3); create-if-absent occurrence (Task 4); refresh on `setEnabled(true)` (Task 5); `onError` option (Task 11) |
| `src/notifications.ts` | modify | Authorization-failed notification for event triggers; neutral default copy; default copy no longer part of a notification's identity (Task 7) |
| `src/domain.ts` | modify | `Notification.eventTriggerId` (Task 7) |
| `src/http/server.ts` | modify | Pass the mode from `AccessService` to the two automation services and to `TaskService`; connect the automation `onError` hooks to the server logger (Task 12) |
| `README.md` | modify | Per-mode behaviour of unattended automations (Task 12) |
| `test/access.test.ts` | modify (created by plan A) | `validateDelegation` classification (Task 1) |
| `test/tasks.test.ts` | modify (append) | Transient retry (Task 2), lapsed durable grant (Task 9), durable resume (Task 10) |
| `test/event-triggers.test.ts` | modify (append) | Durable actors (Task 3), occurrence re-materialisation (Task 4), refresh on enable (Task 5), trigger `authorizationFailedAt` (Task 6), unsupported mode (Task 8), reported retries (Task 11) |
| `test/notifications.test.ts` | modify (append) | Trigger authorization-failed notification, legacy wording (Task 7) |
| `test/automation-authorization.test.ts` | create | End-to-end pins with a real `AccessService` and a stubbed Account check, plus `createServer` wiring (Task 12) |

No entity kind, migration, HTTP route, request schema, config key, task state, task event type or notification type is added. One error code is added: `unattended_automation_unsupported` (HTTP 503).

---

### Task 1: AccessService separates an explicit denial from a transient failure (C2)

**Files:**
- Modify: `src/access.ts` (`AccessService.validateDelegation`, the last nine lines of the method, lines 42-50 as of commit 17d571f)
- Test: `test/access.test.ts` (created by plan A; append one `test.describe` block)

**Interfaces:**
- Consumes: `AccessService` constructor `(store, ownerSubject?, serviceToken?, identityMode = 'account', accountApiUrl?, fetcher = fetch, levelCeilings = {})` (the seventh parameter is added by plan A and not used here); `AccessService.authorize(identity: Principal): Promise<Principal>` as rewritten by plan A (the configured owner subject gets level 1 and `['*']` without a record); `DomainError(code, message, statusCode)`.
- Produces: `AccessService.validateDelegation(principal: Principal): Promise<boolean>` — signature unchanged. Resolves `true` when valid. Resolves `false` only for an explicit denial: the stored principal's own `expiresAt` has passed, an OIDC principal has no `expiresAt`, its scopes are no longer covered, it lacks `subject`/`applicationId`/`credentialVersion`, or the identity service answered HTTP 200 with `active: false` or a different `credentialVersion`. Rejects with `DomainError('identity_unavailable', 'Account authorization check is unavailable', 503)` for a missing service credential, a network error, a timeout, a redirect, any non-2xx status (including 401, 403 and 404) and any 200 body that is not `{ success: true, data: { active: boolean, credentialVersion: number } }`. Still rejects with `access_revoked` / `access_required` from `authorize`.

Background for the implementer: `validateDelegation` is called by the `reauthorize` hook in `src/bootstrap.ts` (lines 82-88) and by the fallback hook in `src/http/server.ts` (lines 83-86). Both turn `false` into `DomainError('grant_revoked', …, 403)`, which disables schedules and triggers and pauses tasks. Neither caller changes in this task: a thrown `identity_unavailable` simply propagates through them.

- [ ] **Step 1: Write the failing test**

Append this block to the end of `test/access.test.ts`. It uses only these module-level names, which plan A's file already imports: `assert` (`node:assert/strict`), `test` (default import of `node:test`), `AccessService`, `DomainError`, `type Principal`, `SqliteStore`. If one of them is missing from the import block at the top of the file, add it there; do not import a name twice. Every helper is local to the block, so nothing collides with plan A's helpers.

```ts
// ---------------------------------------------------------------------------
// Workstream C (C2): the Account authorization check is either an explicit
// denial (false) or a transient failure (identity_unavailable). Every helper
// this block needs is defined inside it.
// ---------------------------------------------------------------------------
test.describe('validateDelegation: explicit denial versus transient failure', () => {
  const issuer = 'https://identity.example.test';
  const accountApi = 'https://account-api.example.test';
  const ownerSubject = `acct_${'c'.repeat(32)}`;
  type Reply = () => Response | Promise<Response>;

  /** A stored (durable) principal: no expiresAt. */
  const stored = (overrides: Partial<Principal> = {}): Principal => ({
    id: 'durable-owner',
    issuer,
    subject: ownerSubject,
    level: 1,
    scopes: ['schedule:write', 'model:read'],
    applicationId: 'kiancode',
    audience: 'kiancode',
    credentialVersion: 4,
    ...overrides,
  });
  const json = (body: unknown, status = 200): Reply => () => new Response(JSON.stringify(body), {
    status, headers: { 'content-type': 'application/json' },
  });

  /** Runs validateDelegation once. `outcome` is true, false, or '<code>:<statusCode>' of the DomainError. */
  const check = async (
    reply: Reply,
    principal: Principal = stored(),
    options: { serviceToken?: string; mode?: 'account' | 'oidc' } = {},
  ): Promise<{ outcome: boolean | string; requests: Array<{ url: string; init?: RequestInit }> }> => {
    const store = new SqliteStore();
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    const fetcher = (async (input: string | URL | Request, init?: RequestInit) => {
      requests.push({ url: String(input), init });
      return reply();
    }) as typeof fetch;
    try {
      const access = new AccessService(
        store,
        ownerSubject,
        'serviceToken' in options ? options.serviceToken : 'service-token',
        options.mode ?? 'account',
        accountApi,
        fetcher,
      );
      const outcome = await access.validateDelegation(principal).then(
        (value): boolean | string => value,
        (error: unknown) => error instanceof DomainError ? `${error.code}:${error.statusCode}` : `raw:${String(error)}`,
      );
      return { outcome, requests };
    } finally {
      await store.close();
    }
  };

  test('an active answer with the same credential version is valid, for a principal without expiresAt', async () => {
    const { outcome, requests } = await check(json({ success: true, data: { active: true, credentialVersion: 4 } }));
    assert.equal(outcome, true);
    assert.equal(requests.length, 1);
    assert.equal(requests[0]!.url, `${accountApi}/api/internal/authorization/check/`);
    assert.equal(requests[0]!.init?.method, 'POST');
    assert.equal(requests[0]!.init?.redirect, 'error');
    assert.ok(requests[0]!.init?.signal instanceof AbortSignal);
    assert.equal((requests[0]!.init?.headers as Record<string, string>).authorization, 'Bearer service-token');
    assert.deepEqual(JSON.parse(String(requests[0]!.init?.body)), {
      subject: ownerSubject, applicationId: 'kiancode', credentialVersion: 4,
    });
  });

  test('only HTTP 200 with active:false or another credential version is an explicit denial', async () => {
    assert.equal((await check(json({ success: true, data: { active: false, credentialVersion: 4 } }))).outcome, false);
    assert.equal((await check(json({ success: true, data: { active: false, credentialVersion: 0 } }))).outcome, false);
    assert.equal((await check(json({ success: true, data: { active: true, credentialVersion: 5 } }))).outcome, false);
  });

  test('401, 403, 404 and every other non-2xx status are identity_unavailable, never a denial', async () => {
    for (const status of [400, 401, 403, 404, 429, 500, 502, 503, 504]) {
      const { outcome } = await check(json({ success: false, error: 'any' }, status));
      assert.equal(outcome, 'identity_unavailable:503', `HTTP ${status}`);
    }
  });

  test('a network error or a timeout is identity_unavailable', async () => {
    assert.equal((await check(() => { throw new TypeError('fetch failed'); })).outcome, 'identity_unavailable:503');
    assert.equal(
      (await check(() => { throw new DOMException('The operation timed out', 'TimeoutError'); })).outcome,
      'identity_unavailable:503',
    );
  });

  test('a 200 answer that is not the documented envelope is identity_unavailable', async () => {
    const html: Reply = () => new Response('<html>bad gateway</html>', { status: 200, headers: { 'content-type': 'text/html' } });
    for (const [name, reply] of [
      ['html body', html],
      ['success false', json({ success: false, error: 'internal_error' })],
      ['no data', json({ success: true })],
      ['string active', json({ success: true, data: { active: 'true', credentialVersion: 4 } })],
      ['missing credentialVersion', json({ success: true, data: { active: true } })],
      ['null body', json(null)],
    ] as Array<[string, Reply]>) {
      assert.equal((await check(reply)).outcome, 'identity_unavailable:503', name);
    }
  });

  test('a missing service credential is identity_unavailable and no request is sent', async () => {
    const { outcome, requests } = await check(json({ success: true, data: { active: true, credentialVersion: 4 } }), stored(), {
      serviceToken: undefined,
    });
    assert.equal(outcome, 'identity_unavailable:503');
    assert.equal(requests.length, 0);
  });

  test('local denials stay false and never reach the Account service', async () => {
    const active = json({ success: true, data: { active: true, credentialVersion: 4 } });
    const expired = await check(active, stored({ expiresAt: new Date(Date.now() - 1).toISOString() }));
    assert.deepEqual([expired.outcome, expired.requests.length], [false, 0]);
    const noApplication = await check(active, stored({ applicationId: undefined }));
    assert.deepEqual([noApplication.outcome, noApplication.requests.length], [false, 0]);
    const noVersion = await check(active, stored({ credentialVersion: undefined }));
    assert.deepEqual([noVersion.outcome, noVersion.requests.length], [false, 0]);
    const oidcWithoutExpiry = await check(active, stored(), { mode: 'oidc' });
    assert.deepEqual([oidcWithoutExpiry.outcome, oidcWithoutExpiry.requests.length], [false, 0]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx --test test/access.test.ts`

Expected: the suite `validateDelegation: explicit denial versus transient failure` reports 4 failing tests and 3 passing ones (plan A's own tests in the file keep passing). The failures are:

```
✖ 401, 403, 404 and every other non-2xx status are identity_unavailable, never a denial
  AssertionError [ERR_ASSERTION]: HTTP 400
  + false
  - 'identity_unavailable:503'
✖ a network error or a timeout is identity_unavailable
  + 'raw:TypeError: fetch failed'
  - 'identity_unavailable:503'
✖ a 200 answer that is not the documented envelope is identity_unavailable
  AssertionError [ERR_ASSERTION]: html body
  + `raw:SyntaxError: Unexpected token '<', "<html>bad "... is not valid JSON`
  - 'identity_unavailable:503'
✖ a missing service credential is identity_unavailable and no request is sent
  + false
  - 'identity_unavailable:503'
```

- [ ] **Step 3: Write minimal implementation**

In `src/access.ts`, inside `validateDelegation`, replace these existing lines (the end of the method; the lines above them are left exactly as plan A wrote them):

```ts
    if (!this.serviceToken || !principal.subject || !principal.applicationId || principal.credentialVersion === undefined) return false;
    const response = await this.fetcher(new URL('/api/internal/authorization/check/', this.accountApiOrigin ?? principal.issuer), {
      method: 'POST', headers: { authorization: `Bearer ${this.serviceToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({ subject: principal.subject, applicationId: principal.applicationId, credentialVersion: principal.credentialVersion }), redirect: 'error', signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) return false;
    const result = await response.json() as { success?: boolean; data?: { active?: boolean; credentialVersion?: number } };
    return result.success === true && result.data?.active === true && result.data.credentialVersion === principal.credentialVersion;
  }
```

with:

```ts
    if (!principal.subject || !principal.applicationId || principal.credentialVersion === undefined) return false;
    const unavailable = () => new DomainError('identity_unavailable', 'Account authorization check is unavailable', 503);
    if (!this.serviceToken) throw unavailable();
    let result: { success?: unknown; data?: { active?: unknown; credentialVersion?: unknown } } | null;
    try {
      const response = await this.fetcher(new URL('/api/internal/authorization/check/', this.accountApiOrigin ?? principal.issuer), {
        method: 'POST', headers: { authorization: `Bearer ${this.serviceToken}`, 'content-type': 'application/json' },
        body: JSON.stringify({ subject: principal.subject, applicationId: principal.applicationId, credentialVersion: principal.credentialVersion }), redirect: 'error', signal: AbortSignal.timeout(5000),
      });
      if (!response.ok) throw unavailable();
      result = await response.json() as typeof result;
    } catch {
      throw unavailable();
    }
    if (result?.success !== true || typeof result.data?.active !== 'boolean' || typeof result.data.credentialVersion !== 'number') throw unavailable();
    return result.data.active && result.data.credentialVersion === principal.credentialVersion;
  }
```

The order matters: a principal that can never be checked (no subject, application or credential version) is still an explicit denial; a missing service credential is the core's own misconfiguration and is transient, exactly like a 401 from the identity service. The `catch` deliberately swallows the `unavailable()` thrown for a non-2xx status and rethrows the same error.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx tsx --test test/access.test.ts test/auth.test.ts`

Expected: every test passes, `ℹ fail 0`. `test/auth.test.ts` contains `account API endpoint is separate from the canonical identity issuer`, which exercises the unchanged success path.

- [ ] **Step 5: Commit**

```bash
git add src/access.ts test/access.test.ts
git commit -m "修復：授權檢查只把明確拒絕視為撤銷，其餘視為身份服務暫時不可用"
```

### Task 2: TaskService retries a step when revalidation is transiently unavailable (C2)

**Files:**
- Modify: `src/tasks.ts` (`TaskService.execute`, the `catch (caught)` block, lines 807-826 as of commit 17d571f)
- Test: `test/tasks.test.ts` (append at the end of the file)

**Interfaces:**
- Consumes: `TaskServiceOptions.reauthorize?: (principal: Principal) => Promise<Principal>` and `TaskServiceOptions.onError?: (error: unknown) => void` (both existing); `DomainError('identity_unavailable', …, 503)` as thrown by Task 1 through the `reauthorize` hook.
- Produces: when `execute` ends with an error whose `code` is `identity_unavailable` and no write or external dispatch is unconfirmed, the task row becomes `{ state: 'queued', error: <the error message>, nextAttemptAt: <now + 30 000 ms>, workerId: undefined, leaseExpiresAt: undefined }` and the error is passed to `options.onError`. No event, no notification, no new state. `error` and `nextAttemptAt` are cleared on completion by the existing code.

Background for the implementer: `execute` revalidates the task principal at its start and again before it persists every `model_call` and `tool_dispatched` runtime event. Today a thrown `identity_unavailable` falls through to the last `return` of the catch block and the task becomes `failed`. The branch order in the catch block is significant and must stay: `waiting_for_device`, then `authorizationPauseCodes` (pause), then `unresolved` (state `unknown`), then the new branch, then the abort branch, then `failed`. Placing the new branch after `unresolved` keeps the rule that an unconfirmed dispatch is never retried.

- [ ] **Step 1: Write the failing test**

Append to the end of `test/tasks.test.ts` (all names used are already imported or defined at the top of that file: `assert`, `test`, `SqliteStore`, `TaskService`, `Task`, `DomainError`, `NotificationService`, `principal`, `conversation`):

```ts
test('a task whose revalidation is transiently unavailable is retried, not paused or failed', async () => {
  const store = new SqliteStore();
  let now = Date.parse('2026-09-27T04:00:00.000Z');
  let available = false;
  let runs = 0;
  const logged: unknown[] = [];
  const notifications = new NotificationService(store, { now: () => new Date(now) });
  const service = new TaskService(store, async () => {
    runs += 1;
    return { text: 'done' };
  }, {
    now: () => now,
    notifications,
    onError: (error) => logged.push(error),
    async reauthorize(current) {
      if (!available) throw new DomainError('identity_unavailable', 'Account authorization check is unavailable', 503);
      return current;
    },
  });
  try {
    const thread = await store.create('conversation', principal.id, conversation);
    const task = await service.enqueue(principal, thread.id, 'retry me');
    await service.drain();
    const waiting = (await store.get<Task>('task', task.id, principal.id))!;
    assert.equal(waiting.data.state, 'queued');
    assert.equal(waiting.data.error, 'Account authorization check is unavailable');
    assert.equal(waiting.data.nextAttemptAt, new Date(now + 30_000).toISOString());
    assert.equal(waiting.data.workerId, undefined);
    assert.equal(waiting.data.leaseExpiresAt, undefined);
    assert.equal(runs, 0);
    assert.equal(logged.length, 1);
    assert.equal((logged[0] as DomainError).code, 'identity_unavailable');
    assert.equal((await store.scan('notification', principal.id)).length, 0);

    await service.drain();
    assert.equal(runs, 0, 'the retry waits for nextAttemptAt');

    now += 30_001;
    available = true;
    await service.drain();
    const completed = (await store.get<Task>('task', task.id, principal.id))!;
    assert.equal(completed.data.state, 'completed');
    assert.equal(completed.data.error, undefined);
    assert.equal(completed.data.nextAttemptAt, undefined);
    assert.equal(runs, 1);
  } finally { await service.close(); await store.close(); }
});

test('a transient revalidation failure at a tool dispatch re-queues before the action runs', async () => {
  const store = new SqliteStore();
  let now = Date.parse('2026-09-27T04:00:00.000Z');
  let failNext = false;
  let runs = 0;
  let actionRuns = 0;
  const service = new TaskService(store, async ({ onEvent }) => {
    runs += 1;
    failNext = runs === 1;
    await onEvent({
      type: 'tool_dispatched',
      toolCall: { id: 'write-1', name: 'workspace.write', arguments: {} },
      sideEffect: 'write',
    });
    actionRuns += 1;
    await onEvent({ type: 'tool_result', toolCallId: 'write-1', outcome: 'confirmed' });
    return { text: 'done' };
  }, {
    now: () => now,
    async reauthorize(current) {
      if (failNext) throw new DomainError('identity_unavailable', 'Account authorization check is unavailable', 503);
      return current;
    },
  });
  try {
    const thread = await store.create('conversation', principal.id, conversation);
    const task = await service.enqueue(principal, thread.id, 'write');
    await service.drain();
    assert.equal(actionRuns, 0);
    assert.equal((await store.get<Task>('task', task.id, principal.id))?.data.state, 'queued');
    assert.equal(
      (await service.events(principal.id, task.id)).some((row) => row.data.type === 'tool_dispatched'),
      false,
      'a dispatch that was never authorised is not recorded',
    );

    now += 30_001;
    failNext = false;
    await service.drain();
    assert.equal(runs, 2);
    assert.equal(actionRuns, 1);
    assert.equal((await store.get<Task>('task', task.id, principal.id))?.data.state, 'completed');
  } finally { await service.close(); await store.close(); }
});

test('a transient revalidation failure after an unconfirmed dispatch still ends unknown', async () => {
  const store = new SqliteStore();
  let failNext = false;
  const service = new TaskService(store, async ({ onEvent }) => {
    await onEvent({
      type: 'tool_dispatched',
      toolCall: { id: 'write-1', name: 'workspace.write', arguments: {} },
      sideEffect: 'write',
    });
    failNext = true;
    await onEvent({ type: 'model_call', call: 2 });
    return { text: 'unreachable' };
  }, {
    async reauthorize(current) {
      if (failNext) throw new DomainError('identity_unavailable', 'Account authorization check is unavailable', 503);
      return current;
    },
  });
  try {
    const thread = await store.create('conversation', principal.id, conversation);
    const task = await service.enqueue(principal, thread.id, 'write then think');
    await service.drain();
    const stopped = (await store.get<Task>('task', task.id, principal.id))!;
    assert.equal(stopped.data.state, 'unknown');
    assert.equal(stopped.data.nextAttemptAt, undefined);
  } finally { await service.close(); await store.close(); }
});

test('a task waiting for its revalidation retry can be cancelled, and an interactive grant still expires', async () => {
  const store = new SqliteStore();
  let now = Date.parse('2026-09-27T04:00:00.000Z');
  const service = new TaskService(store, async () => ({ text: 'never' }), {
    now: () => now,
    async reauthorize() { throw new DomainError('identity_unavailable', 'Account authorization check is unavailable', 503); },
  });
  try {
    const thread = await store.create('conversation', principal.id, conversation);
    const cancelled = await service.enqueue(principal, thread.id, 'cancel me');
    const expiring = await service.enqueue(principal, thread.id, 'expire me');
    await service.drain();
    assert.equal((await store.get<Task>('task', cancelled.id, principal.id))?.data.state, 'queued');
    assert.equal((await service.control(principal.id, cancelled.id, 'cancel')).data.state, 'cancelled');

    now += 3_600_001;
    await service.drain();
    const paused = (await store.get<Task>('task', expiring.id, principal.id))!;
    assert.equal(paused.data.state, 'paused');
    assert.match(paused.data.error ?? '', /authorization expired/);
  } finally { await service.close(); await store.close(); }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx --test --test-name-pattern='revalidation' test/tasks.test.ts`

Expected: 3 of the 4 new tests fail, each with `'failed' !== 'queued'`:

```
✖ a task whose revalidation is transiently unavailable is retried, not paused or failed
✖ a transient revalidation failure at a tool dispatch re-queues before the action runs
✔ a transient revalidation failure after an unconfirmed dispatch still ends unknown
✖ a task waiting for its revalidation retry can be cancelled, and an interactive grant still expires
```

The third test passes already; it guards the branch order while the new branch is added.

- [ ] **Step 3: Write minimal implementation**

In `src/tasks.ts`, in the `catch (caught)` block of `execute`, replace:

```ts
        if (controller.signal.aborted) {
          return {
            ...current,
            state: 'queued',
            error: undefined,
            workerId: undefined,
            leaseExpiresAt: undefined,
          };
        }
        return {
          ...current,
          state: 'failed',
          error: error instanceof Error ? error.message : 'Task execution failed',
          workerId: undefined,
          leaseExpiresAt: undefined,
        };
      }).catch((storageError) => {
        this.options.onError?.(storageError);
        return undefined;
      });
```

with:

```ts
        if (code === 'identity_unavailable') {
          return {
            ...current,
            state: 'queued',
            error: error instanceof Error ? error.message : 'Authorization check is unavailable',
            nextAttemptAt: new Date(this.now() + 30_000).toISOString(),
            workerId: undefined,
            leaseExpiresAt: undefined,
          };
        }
        if (controller.signal.aborted) {
          return {
            ...current,
            state: 'queued',
            error: undefined,
            workerId: undefined,
            leaseExpiresAt: undefined,
          };
        }
        return {
          ...current,
          state: 'failed',
          error: error instanceof Error ? error.message : 'Task execution failed',
          workerId: undefined,
          leaseExpiresAt: undefined,
        };
      }).catch((storageError) => {
        this.options.onError?.(storageError);
        return undefined;
      });
      if (code === 'identity_unavailable' && updated?.data.state === 'queued') {
        this.options.onError?.(error);
      }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx tsx --test test/tasks.test.ts`

Expected: all tests pass, `ℹ fail 0`. This includes the two existing guards `tool dispatch revalidates authorization before the action may proceed` (a non-`DomainError` from `reauthorize` still fails the task) and `model calls revalidate current authorization and preserve the task scope ceiling` (`grant_revoked` still pauses).

- [ ] **Step 5: Commit**

```bash
git add src/tasks.ts test/tasks.test.ts
git commit -m "修復：身份服務暫時不可用時任務延後重試而非失敗"
```

### Task 3: Durable actor at save and at dispatch (C1)

**Files:**
- Modify: `src/event-triggers.ts` (`EventTriggerOptions` lines 131-135; new exported type and function above `class AutomationDispatcher` line 187; `EventTriggerService.create` lines 370-378; `EventTriggerService.update` lines 417-431; `EventTriggerService.reconcileItem` lines 561-563)
- Modify: `src/scheduler.ts` (import block lines 4-8; `SchedulerOptions` lines 74-77; `SchedulerService.create` lines 120-129; `SchedulerService.update` lines 161-173; `SchedulerService.reconcileOccurrence` lines 290-292)
- Test: `test/event-triggers.test.ts` (append at the end of the file)

**Interfaces:**
- Consumes: `Principal` from `src/contracts.ts` (`expiresAt?: string` is the session expiry); `AutomationDispatcher.dispatch(input)` and `AutomationDispatcher.authorize(ownerId, actor, settings, reauthorize)` unchanged — `authorize` rejects an actor whose `expiresAt` has passed with `actor_expired` and accepts an actor without `expiresAt`.
- Produces:
  - `export type UnattendedAuthorization = 'durable' | 'unsupported';` (in `src/event-triggers.ts`, re-exported by `src/index.ts` through its existing `export *`).
  - `export function automationActor(actor: Principal, unattended: UnattendedAuthorization | undefined, enabled = false): Principal` — in durable mode returns a copy of `actor` without the `expiresAt` key; otherwise returns `actor` unchanged. The third parameter is not read in this task; Task 8 makes the function throw when `unattended === 'unsupported' && enabled`.
  - `EventTriggerOptions.unattended?: UnattendedAuthorization` and `SchedulerOptions.unattended?: UnattendedAuthorization`. Absent means today's behaviour.
  - Stored data: `automation_schedule.data.actor` and `event_trigger.data.actor` have no `expiresAt` when saved in durable mode. `schedule_occurrence.data.actor` and `event_inbox.data.actor` remain verbatim copies of the stored actor and are never rewritten; a stale `expiresAt` in them is dropped only in the value handed to the dispatcher.

Background for the implementer: in account mode the calling principal carries `expiresAt` = the end of a sign-in session of about 15 minutes. Today that principal is stored verbatim as `actor`, copied into every occurrence and inbox item, and rejected with `actor_expired` at dispatch once the session has ended, which disables the automation. `actor_expired` at save time (an already expired caller) must keep working: `assertScheduleActor` / `assertOwnerActor` run on the caller before `automationActor` is applied.

- [ ] **Step 1: Write the failing test**

Append to the end of `test/event-triggers.test.ts` (after the existing `hasCode` function; function declarations are hoisted, so the tests can use it). All imports used are already at the top of that file.

```ts
// ---------------------------------------------------------------------------
// Workstream C — authorization lifetime of automations.
// ---------------------------------------------------------------------------

/** A principal as account mode reports it for the owner: session-bound, with identity fields. */
const sessionOwner = (expiresAt: string, overrides: Partial<Principal> = {}): Principal => ({
  ...owner(expiresAt),
  issuer: 'https://identity.example.test',
  subject: `acct_${'a'.repeat(32)}`,
  applicationId: 'kiancode',
  audience: 'kiancode',
  credentialVersion: 3,
  ...overrides,
});
const automationSettings = (conversationId: string) => ({
  conversationId, permissions: ['model:read'], notification: { type: 'none' as const },
});

test('account-mode automations store a durable actor and still dispatch 31 days later', async () => {
  const store = new SqliteStore();
  let now = start;
  const tasks = new TaskService(store, async () => ({ text: 'unused' }), { now: () => now });
  try {
    const source = await store.create<Conversation>('conversation', owner().id, baseConversation);
    const dispatcher = new AutomationDispatcher(store, tasks, () => now);
    const reauthorized: Principal[] = [];
    const reauthorize = async (stored: Principal): Promise<Principal> => {
      reauthorized.push(stored);
      return stored;
    };
    const scheduler = new SchedulerService(store, dispatcher, { enabled: true, now: () => now, unattended: 'durable', reauthorize });
    const triggers = new EventTriggerService(store, dispatcher, { enabled: true, now: () => now, unattended: 'durable', reauthorize });
    const caller = sessionOwner(new Date(start + 15 * 60_000).toISOString());
    const { expiresAt: _sessionExpiry, ...durable } = caller;

    const schedule = await scheduler.create(caller, {
      name: 'Daily', prompt: 'Run daily', nextAt: new Date(start + 86_400_000).toISOString(), intervalSeconds: 86_400,
      enabled: true, settings: automationSettings(source.id),
    });
    assert.equal('expiresAt' in schedule.data.actor, false);
    assert.deepEqual(schedule.data.actor, durable);
    const created = await triggers.create(caller, {
      name: 'Hook', prompt: 'Handle', enabled: true, type: 'webhook', filter: {}, settings: automationSettings(source.id),
    });
    assert.equal('expiresAt' in created.trigger.data.actor, false);
    assert.deepEqual(created.trigger.data.actor, durable);

    now = start + 31 * 86_400_000 + 1_000;
    await triggers.ingestWebhook(created.trigger.data.webhook!.id, created.secret, { eventId: 'late-1', eventName: 'test', payload: {} });
    await scheduler.reconcile();
    await triggers.reconcile();

    const enqueued = await store.scan<Task>('task', owner().id);
    assert.equal(enqueued.length, 2);
    for (const task of enqueued) {
      assert.equal('expiresAt' in task.data.principal, false);
      assert.deepEqual(task.data.principal.scopes, ['model:read']);
    }
    assert.equal(reauthorized.length, 2);
    assert.ok(reauthorized.every((principal) => !('expiresAt' in principal)));
    const after = await store.get<AutomationSchedule>('automation_schedule', schedule.id, owner().id);
    assert.equal(after?.data.enabled, true);
    assert.equal(after?.data.authorizationFailedAt, undefined);
    assert.equal((await triggers.list(owner().id))[0]?.data.enabled, true);

    const edited = await scheduler.update(sessionOwner(new Date(now + 60_000).toISOString(), { credentialVersion: 4 }), schedule.id, after!.revision, {
      name: 'Daily', prompt: 'Run daily', nextAt: new Date(now + 86_400_000).toISOString(), intervalSeconds: 86_400,
      enabled: true, settings: automationSettings(source.id),
    });
    assert.equal('expiresAt' in edited.data.actor, false);
    assert.equal(edited.data.actor.credentialVersion, 4);

    // A trigger has no enable-only call: saving it again is how its stored authorisation is refreshed.
    const listed = (await triggers.list(owner().id))[0]!;
    const resaved = await triggers.update(sessionOwner(new Date(now + 60_000).toISOString(), { credentialVersion: 4 }), listed.id, listed.revision, {
      name: 'Hook', prompt: 'Handle', enabled: true, type: 'webhook', filter: {}, settings: automationSettings(source.id),
    });
    assert.equal('expiresAt' in resaved.data.actor, false);
    assert.equal(resaved.data.actor.credentialVersion, 4);
  } finally {
    await tasks.close();
    await store.close();
  }
});

test('a legacy actor with a stale expiresAt is dispatched in durable mode without rewriting stored rows', async () => {
  const store = new SqliteStore();
  let now = start;
  const tasks = new TaskService(store, async () => ({ text: 'unused' }), { now: () => now });
  try {
    const source = await store.create<Conversation>('conversation', owner().id, baseConversation);
    const dispatcher = new AutomationDispatcher(store, tasks, () => now);
    const reauthorize = async (stored: Principal): Promise<Principal> => stored;
    const staleExpiry = new Date(start + 15 * 60_000).toISOString();
    const caller = sessionOwner(staleExpiry);

    // Saved by the code before this change: no `unattended` option, the actor keeps its session expiry.
    const legacyScheduler = new SchedulerService(store, dispatcher, { enabled: true, now: () => now, reauthorize });
    const legacyTriggers = new EventTriggerService(store, dispatcher, { enabled: true, now: () => now, reauthorize });
    const schedule = await legacyScheduler.create(caller, {
      name: 'Legacy', prompt: 'Run', nextAt: new Date(start + 3_600_000).toISOString(), enabled: true,
      settings: automationSettings(source.id),
    });
    assert.equal(schedule.data.actor.expiresAt, staleExpiry);
    const created = await legacyTriggers.create(caller, {
      name: 'Legacy hook', prompt: 'Handle', enabled: true, type: 'webhook', filter: {}, settings: automationSettings(source.id),
    });
    await legacyTriggers.ingestWebhook(created.trigger.data.webhook!.id, created.secret, { eventId: 'legacy-1', eventName: 'test', payload: {} });

    now = start + 3_600_000 + 1_000;
    const scheduler = new SchedulerService(store, dispatcher, { enabled: true, now: () => now, unattended: 'durable', reauthorize });
    const triggers = new EventTriggerService(store, dispatcher, { enabled: true, now: () => now, unattended: 'durable', reauthorize });
    await scheduler.reconcile();
    await triggers.reconcile();

    assert.equal((await store.scan<Task>('task', owner().id)).length, 2);
    const occurrence = (await store.scan<ScheduleOccurrence>('schedule_occurrence', owner().id))[0]!;
    assert.equal(occurrence.data.status, 'enqueued');
    assert.equal(occurrence.data.actor.expiresAt, staleExpiry, 'the stored occurrence copy is not rewritten');
    const inbox = (await store.scan<EventInboxItem>('event_inbox', owner().id))[0]!;
    assert.equal(inbox.data.status, 'enqueued');
    assert.equal(inbox.data.actor.expiresAt, staleExpiry, 'the stored inbox copy is not rewritten');
    const stored = await store.get<AutomationSchedule>('automation_schedule', schedule.id, owner().id);
    assert.equal(stored?.data.actor.expiresAt, staleExpiry, 'the stored schedule is not rewritten');
    assert.equal(stored?.data.authorizationFailedAt, undefined);
  } finally {
    await tasks.close();
    await store.close();
  }
});

test('durable mode still refuses an expired, low-level or under-scoped caller at save time', async () => {
  const store = new SqliteStore();
  const tasks = new TaskService(store, async () => ({ text: 'unused' }));
  try {
    const source = await store.create<Conversation>('conversation', owner().id, baseConversation);
    const dispatcher = new AutomationDispatcher(store, tasks, () => start);
    const scheduler = new SchedulerService(store, dispatcher, { enabled: true, now: () => start, unattended: 'durable' });
    const triggers = new EventTriggerService(store, dispatcher, { enabled: true, now: () => start, unattended: 'durable' });
    const schedule = {
      name: 'Denied', prompt: 'Never', nextAt: new Date(start + 60_000).toISOString(), enabled: true,
      settings: automationSettings(source.id),
    };
    const trigger = {
      name: 'Denied', prompt: 'Never', enabled: true, type: 'webhook' as const, filter: {}, settings: automationSettings(source.id),
    };
    const expired = sessionOwner(new Date(start - 1).toISOString());
    await assert.rejects(scheduler.create(expired, schedule), hasCode('actor_expired'));
    await assert.rejects(triggers.create(expired, trigger), hasCode('actor_expired'));
    const lowLevel = sessionOwner(new Date(start + 60_000).toISOString(), { level: 2 });
    await assert.rejects(scheduler.create(lowLevel, schedule), hasCode('owner_required'));
    await assert.rejects(triggers.create(lowLevel, trigger), hasCode('owner_required'));
    const underScoped = sessionOwner(new Date(start + 60_000).toISOString(), { scopes: ['schedule:read'] });
    await assert.rejects(scheduler.create(underScoped, schedule), hasCode('forbidden'));
    await assert.rejects(triggers.create(underScoped, trigger), hasCode('forbidden'));
    assert.equal((await store.scan('automation_schedule')).length, 0);
    assert.equal((await store.scan('event_trigger')).length, 0);
  } finally {
    await tasks.close();
    await store.close();
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx --test --test-name-pattern='durable' test/event-triggers.test.ts`

Expected (`tsx` does not type-check, so the unknown `unattended` option is ignored at run time):

```
✖ account-mode automations store a durable actor and still dispatch 31 days later
  AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:
  true !== false
✖ a legacy actor with a stale expiresAt is dispatched in durable mode without rewriting stored rows
  AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:
  0 !== 2
✔ durable mode still refuses an expired, low-level or under-scoped caller at save time
```

The third test passes already; it guards the save-time checks while the actor handling changes. `npx tsc --noEmit` reports `'unattended' does not exist in type 'SchedulerOptions'` / `'EventTriggerOptions'` until Step 3 is done.

- [ ] **Step 3: Write minimal implementation**

`src/event-triggers.ts`, edit 1 — the options interface. Replace:

```ts
export interface EventTriggerOptions {
  enabled?: boolean;
  now?: () => number;
  claimMs?: number;
  reauthorize?: (principal: Principal) => Promise<Principal>;
```

with:

```ts
/**
 * How the server can keep an automation authorised while nobody is signed in.
 * 'durable': the stored actor carries no session expiry and is revalidated at every dispatch (account mode).
 * 'unsupported': no unattended revalidation exists (OIDC mode).
 * Absent: the actor is stored and enforced exactly as given (development mode, embedders).
 */
export type UnattendedAuthorization = 'durable' | 'unsupported';

export interface EventTriggerOptions {
  enabled?: boolean;
  now?: () => number;
  claimMs?: number;
  unattended?: UnattendedAuthorization;
  reauthorize?: (principal: Principal) => Promise<Principal>;
```

`src/event-triggers.ts`, edit 2 — the helper, directly above the dispatcher class. Replace:

```ts
export class AutomationDispatcher {
  public constructor(
```

with:

```ts
/**
 * The actor an automation stores (save) or hands to the dispatcher (dispatch).
 * In durable mode the session expiry is dropped: the key is removed, not set to undefined.
 * `enabled` is true when the caller is saving an enabled automation; dispatch leaves it false.
 * It has no effect in durable mode.
 */
export function automationActor(
  actor: Principal,
  unattended: UnattendedAuthorization | undefined,
  enabled = false,
): Principal {
  if (unattended !== 'durable') return actor;
  const { expiresAt: _expiresAt, ...durable } = actor;
  return durable;
}

export class AutomationDispatcher {
  public constructor(
```

`src/event-triggers.ts`, edit 3 — `EventTriggerService.create`. Replace:

```ts
    const settings = await this.dispatcher.snapshot(actor.id, input.settings);
    const base = {
      name: input.name.trim(),
      prompt: input.prompt.trim(),
      enabled: input.enabled === true,
      actor,
      settings,
      version: 1,
    };
```

with:

```ts
    const storedActor = automationActor(actor, this.options.unattended, input.enabled === true);
    const settings = await this.dispatcher.snapshot(actor.id, input.settings);
    const base = {
      name: input.name.trim(),
      prompt: input.prompt.trim(),
      enabled: input.enabled === true,
      actor: storedActor,
      settings,
      version: 1,
    };
```

`src/event-triggers.ts`, edit 4 — `EventTriggerService.update`. Replace:

```ts
    const current = await this.requireTrigger(actor.id, id);
    if (current.revision !== expectedRevision) throw new DomainError('conflict', 'Event trigger changed; reload and retry.', 409);
    if (current.data.type !== input.type) {
      throw new DomainError('invalid_trigger_type', 'Trigger type cannot be changed; create another trigger.', 409);
    }
    const settings = await this.dispatcher.snapshot(actor.id, input.settings);
    const common = {
      ...current.data,
      name: input.name.trim(),
      prompt: input.prompt.trim(),
      enabled: input.enabled === true,
      actor,
      settings,
      version: current.data.version + 1,
    };
```

with:

```ts
    const storedActor = automationActor(actor, this.options.unattended, input.enabled === true);
    const current = await this.requireTrigger(actor.id, id);
    if (current.revision !== expectedRevision) throw new DomainError('conflict', 'Event trigger changed; reload and retry.', 409);
    if (current.data.type !== input.type) {
      throw new DomainError('invalid_trigger_type', 'Trigger type cannot be changed; create another trigger.', 409);
    }
    const settings = await this.dispatcher.snapshot(actor.id, input.settings);
    const common = {
      ...current.data,
      name: input.name.trim(),
      prompt: input.prompt.trim(),
      enabled: input.enabled === true,
      actor: storedActor,
      settings,
      version: current.data.version + 1,
    };
```

`src/event-triggers.ts`, edit 5 — `EventTriggerService.reconcileItem`, the `dispatcher.dispatch` call. Replace:

```ts
        occurrenceId: claimed.data.eventId,
        prompt: claimed.data.prompt,
        actor: claimed.data.actor,
```

with:

```ts
        occurrenceId: claimed.data.eventId,
        prompt: claimed.data.prompt,
        actor: automationActor(claimed.data.actor, this.options.unattended),
```

`src/scheduler.ts`, edit 1 — the import. Replace:

```ts
import {
  AutomationDispatcher,
  type AutomationExecutionSnapshot,
  type AutomationSettingsInput,
} from './event-triggers.js';
```

with:

```ts
import {
  automationActor,
  AutomationDispatcher,
  type AutomationExecutionSnapshot,
  type AutomationSettingsInput,
  type UnattendedAuthorization,
} from './event-triggers.js';
```

`src/scheduler.ts`, edit 2 — the options interface. Replace:

```ts
export interface SchedulerOptions {
  enabled?: boolean;
  now?: () => number;
  claimMs?: number;
```

with:

```ts
export interface SchedulerOptions {
  enabled?: boolean;
  now?: () => number;
  claimMs?: number;
  unattended?: UnattendedAuthorization;
```

`src/scheduler.ts`, edit 3 — `SchedulerService.create`. Replace:

```ts
    const settings = await this.dispatcher.snapshot(actor.id, input.settings);
    return this.store.create<AutomationSchedule>('automation_schedule', actor.id, {
      name: input.name.trim(),
      prompt: input.prompt.trim(),
      ...timing,
      enabled: input.enabled === true,
      actor,
      settings,
      version: 1,
    });
```

with:

```ts
    const storedActor = automationActor(actor, this.options.unattended, input.enabled === true);
    const settings = await this.dispatcher.snapshot(actor.id, input.settings);
    return this.store.create<AutomationSchedule>('automation_schedule', actor.id, {
      name: input.name.trim(),
      prompt: input.prompt.trim(),
      ...timing,
      enabled: input.enabled === true,
      actor: storedActor,
      settings,
      version: 1,
    });
```

`src/scheduler.ts`, edit 4 — `SchedulerService.update`. Replace:

```ts
    const current = await this.requireSchedule(actor.id, id);
    if (current.revision !== expectedRevision) throw new DomainError('conflict', 'Schedule changed; reload and retry.', 409);
    const settings = await this.dispatcher.snapshot(actor.id, input.settings);
    return this.store.put('automation_schedule', id, actor.id, {
      ...current.data,
      name: input.name.trim(),
      prompt: input.prompt.trim(),
      ...timing,
      intervalSeconds: timing.intervalSeconds,
      cronExpression: timing.cronExpression,
      timezone: timing.timezone,
      enabled: input.enabled === true,
      actor,
```

with:

```ts
    const storedActor = automationActor(actor, this.options.unattended, input.enabled === true);
    const current = await this.requireSchedule(actor.id, id);
    if (current.revision !== expectedRevision) throw new DomainError('conflict', 'Schedule changed; reload and retry.', 409);
    const settings = await this.dispatcher.snapshot(actor.id, input.settings);
    return this.store.put('automation_schedule', id, actor.id, {
      ...current.data,
      name: input.name.trim(),
      prompt: input.prompt.trim(),
      ...timing,
      intervalSeconds: timing.intervalSeconds,
      cronExpression: timing.cronExpression,
      timezone: timing.timezone,
      enabled: input.enabled === true,
      actor: storedActor,
```

`src/scheduler.ts`, edit 5 — `SchedulerService.reconcileOccurrence`, the `dispatcher.dispatch` call. Replace:

```ts
        occurrenceId: claimed.data.dueAt,
        prompt: claimed.data.prompt,
        actor: claimed.data.actor,
```

with:

```ts
        occurrenceId: claimed.data.dueAt,
        prompt: claimed.data.prompt,
        actor: automationActor(claimed.data.actor, this.options.unattended),
```

In all four save paths `automationActor` is called after the existing `scheduler_disabled` / `event_triggers_disabled` check and before `dispatcher.snapshot` or any store write. Task 8 relies on that position.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx tsc --noEmit && npx tsx --test test/event-triggers.test.ts test/tasks.test.ts`

Expected: no type errors; all tests pass, `ℹ fail 0`. The existing test `expired or low-privilege actors cannot create or execute event triggers` (no `unattended` option) still ends with `rejectionCode: 'actor_expired'`, which proves the default behaviour is unchanged.

- [ ] **Step 5: Commit**

```bash
git add src/event-triggers.ts src/scheduler.ts test/event-triggers.test.ts
git commit -m "實現：帳號模式的排程與觸發器保存不含工作階段期限的持久授權"
```

### Task 4: Re-materialising an existing occurrence must not abort reconcile (prerequisite for C3)

**Files:**
- Modify: `src/scheduler.ts` (`SchedulerService.materializeOccurrence`, line 242 as of commit 17d571f)
- Test: `test/event-triggers.test.ts` (append at the end of the file)

**Interfaces:**
- Consumes: `automationSettings(conversationId)` test helper defined in Task 3's test block of the same file; `SchedulerService.setEnabled(actor, id, expectedRevision, enabled)` and `SchedulerService.update(actor, id, expectedRevision, input)` (existing); module-private `isConflict(error)` and `createOrVerify` in `src/scheduler.ts` (existing; `createOrVerify` stays in use for tombstones).
- Produces: `SchedulerService.reconcile()` resolves when a due, enabled schedule already has an occurrence for its `nextAt` in any state. The existing occurrence is left untouched and is not dispatched again. A one-shot schedule in that situation goes back to `enabled: false`; the owner runs it again by saving a new `nextAt`.

Background for the implementer: the occurrence id is `sha256(ownerId NUL scheduleId NUL nextAt)`. `materializeOccurrence` calls `createOrVerify`, which throws `idempotency_conflict` (409) when a row with that id exists with different data. An occurrence that has run has `status: 'enqueued'` and `attempts: 1`, so re-enabling a one-shot schedule (same `nextAt`) makes `reconcile()` reject on every tick. In production `reconcile()` runs inside the task tick before any task is claimed (`src/bootstrap.ts`, `server.tasks.setReconciler`), so that single schedule stops task execution for every owner. Task 5 makes "re-enable" the documented recovery, so this must be fixed first.

- [ ] **Step 1: Write the failing test**

Append to the end of `test/event-triggers.test.ts`:

```ts
test('re-enabling a one-shot schedule that already fired neither runs it again nor aborts reconcile', async () => {
  const store = new SqliteStore();
  let now = start;
  const tasks = new TaskService(store, async () => ({ text: 'unused' }), { now: () => now });
  try {
    const other: Principal = { ...owner(), id: 'owner-2' };
    const source = await store.create<Conversation>('conversation', owner().id, baseConversation);
    const otherSource = await store.create<Conversation>('conversation', other.id, baseConversation);
    const scheduler = new SchedulerService(store, new AutomationDispatcher(store, tasks, () => now), {
      enabled: true, now: () => now, reauthorize: async (stored) => stored,
    });
    const once = await scheduler.create(owner(), {
      name: 'Once', prompt: 'Run once', nextAt: new Date(now).toISOString(), enabled: true,
      settings: automationSettings(source.id),
    });
    await scheduler.reconcile();
    assert.equal((await store.scan<Task>('task', owner().id)).length, 1);
    const fired = (await store.get<AutomationSchedule>('automation_schedule', once.id, owner().id))!;
    assert.equal(fired.data.enabled, false);

    await scheduler.setEnabled(owner(), once.id, fired.revision, true);
    await scheduler.create(other, {
      name: 'Unrelated', prompt: 'Run for another owner', nextAt: new Date(now).toISOString(), enabled: true,
      settings: automationSettings(otherSource.id),
    });
    now += 1_000;
    await scheduler.reconcile();
    await scheduler.reconcile();

    assert.equal((await store.scan<Task>('task', owner().id)).length, 1, 'the one-shot does not run twice');
    assert.equal((await store.scan<ScheduleOccurrence>('schedule_occurrence', owner().id)).length, 1);
    const again = (await store.get<AutomationSchedule>('automation_schedule', once.id, owner().id))!;
    assert.equal(again.data.enabled, false, 'a one-shot whose occurrence exists goes back to disabled');
    assert.equal((await store.scan<Task>('task', other.id)).length, 1, 'other owners are still served in the same reconcile');
  } finally {
    await tasks.close();
    await store.close();
  }
});

test('a one-shot schedule rejected for authorization runs only after the owner saves a new time', async () => {
  const store = new SqliteStore();
  let now = start;
  let revoked = true;
  const tasks = new TaskService(store, async () => ({ text: 'unused' }), { now: () => now });
  try {
    const source = await store.create<Conversation>('conversation', owner().id, baseConversation);
    const scheduler = new SchedulerService(store, new AutomationDispatcher(store, tasks, () => now), {
      enabled: true,
      now: () => now,
      async reauthorize(stored) {
        if (revoked) throw new DomainError('grant_revoked', 'revoked', 403);
        return stored;
      },
    });
    const once = await scheduler.create(owner(), {
      name: 'Once', prompt: 'Run once', nextAt: new Date(now).toISOString(), enabled: true,
      settings: automationSettings(source.id),
    });
    await scheduler.reconcile();
    const failed = (await store.get<AutomationSchedule>('automation_schedule', once.id, owner().id))!;
    assert.equal(failed.data.enabled, false);
    assert.ok(failed.data.authorizationFailedAt);

    revoked = false;
    const enabled = await scheduler.setEnabled(owner(), once.id, failed.revision, true);
    assert.equal(enabled.data.authorizationFailedAt, undefined);
    await scheduler.reconcile();
    assert.equal((await store.scan<Task>('task', owner().id)).length, 0, 'the rejected occurrence is not replayed');
    const occurrences = await store.scan<ScheduleOccurrence>('schedule_occurrence', owner().id);
    assert.deepEqual(occurrences.map((row) => row.data.status), ['rejected']);
    const idle = (await store.get<AutomationSchedule>('automation_schedule', once.id, owner().id))!;
    assert.equal(idle.data.enabled, false);
    assert.equal(idle.data.authorizationFailedAt, undefined);

    await scheduler.update(owner(), once.id, idle.revision, {
      name: 'Once', prompt: 'Run once', nextAt: new Date(now + 1_000).toISOString(), enabled: true,
      settings: automationSettings(source.id),
    });
    now += 1_001;
    await scheduler.reconcile();
    assert.equal((await store.scan<Task>('task', owner().id)).length, 1);
  } finally {
    await tasks.close();
    await store.close();
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx --test --test-name-pattern='one-shot' test/event-triggers.test.ts`

Expected: both tests fail at their second `scheduler.reconcile()` with

```
Error [DomainError]: schedule_occurrence identifier belongs to different data.
  code: 'idempotency_conflict',
  statusCode: 409
```

- [ ] **Step 3: Write minimal implementation**

In `src/scheduler.ts`, in `materializeOccurrence`, replace this one line:

```ts
    await createOrVerify(this.store, 'schedule_occurrence', occurrenceId, schedule.ownerId, occurrence);
```

with:

```ts
    // Create only when absent. An occurrence that already exists for this due time (run, rejected or
    // still pending) is never replaced or replayed; re-enabling a one-shot schedule must not abort reconcile.
    if (!await this.store.get<ScheduleOccurrence>('schedule_occurrence', occurrenceId, schedule.ownerId)) {
      try {
        await this.store.create<ScheduleOccurrence>('schedule_occurrence', schedule.ownerId, occurrence, occurrenceId);
      } catch (error) {
        if (!isConflict(error)) throw error;
      }
    }
```

Leave the rest of the method as it is: it still advances `nextAt` for interval and cron schedules and sets `enabled: false` for a one-shot schedule.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx tsc --noEmit && npx tsx --test test/event-triggers.test.ts test/tasks.test.ts`

Expected: no type errors; all tests pass, `ℹ fail 0`. The existing concurrency guards `schedule freezes agent and model settings, coalesces missed intervals and edits future settings` (two parallel reconciles, one task) and `stale schedule claim reuses the same task instead of replaying a missed external run` still pass.

- [ ] **Step 5: Commit**

```bash
git add src/scheduler.ts test/event-triggers.test.ts
git commit -m "修復：重新啟用已觸發的單次排程不再令排程對帳中止"
```

### Task 5: Enabling a schedule refreshes the stored authorisation (C3)

**Files:**
- Modify: `src/scheduler.ts` (`SchedulerService.setEnabled`, lines 190-196 as of commit 17d571f)
- Test: `test/event-triggers.test.ts` (append at the end of the file)

**Interfaces:**
- Consumes: `automationActor(actor: Principal, unattended: UnattendedAuthorization | undefined, enabled = false): Principal` and `SchedulerOptions.unattended` from Task 3; the create-if-absent occurrence of Task 4; test helpers `sessionOwner(expiresAt, overrides)` and `automationSettings(conversationId)` from Task 3's test block.
- Produces: `SchedulerService.setEnabled(actor: Principal, id: string, expectedRevision: number, enabled: boolean): Promise<Entity<AutomationSchedule>>` — signature unchanged. With `enabled === true` it stores `actor: automationActor(actor, unattended, true)` and clears `authorizationFailedAt`. With `enabled === false` the stored actor and `authorizationFailedAt` are untouched. `version` and `settings` never change. `SchedulerService.update` and `EventTriggerService.update` already replace the actor (Task 3); event triggers have no enable-only route and are re-enabled with the existing `PUT /v1/event-triggers/:id`.

- [ ] **Step 1: Write the failing test**

Append to the end of `test/event-triggers.test.ts`:

```ts
test('enabling a schedule stores the caller as the new actor', async () => {
  const store = new SqliteStore();
  let now = start;
  let revoked = true;
  const tasks = new TaskService(store, async () => ({ text: 'unused' }), { now: () => now });
  try {
    const source = await store.create<Conversation>('conversation', owner().id, baseConversation);
    const reauthorized: Principal[] = [];
    const scheduler = new SchedulerService(store, new AutomationDispatcher(store, tasks, () => now), {
      enabled: true,
      now: () => now,
      unattended: 'durable',
      async reauthorize(stored) {
        reauthorized.push(stored);
        if (revoked) throw new DomainError('grant_revoked', 'revoked', 403);
        return stored;
      },
    });
    const before = sessionOwner(new Date(start + 15 * 60_000).toISOString(), { credentialVersion: 1, applicationId: 'app-a' });
    const created = await scheduler.create(before, {
      name: 'Every minute', prompt: 'Run', nextAt: new Date(now).toISOString(), intervalSeconds: 60, enabled: true,
      settings: automationSettings(source.id),
    });
    await scheduler.reconcile();
    const failed = (await store.get<AutomationSchedule>('automation_schedule', created.id, owner().id))!;
    assert.equal(failed.data.enabled, false);
    assert.equal(failed.data.authorizationFailedAt, new Date(start).toISOString());

    now += 3_600_000;
    const after = sessionOwner(new Date(now + 15 * 60_000).toISOString(), { credentialVersion: 2, applicationId: 'app-b' });
    await assert.rejects(scheduler.setEnabled(after, created.id, failed.revision + 1, true), hasCode('conflict'));
    const stillOff = await scheduler.setEnabled(after, created.id, failed.revision, false);
    assert.equal(stillOff.data.actor.credentialVersion, 1, 'disabling does not touch the stored actor');
    assert.equal(stillOff.data.authorizationFailedAt, failed.data.authorizationFailedAt);

    const enabled = await scheduler.setEnabled(after, created.id, stillOff.revision, true);
    const { expiresAt: _sessionExpiry, ...durable } = after;
    assert.deepEqual(enabled.data.actor, durable);
    assert.equal(enabled.data.enabled, true);
    assert.equal(enabled.data.authorizationFailedAt, undefined);
    assert.equal(enabled.data.version, created.data.version, 'enabling is not an edit');
    assert.equal(enabled.data.settings.fingerprint, created.data.settings.fingerprint);

    revoked = false;
    await scheduler.reconcile();
    const run = await store.scan<Task>('task', owner().id);
    assert.equal(run.length, 1, 'the interval schedule runs again with the refreshed authorisation');
    assert.equal(reauthorized.at(-1)?.credentialVersion, 2);
    assert.equal(reauthorized.at(-1)?.applicationId, 'app-b');
  } finally {
    await tasks.close();
    await store.close();
  }
});

test('without the unattended option enabling stores the calling principal verbatim', async () => {
  const store = new SqliteStore();
  const tasks = new TaskService(store, async () => ({ text: 'unused' }));
  try {
    const source = await store.create<Conversation>('conversation', owner().id, baseConversation);
    const scheduler = new SchedulerService(store, new AutomationDispatcher(store, tasks, () => start), {
      enabled: true, now: () => start,
    });
    const created = await scheduler.create(owner(), {
      name: 'Later', prompt: 'Run', nextAt: new Date(start + 60_000).toISOString(),
      settings: automationSettings(source.id),
    });
    const caller = owner('2026-09-27T05:00:00.000Z');
    const enabled = await scheduler.setEnabled(caller, created.id, created.revision, true);
    assert.deepEqual(enabled.data.actor, caller);
  } finally {
    await tasks.close();
    await store.close();
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx --test --test-name-pattern='enabling' test/event-triggers.test.ts`

Expected: the pattern also selects Task 4's `re-enabling a one-shot schedule…` test, which passes. The two new tests fail:

```
✖ enabling a schedule stores the caller as the new actor
  AssertionError [ERR_ASSERTION]: Expected values to be strictly deep-equal:
  +   applicationId: 'app-a',
  -   applicationId: 'app-b',
  +   credentialVersion: 1,
  -   credentialVersion: 2,
✖ without the unattended option enabling stores the calling principal verbatim
  AssertionError [ERR_ASSERTION]: Expected values to be strictly deep-equal:
  +   expiresAt: '2026-09-27T06:00:00.000Z',
  -   expiresAt: '2026-09-27T05:00:00.000Z',
```

- [ ] **Step 3: Write minimal implementation**

In `src/scheduler.ts`, in `setEnabled`, replace:

```ts
    const current = await this.requireSchedule(actor.id, id);
    if (current.revision !== expectedRevision) throw new DomainError('conflict', 'Schedule changed; reload and retry.', 409);
    return this.store.put('automation_schedule', id, actor.id, {
      ...current.data,
      enabled,
      authorizationFailedAt: enabled ? undefined : current.data.authorizationFailedAt,
    }, expectedRevision);
```

with:

```ts
    const storedActor = enabled ? automationActor(actor, this.options.unattended, true) : undefined;
    const current = await this.requireSchedule(actor.id, id);
    if (current.revision !== expectedRevision) throw new DomainError('conflict', 'Schedule changed; reload and retry.', 409);
    return this.store.put('automation_schedule', id, actor.id, {
      ...current.data,
      enabled,
      ...(storedActor ? { actor: storedActor } : {}),
      authorizationFailedAt: enabled ? undefined : current.data.authorizationFailedAt,
    }, expectedRevision);
```

The `automationActor` call sits after the existing `scheduler_disabled` check and before the schedule is read, the same position as in `create` and `update`.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx tsc --noEmit && npx tsx --test test/event-triggers.test.ts test/tasks.test.ts`

Expected: no type errors; all tests pass, `ℹ fail 0`. The existing HTTP test `automation HTTP routes default disabled, expose a secret once and support full schedule edits` still shows that `PATCH … { enabled: false }` leaves `version` and `settings.fingerprint` unchanged.

- [ ] **Step 5: Commit**

```bash
git add src/scheduler.ts test/event-triggers.test.ts
git commit -m "修復：啟用排程時以目前登入者更新已保存的授權"
```

### Task 6: Event triggers record `authorizationFailedAt` (C4)

**Files:**
- Modify: `src/event-triggers.ts` (`EventTrigger` lines 52-71; `EventTriggerService.update`, the `common` object, lines 423-431; `EventTriggerService.disableTrigger` lines 661-665, all as of commit 17d571f)
- Test: `test/event-triggers.test.ts` (append at the end of the file)

**Interfaces:**
- Consumes: `automationSettings(conversationId)` test helper from Task 3's test block; `EventTriggerService.update` as edited by Task 3 (it contains `actor: storedActor,`).
- Produces: `event_trigger.data.authorizationFailedAt?: string` (ISO timestamp) on both members of the `EventTrigger` union, and therefore on `PublicEventTrigger.data` returned by `GET/POST/PUT /v1/event-triggers`. It is written once, together with `enabled: false`, when a dispatch ends with a code in `permanentAuthorizationCodes`; it is cleared by `EventTriggerService.update`; `rotateSecret` keeps it. Rows without the field (every stored row today) stay valid. Task 7 reads this field.

Background for the implementer: `SchedulerService.disableSchedule` (`src/scheduler.ts`) already does exactly this for schedules; `disableTrigger` becomes its mirror, including the early return when the timestamp is already set (so three failing events in one reconcile leave one timestamp).

- [ ] **Step 1: Write the failing test**

Append to the end of `test/event-triggers.test.ts`:

```ts
test('a permanent authorization failure stamps the trigger once and a transient one does not', async () => {
  const store = new SqliteStore();
  let now = start;
  let answer: 'unavailable' | 'revoked' = 'unavailable';
  const tasks = new TaskService(store, async () => ({ text: 'unused' }), { now: () => now });
  try {
    const source = await store.create<Conversation>('conversation', owner().id, baseConversation);
    const service = new EventTriggerService(store, new AutomationDispatcher(store, tasks, () => now), {
      enabled: true,
      now: () => now,
      async reauthorize() {
        if (answer === 'unavailable') throw new DomainError('identity_unavailable', 'Account authorization check is unavailable', 503);
        now += 1_000; // every refused dispatch happens one second after the previous one
        throw new DomainError('grant_revoked', 'revoked', 403);
      },
    });
    const input = {
      name: 'Hook', prompt: 'Handle', enabled: true, type: 'webhook' as const, filter: {}, settings: automationSettings(source.id),
    };
    const created = await service.create(owner(), input);
    const webhookId = created.trigger.data.webhook!.id;
    for (const eventId of ['event-1', 'event-2', 'event-3']) {
      await service.ingestWebhook(webhookId, created.secret, { eventId, eventName: 'test', payload: {} });
    }

    await service.reconcile();
    const waiting = (await service.list(owner().id))[0]!;
    assert.equal(waiting.data.enabled, true, 'a transient failure never disables a trigger');
    assert.equal(waiting.data.authorizationFailedAt, undefined);
    assert.deepEqual(
      (await store.scan<EventInboxItem>('event_inbox', owner().id)).map((row) => row.data.status),
      ['pending', 'pending', 'pending'],
    );

    answer = 'revoked';
    now += 5_000;
    const firstRefusal = now + 1_000;
    await service.reconcile();
    assert.equal(now, firstRefusal + 2_000, 'all three events were dispatched and refused, one second apart');
    const failed = (await service.list(owner().id))[0]!;
    assert.equal(failed.data.enabled, false);
    assert.equal(failed.data.authorizationFailedAt, new Date(firstRefusal).toISOString(), 'stamped by the first refusal only');
    assert.equal(JSON.stringify(failed).includes('secretHash'), false);
    const rejected = await store.scan<EventInboxItem>('event_inbox', owner().id);
    assert.deepEqual(rejected.map((row) => row.data.status), ['rejected', 'rejected', 'rejected']);
    assert.deepEqual(rejected.map((row) => row.data.rejectionCode), ['grant_revoked', 'grant_revoked', 'grant_revoked']);
    await assert.rejects(
      service.ingestWebhook(webhookId, created.secret, { eventId: 'event-4', eventName: 'test', payload: {} }),
      hasCode('trigger_disabled'),
    );

    const rotated = await service.rotateSecret(owner(), failed.id, failed.revision);
    assert.equal(rotated.trigger.data.authorizationFailedAt, failed.data.authorizationFailedAt, 'rotating the secret is not a recovery');

    const saved = await service.update(owner(), failed.id, rotated.trigger.revision, input);
    assert.equal(saved.data.enabled, true);
    assert.equal(saved.data.authorizationFailedAt, undefined, 'saving the trigger again clears the failure');

    now += 60_000;
    await service.ingestWebhook(webhookId, rotated.secret, { eventId: 'event-5', eventName: 'test', payload: {} });
    await service.reconcile();
    const failedAgain = (await service.list(owner().id))[0]!;
    assert.equal(failedAgain.data.enabled, false);
    assert.equal(failedAgain.data.authorizationFailedAt, new Date(now).toISOString());
    assert.notEqual(failedAgain.data.authorizationFailedAt, failed.data.authorizationFailedAt);
  } finally {
    await tasks.close();
    await store.close();
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx --test --test-name-pattern='stamps the trigger' test/event-triggers.test.ts`

Expected:

```
✖ a permanent authorization failure stamps the trigger once and a transient one does not
  AssertionError [ERR_ASSERTION]: stamped by the first refusal only
  + undefined
  - '2026-09-27T04:00:06.000Z'
```

`npx tsc --noEmit` reports `Property 'authorizationFailedAt' does not exist on type 'Omit<EventTrigger, "webhook"> & …'` until Step 3 is done.

- [ ] **Step 3: Write minimal implementation**

`src/event-triggers.ts`, edit 1 — the entity type. Replace:

```ts
export type EventTrigger = {
  name: string;
  prompt: string;
  enabled: boolean;
  actor: Principal;
  settings: AutomationExecutionSnapshot;
  version: number;
  type: 'webhook';
  filter: WebhookFilter;
  webhook: { id: string; salt: string; secretHash: string };
} | {
  name: string;
  prompt: string;
  enabled: boolean;
  actor: Principal;
  settings: AutomationExecutionSnapshot;
  version: number;
  type: 'device_online';
  filter: DeviceOnlineFilter;
};
```

with:

```ts
export type EventTrigger = {
  name: string;
  prompt: string;
  enabled: boolean;
  actor: Principal;
  settings: AutomationExecutionSnapshot;
  version: number;
  authorizationFailedAt?: string;
  type: 'webhook';
  filter: WebhookFilter;
  webhook: { id: string; salt: string; secretHash: string };
} | {
  name: string;
  prompt: string;
  enabled: boolean;
  actor: Principal;
  settings: AutomationExecutionSnapshot;
  version: number;
  authorizationFailedAt?: string;
  type: 'device_online';
  filter: DeviceOnlineFilter;
};
```

`src/event-triggers.ts`, edit 2 — `EventTriggerService.update`, the end of the `common` object (as left by Task 3). Replace:

```ts
      actor: storedActor,
      settings,
      version: current.data.version + 1,
    };
```

with:

```ts
      actor: storedActor,
      settings,
      version: current.data.version + 1,
      authorizationFailedAt: undefined,
    };
```

`src/event-triggers.ts`, edit 3 — `disableTrigger`. Replace:

```ts
      const trigger = await this.store.get<EventTrigger>('event_trigger', triggerId, ownerId);
      if (!trigger || !trigger.data.enabled) return;
      try {
        await this.store.put('event_trigger', trigger.id, ownerId, { ...trigger.data, enabled: false }, trigger.revision);
        return;
```

with:

```ts
      const trigger = await this.store.get<EventTrigger>('event_trigger', triggerId, ownerId);
      if (!trigger || trigger.data.authorizationFailedAt) return;
      const authorizationFailedAt = new Date(this.now()).toISOString();
      try {
        await this.store.put('event_trigger', trigger.id, ownerId, {
          ...trigger.data,
          enabled: false,
          authorizationFailedAt,
        }, trigger.revision);
        return;
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx tsc --noEmit && npx tsx --test test/event-triggers.test.ts`

Expected: no type errors; all tests pass, `ℹ fail 0`.

- [ ] **Step 5: Commit**

```bash
git add src/event-triggers.ts test/event-triggers.test.ts
git commit -m "實現：事件觸發器記錄授權失效時間"
```

### Task 7: Notification for a trigger authorization failure, with neutral wording (C4)

**Files:**
- Modify: `src/domain.ts` (`Notification`, lines 141-144 as of commit 17d571f)
- Modify: `src/notifications.ts` (`NotificationInput` lines 21-24; `NotificationService.publish`, the `data` object, lines 166-167; `NotificationService.reconcile` lines 411-420; `notificationCopy` line 516; `sameNotificationEvent` lines 583-588, all as of commit 17d571f)
- Test: `test/notifications.test.ts` (append at the end of the file)

**Interfaces:**
- Consumes: `event_trigger.data.authorizationFailedAt?: string` written by Task 6; `event_trigger.data.settings.notification` (existing `NotificationDestination`); `NotificationService.publishTask(ownerId, input, occurredAt, destination)` (existing).
- Produces:
  - `Notification.eventTriggerId?: string` and `NotificationInput.eventTriggerId?: string`.
  - `NotificationService.reconcile()` publishes, for every `event_trigger` row that has `authorizationFailedAt`, one notification `{ type: 'schedule_authorization_failed', eventTriggerId: <trigger id>, dedupeKey: 'event-trigger:<trigger id>:authorization:<authorizationFailedAt>' }` with `occurredAt = authorizationFailedAt`, routed by the trigger's `settings.notification` (`none` publishes nothing). No `scheduleId` on it. The notification type is not new.
  - Default copy of `schedule_authorization_failed` for schedules and triggers alike: title `自動化已暫停`, body `排程或觸發器的授權已失效，請重新登入後再次啟用。`.
  - `publish` no longer treats the default copy as part of an event's identity: `title` and `body` are compared with a stored row only when the caller passed them explicitly. A row stored by an earlier release with the previous default wording is returned unchanged instead of raising `idempotency_conflict`.

Background for the implementer: `reconcile()` runs on every task tick and re-publishes the notification of every schedule that still has `authorizationFailedAt`; `publish` finds the stored row by its dedupe key and compares it with the new input in `sameNotificationEvent`, including `title` and `body`. A deployed database already holds rows with the old wording (`排程已暫停` / `排程授權已失效，請重新登入後啟用。`). Changing the default copy without the change to `sameNotificationEvent` makes `reconcile()` throw `idempotency_conflict` on every tick for those owners. The second test below pins that; do not drop edit 6.

- [ ] **Step 1: Write the failing test**

Append to the end of `test/notifications.test.ts` (every name used is already imported at the top of that file):

```ts
test('a trigger disabled for authorization produces one neutral notification', async () => {
  const store = new SqliteStore();
  const now = new Date('2026-09-27T08:00:00.000Z');
  const notifications = new NotificationService(store, { now: () => now });
  const failedAt = '2026-09-27T07:59:00.000Z';
  const trigger = (destination: unknown, authorizationFailedAt?: string) => ({
    enabled: false,
    ...(authorizationFailedAt ? { authorizationFailedAt } : {}),
    settings: { notification: destination },
  });
  try {
    const failed = await store.create('event_trigger', 'alice', trigger({ type: 'in_app' }, failedAt), 'automation-1');
    await store.create('event_trigger', 'alice', trigger({ type: 'none' }, failedAt), 'muted');
    await store.create('event_trigger', 'alice', trigger({ type: 'push', subscriptionId: 'subscription-1' }, failedAt), 'pushed');
    await store.create('event_trigger', 'alice', trigger({ type: 'in_app' }), 'disabled-by-owner');

    await notifications.reconcile();
    await Promise.all([notifications.reconcile(), notifications.reconcile()]);

    const rows = await store.scan<Notification>('notification', 'alice');
    assert.equal(rows.length, 2, 'one per failed trigger with a destination; none for a muted or owner-disabled trigger');
    const inApp = rows.find((row) => row.data.eventTriggerId === 'automation-1')!;
    assert.equal(inApp.data.type, 'schedule_authorization_failed');
    assert.equal(inApp.data.scheduleId, undefined);
    assert.equal(inApp.data.occurredAt, failedAt);
    assert.equal(inApp.data.title, '自動化已暫停');
    assert.equal(inApp.data.body, '排程或觸發器的授權已失效，請重新登入後再次啟用。');
    assert.equal(inApp.data.pushEligible, false);
    assert.equal(inApp.data.dedupeKey, `event-trigger:automation-1:authorization:${failedAt}`);
    const pushed = rows.find((row) => row.data.eventTriggerId === 'pushed')!;
    assert.equal(pushed.data.pushEligible, true);
    assert.equal(pushed.data.targetSubscriptionId, 'subscription-1');

    // A schedule with the same id is a different event: separate dedupe namespace.
    await store.create('automation_schedule', 'alice', trigger({ type: 'in_app' }, failedAt), 'automation-1');
    // The owner saved the trigger again and it failed a second time: a new timestamp is a new event.
    const later = '2026-09-27T07:59:30.000Z';
    await store.put('event_trigger', failed.id, 'alice', trigger({ type: 'in_app' }, later), failed.revision);
    await notifications.reconcile();

    const after = await store.scan<Notification>('notification', 'alice');
    assert.equal(after.length, 4);
    assert.equal(after.filter((row) => row.data.eventTriggerId === 'automation-1').length, 2);
    const schedule = after.find((row) => row.data.scheduleId === 'automation-1')!;
    assert.equal(schedule.data.eventTriggerId, undefined);
    assert.equal(schedule.data.title, '自動化已暫停');
  } finally {
    await store.close();
  }
});

test('a schedule notification stored with the previous wording does not break reconcile', async () => {
  const store = new SqliteStore();
  const notifications = new NotificationService(store);
  const failedAt = '2026-09-27T07:59:00.000Z';
  try {
    await store.create('automation_schedule', 'alice', {
      enabled: false, authorizationFailedAt: failedAt, settings: { notification: { type: 'in_app' } },
    }, 'schedule-1');
    // Exactly the row the previous release stored for this failure.
    const legacy = await notifications.publishTask('alice', {
      type: 'schedule_authorization_failed',
      dedupeKey: `schedule:schedule-1:authorization:${failedAt}`,
      scheduleId: 'schedule-1',
      title: '排程已暫停',
      body: '排程授權已失效，請重新登入後啟用。',
    }, new Date(failedAt), { type: 'in_app' });

    await notifications.reconcile();
    await notifications.reconcile();

    assert.deepEqual(await store.scan<Notification>('notification', 'alice'), [legacy]);
  } finally {
    await store.close();
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx --test --test-name-pattern='trigger disabled for authorization|previous wording' test/notifications.test.ts`

Expected:

```
✖ a trigger disabled for authorization produces one neutral notification
  AssertionError [ERR_ASSERTION]: one per failed trigger with a destination; none for a muted or owner-disabled trigger
  0 !== 2
✔ a schedule notification stored with the previous wording does not break reconcile
```

The second test passes before the change and must still pass after it. It fails with `Error [DomainError]: Notification key belongs to another event. code: 'idempotency_conflict'` if edit 5 is applied without edit 6. `npx tsc --noEmit` reports `Property 'eventTriggerId' does not exist on type 'Notification'` until Step 3 is done.

- [ ] **Step 3: Write minimal implementation**

`src/domain.ts`, edit 1 — the end of `interface Notification`. Replace:

```ts
  taskId?: string;
  conversationId?: string;
  scheduleId?: string;
}

export interface NotificationChannelDestination {
```

with:

```ts
  taskId?: string;
  conversationId?: string;
  scheduleId?: string;
  eventTriggerId?: string;
}

export interface NotificationChannelDestination {
```

`src/notifications.ts`, edit 2 — the end of `interface NotificationInput`. Replace:

```ts
  scheduleId?: string;
  title?: string;
  body?: string;
}
```

with:

```ts
  scheduleId?: string;
  eventTriggerId?: string;
  title?: string;
  body?: string;
}
```

`src/notifications.ts`, edit 3 — `publish`, the end of the `data` object. Replace:

```ts
      ...(input.scheduleId ? { scheduleId: input.scheduleId } : {}),
    };
```

with:

```ts
      ...(input.scheduleId ? { scheduleId: input.scheduleId } : {}),
      ...(input.eventTriggerId ? { eventTriggerId: input.eventTriggerId } : {}),
    };
```

`src/notifications.ts`, edit 4 — the end of `reconcile`. Replace:

```ts
    for (const schedule of await this.store.scan<AutomationScheduleNotification>('automation_schedule')) {
      if (!schedule.data.authorizationFailedAt) continue;
      await this.publishTask(schedule.ownerId, {
        type: 'schedule_authorization_failed',
        dedupeKey: `schedule:${schedule.id}:authorization:${schedule.data.authorizationFailedAt}`,
        scheduleId: schedule.id,
      }, new Date(schedule.data.authorizationFailedAt), schedule.data.settings.notification);
    }
  }
}
```

with:

```ts
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
}
```

The private interface `AutomationScheduleNotification` (`{ authorizationFailedAt?: string; settings: { notification: NotificationDestination } }`) describes exactly the two fields read from a trigger row, so it is reused as the scan type; do not import `EventTrigger` into this module.

`src/notifications.ts`, edit 5 — `notificationCopy`. Replace:

```ts
    case 'schedule_authorization_failed': return { title: '排程已暫停', body: '排程授權已失效，請重新登入後啟用。' };
```

with:

```ts
    case 'schedule_authorization_failed': return { title: '自動化已暫停', body: '排程或觸發器的授權已失效，請重新登入後再次啟用。' };
```

`src/notifications.ts`, edit 6 — `sameNotificationEvent`. Replace:

```ts
    && existing.title === title
    && existing.body === body
    && existing.taskId === input.taskId
    && existing.conversationId === input.conversationId
    && existing.scheduleId === input.scheduleId
    && existing.pushEligible === delivery.pushEligible
```

with:

```ts
    && (input.title === undefined || existing.title === title)
    && (input.body === undefined || existing.body === body)
    && existing.taskId === input.taskId
    && existing.conversationId === input.conversationId
    && existing.scheduleId === input.scheduleId
    && existing.eventTriggerId === input.eventTriggerId
    && existing.pushEligible === delivery.pushEligible
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx tsc --noEmit && npx tsx --test test/notifications.test.ts test/tasks.test.ts`

Expected: no type errors; all tests pass, `ℹ fail 0`. This includes the existing `scheduled work revalidates authorization and quiet time silences its notification` test in `test/tasks.test.ts` (it asserts one `schedule_authorization_failed` row for a failed schedule) and the two `idempotency_conflict` assertions in `test/notifications.test.ts` (a different destination, a different `occurredAt`), which do not depend on the copy.

- [ ] **Step 5: Commit**

```bash
git add src/domain.ts src/notifications.ts test/notifications.test.ts
git commit -m "實現：事件觸發器授權失效時發出通知，文案改為同時適用排程與觸發器"
```

### Task 8: OIDC mode refuses to save or enable an automation (C5)

**Files:**
- Modify: `src/event-triggers.ts` (`automationActor`, the function added by Task 3 directly above `class AutomationDispatcher`)
- Test: `test/event-triggers.test.ts` (append at the end of the file)

**Interfaces:**
- Consumes: `automationActor(actor: Principal, unattended: UnattendedAuthorization | undefined, enabled = false): Principal`, `SchedulerOptions.unattended` and `EventTriggerOptions.unattended` from Task 3; the call sites written by Tasks 3 and 5 (`create`, `update` and `setEnabled` call `automationActor(actor, this.options.unattended, <enabled>)` after the existing `scheduler_disabled` / `event_triggers_disabled` check and before any snapshot or store write; the two dispatch call sites omit the third argument); test helper `automationSettings(conversationId)` from Task 3's test block.
- Produces: with `unattended: 'unsupported'`, `SchedulerService.create`, `SchedulerService.update`, `SchedulerService.setEnabled(…, true)`, `EventTriggerService.create` and `EventTriggerService.update` reject with `DomainError('unattended_automation_unsupported', <message>, 503)` when the automation would be enabled, before anything is stored. Saving with `enabled: false`, `setEnabled(…, false)`, `list`, `listDrafts`, `removeDraft`, `remove` and `rotateSecret` work and store the calling principal unchanged. Dispatch is not affected by this mode: an automation that is already enabled keeps today's path (it is rejected with `actor_expired` and disabled once the stored session has expired). The HTTP layer needs no change: the error handler of `createServer` already renders a `DomainError` as `{ error: { code, message } }` with its status code. Task 12 wires the mode and pins the HTTP response.

Background for the implementer: OIDC access tokens are short-lived and the server keeps them only in process memory, so it has no way to revalidate an automation while nobody is signed in. The spec decides not to build a token store. Refusing at save time replaces today's behaviour, where the automation is accepted and then disabled at its first dispatch after the token expired. The status follows the existing `scheduler_disabled` precedent (503).

- [ ] **Step 1: Write the failing test**

Append to the end of `test/event-triggers.test.ts` (`AgentProfile`, `ScheduleOccurrence` and every other name used are already imported at the top of that file):

```ts
test('unsupported mode refuses to save or enable an automation but keeps drafts, listing and deletion', async () => {
  const store = new SqliteStore();
  let now = start;
  const tasks = new TaskService(store, async () => ({ text: 'unused' }), { now: () => now });
  const unsupported = (error: unknown): boolean => error instanceof DomainError
    && error.code === 'unattended_automation_unsupported' && error.statusCode === 503;
  try {
    const agent = await store.create<AgentProfile>('agent', owner().id, {
      systemPrompt: 'Policy', strategy: 'single', modelPolicy: 'cloud', experts: [], candidateCount: 1,
    });
    const source = await store.create<Conversation>('conversation', owner().id, { ...baseConversation, agentId: agent.id });
    const dispatcher = new AutomationDispatcher(store, tasks, () => now);
    const reauthorize = async (): Promise<Principal> => { throw new DomainError('unauthorized', 'Sign in to continue', 401); };
    const scheduler = new SchedulerService(store, dispatcher, { enabled: true, now: () => now, unattended: 'unsupported', reauthorize });
    const triggers = new EventTriggerService(store, dispatcher, { enabled: true, now: () => now, unattended: 'unsupported', reauthorize });
    const schedule = (enabled: boolean) => ({
      name: 'Daily', prompt: 'Run', nextAt: new Date(start + 60_000).toISOString(), intervalSeconds: 86_400, enabled,
      settings: automationSettings(source.id),
    });
    const webhook = (enabled: boolean) => ({
      name: 'Hook', prompt: 'Handle', enabled, type: 'webhook' as const, filter: {}, settings: automationSettings(source.id),
    });
    const caller = owner();

    await assert.rejects(scheduler.create(caller, schedule(true)), unsupported);
    await assert.rejects(triggers.create(caller, webhook(true)), unsupported);
    await assert.rejects(triggers.create(caller, {
      name: 'Mac online', prompt: 'Check', enabled: true, type: 'device_online', filter: {}, settings: automationSettings(source.id),
    }), unsupported);
    assert.equal((await store.scan('automation_schedule')).length, 0);
    assert.equal((await store.scan('event_trigger')).length, 0);
    assert.equal((await store.scan('agent', owner().id)).length, 1, 'no agent snapshot is frozen for a refused save');

    const draft = await scheduler.create(caller, schedule(false));
    assert.equal(draft.data.enabled, false);
    assert.deepEqual(draft.data.actor, caller, 'the actor is stored as given, session expiry included');
    const created = await triggers.create(caller, webhook(false));
    assert.equal(created.trigger.data.enabled, false);
    assert.deepEqual(created.trigger.data.actor, caller);

    await assert.rejects(scheduler.setEnabled(caller, draft.id, draft.revision, true), unsupported);
    await assert.rejects(scheduler.update(caller, draft.id, draft.revision, schedule(true)), unsupported);
    await assert.rejects(triggers.update(caller, created.trigger.id, created.trigger.revision, webhook(true)), unsupported);
    assert.equal((await scheduler.list(owner().id))[0]?.revision, draft.revision);
    assert.equal((await triggers.list(owner().id))[0]?.revision, created.trigger.revision);

    const edited = await scheduler.update(caller, draft.id, draft.revision, { ...schedule(false), name: 'Renamed' });
    assert.equal(edited.data.name, 'Renamed');
    const stillOff = await scheduler.setEnabled(caller, draft.id, edited.revision, false);
    const renamed = await triggers.update(caller, created.trigger.id, created.trigger.revision, { ...webhook(false), name: 'Renamed' });
    const rotated = await triggers.rotateSecret(caller, renamed.id, renamed.revision);
    await scheduler.remove(caller, draft.id, stillOff.revision);
    await triggers.remove(caller, rotated.trigger.id, rotated.trigger.revision);
    assert.equal((await scheduler.list(owner().id)).length, 0);
    assert.equal((await triggers.list(owner().id)).length, 0);

    // When the server switch is off as well, the existing error wins.
    const off = new SchedulerService(store, dispatcher, { now: () => now, unattended: 'unsupported' });
    await assert.rejects(off.create(caller, schedule(true)), hasCode('scheduler_disabled'));
    const triggersOff = new EventTriggerService(store, dispatcher, { now: () => now, unattended: 'unsupported' });
    await assert.rejects(triggersOff.create(caller, webhook(true)), hasCode('event_triggers_disabled'));
  } finally {
    await tasks.close();
    await store.close();
  }
});

test('unsupported mode leaves an automation that is already enabled on its existing dispatch path', async () => {
  const store = new SqliteStore();
  let now = start;
  const tasks = new TaskService(store, async () => ({ text: 'unused' }), { now: () => now });
  try {
    const source = await store.create<Conversation>('conversation', owner().id, baseConversation);
    const dispatcher = new AutomationDispatcher(store, tasks, () => now);
    const reauthorize = async (stored: Principal): Promise<Principal> => stored;
    const sessionExpiry = new Date(start + 15 * 60_000).toISOString();
    // Enabled by an earlier release, which had no `unattended` option.
    const before = new SchedulerService(store, dispatcher, { enabled: true, now: () => now, reauthorize });
    const first = await before.create(owner(sessionExpiry), {
      name: 'Every ten minutes', prompt: 'Run', nextAt: new Date(start + 600_000).toISOString(), intervalSeconds: 600, enabled: true,
      settings: automationSettings(source.id),
    });
    const scheduler = new SchedulerService(store, dispatcher, { enabled: true, now: () => now, unattended: 'unsupported', reauthorize });

    now = start + 600_000;
    await scheduler.reconcile();
    assert.equal((await store.scan<Task>('task', owner().id)).length, 1, 'it runs while the stored session is still valid');

    now = start + 1_200_000;
    await scheduler.reconcile();
    assert.equal((await store.scan<Task>('task', owner().id)).length, 1);
    const expired = (await store.get<AutomationSchedule>('automation_schedule', first.id, owner().id))!;
    assert.equal(expired.data.enabled, false);
    assert.equal(expired.data.authorizationFailedAt, new Date(now).toISOString());
    const occurrences = await store.scan<ScheduleOccurrence>('schedule_occurrence', owner().id);
    assert.deepEqual(occurrences.map((row) => row.data.rejectionCode).filter(Boolean), ['actor_expired']);
  } finally {
    await tasks.close();
    await store.close();
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx --test --test-name-pattern='unsupported mode' test/event-triggers.test.ts`

Expected:

```
✖ unsupported mode refuses to save or enable an automation but keeps drafts, listing and deletion
  AssertionError [ERR_ASSERTION]: Missing expected rejection (unsupported).
✔ unsupported mode leaves an automation that is already enabled on its existing dispatch path
```

The second test passes already; it guards the dispatch path while the helper changes.

- [ ] **Step 3: Write minimal implementation**

In `src/event-triggers.ts` replace the head of `automationActor` (written in Task 3):

```ts
/**
 * The actor an automation stores (save) or hands to the dispatcher (dispatch).
 * In durable mode the session expiry is dropped: the key is removed, not set to undefined.
 * `enabled` is true when the caller is saving an enabled automation; dispatch leaves it false.
 * It has no effect in durable mode.
 */
export function automationActor(
  actor: Principal,
  unattended: UnattendedAuthorization | undefined,
  enabled = false,
): Principal {
  if (unattended !== 'durable') return actor;
```

with:

```ts
/**
 * The actor an automation stores (save) or hands to the dispatcher (dispatch).
 * In durable mode the session expiry is dropped: the key is removed, not set to undefined.
 * `enabled` is true when the caller is saving an enabled automation; dispatch leaves it false.
 * In unsupported mode saving an enabled automation is refused; a disabled one is stored as given.
 */
export function automationActor(
  actor: Principal,
  unattended: UnattendedAuthorization | undefined,
  enabled = false,
): Principal {
  if (unattended === 'unsupported' && enabled) {
    throw new DomainError(
      'unattended_automation_unsupported',
      'This server signs in with OIDC and cannot keep an automation authorised while nobody is signed in. Save it disabled, or use account sign-in to run automations unattended.',
      503,
    );
  }
  if (unattended !== 'durable') return actor;
```

The two lines that follow (`const { expiresAt: _expiresAt, ...durable } = actor;` and `return durable;`) stay. No call site changes: every save path already passes its `enabled` flag, and the dispatch paths pass none, so dispatch never throws this error.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx tsc --noEmit && npx tsx --test test/event-triggers.test.ts`

Expected: no type errors; all tests pass, `ℹ fail 0`.

- [ ] **Step 5: Commit**

```bash
git add src/event-triggers.ts test/event-triggers.test.ts
git commit -m "實現：OIDC 模式拒絕儲存或啟用無人值守的排程與觸發器"
```

### Task 9: A durable task is not paused by the one-hour grant (C1)

**Files:**
- Modify: `src/tasks.ts` (`TaskServiceOptions` lines 31-33; `TaskService.execute`, the first statements of its `try` block, lines 674-690 as of commit 17d571f)
- Test: `test/tasks.test.ts` (append at the end of the file)

**Interfaces:**
- Consumes: `TaskServiceOptions.reauthorize` (existing); the `identity_unavailable` re-queue branch of Task 2; module-private `renewedGrantExpiry(principal: Principal, now: number): string` and `revalidatedPrincipal(granted, current, ownerId)` in `src/tasks.ts` (existing, unchanged).
- Produces:
  - `TaskServiceOptions.durableGrants?: boolean`. Absent or `false`: behaviour is exactly as before.
  - With `durableGrants: true` and a `reauthorize` hook, a task whose `principal.expiresAt` is `undefined` (a durable task) is no longer stopped with `grant_expired` when `grantExpiresAt` has passed at the start of `execute`. It is revalidated through `reauthorize`; when that succeeds `task.data.grantExpiresAt` becomes `now + 1 h` in the same store write that already saves the revalidated principal. When revalidation throws, nothing is renewed and the existing branches apply (a pause code pauses, `identity_unavailable` re-queues).
  - A grant that has not lapsed is never rewritten. A task whose principal has `expiresAt` (every interactive task in account mode) is unchanged.
  - Task 10 uses the option name `durableGrants`; Task 12 sets it from `AccessService.unattendedAuthorization()`.

Background for the implementer: `grantExpiresAt` is written at `enqueue` and at `control('resume')` as `min(now + 1 h, principal.expiresAt)` and is read in exactly two places: the check at the start of `execute`, and `AgentCoordinator.prepareChildren` (`src/agents/coordinator.ts`), which copies the parent's value into each child and later compares it when it re-creates children idempotently after a crash. A task started by a schedule or trigger that is claimed more than an hour after it was enqueued (device offline, children running long, crash recovery, a long identity-service outage) is paused today with `Task authorization expired; resume from a signed-in client`, which defeats unattended operation. The spec says the grant is renewed after a successful revalidation. The renewal is written only when the grant has lapsed, because that is the only moment it is enforced, and because rewriting it at every model call would change the value the coordinator compares.

- [ ] **Step 1: Write the failing test**

Append to the end of `test/tasks.test.ts` (all names used are already imported or defined at the top of that file):

```ts
/** A principal as a durable automation stores it in account mode: identity fields, no session expiry. */
const durablePrincipal: Principal = {
  id: 'alice',
  issuer: 'https://identity.example.test',
  subject: `acct_${'a'.repeat(32)}`,
  level: 1,
  scopes: ['model:read'],
  applicationId: 'kiancode',
  audience: 'kiancode',
  credentialVersion: 3,
};

test('a durable task is not paused when its one-hour grant lapses: it is revalidated and the grant is renewed', async () => {
  const store = new SqliteStore();
  let now = Date.parse('2026-09-27T04:00:00.000Z');
  let answer: 'valid' | 'unavailable' | 'revoked' = 'unavailable';
  let runs = 0;
  const reauthorized: Principal[] = [];
  const service = new TaskService(store, async () => {
    runs += 1;
    return { text: 'done' };
  }, {
    now: () => now,
    durableGrants: true,
    async reauthorize(current) {
      reauthorized.push(current);
      if (answer === 'unavailable') throw new DomainError('identity_unavailable', 'Account authorization check is unavailable', 503);
      if (answer === 'revoked') throw new DomainError('grant_revoked', 'Task authorization has expired or been revoked', 403);
      return { ...current, scopes: ['*'] };
    },
  });
  try {
    const thread = await store.create('conversation', durablePrincipal.id, conversation);
    const task = await service.enqueue(durablePrincipal, thread.id, 'unattended');
    const granted = new Date(now + 3_600_000).toISOString();
    assert.equal(task.data.grantExpiresAt, granted);

    // Claimed three hours later while the identity service is down: it waits, it is not paused.
    now += 3 * 3_600_000;
    await service.drain();
    const waiting = (await store.get<Task>('task', task.id, durablePrincipal.id))!;
    assert.equal(waiting.data.state, 'queued');
    assert.equal(waiting.data.grantExpiresAt, granted, 'a failed revalidation renews nothing');
    assert.equal(runs, 0);

    now += 30_001;
    answer = 'valid';
    await service.drain();
    const done = (await store.get<Task>('task', task.id, durablePrincipal.id))!;
    assert.equal(done.data.state, 'completed');
    assert.equal(runs, 1);
    assert.equal(done.data.grantExpiresAt, new Date(now + 3_600_000).toISOString());
    assert.equal('expiresAt' in done.data.principal, false);
    assert.deepEqual(done.data.principal.scopes, ['model:read'], 'the task keeps its own scope ceiling');
    assert.ok(reauthorized.every((principal) => !('expiresAt' in principal)));

    // An explicit denial after the grant lapsed still pauses the task.
    const second = await service.enqueue(durablePrincipal, thread.id, 'unattended again');
    now += 2 * 3_600_000;
    answer = 'revoked';
    await service.drain();
    const paused = (await store.get<Task>('task', second.id, durablePrincipal.id))!;
    assert.equal(paused.data.state, 'paused');
    assert.match(paused.data.error ?? '', /expired or been revoked/);
    assert.equal(runs, 1);
  } finally { await service.close(); await store.close(); }
});

test('a grant that has not lapsed is left untouched, and only durable tasks outlive it', async () => {
  let now = Date.parse('2026-09-27T04:00:00.000Z');
  const reauthorize = async (current: Principal): Promise<Principal> => current;
  /** Enqueues one task, lets `elapsedMs` pass, drains, and returns the task as enqueued and as stored afterwards. */
  const runAfter = async (options: { durableGrants?: boolean }, taskPrincipal: Principal, elapsedMs: number) => {
    const store = new SqliteStore();
    const service = new TaskService(store, async () => ({ text: 'done' }), { now: () => now, reauthorize, ...options });
    try {
      const thread = await store.create('conversation', taskPrincipal.id, conversation);
      const enqueued = await service.enqueue(taskPrincipal, thread.id, 'work');
      now += elapsedMs;
      await service.drain();
      return { enqueued, stored: (await store.get<Task>('task', enqueued.id, taskPrincipal.id))! };
    } finally { await service.close(); await store.close(); }
  };

  const quick = await runAfter({ durableGrants: true }, durablePrincipal, 60_000);
  assert.equal(quick.stored.data.state, 'completed');
  assert.equal(quick.stored.data.grantExpiresAt, quick.enqueued.data.grantExpiresAt, 'the stored grant only changes once it has lapsed');

  // An interactive task (its principal carries a session expiry) is still paused, with the option on.
  const session = { ...durablePrincipal, expiresAt: new Date(now + 5 * 3_600_000).toISOString() };
  const interactive = await runAfter({ durableGrants: true }, session, 3_600_001);
  assert.equal(interactive.stored.data.state, 'paused');
  assert.match(interactive.stored.data.error ?? '', /authorization expired/);

  // Without the option (development mode, embedders) a principal without expiresAt is paused as before.
  const standard = await runAfter({}, durablePrincipal, 3_600_001);
  assert.equal(standard.stored.data.state, 'paused');
  assert.match(standard.stored.data.error ?? '', /authorization expired/);
  assert.equal(standard.stored.data.grantExpiresAt, standard.enqueued.data.grantExpiresAt);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx --test --test-name-pattern='one-hour grant lapses|has not lapsed' test/tasks.test.ts`

Expected (`tsx` does not type-check, so the unknown `durableGrants` option is ignored at run time):

```
✖ a durable task is not paused when its one-hour grant lapses: it is revalidated and the grant is renewed
  AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:
  'paused' !== 'queued'
✔ a grant that has not lapsed is left untouched, and only durable tasks outlive it
```

The second test passes already; it guards the three paths that must not change. `npx tsc --noEmit` reports `'durableGrants' does not exist in type 'TaskServiceOptions'` until Step 3 is done.

- [ ] **Step 3: Write minimal implementation**

`src/tasks.ts`, edit 1 — `TaskServiceOptions`. Replace:

```ts
  onError?: (error: unknown) => void;
  reauthorize?: (principal: Principal) => Promise<Principal>;
  isQuietTime?: (ownerId: string, at: Date) => boolean | Promise<boolean>;
```

with:

```ts
  onError?: (error: unknown) => void;
  reauthorize?: (principal: Principal) => Promise<Principal>;
  /**
   * Account mode. A task whose principal carries no session expiry (started by a schedule or an event
   * trigger) is not paused when its one-hour grant has lapsed: it is revalidated through `reauthorize`
   * and, when that succeeds, the grant is renewed. Absent or false: every task is paused, as before.
   */
  durableGrants?: boolean;
  isQuietTime?: (ownerId: string, at: Date) => boolean | Promise<boolean>;
```

`src/tasks.ts`, edit 2 — the start of the `try` block in `execute`. Replace:

```ts
      if (Date.parse(task.data.grantExpiresAt) <= this.now()) {
        throw new DomainError('grant_expired', 'Task authorization expired; resume from a signed-in client', 403);
      }
      let executionTask = task;
      if (this.options.reauthorize) {
        const principal = revalidatedPrincipal(
          task.data.principal,
          await this.options.reauthorize(task.data.principal),
          task.ownerId,
        );
        executionTask = await this.change(task.ownerId, task.id, (current) => {
          if (current.state !== 'running' || current.workerId !== this.workerId) {
            throw new DomainError('lease_lost', 'Execution lease lost', 409);
          }
          return { ...current, principal };
        });
      }
```

with:

```ts
      const grantLapsed = Date.parse(task.data.grantExpiresAt) <= this.now();
      const durable = this.options.durableGrants === true
        && this.options.reauthorize !== undefined
        && task.data.principal.expiresAt === undefined;
      if (grantLapsed && !durable) {
        throw new DomainError('grant_expired', 'Task authorization expired; resume from a signed-in client', 403);
      }
      let executionTask = task;
      if (this.options.reauthorize) {
        const principal = revalidatedPrincipal(
          task.data.principal,
          await this.options.reauthorize(task.data.principal),
          task.ownerId,
        );
        executionTask = await this.change(task.ownerId, task.id, (current) => {
          if (current.state !== 'running' || current.workerId !== this.workerId) {
            throw new DomainError('lease_lost', 'Execution lease lost', 409);
          }
          return {
            ...current,
            principal,
            // Only a lapsed grant is rewritten. The agent coordinator compares a child's stored grant with
            // its parent's when it re-creates children idempotently, so the value must not move at every step.
            ...(grantLapsed ? { grantExpiresAt: renewedGrantExpiry(principal, this.now()) } : {}),
          };
        });
      }
```

Do not touch the second revalidation site (the `DurableRuntimeEventStream` callback at the top of `execute`, which runs for `model_call` and `tool_dispatched`): it keeps writing `{ ...current, principal }` only.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx tsc --noEmit && npx tsx --test test/tasks.test.ts test/agents-coordinator.test.ts`

Expected: no type errors; all tests pass, `ℹ fail 0`. The existing test `an expired grant pauses and resumes with the current signed-in principal` (no option) still pauses.

- [ ] **Step 5: Commit**

```bash
git add src/tasks.ts test/tasks.test.ts
git commit -m "實現：持久授權的任務在一小時授權到期後重新驗證並續期，不再暫停"
```

### Task 10: Resuming a durable task keeps it durable (C1 follow-through)

**Files:**
- Modify: `src/tasks.ts` (`TaskService.control`, line 454; module-private `resumedPrincipal`, lines 989-993, as of commit 17d571f)
- Test: `test/tasks.test.ts` (append at the end of the file)

**Interfaces:**
- Consumes: `TaskServiceOptions.durableGrants?: boolean` from Task 9; test fixture `durablePrincipal` defined in Task 9's test block of `test/tasks.test.ts`; `TaskService.control(ownerId: string, id: string, action: 'pause' | 'resume' | 'cancel', hashes: string[] = [], actor?: Principal): Promise<Entity<Task>>` (existing signature, unchanged); module-private `revalidatedPrincipal(granted: Principal, current: Principal, ownerId: string): Principal` (existing: throws `unauthorized` 401 when id, issuer or subject differ, `grant_revoked` 403 when `current.scopes` no longer cover `granted.scopes`, and returns `current` with `granted.scopes`).
- Produces: with `durableGrants: true`, `control(…, 'resume', hashes, actor)` on a task whose `principal.expiresAt` is `undefined`, called with an `actor` that has `expiresAt`, stores `revalidatedPrincipal(task.principal, actor, task.principal.id)` without the `expiresAt` key: the task keeps its own scopes and stays durable, and takes `credentialVersion`, `applicationId` and `level` from the actor. `grantExpiresAt` becomes `now + 1 h` through the existing `renewedGrantExpiry`. Every other combination (option off, task principal with `expiresAt`, actor without `expiresAt`, no actor) is unchanged. No HTTP change: `POST /v1/tasks/:id/control` and `POST /v1/tasks/:id/approve` already pass the signed-in principal as `actor`.

Background for the implementer: today a resumed non-orchestration task simply takes the signed-in principal, scopes included. For a task started by an automation that means two things after the owner approves an action or resumes it from a client: the task's scopes widen from the automation's `settings.permissions` to everything the owner holds, and the task becomes bound to that sign-in session, so it is paused again with `grant_revoked` when the session ends (about fifteen minutes in account mode). Both contradict C1. This branch is not named in the spec's section C; it is the consequence of "a saved schedule or trigger stores the actor without `expiresAt`" for the one path that replaces a task's principal.

- [ ] **Step 1: Write the failing test**

Append to the end of `test/tasks.test.ts`:

```ts
test('resuming a durable task keeps it durable and inside its own scope ceiling', async () => {
  const store = new SqliteStore();
  let now = Date.parse('2026-09-27T04:00:00.000Z');
  let runs = 0;
  const service = new TaskService(store, async () => {
    runs += 1;
    return { text: 'done' };
  }, {
    now: () => now,
    durableGrants: true,
    reauthorize: async (current) => ({ ...current, scopes: ['*'] }),
  });
  const rejectedWith = (code: string, statusCode: number) => (error: unknown): boolean => error instanceof DomainError
    && error.code === code && error.statusCode === statusCode;
  try {
    const thread = await store.create('conversation', durablePrincipal.id, conversation);
    const task = await service.enqueue(durablePrincipal, thread.id, 'needs the owner');
    await service.control(durablePrincipal.id, task.id, 'pause');
    /** The owner signed in on a client: full scopes, a newer credential version, a session that ends in one minute. */
    const session = (overrides: Partial<Principal> = {}): Principal => ({
      ...durablePrincipal, scopes: ['*'], credentialVersion: 4, expiresAt: new Date(now + 60_000).toISOString(), ...overrides,
    });

    await assert.rejects(
      service.control(durablePrincipal.id, task.id, 'resume', [], session({ scopes: ['chat:read'] })),
      rejectedWith('grant_revoked', 403),
    );
    await assert.rejects(
      service.control(durablePrincipal.id, task.id, 'resume', [], session({ subject: `acct_${'b'.repeat(32)}` })),
      rejectedWith('unauthorized', 401),
    );
    await assert.rejects(
      service.control(durablePrincipal.id, task.id, 'resume', [], session({ expiresAt: new Date(now - 1).toISOString() })),
      rejectedWith('unauthorized', 401),
    );
    const untouched = (await store.get<Task>('task', task.id, durablePrincipal.id))!;
    assert.equal(untouched.data.state, 'paused');
    assert.deepEqual(untouched.data.principal, durablePrincipal);

    const resumed = await service.control(durablePrincipal.id, task.id, 'resume', [], session());
    assert.equal(resumed.data.state, 'queued');
    assert.equal('expiresAt' in resumed.data.principal, false, 'the task does not become bound to the approving session');
    assert.deepEqual(resumed.data.principal.scopes, ['model:read'], 'the task keeps its own scope ceiling');
    assert.equal(resumed.data.principal.credentialVersion, 4, 'the current credential version is taken from the signed-in owner');
    assert.equal(resumed.data.grantExpiresAt, new Date(now + 3_600_000).toISOString());

    now += 2 * 3_600_000;
    await service.drain();
    assert.equal((await store.get<Task>('task', task.id, durablePrincipal.id))?.data.state, 'completed');
    assert.equal(runs, 1);
  } finally { await service.close(); await store.close(); }
});

test('without durable grants a resumed task takes the signed-in principal as before', async () => {
  const store = new SqliteStore();
  const now = Date.parse('2026-09-27T04:00:00.000Z');
  const service = new TaskService(store, async () => ({ text: 'done' }), { now: () => now, reauthorize: async (current) => current });
  try {
    const thread = await store.create('conversation', durablePrincipal.id, conversation);
    const task = await service.enqueue(durablePrincipal, thread.id, 'paused');
    await service.control(durablePrincipal.id, task.id, 'pause');
    const actor: Principal = { ...durablePrincipal, scopes: ['*'], expiresAt: new Date(now + 60_000).toISOString() };
    const resumed = await service.control(durablePrincipal.id, task.id, 'resume', [], actor);
    assert.deepEqual(resumed.data.principal, actor);
    assert.equal(resumed.data.grantExpiresAt, actor.expiresAt);
  } finally { await service.close(); await store.close(); }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx --test --test-name-pattern='resuming a durable task|without durable grants' test/tasks.test.ts`

Expected:

```
✖ resuming a durable task keeps it durable and inside its own scope ceiling
  AssertionError [ERR_ASSERTION]: Missing expected rejection.
✔ without durable grants a resumed task takes the signed-in principal as before
```

The first test fails at its first `assert.rejects`: today an actor holding only `chat:read` resumes the task. The second test passes already; it guards the default path.

- [ ] **Step 3: Write minimal implementation**

`src/tasks.ts`, edit 1 — in `control`, inside the `this.change` callback. Replace:

```ts
      const principal = actor ? resumedPrincipal(task, actor, this.now()) : task.principal;
```

with:

```ts
      const principal = actor
        ? resumedPrincipal(task, actor, this.now(), this.options.durableGrants === true)
        : task.principal;
```

`src/tasks.ts`, edit 2 — the head of the module-private function `resumedPrincipal`. Replace:

```ts
function resumedPrincipal(task: Task, actor: Principal, now: number): Principal {
  if (actor.expiresAt && (!Number.isFinite(Date.parse(actor.expiresAt)) || Date.parse(actor.expiresAt) <= now)) {
    throw new DomainError('unauthorized', 'The signed-in session has expired', 401);
  }
  if (!task.orchestration) return { ...actor, scopes: [...actor.scopes] };
```

with:

```ts
function resumedPrincipal(task: Task, actor: Principal, now: number, durableGrants: boolean): Principal {
  if (actor.expiresAt && (!Number.isFinite(Date.parse(actor.expiresAt)) || Date.parse(actor.expiresAt) <= now)) {
    throw new DomainError('unauthorized', 'The signed-in session has expired', 401);
  }
  if (durableGrants && task.principal.expiresAt === undefined && actor.expiresAt !== undefined) {
    // A durable task resumed from a signed-in client stays durable and keeps its own scope ceiling.
    // The signed-in owner proves ownership and supplies the current credential version.
    const { expiresAt: _sessionExpiry, ...durable } = revalidatedPrincipal(task.principal, actor, task.principal.id);
    return durable;
  }
  if (!task.orchestration) return { ...actor, scopes: [...actor.scopes] };
```

The last line of the function (`return revalidatedPrincipal(task.principal, actor, task.principal.id);`) stays. `resumedPrincipal` has exactly one caller, the one changed in edit 1.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx tsc --noEmit && npx tsx --test test/tasks.test.ts test/agents-coordinator.test.ts test/api.test.ts`

Expected: no type errors; all tests pass, `ℹ fail 0`. The existing tests `an expired grant pauses and resumes with the current signed-in principal` and `approval resumes from the persisted runtime checkpoint` (no option) are unchanged.

- [ ] **Step 5: Commit**

```bash
git add src/tasks.ts test/tasks.test.ts
git commit -m "修復：從已登入用戶端恢復持久授權任務時保留其權限上限與持久性"
```

### Task 11: A retried dispatch failure is reported, not silent (C2)

**Files:**
- Modify: `src/event-triggers.ts` (`EventTriggerOptions`, as edited by Task 3; `EventTriggerService.reconcileItem`, the last line of its `catch` block, line 584 as of commit 17d571f)
- Modify: `src/scheduler.ts` (`SchedulerOptions`, as edited by Task 3; `SchedulerService.reconcileOccurrence`, the last line of its `catch` block, line 320 as of commit 17d571f)
- Test: `test/event-triggers.test.ts` (append at the end of the file)

**Interfaces:**
- Consumes: `EventTriggerOptions.unattended` / `SchedulerOptions.unattended` lines added by Task 3 (used only as text anchors); test helper `automationSettings(conversationId)` from Task 3's test block; `DomainError('identity_unavailable', …, 503)` as thrown by Task 1 through the `reauthorize` hook.
- Produces: `SchedulerOptions.onError?: (error: unknown) => void` and `EventTriggerOptions.onError?: (error: unknown) => void`. The hook is called once per dispatch attempt that ends with a code outside `permanentAuthorizationCodes` (the attempt is retried with the existing backoff: 2 s, 4 s, … capped at 5 minutes), after the occurrence or inbox item has been put back to `pending`. It is not called for a permanent code. Task 12 connects both hooks to the server logger.

Background for the implementer: the spec requires a transient authorization failure to be "retried, logged". The retry exists already; the failure is only written to `lastError` on the occurrence or inbox row, so an operator sees nothing while the identity service is down or the core's service credential is wrong. `TaskService` already reports its own retries through `TaskServiceOptions.onError` (Task 2).

- [ ] **Step 1: Write the failing test**

Append to the end of `test/event-triggers.test.ts`:

```ts
test('a transient dispatch failure is reported through onError and retried; a permanent one is not reported there', async () => {
  const store = new SqliteStore();
  let now = start;
  let answer: 'unavailable' | 'broken' | 'valid' | 'revoked' = 'unavailable';
  const tasks = new TaskService(store, async () => ({ text: 'unused' }), { now: () => now });
  try {
    const source = await store.create<Conversation>('conversation', owner().id, baseConversation);
    const dispatcher = new AutomationDispatcher(store, tasks, () => now);
    const reauthorize = async (stored: Principal): Promise<Principal> => {
      if (answer === 'unavailable') throw new DomainError('identity_unavailable', 'Account authorization check is unavailable', 503);
      if (answer === 'broken') throw new Error('connection reset');
      if (answer === 'revoked') throw new DomainError('grant_revoked', 'revoked', 403);
      return stored;
    };
    const reported: Array<{ from: string; error: unknown }> = [];
    const scheduler = new SchedulerService(store, dispatcher, {
      enabled: true, now: () => now, reauthorize, onError: (error) => reported.push({ from: 'schedule', error }),
    });
    const triggers = new EventTriggerService(store, dispatcher, {
      enabled: true, now: () => now, reauthorize, onError: (error) => reported.push({ from: 'trigger', error }),
    });
    const schedule = await scheduler.create(owner(), {
      name: 'Hourly', prompt: 'Run', nextAt: new Date(now).toISOString(), intervalSeconds: 3_600, enabled: true,
      settings: automationSettings(source.id),
    });
    const created = await triggers.create(owner(), {
      name: 'Hook', prompt: 'Handle', enabled: true, type: 'webhook', filter: {}, settings: automationSettings(source.id),
    });
    await triggers.ingestWebhook(created.trigger.data.webhook!.id, created.secret, { eventId: 'event-1', eventName: 'test', payload: {} });

    await scheduler.reconcile();
    await triggers.reconcile();
    assert.deepEqual(reported.map((entry) => entry.from), ['schedule', 'trigger']);
    assert.ok(reported.every((entry) => entry.error instanceof DomainError && entry.error.code === 'identity_unavailable'));
    const occurrence = (await store.scan<ScheduleOccurrence>('schedule_occurrence', owner().id))[0]!;
    assert.equal(occurrence.data.status, 'pending');
    assert.equal(occurrence.data.attempts, 1);
    assert.equal(occurrence.data.availableAt, new Date(now + 2_000).toISOString());
    assert.equal(occurrence.data.lastError, 'Account authorization check is unavailable');

    // Before the retry time nothing is attempted, so nothing more is reported.
    await scheduler.reconcile();
    await triggers.reconcile();
    assert.equal(reported.length, 2);

    // An error that is not a DomainError is transient too.
    now += 2_000;
    answer = 'broken';
    await scheduler.reconcile();
    await triggers.reconcile();
    assert.equal(reported.length, 4);
    assert.equal((reported[2]!.error as Error).message, 'connection reset');
    assert.equal((await store.get<AutomationSchedule>('automation_schedule', schedule.id, owner().id))?.data.enabled, true);
    assert.equal((await triggers.list(owner().id))[0]?.data.enabled, true);

    // The service answers again: one task each, and nothing is reported.
    now += 4_000;
    answer = 'valid';
    await scheduler.reconcile();
    await triggers.reconcile();
    assert.equal((await store.scan<Task>('task', owner().id)).length, 2);
    assert.equal(reported.length, 4);

    // An explicit denial disables the automation and notifies the owner; it is not an operational error.
    now += 3_600_000;
    answer = 'revoked';
    await scheduler.reconcile();
    assert.equal(reported.length, 4);
    assert.equal((await store.get<AutomationSchedule>('automation_schedule', schedule.id, owner().id))?.data.enabled, false);
  } finally {
    await tasks.close();
    await store.close();
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx --test --test-name-pattern='transient dispatch failure is reported' test/event-triggers.test.ts`

Expected:

```
✖ a transient dispatch failure is reported through onError and retried; a permanent one is not reported there
  AssertionError [ERR_ASSERTION]: Expected values to be strictly deep-equal:
  + []
  - [
  -   'schedule',
  -   'trigger'
  - ]
```

`npx tsc --noEmit` reports `'onError' does not exist in type 'SchedulerOptions'` / `'EventTriggerOptions'` until Step 3 is done.

- [ ] **Step 3: Write minimal implementation**

`src/event-triggers.ts`, edit 1 — `EventTriggerOptions`. Replace:

```ts
  unattended?: UnattendedAuthorization;
  reauthorize?: (principal: Principal) => Promise<Principal>;
  validateDeviceConnection?: (edge: DeviceConnectionEdge) => Promise<ValidatedDeviceConnection>;
```

with:

```ts
  unattended?: UnattendedAuthorization;
  reauthorize?: (principal: Principal) => Promise<Principal>;
  /** Receives every dispatch failure that is retried (identity service unavailable, storage, network). */
  onError?: (error: unknown) => void;
  validateDeviceConnection?: (edge: DeviceConnectionEdge) => Promise<ValidatedDeviceConnection>;
```

`src/event-triggers.ts`, edit 2 — the end of the `catch` block in `reconcileItem`. Replace:

```ts
      if (permanent) await this.disableTrigger(claimed.ownerId, claimed.data.triggerId);
```

with:

```ts
      if (permanent) await this.disableTrigger(claimed.ownerId, claimed.data.triggerId);
      else this.options.onError?.(error);
```

`src/scheduler.ts`, edit 1 — `SchedulerOptions`. Replace:

```ts
  unattended?: UnattendedAuthorization;
  reauthorize?: (principal: Principal) => Promise<Principal>;
}
```

with:

```ts
  unattended?: UnattendedAuthorization;
  reauthorize?: (principal: Principal) => Promise<Principal>;
  /** Receives every dispatch failure that is retried (identity service unavailable, storage, network). */
  onError?: (error: unknown) => void;
}
```

`src/scheduler.ts`, edit 2 — the end of the `catch` block in `reconcileOccurrence`. Replace:

```ts
      if (permanent) await this.disableSchedule(claimed.ownerId, claimed.data.scheduleId);
```

with:

```ts
      if (permanent) await this.disableSchedule(claimed.ownerId, claimed.data.scheduleId);
      else this.options.onError?.(error);
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx tsc --noEmit && npx tsx --test test/event-triggers.test.ts`

Expected: no type errors; all tests pass, `ℹ fail 0`.

- [ ] **Step 5: Commit**

```bash
git add src/event-triggers.ts src/scheduler.ts test/event-triggers.test.ts
git commit -m "實現：排程與觸發器重試派發失敗時回報錯誤"
```

### Task 12: Wire the mode from AccessService, pin the behaviour end to end, document it (C1, C2, C5)

**Files:**
- Modify: `src/access.ts` (`AccessService`: new method directly above `authorize`, line 22 as of commit 17d571f)
- Modify: `src/http/server.ts` (`createServer`: the construction of `tasks`, `eventTriggers` and `scheduler`, lines 87-103 as of commit 17d571f)
- Modify: `README.md` (the "Schedules and webhook or device-online triggers" bullet of the Components list, line 68 as of commit 17d571f)
- Create: `test/automation-authorization.test.ts`
- Test: `test/automation-authorization.test.ts`

**Interfaces:**
- Consumes:
  - From plan A: `AccessService` constructor `(store, ownerSubject?, serviceToken?, identityMode = 'account', accountApiUrl?, fetcher = fetch, levelCeilings: LevelCeilings = {})`; `export type LevelCeilings = Partial<Record<2 | 3 | 4 | 5, readonly string[]>>` from `src/access.ts`; `AccessService.authorize` (the configured owner subject gets level 1 and `['*']` without a record; any other principal needs an enabled `access` record, is at least level 2 and is capped by its level ceiling; otherwise `access_required`); `'access_required'` in both `permanentAuthorizationCodes` sets.
  - From this plan: `AccessService.validateDelegation` (Task 1); the `identity_unavailable` re-queue (Task 2); `UnattendedAuthorization`, `SchedulerOptions.unattended`, `EventTriggerOptions.unattended` (Task 3); `event_trigger.data.authorizationFailedAt` (Task 6); `Notification.eventTriggerId` (Task 7); `unattended_automation_unsupported` (Task 8); `TaskServiceOptions.durableGrants` (Task 9); `SchedulerOptions.onError`, `EventTriggerOptions.onError` (Task 11).
  - Existing: `createServer(options: ServerOptions)` returning `{ app, tasks, scheduler, eventTriggers, … }`; its fallback revalidation hook built from `options.access` (`validateDelegation` false → `grant_revoked`, then `authorize`).
- Produces:
  - `AccessService.unattendedAuthorization(): 'durable' | 'unsupported' | undefined` — `'durable'` in account mode, `'unsupported'` in oidc mode, `undefined` in development mode.
  - `createServer` passes that value as `unattended` to `SchedulerService` and `EventTriggerService`, sets `durableGrants: true` on `TaskService` when it is `'durable'`, and connects both automation `onError` hooks to `app.log.warn`. Without `options.access` nothing changes. `ServerOptions` and `src/bootstrap.ts` are not changed: bootstrap already hands its `AccessService` to `createServer`.

Background for the implementer: `src/bootstrap.ts` currently starts the server with `logger: false`, so `app.log.warn` writes nothing until plan F enables the server logger at warn level. The hook is wired here so that plan F only has to switch the logger on.

- [ ] **Step 1: Write the failing test**

Create `test/automation-authorization.test.ts` with exactly this content:

```ts
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { AccessService, type AccessGrant, type LevelCeilings } from '../src/access.js';
import { DomainError, type Principal } from '../src/contracts.js';
import type { Conversation, Notification, Task } from '../src/domain.js';
import { AutomationDispatcher, EventTriggerService, type EventInboxItem } from '../src/event-triggers.js';
import { createServer } from '../src/http/server.js';
import { NotificationService } from '../src/notifications.js';
import {
  SchedulerService,
  type AutomationSchedule,
  type LegacyScheduleDraft,
  type ScheduleOccurrence,
} from '../src/scheduler.js';
import { SqliteStore } from '../src/storage/sqlite.js';
import { TaskService, type TaskRunner } from '../src/tasks.js';

// ---------------------------------------------------------------------------
// End-to-end pins for the authorization lifetime of automations: a real
// AccessService in front of a stubbed Account authorization check.
// ---------------------------------------------------------------------------

const issuer = 'https://identity.example.test';
const accountApi = 'https://account-api.example.test';
const ownerSubject = `acct_${'a'.repeat(32)}`;
const otherSubject = `acct_${'b'.repeat(32)}`;
const start = Date.parse('2026-09-27T04:00:00.000Z');
const conversation: Conversation = {
  title: 'Automation source', scope: 'private', modelPolicy: 'cloud', strategy: 'single', mode: 'act', archived: false,
};

/** The principal id the core derives for an identity: sha256(issuer NUL subject), lowercase hex. */
const principalId = (subject: string): string => createHash('sha256').update(`${issuer}\0${subject}`).digest('hex');
const ownerId = principalId(ownerSubject);

/** What the identity provider reports for a signed-in session, before AccessService.authorize. */
const session = (subject: string, expiresAt: string, overrides: Partial<Principal> = {}): Principal => ({
  id: principalId(subject), issuer, subject, level: 1, scopes: [], applicationId: 'kiancode', audience: 'kiancode',
  credentialVersion: 3, expiresAt, ...overrides,
});
const settings = (conversationId: string, notification: { type: 'none' } | { type: 'in_app' } = { type: 'none' }) => ({
  conversationId, permissions: ['model:read'], notification,
});

type CheckBody = { subject: string; applicationId: string; credentialVersion: number };
type Answer = 'network' | ((body: CheckBody) => Response);
const active: Answer = (body) => Response.json({ success: true, data: { active: true, credentialVersion: body.credentialVersion } });
const inactive: Answer = (body) => Response.json({ success: true, data: { active: false, credentialVersion: body.credentialVersion } });
const rotated: Answer = (body) => Response.json({ success: true, data: { active: true, credentialVersion: body.credentialVersion + 1 } });
const status = (code: number): Answer => () => Response.json({ success: false, error: 'any' }, { status: code });

/** Stub of the Account authorization check. Records every request body; `reply` switches the answer. */
function accountStub() {
  let answer: Answer = active;
  const requests: CheckBody[] = [];
  const fetcher = (async (_input: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as CheckBody;
    requests.push(body);
    if (answer === 'network') throw new TypeError('fetch failed');
    return answer(body);
  }) as typeof fetch;
  return { fetcher, requests, reply(next: Answer) { answer = next; } };
}

/** The background revalidation hook exactly as createServer and bootstrap build it from an AccessService. */
function reauthorizeWith(access: AccessService): (principal: Principal) => Promise<Principal> {
  return async (principal) => {
    if (!await access.validateDelegation(principal)) {
      throw new DomainError('grant_revoked', 'Task authorization has expired or been revoked', 403);
    }
    return access.authorize(principal);
  };
}

/** Account-mode services wired by hand so the clock can be moved. */
async function harness(options: { runner?: TaskRunner; levelCeilings?: LevelCeilings } = {}) {
  const store = new SqliteStore();
  const clock = { now: start };
  const account = accountStub();
  const access = new AccessService(store, ownerSubject, 'service-token', 'account', accountApi, account.fetcher, options.levelCeilings ?? {});
  const reauthorize = reauthorizeWith(access);
  const reported: unknown[] = [];
  const onError = (error: unknown): void => { reported.push(error); };
  const notifications = new NotificationService(store, { now: () => new Date(clock.now) });
  const tasks = new TaskService(store, options.runner ?? (async () => ({ text: 'done' })), {
    now: () => clock.now, reauthorize, durableGrants: true, notifications, onError,
  });
  const dispatcher = new AutomationDispatcher(store, tasks, () => clock.now);
  const scheduler = new SchedulerService(store, dispatcher, { enabled: true, now: () => clock.now, reauthorize, unattended: 'durable', onError });
  const triggers = new EventTriggerService(store, dispatcher, { enabled: true, now: () => clock.now, reauthorize, unattended: 'durable', onError });
  /** The owner as the HTTP layer hands it to the services: authorised, with a 15-minute session. */
  const signedInOwner = () => access.authorize(session(ownerSubject, new Date(clock.now + 15 * 60_000).toISOString()));
  return {
    store, clock, account, access, notifications, tasks, scheduler, triggers, reported, signedInOwner,
    async close() { await tasks.close(); await store.close(); },
  };
}

test('the unattended mode follows the identity mode', async () => {
  const store = new SqliteStore();
  try {
    assert.equal(new AccessService(store, ownerSubject, 'service-token', 'account').unattendedAuthorization(), 'durable');
    assert.equal(new AccessService(store, ownerSubject).unattendedAuthorization(), 'durable', 'account is the default identity mode');
    assert.equal(new AccessService(store, ownerSubject, undefined, 'oidc').unattendedAuthorization(), 'unsupported');
    assert.equal(new AccessService(store, ownerSubject, undefined, 'development').unattendedAuthorization(), undefined);
  } finally {
    await store.close();
  }
});

test('account mode: a saved schedule has no expiresAt and dispatches through the Account check after the session expired', async () => {
  const store = new SqliteStore();
  const account = accountStub();
  const access = new AccessService(store, ownerSubject, 'service-token', 'account', accountApi, account.fetcher);
  const server = await createServer({
    store,
    access,
    authenticate: async () => access.authorize(session(ownerSubject, new Date(Date.now() + 60_000).toISOString())),
    runner: async () => ({ text: 'done' }),
    automations: { eventTriggersEnabled: true, schedulerEnabled: true },
  });
  const headers = { authorization: 'Bearer session-token' };
  try {
    const source = await server.app.inject({ method: 'POST', url: '/v1/conversations', headers, payload: { title: 'Automation source' } });
    assert.equal(source.statusCode, 201, source.body);
    const created = await server.app.inject({
      method: 'POST', url: '/v1/schedules', headers,
      payload: {
        name: 'Due now', prompt: 'Run', nextAt: new Date(Date.now() - 1_000).toISOString(), intervalSeconds: 3_600, enabled: true,
        settings: settings(source.json().data.id),
      },
    });
    assert.equal(created.statusCode, 201, created.body);
    const saved = created.json().data as { id: string; data: AutomationSchedule };
    assert.equal('expiresAt' in saved.data.actor, false, 'createServer passes the durable mode to the scheduler');
    assert.equal(saved.data.actor.credentialVersion, 3);

    // The same row as an earlier release stored it: the actor still carries a session expiry, long past.
    const row = (await store.get<AutomationSchedule>('automation_schedule', saved.id, ownerId))!;
    await store.put<AutomationSchedule>('automation_schedule', row.id, ownerId, {
      ...row.data, actor: { ...row.data.actor, expiresAt: new Date(Date.now() - 31 * 86_400_000).toISOString() },
    }, row.revision);

    await server.scheduler.reconcile();
    const enqueued = await store.scan<Task>('task', ownerId);
    assert.equal(enqueued.length, 1);
    assert.equal('expiresAt' in enqueued[0]!.data.principal, false);
    assert.deepEqual(enqueued[0]!.data.principal.scopes, ['model:read']);
    assert.deepEqual(account.requests.at(-1), { subject: ownerSubject, applicationId: 'kiancode', credentialVersion: 3 });
    const after = (await store.get<AutomationSchedule>('automation_schedule', saved.id, ownerId))!;
    assert.equal(after.data.enabled, true);
    assert.equal(after.data.authorizationFailedAt, undefined);

    // createServer also turns durable grants on: a lapsed one-hour grant does not pause this task.
    const queued = enqueued[0]!;
    await store.put<Task>('task', queued.id, ownerId, { ...queued.data, grantExpiresAt: new Date(Date.now() - 1).toISOString() }, queued.revision);
    await server.tasks.drain();
    assert.equal((await store.get<Task>('task', queued.id, ownerId))?.data.state, 'completed');
  } finally {
    await server.close();
  }
});

test('account mode: a dispatch that cannot reach the Account check is written to the server log and nothing is disabled', async () => {
  const store = new SqliteStore();
  const account = accountStub();
  const access = new AccessService(store, ownerSubject, 'service-token', 'account', accountApi, account.fetcher);
  const server = await createServer({
    store,
    access,
    authenticate: async () => access.authorize(session(ownerSubject, new Date(Date.now() + 60_000).toISOString())),
    runner: async () => ({ text: 'done' }),
    automations: { eventTriggersEnabled: true, schedulerEnabled: true },
  });
  const headers = { authorization: 'Bearer session-token' };
  const warned: unknown[] = [];
  // With `logger: false` Fastify gives every server the same no-op logger object, so the method is put back afterwards.
  const originalWarn = server.app.log.warn;
  server.app.log.warn = ((value: unknown) => { warned.push(value); }) as typeof server.app.log.warn;
  try {
    const source = await server.app.inject({ method: 'POST', url: '/v1/conversations', headers, payload: { title: 'Automation source' } });
    const schedule = await server.app.inject({
      method: 'POST', url: '/v1/schedules', headers,
      payload: {
        name: 'Due now', prompt: 'Run', nextAt: new Date(Date.now() - 1_000).toISOString(), intervalSeconds: 3_600, enabled: true,
        settings: settings(source.json().data.id),
      },
    });
    assert.equal(schedule.statusCode, 201, schedule.body);
    const trigger = await server.app.inject({
      method: 'POST', url: '/v1/event-triggers', headers,
      payload: { type: 'webhook', name: 'Hook', prompt: 'Handle', enabled: true, settings: settings(source.json().data.id), filter: {} },
    });
    assert.equal(trigger.statusCode, 201, trigger.body);
    const hook = await server.app.inject({
      method: 'POST', url: `/v1/event-hooks/${trigger.json().webhook.id}`,
      headers: { 'x-kian-webhook-secret': trigger.json().webhook.secret },
      payload: { eventId: 'event-1', eventName: 'test', payload: {} },
    });
    assert.equal(hook.statusCode, 202, hook.body);

    account.reply(status(401));
    await server.scheduler.reconcile();
    await server.eventTriggers.reconcile();

    assert.equal(warned.length, 2);
    assert.ok(warned.every((value) => value instanceof DomainError && value.code === 'identity_unavailable'));
    assert.equal((await store.scan<Task>('task', ownerId)).length, 0);
    assert.equal((await store.scan<AutomationSchedule>('automation_schedule', ownerId))[0]?.data.enabled, true);
    const listed = await server.app.inject({ method: 'GET', url: '/v1/event-triggers', headers });
    assert.equal(listed.json().data[0].data.enabled, true);
    assert.equal(listed.json().data[0].data.authorizationFailedAt, undefined);
  } finally {
    server.app.log.warn = originalWarn;
    await server.close();
  }
});

test('oidc mode: enabling an automation is refused over HTTP while drafts, listing and deletion work', async () => {
  const store = new SqliteStore();
  const access = new AccessService(store, ownerSubject, undefined, 'oidc');
  const server = await createServer({
    store,
    access,
    authenticate: async () => access.authorize(session(ownerSubject, new Date(Date.now() + 60_000).toISOString())),
    runner: async () => ({ text: 'unused' }),
    automations: { eventTriggersEnabled: true, schedulerEnabled: true },
  });
  const headers = { authorization: 'Bearer session-token' };
  try {
    const source = await server.app.inject({ method: 'POST', url: '/v1/conversations', headers, payload: { title: 'Automation source' } });
    const schedule = (enabled: boolean) => ({
      name: 'Daily', prompt: 'Run', nextAt: new Date(Date.now() + 86_400_000).toISOString(), intervalSeconds: 86_400, enabled,
      settings: settings(source.json().data.id),
    });
    const trigger = (enabled: boolean) => ({
      type: 'webhook', name: 'Hook', prompt: 'Handle', enabled, settings: settings(source.json().data.id), filter: {},
    });

    for (const [url, payload] of [['/v1/schedules', schedule(true)], ['/v1/event-triggers', trigger(true)]] as const) {
      const refused = await server.app.inject({ method: 'POST', url, headers, payload });
      assert.equal(refused.statusCode, 503, refused.body);
      assert.equal(refused.json().error.code, 'unattended_automation_unsupported');
      assert.equal(typeof refused.json().error.message, 'string');
    }

    const draft = await server.app.inject({ method: 'POST', url: '/v1/schedules', headers, payload: schedule(false) });
    assert.equal(draft.statusCode, 201, draft.body);
    assert.equal(typeof draft.json().data.data.actor.expiresAt, 'string', 'outside account mode the actor is stored as given');
    const draftTrigger = await server.app.inject({ method: 'POST', url: '/v1/event-triggers', headers, payload: trigger(false) });
    assert.equal(draftTrigger.statusCode, 201, draftTrigger.body);

    const enable = await server.app.inject({
      method: 'PATCH', url: `/v1/schedules/${draft.json().data.id}`, headers,
      payload: { revision: draft.json().data.revision, enabled: true },
    });
    assert.equal(enable.statusCode, 503, enable.body);
    assert.equal(enable.json().error.code, 'unattended_automation_unsupported');
    const enableTrigger = await server.app.inject({
      method: 'PUT', url: `/v1/event-triggers/${draftTrigger.json().data.id}`, headers,
      payload: { revision: draftTrigger.json().data.revision, data: trigger(true) },
    });
    assert.equal(enableTrigger.statusCode, 503, enableTrigger.body);

    const listed = await server.app.inject({ method: 'GET', url: '/v1/schedules', headers });
    assert.equal(listed.json().data.length, 1);
    assert.equal(listed.json().data[0].data.enabled, false);
    const removed = await server.app.inject({
      method: 'DELETE', url: `/v1/schedules/${draft.json().data.id}?revision=${draft.json().data.revision}`, headers,
    });
    assert.equal(removed.statusCode, 204, removed.body);

    // Imported legacy drafts (`/v1/schedule-drafts`) can still be listed and discarded.
    const legacy = await store.create<LegacyScheduleDraft>('automation_schedule_draft', ownerId, {
      name: 'Imported draft', prompt: 'Review before adopting.',
      timing: { type: 'interval', intervalSeconds: 3_600 },
      enabled: false, originalEnabled: true, requiresReview: ['execution_settings'],
      importedAt: new Date(start).toISOString(),
      source: { system: 'hermes', idHash: 'a'.repeat(64), fingerprint: 'b'.repeat(64) },
    }, 'draft-1');
    const drafts = await server.app.inject({ method: 'GET', url: '/v1/schedule-drafts', headers });
    assert.equal(drafts.statusCode, 200, drafts.body);
    assert.deepEqual(drafts.json().data.map((row: { id: string }) => row.id), ['draft-1']);
    const discarded = await server.app.inject({
      method: 'DELETE', url: `/v1/schedule-drafts/${legacy.id}?revision=${legacy.revision}`, headers,
    });
    assert.equal(discarded.statusCode, 204, discarded.body);
  } finally {
    await server.close();
  }
});

test('an Account outage never disables a schedule and the occurrence runs once the service is back', async () => {
  let duringStep: (() => void) | undefined;
  const h = await harness({
    runner: async ({ onEvent }) => {
      duringStep?.();
      await onEvent({ type: 'model_call', call: 1 });
      return { text: 'done' };
    },
  });
  try {
    const source = await h.store.create<Conversation>('conversation', ownerId, conversation);
    const caller = await h.signedInOwner();
    const schedule = await h.scheduler.create(caller, {
      name: 'Hourly', prompt: 'Run', nextAt: new Date(start + 3_600_000).toISOString(), intervalSeconds: 3_600, enabled: true,
      settings: settings(source.id),
    });
    const created = await h.triggers.create(caller, {
      name: 'Hook', prompt: 'Handle', enabled: true, type: 'webhook', filter: {}, settings: settings(source.id),
    });

    // One hour later: the 15-minute session that saved them ended long ago.
    h.clock.now = start + 3_600_000;
    await h.triggers.ingestWebhook(created.trigger.data.webhook!.id, created.secret, { eventId: 'event-1', eventName: 'test', payload: {} });
    const malformed: Answer = () => new Response('<html>bad gateway</html>', { status: 200, headers: { 'content-type': 'text/html' } });
    const outage: Answer[] = [status(503), status(429), status(401), status(403), status(404), 'network', malformed];
    for (const answer of outage) {
      h.account.reply(answer);
      await h.scheduler.reconcile();
      await h.triggers.reconcile();
      const current = (await h.store.get<AutomationSchedule>('automation_schedule', schedule.id, ownerId))!;
      assert.equal(current.data.enabled, true);
      assert.equal(current.data.authorizationFailedAt, undefined);
      const trigger = (await h.triggers.list(ownerId))[0]!;
      assert.equal(trigger.data.enabled, true);
      assert.equal(trigger.data.authorizationFailedAt, undefined);
      h.clock.now += 5 * 60_000 + 1;
    }
    const waiting = (await h.store.scan<ScheduleOccurrence>('schedule_occurrence', ownerId))[0]!;
    assert.equal(waiting.data.status, 'pending');
    assert.equal(waiting.data.attempts, outage.length);
    assert.equal(waiting.data.lastError, 'Account authorization check is unavailable');
    assert.equal((await h.store.scan<EventInboxItem>('event_inbox', ownerId))[0]?.data.status, 'pending');
    assert.equal((await h.store.scan<Task>('task', ownerId)).length, 0);
    assert.equal(h.reported.length, 2 * outage.length, 'every retried attempt is reported');
    assert.ok(h.reported.every((error) => error instanceof DomainError && error.code === 'identity_unavailable'));

    h.account.reply(active);
    await h.scheduler.reconcile();
    await h.triggers.reconcile();
    await h.scheduler.reconcile();
    await h.triggers.reconcile();
    const tasks = await h.store.scan<Task>('task', ownerId);
    assert.equal(tasks.length, 2, 'one task for the occurrence and one for the event, each exactly once');
    assert.ok(tasks.every((task) => !('expiresAt' in task.data.principal)));

    // The service goes away again between two steps of the first task: both tasks wait, neither fails.
    duringStep = () => h.account.reply(status(503));
    await h.tasks.drain();
    const stalled = await h.store.scan<Task>('task', ownerId);
    assert.deepEqual(stalled.map((task) => task.data.state), ['queued', 'queued']);
    assert.ok(stalled.every((task) => task.data.error === 'Account authorization check is unavailable'));

    duringStep = undefined;
    h.account.reply(active);
    h.clock.now += 30_001;
    await h.tasks.drain();
    const finished = await h.store.scan<Task>('task', ownerId);
    assert.deepEqual(finished.map((task) => task.data.state), ['completed', 'completed']);
    await h.notifications.reconcile();
    assert.equal((await h.store.scan<Notification>('notification', ownerId)).length, 0);
  } finally {
    await h.close();
  }
});

test('an explicit denial disables the schedule, notifies the owner once and pauses a running task', async () => {
  let betweenSteps: (() => void) | undefined;
  const h = await harness({
    runner: async ({ onEvent }) => {
      betweenSteps?.();
      await onEvent({ type: 'model_call', call: 1 });
      return { text: 'done' };
    },
  });
  try {
    const source = await h.store.create<Conversation>('conversation', ownerId, conversation);
    const caller = await h.signedInOwner();
    const schedule = await h.scheduler.create(caller, {
      name: 'Hourly', prompt: 'Run', nextAt: new Date(start + 3_600_000).toISOString(), intervalSeconds: 3_600, enabled: true,
      settings: settings(source.id, { type: 'in_app' }),
    });
    const created = await h.triggers.create(caller, {
      name: 'Hook', prompt: 'Handle', enabled: true, type: 'webhook', filter: {}, settings: settings(source.id, { type: 'in_app' }),
    });

    h.clock.now = start + 3_600_000;
    await h.scheduler.reconcile();
    const running = (await h.store.scan<Task>('task', ownerId))[0]!;

    // The account is deactivated while the task is between two steps.
    betweenSteps = () => h.account.reply(inactive);
    await h.tasks.drain();
    const paused = (await h.store.get<Task>('task', running.id, ownerId))!;
    assert.equal(paused.data.state, 'paused');
    assert.match(paused.data.error ?? '', /expired or been revoked/);

    // The next occurrence is refused, and the schedule is switched off.
    h.clock.now += 3_600_000;
    await h.scheduler.reconcile();
    const occurrences = await h.store.scan<ScheduleOccurrence>('schedule_occurrence', ownerId);
    assert.deepEqual(occurrences.map((row) => row.data.rejectionCode).filter(Boolean), ['grant_revoked']);
    const disabled = (await h.store.get<AutomationSchedule>('automation_schedule', schedule.id, ownerId))!;
    assert.equal(disabled.data.enabled, false);
    assert.equal(disabled.data.authorizationFailedAt, new Date(h.clock.now).toISOString());
    assert.equal((await h.store.scan<Task>('task', ownerId)).length, 1);

    // A changed credential version is the other explicit denial; it switches the trigger off.
    h.account.reply(rotated);
    await h.triggers.ingestWebhook(created.trigger.data.webhook!.id, created.secret, { eventId: 'event-1', eventName: 'test', payload: {} });
    await h.triggers.reconcile();
    const trigger = (await h.triggers.list(ownerId))[0]!;
    assert.equal(trigger.data.enabled, false);
    assert.equal(trigger.data.authorizationFailedAt, new Date(h.clock.now).toISOString());
    assert.equal(h.reported.length, 0, 'a denial is not an operational error');

    await h.notifications.reconcile();
    await h.notifications.reconcile();
    const rows = (await h.store.scan<Notification>('notification', ownerId))
      .filter((row) => row.data.type === 'schedule_authorization_failed');
    assert.equal(rows.length, 2, 'one for the schedule and one for the trigger, however often reconcile runs');
    assert.equal(rows.filter((row) => row.data.scheduleId === schedule.id).length, 1);
    assert.equal(rows.filter((row) => row.data.eventTriggerId === trigger.id).length, 1);
  } finally {
    await h.close();
  }
});

test('a durable actor that is not the configured owner subject is rejected at dispatch', async () => {
  const stored = ['schedule:read', 'schedule:write', 'model:read'];
  const variants: Array<{ name: string; record?: string[]; ceiling?: string[]; code: string }> = [
    { name: 'no access record', code: 'access_required' },
    { name: 'a record that does not cover the stored scopes', record: ['chat:read', 'schedule:read'], code: 'grant_revoked' },
    { name: 'a record and an operator ceiling that cover them', record: stored, ceiling: stored, code: 'owner_required' },
  ];
  for (const variant of variants) {
    const h = await harness(variant.ceiling ? { levelCeilings: { 2: variant.ceiling } } : {});
    try {
      // An actor saved by an earlier release for an account the identity service reported as level 1.
      const actor: Principal = {
        id: principalId(otherSubject), issuer, subject: otherSubject, level: 1, scopes: stored,
        applicationId: 'kiancode', audience: 'kiancode', credentialVersion: 3,
      };
      if (variant.record) {
        await h.store.create<AccessGrant>('access', actor.id, { scopes: variant.record, enabled: true }, actor.id);
      }
      const source = await h.store.create<Conversation>('conversation', actor.id, conversation);
      const schedule = await h.scheduler.create(actor, {
        name: 'Hourly', prompt: 'Run', nextAt: new Date(start).toISOString(), intervalSeconds: 3_600, enabled: true,
        settings: settings(source.id),
      });
      await h.scheduler.reconcile();

      assert.equal((await h.store.scan<Task>('task', actor.id)).length, 0, variant.name);
      const occurrence = (await h.store.scan<ScheduleOccurrence>('schedule_occurrence', actor.id))[0]!;
      assert.equal(occurrence.data.status, 'rejected', variant.name);
      assert.equal(occurrence.data.rejectionCode, variant.code, variant.name);
      const after = (await h.store.get<AutomationSchedule>('automation_schedule', schedule.id, actor.id))!;
      assert.equal(after.data.enabled, false, variant.name);
      assert.equal(after.data.authorizationFailedAt, new Date(start).toISOString(), variant.name);
    } finally {
      await h.close();
    }
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx --test test/automation-authorization.test.ts`

Expected: 4 failing and 3 passing tests.

```
✖ the unattended mode follows the identity mode
  TypeError [Error]: (intermediate value).unattendedAuthorization is not a function
✖ account mode: a saved schedule has no expiresAt and dispatches through the Account check after the session expired
  AssertionError [ERR_ASSERTION]: createServer passes the durable mode to the scheduler
  true !== false
✖ account mode: a dispatch that cannot reach the Account check is written to the server log and nothing is disabled
  AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:
  0 !== 2
✖ oidc mode: enabling an automation is refused over HTTP while drafts, listing and deletion work
  201 !== 503
✔ an Account outage never disables a schedule and the occurrence runs once the service is back
✔ an explicit denial disables the schedule, notifies the owner once and pauses a running task
✔ a durable actor that is not the configured owner subject is rejected at dispatch
```

The three passing tests wire the services by hand and pin the combined behaviour of Tasks 1 to 11 and of plan A against a real `AccessService`. If one of them fails, the defect is in an earlier task or in plan A, not in this one; stop and fix it there.

- [ ] **Step 3: Write minimal implementation**

`src/access.ts` — add the method directly above `authorize`. Replace this one line:

```ts
  async authorize(identity: Principal): Promise<Principal> {
```

with:

```ts
  /**
   * How schedules and event triggers stay authorised while nobody is signed in.
   * 'durable': account mode, every dispatch and step is checked with the identity service.
   * 'unsupported': OIDC mode, there is nothing to check an absent user against.
   * undefined: development mode, stored principals are used as they are.
   */
  unattendedAuthorization(): 'durable' | 'unsupported' | undefined {
    if (this.identityMode === 'account') return 'durable';
    return this.identityMode === 'oidc' ? 'unsupported' : undefined;
  }
  async authorize(identity: Principal): Promise<Principal> {
```

`src/http/server.ts` — in `createServer`. Replace:

```ts
  const tasks = new TaskService(store, options.runner, {
    onError: (error) => app.log.error(error),
    notifications,
    ...(reauthorize ? { reauthorize } : {}),
  });
  const devices = options.devices ?? new DeviceService(store);
  const dispatcher = new AutomationDispatcher(store, tasks);
  const deviceConnections = new DeviceConnectionRegistry();
  const eventTriggers = new EventTriggerService(store, dispatcher, {
    enabled: options.automations?.eventTriggersEnabled === true,
    ...(reauthorize ? { reauthorize } : {}),
    validateDeviceConnection: (edge) => deviceConnections.validate(edge),
  });
  const scheduler = new SchedulerService(store, dispatcher, {
    enabled: options.automations?.schedulerEnabled === true,
    ...(reauthorize ? { reauthorize } : {}),
  });
```

with:

```ts
  const unattended = options.access?.unattendedAuthorization();
  const tasks = new TaskService(store, options.runner, {
    onError: (error) => app.log.error(error),
    notifications,
    ...(reauthorize ? { reauthorize } : {}),
    ...(unattended === 'durable' ? { durableGrants: true } : {}),
  });
  const devices = options.devices ?? new DeviceService(store);
  const dispatcher = new AutomationDispatcher(store, tasks);
  const deviceConnections = new DeviceConnectionRegistry();
  const eventTriggers = new EventTriggerService(store, dispatcher, {
    enabled: options.automations?.eventTriggersEnabled === true,
    ...(reauthorize ? { reauthorize } : {}),
    ...(unattended ? { unattended } : {}),
    onError: (error) => app.log.warn(error),
    validateDeviceConnection: (edge) => deviceConnections.validate(edge),
  });
  const scheduler = new SchedulerService(store, dispatcher, {
    enabled: options.automations?.schedulerEnabled === true,
    ...(reauthorize ? { reauthorize } : {}),
    ...(unattended ? { unattended } : {}),
    onError: (error) => app.log.warn(error),
  });
```

If an earlier plan has added lines to one of these three option objects, keep its lines and add only the four new ones (`const unattended = …`, the `durableGrants` spread, and the `unattended` spread plus `onError` in each automation service).

`README.md` — in the Components list. Replace this bullet:

```md
- Schedules and webhook or device-online triggers use immutable execution snapshots and revalidate current authorization before enqueueing work. Cron schedules require an IANA timezone; imported legacy schedules remain disabled drafts until the owner reviews them. Both execution paths default to disabled and require explicit `automations` configuration.
```

with:

```md
- Schedules and webhook or device-online triggers use immutable execution snapshots and revalidate current authorization before enqueueing work. Cron schedules require an IANA timezone; imported legacy schedules remain disabled drafts until the owner reviews them. Both execution paths default to disabled and require explicit `automations` configuration.
- How an automation stays authorised while nobody is signed in depends on the identity mode:
  - Account authentication: a saved schedule or trigger stores its owner without the sign-in session's expiry. Every dispatch, and every model or tool step of the task it starts, is checked again with the Account authorization check and the owner's access record; such a task is not paused when its one-hour grant lapses. Only an explicit answer (the account is inactive, or its credential version changed) or a lost access record switches the automation off, sets `authorizationFailedAt`, notifies the owner and pauses its running tasks. After signing in again, re-enable a schedule with `PATCH /v1/schedules/:id` or save a trigger again with `PUT /v1/event-triggers/:id`; either stores the current sign-in as the new authorisation. A one-shot schedule whose time has already produced a run or a refusal does not run again when re-enabled; save a new time.
  - Any other failure of that check (network error, timeout, 429, 5xx, and also 401, 403 or 404, which on this route mean the core's own service credential or URL is wrong) is retried and reported to the server log, and never disables an automation or fails a task. The check needs the service credential named by `auth.serviceTokenEnv`.
  - OIDC authentication: the server has nothing to check an absent user against, so saving an enabled schedule or trigger, or enabling one, fails with `unattended_automation_unsupported` (503). Disabled drafts, listing and deletion still work.
  - Development authentication stores and uses the principal as given.
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx tsx --test test/automation-authorization.test.ts`

Expected: `ℹ tests 7`, `ℹ pass 7`, `ℹ fail 0`.

Then run the delivery gate: `npm run check`

Expected: `tsc --noEmit` prints no errors, the test run ends with `ℹ fail 0` (PostgreSQL contract cases from plan G are reported as skipped unless `KIANCODE_TEST_DATABASE_URL` is set), and `tsc -p tsconfig.build.json` exits 0.

- [ ] **Step 5: Commit**

```bash
git add src/access.ts src/http/server.ts README.md test/automation-authorization.test.ts
git commit -m "實現：依身份模式接線無人值守授權，並補上端到端測試與說明"
```
