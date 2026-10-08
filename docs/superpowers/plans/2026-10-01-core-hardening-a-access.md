# Access Control and Levels Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Only the configured owner subject can act as owner; every other signed-in principal is denied until the owner grants it an access record, and what it then receives is bounded by a per-level scope ceiling.

**Architecture:** Every access decision stays inside `AccessService` (`src/access.ts`): `authorize` becomes default-deny with a level floor and a level ceiling, `grant` becomes owner-only with validated input. One exported matcher, `scopeAllows` in `src/auth.ts`, is shared by `requireScope` and `AccessService`. The new `access_required` code joins the existing authorization code sets so background work pauses or is rejected exactly like `access_revoked`, and a pure `requireOwnerSubject(config, env)` check is called by both `bootstrap` and the `config-check` command.

**Tech Stack:** TypeScript (NodeNext modules), Node.js 24, Fastify 5, zod 4, `node:test` run through `tsx --test`, in-memory `SqliteStore` for tests.

**Spec:** `docs/superpowers/specs/2026-10-01-core-hardening-design.md` (section A)

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
- Execution order is G, A, C, B1, B2, D, E, F. This plan runs after G only. Plan G does not touch any source file this plan modifies (it edits `README.md` under `## Verification`, which is a different section from the one edited here), so the line numbers below still hold; locate code by the quoted text anyway.
- Commit subjects are in Traditional Chinese with a type prefix and a full-width colon (`修復：…`, `實現：…`, `測試：…`, `文件：…`).
- Run every command from the repository root.

## Review Focus

Most likely first. Each line names the task that owns the code and the test that pins it.

1. **An existing non-owner signs in after the upgrade and has no access record.** Expected: every authenticated route, including `GET /v1/session`, answers 403 `access_required` with a stable message, and the very next request after the owner's `PUT /v1/access/:id` succeeds with exactly the granted scopes (no restart, no cache). Task 2, test `every authenticated route answers 403 access_required until the owner grants access`.
2. **A queued task, a schedule or an event trigger belongs to a principal that is no longer admitted.** Expected: the task becomes `paused` (resumable from a signed-in client), never `failed` or `unknown`; the schedule or trigger occurrence is `rejected` and the automation is disabled instead of being retried forever. Task 5, tests `a task whose principal has no access record pauses and resumes after the owner grants access`, `a schedule whose stored actor is no longer admitted is rejected and disabled` and `an event trigger whose stored actor is no longer admitted is rejected and disabled`.
3. **Production is started (or `config-check` is run) without the owner subject variable.** Expected: a start-up failure that names the variable, before any database connection, instead of a service in which nobody is the owner and nobody can grant access. Task 8, tests `bootstrap refuses a production start without the owner subject before touching the database` and `config-check fails without the owner subject and passes with it`.
4. **The owner sends a bad grant: its own principal id, an account subject instead of the hashed principal id, or a scope list containing `*`, `admin:*` or `admin:grant` in any accepted form.** Expected: 400, the whole request is rejected and nothing is written, so the owner cannot lock itself out or hand out the right to grant. Task 6, tests `the owner cannot write a record for its own id`, `in account and oidc modes the record id must be a 64-character lowercase hex principal id` and `reserved and malformed scopes are rejected with invalid_scope and nothing is written`.
5. **A stored record is broader than the level allows (legacy `*`, the old default list, tool scopes), or the identity service reports level 1 for somebody who is not the owner.** Expected: effective scopes are clamped to the level ceiling, level 5 is denied, and the principal is level 2 and fails every owner check. Task 4, test `a legacy record with wildcard, tool and admin scopes is clamped to the level ceiling`; Task 3, test `a non-owner that the identity service reports as level 1 is floored to level 2 and cannot use owner routes`.

## Readings of the Spec

Where the spec text leaves room, this plan fixes one reading. Implement what the tasks say; do not "correct" these back to a more literal reading.

- **A1, "without an enabled `access` record".** No record is 403 `access_required`. A record with `enabled: false` keeps the existing 403 `access_revoked` (existing codes do not change); both codes pause tasks and disable automations. Task 2.
- **A3, "intersection".** Two-way under `scopeAllows`: record scopes the ceiling allows, plus ceiling scopes the record allows. A one-way filter would leave a record written as `chat:*`, `kiancode:chat:read` or a legacy `*` with nothing. With the built-in ceilings (plain names only) the result is exactly the ceiling scopes the record allows. Task 4.
- **A4, "Scopes are validated".** A scope is 1 to 100 printable ASCII characters without spaces. The reserved check is "this single scope would satisfy `admin:grant`", which adds `kiancode:*` and `kiancode:admin:grant` to the three forms the spec names. Both id rules (own id, not a 64-hex id) use one new code, `invalid_principal` (400). The own-id rule applies in every identity mode; the 64-hex rule only in account and oidc modes, as the spec says. Task 6.
- **A5, "unset or empty".** A value with leading or trailing whitespace is rejected too: it can never equal a subject, so the service would start with nobody as owner, which is the failure A5 exists to prevent. Task 8.
- **README.** Section A of the spec lists no README change. Task 8 still updates `## Deployment`, because that section is where the production start-up requirements are stated and it would be wrong after A5; the edit is its own commit.

## File Structure

| File | Action | Responsibility |
| --- | --- | --- |
| `src/auth.ts` | modify | Export the canonical scope matcher `scopeAllows`; `requireScope` delegates to it. |
| `src/access.ts` | modify | `AccessService`: default-deny `authorize`, level floor, level ceilings, owner-only validated `grant`, canonical scope coverage in `validateDelegation`. |
| `src/tasks.ts` | modify | Add `access_required` to `authorizationPauseCodes`. |
| `src/scheduler.ts` | modify | Add `access_required` to `permanentAuthorizationCodes`. |
| `src/event-triggers.ts` | modify | Add `access_required` to `permanentAuthorizationCodes`. |
| `src/config.ts` | modify | `auth.levelCeilings` schema key; exported `requireOwnerSubject(config, env)`. |
| `src/bootstrap.ts` | modify | Call `requireOwnerSubject` first; pass the owner subject and `config.auth.levelCeilings` to `AccessService`. |
| `src/cli.ts` | modify | `config-check` also runs `requireOwnerSubject`. |
| `README.md` | modify | Deployment section: access records, level ceilings, mandatory owner subject. |
| `test/auth.test.ts` | modify (append) | `scopeAllows` / `requireScope` semantics. |
| `test/access.test.ts` | create | Shared access fixtures, and every `AccessService`, `PUT /v1/access/:id`, background-revalidation and bootstrap-wiring test of section A. Plan C appends to this file. |
| `test/config.test.ts` | modify (append) | `auth.levelCeilings` schema, `requireOwnerSubject`, bootstrap fail-fast and `config-check` CLI. |

---

### Task 1: Canonical scope matcher `scopeAllows`

**Files:**
- Modify: `src/auth.ts` (`requireScope`, lines 218-221 as of commit 17d571f)
- Test: `test/auth.test.ts` (import lines 5-6; append after line 166)

**Interfaces:**
- Consumes: nothing from earlier tasks or plans.
- Produces: `export function scopeAllows(grants: readonly string[], scope: string): boolean` in `src/auth.ts` (re-exported from the package root by the existing `export *`). It is true when some grant is `'*'`, `'kiancode:*'`, `scope`, `` `kiancode:${scope}` `` or `` `${scope.split(':')[0]}:*` ``. `requireScope(principal: Principal, scope: string): void` keeps its signature, its error code `forbidden`, status 403 and message `` `Missing capability: ${scope}` ``.

This is a pure refactor: no behaviour changes. The private copies of this matcher in `src/scheduler.ts`, `src/event-triggers.ts`, `src/tasks.ts`, `src/runtime-adapter.ts`, `src/runtime/agent-runtime.ts`, `src/connectors/device.ts` and `src/agents/coordinator.ts` are deliberately left alone (spec non-goal).

- [ ] **Step 1: Write the failing test**

In `test/auth.test.ts` replace these two import lines:

```ts
import { accountAuth, oidcAuth } from '../src/auth.js';
import { SqliteStore } from '../src/storage/sqlite.js';
```

with:

```ts
import { accountAuth, oidcAuth, requireScope, scopeAllows } from '../src/auth.js';
import { DomainError, type Principal } from '../src/contracts.js';
import { SqliteStore } from '../src/storage/sqlite.js';
```

Then append to the end of `test/auth.test.ts`:

```ts

test('scopeAllows accepts the global, prefixed, exact and namespace-wildcard grant forms', () => {
  for (const grant of ['*', 'kiancode:*', 'chat:read', 'kiancode:chat:read', 'chat:*']) {
    assert.equal(scopeAllows([grant], 'chat:read'), true, grant);
  }
  assert.equal(scopeAllows(['task:read', 'chat:read'], 'chat:read'), true);
  assert.equal(scopeAllows(['workspace:*'], 'workspace:abc:read'), true);
  assert.equal(scopeAllows(['workspace:abc:read'], 'workspace:abc:read'), true);
});

test('scopeAllows rejects everything else, including near misses', () => {
  assert.equal(scopeAllows([], 'chat:read'), false);
  for (const grant of ['chat', 'chat:write', 'chatty:*', 'Chat:read', 'chat:read ', 'kiancode:chat:*', 'workspace:abc']) {
    assert.equal(scopeAllows([grant], 'chat:read'), false, grant);
  }
  assert.equal(scopeAllows(['chat:*'], 'chatty:read'), false);
  assert.equal(scopeAllows(['workspace:abc'], 'workspace:abc:read'), false);
  assert.equal(scopeAllows(['chat:read'], '*'), false);
});

test('requireScope delegates to scopeAllows and keeps its error contract', () => {
  const principal: Principal = { id: 'someone', level: 2, scopes: ['kiancode:chat:read', 'task:*'] };
  assert.equal(requireScope(principal, 'chat:read'), undefined);
  assert.equal(requireScope(principal, 'task:write'), undefined);
  assert.throws(() => requireScope(principal, 'memory:read'), (error: unknown) => error instanceof DomainError
    && error.code === 'forbidden' && error.statusCode === 403 && error.message === 'Missing capability: memory:read');
});
```

`'kiancode:chat:*'` not allowing `chat:read` is an existing quirk of `requireScope`; the test pins it so the refactor cannot change it silently.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx --test test/auth.test.ts`

Expected: the file fails to load, and the runner reports 1 failing test for the whole file:

```
SyntaxError: The requested module '../src/auth.js' does not provide an export named 'scopeAllows'
✖ test/auth.test.ts
ℹ pass 0
ℹ fail 1
```

- [ ] **Step 3: Write minimal implementation**

In `src/auth.ts` replace the existing function:

```ts
export function requireScope(principal: Principal, scope: string): void {
  if (principal.scopes.some((grant) => grant === '*' || grant === 'kiancode:*' || grant === scope || grant === `kiancode:${scope}` || grant === `${scope.split(':')[0]}:*`)) return;
  throw new DomainError('forbidden', `Missing capability: ${scope}`, 403);
}
```

with:

```ts
export function scopeAllows(grants: readonly string[], scope: string): boolean {
  const namespace = scope.split(':')[0];
  return grants.some((grant) => grant === '*' || grant === 'kiancode:*' || grant === scope
    || grant === `kiancode:${scope}` || grant === `${namespace}:*`);
}

export function requireScope(principal: Principal, scope: string): void {
  if (scopeAllows(principal.scopes, scope)) return;
  throw new DomainError('forbidden', `Missing capability: ${scope}`, 403);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx tsx --test test/auth.test.ts`

Expected: `ℹ tests 7`, `ℹ pass 7`, `ℹ fail 0` (the four existing tests and the three new ones).

- [ ] **Step 5: Commit**

```bash
git add src/auth.ts test/auth.test.ts
git commit -m "實現：匯出統一的權限範圍比對函式 scopeAllows"
```

---

### Task 2: A1 default-deny in `AccessService.authorize`

**Files:**
- Modify: `src/access.ts` (the `defaultScopes` constant, line 6, and `AccessService.authorize`, lines 22-28 as of commit 17d571f)
- Create: `test/access.test.ts`
- Test: `test/access.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks. `AccessService` constructor as it exists: `(store: Store, ownerSubject?: string, serviceToken?: string, identityMode: 'account' | 'oidc' | 'development' = 'account', accountApiUrl?: string, fetcher: typeof fetch = fetch)`.
- Produces:
  - `AccessService.authorize(identity: Principal): Promise<Principal>` (signature unchanged). Development identity mode: returns `identity` itself, no store read. Account and oidc modes: a principal without `issuer` or `subject` rejects with `DomainError('access_required', 'Kian access has not been granted', 403)`; a disabled record rejects with `DomainError('access_revoked', 'Kian access has been revoked', 403)` (unchanged, still checked before the owner branch); the configured owner subject gets `level: 1` and `scopes: ['*']` with or without a record; any other principal without a record rejects with `access_required`; otherwise the scopes are the record's scopes. Scopes reported by the identity provider are never used.
  - The module-private helper `accessRequired(): DomainError` in `src/access.ts`, reused by Tasks 4 and 6.
  - `test/access.test.ts` with these module-level fixtures, which later tasks of this plan reuse (do not redefine or rename them; plan C appends its own `test.describe` block to this file, with helpers local to that block):
    - `const issuer: string`, `const ownerSubject: string`, `const memberSubject: string`, `const serviceToken: string`, `const conversation: Conversation`.
    - `principalId(subject: string): string` — sha256 of `issuer`, NUL, `subject`, lowercase hex: the id the core derives for an identity.
    - `identity(subject: string, level: Principal['level'] = 2, overrides: Partial<Principal> = {}): Principal` — a principal as the identity provider reports it (empty scopes, `applicationId` and `audience` `'kiancode'`, `credentialVersion` 1, expires in 60 s).
    - `hasCode(expected: string, statusCode?: number): (error: unknown) => boolean` — predicate for `assert.rejects` / `assert.throws`.
    - `accountCheck(respond?): { fetcher: typeof fetch; requests: Array<{ url: string; init?: RequestInit }> }` — recording stub for the Account authorization check; answers `active: true` with the credential version that was asked unless `respond` is given.
    - `accountAccess(store: Store, fetcher: typeof fetch = accountCheck().fetcher): AccessService` — account-mode service whose owner is `ownerSubject` (Task 4 adds a third parameter).
    - `storeRecord(store: Store, subject: string, scopes: string[], enabled = true): Promise<void>` — writes an `access` row directly (legacy and pre-existing rows).
    - `reauthorizeWith(access: AccessService): (principal: Principal) => Promise<Principal>` — the background revalidation hook exactly as `createServer` builds it.
    - `accessServer(store: SqliteStore, access: AccessService, identities: Record<string, Principal>)` — `createServer` behind `access`; `Bearer <name>` signs in as `identities[name]`; closing the server closes the store.

- [ ] **Step 1: Write the failing test**

Create `test/access.test.ts` with exactly this content:

```ts
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { AccessService, type AccessGrant } from '../src/access.js';
import { DomainError, type Principal } from '../src/contracts.js';
import type { Conversation } from '../src/domain.js';
import { createServer } from '../src/http/server.js';
import { SqliteStore } from '../src/storage/sqlite.js';
import type { Store } from '../src/storage/store.js';

// ---------------------------------------------------------------------------
// Shared fixtures. Every test in this file builds on these. Append new tests
// at the end of the file and reuse the helpers instead of redefining them.
// ---------------------------------------------------------------------------

const issuer = 'https://identity.example.test';
const ownerSubject = `acct_${'a'.repeat(32)}`;
const memberSubject = `acct_${'b'.repeat(32)}`;
const serviceToken = 'service-token';
const conversation: Conversation = {
  title: 'Access', scope: 'private', modelPolicy: 'cloud', strategy: 'single', mode: 'ask', archived: false,
};

/** The principal id the core derives for an identity: sha256(issuer NUL subject), lowercase hex. */
function principalId(subject: string): string {
  return createHash('sha256').update(`${issuer}\0${subject}`).digest('hex');
}

/** A principal exactly as the identity provider reports it, before AccessService.authorize. */
function identity(subject: string, level: Principal['level'] = 2, overrides: Partial<Principal> = {}): Principal {
  return {
    id: principalId(subject),
    issuer,
    subject,
    level,
    scopes: [],
    applicationId: 'kiancode',
    audience: 'kiancode',
    credentialVersion: 1,
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    ...overrides,
  };
}

/** Predicate for assert.rejects / assert.throws: a DomainError with this code (and status, when given). */
function hasCode(expected: string, statusCode?: number): (error: unknown) => boolean {
  return (error) => error instanceof DomainError && error.code === expected
    && (statusCode === undefined || error.statusCode === statusCode);
}

/**
 * Fetch stub for the Account authorization check. Records every request. Without `respond` it
 * answers 200 { success: true, data: { active: true, credentialVersion: <the one that was asked> } }.
 */
function accountCheck(
  respond?: (request: { url: string; init?: RequestInit }) => Response | Promise<Response>,
): { fetcher: typeof fetch; requests: Array<{ url: string; init?: RequestInit }> } {
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  const fetcher = (async (input: string | URL | Request, init?: RequestInit) => {
    const request = { url: String(input), init };
    requests.push(request);
    if (respond) return respond(request);
    const body = JSON.parse(String(init?.body)) as { credentialVersion: number };
    return Response.json({ success: true, data: { active: true, credentialVersion: body.credentialVersion } });
  }) as typeof fetch;
  return { fetcher, requests };
}

/** Account-mode AccessService whose owner is `ownerSubject`. */
function accountAccess(store: Store, fetcher: typeof fetch = accountCheck().fetcher): AccessService {
  return new AccessService(store, ownerSubject, serviceToken, 'account', undefined, fetcher);
}

/** Writes an access record directly, bypassing AccessService.grant (for legacy and pre-existing rows). */
async function storeRecord(store: Store, subject: string, scopes: string[], enabled = true): Promise<void> {
  const id = principalId(subject);
  await store.create<AccessGrant>('access', id, { scopes, enabled }, id);
}

/** The background revalidation hook exactly as createServer builds it from an AccessService. */
function reauthorizeWith(access: AccessService): (principal: Principal) => Promise<Principal> {
  return async (principal) => {
    if (!await access.validateDelegation(principal)) {
      throw new DomainError('grant_revoked', 'Task authorization has expired or been revoked', 403);
    }
    return access.authorize(principal);
  };
}

/** createServer with AccessService in front of it; `Bearer <name>` signs in as `identities[name]`. */
function accessServer(store: SqliteStore, access: AccessService, identities: Record<string, Principal>) {
  return createServer({
    store,
    access,
    authenticate: async (authorization) => {
      const found = identities[authorization?.replace(/^Bearer /, '') ?? ''];
      if (!found) throw new DomainError('unauthorized', 'Sign in to continue', 401);
      return access.authorize(found);
    },
    runner: async () => ({ text: 'unused' }),
  });
}

// ---------------------------------------------------------------------------
// A1: default-deny
// ---------------------------------------------------------------------------

test('a signed-in principal without an access record is rejected with access_required', async () => {
  const store = new SqliteStore();
  try {
    for (const mode of ['account', 'oidc'] as const) {
      const access = new AccessService(store, ownerSubject, serviceToken, mode, undefined, accountCheck().fetcher);
      await assert.rejects(access.authorize(identity(memberSubject, 2)), hasCode('access_required', 403), mode);
      await assert.rejects(
        access.authorize(identity(memberSubject, 2, { scopes: ['*', 'admin:grant'] })),
        hasCode('access_required', 403),
        `${mode}: scopes reported by the identity provider must not admit anyone`,
      );
    }
    await assert.rejects(
      accountAccess(store).validateDelegation(identity(memberSubject, 2)),
      hasCode('access_required', 403),
      'background revalidation must surface the same code instead of returning false',
    );
  } finally {
    await store.close();
  }
});

test('the owner needs no record, record scopes replace identity scopes, and a disabled record is access_revoked', async () => {
  const store = new SqliteStore();
  try {
    const access = accountAccess(store);
    const owner = await access.authorize(identity(ownerSubject, 5, { scopes: ['account:profile'] }));
    assert.equal(owner.level, 1);
    assert.deepEqual(owner.scopes, ['*']);

    await storeRecord(store, memberSubject, ['chat:read']);
    const member = await access.authorize(identity(memberSubject, 2, { scopes: ['*', 'admin:grant'] }));
    assert.deepEqual(member.scopes, ['chat:read']);

    const record = await store.get<AccessGrant>('access', member.id, member.id);
    assert.ok(record);
    await store.put<AccessGrant>('access', member.id, member.id, { scopes: ['chat:read'], enabled: false }, record.revision);
    await assert.rejects(access.authorize(identity(memberSubject, 2)), hasCode('access_revoked', 403));
  } finally {
    await store.close();
  }
});

test('a principal without issuer or subject is rejected outside development mode', async () => {
  const store = new SqliteStore();
  try {
    const local: Principal = { id: 'local-owner', level: 1, scopes: ['*'] };
    await store.create<AccessGrant>('access', local.id, { scopes: ['chat:read'], enabled: true }, local.id);
    for (const mode of ['account', 'oidc'] as const) {
      const access = new AccessService(store, ownerSubject, serviceToken, mode, undefined, accountCheck().fetcher);
      await assert.rejects(access.authorize(local), hasCode('access_required', 403), mode);
      await assert.rejects(access.authorize(identity(ownerSubject, 1, { issuer: undefined })), hasCode('access_required', 403), mode);
      await assert.rejects(access.authorize(identity(ownerSubject, 1, { subject: '' })), hasCode('access_required', 403), mode);
    }
    await assert.rejects(accountAccess(store).validateDelegation(local), hasCode('access_required', 403));
  } finally {
    await store.close();
  }
});

test('development mode returns every identity unchanged without reading the store', async () => {
  const store = new SqliteStore();
  try {
    let reads = 0;
    const counting: Store = Object.assign(Object.create(store) as Store, {
      get: async <T>(kind: string, id: string, ownerId: string) => { reads += 1; return store.get<T>(kind, id, ownerId); },
    });
    const access = new AccessService(counting, ownerSubject, undefined, 'development');
    const local: Principal = { id: 'local-owner', level: 1, scopes: ['*'] };
    assert.equal(await access.authorize(local), local);
    const signedIn = identity(memberSubject, 3, { scopes: ['chat:read'] });
    assert.equal(await access.authorize(signedIn), signedIn);
    assert.equal(reads, 0);
    assert.equal(await access.validateDelegation(local), true);
  } finally {
    await store.close();
  }
});

test('every authenticated route answers 403 access_required until the owner grants access', async () => {
  const store = new SqliteStore();
  const server = await accessServer(store, accountAccess(store), {
    owner: identity(ownerSubject, 1),
    member: identity(memberSubject, 2),
  });
  const get = (url: string, bearer: string) => server.app.inject({ method: 'GET', url, headers: { authorization: `Bearer ${bearer}` } });
  try {
    for (const url of ['/v1/session', '/v1/conversations', '/v1/tasks']) {
      const denied = await get(url, 'member');
      assert.equal(denied.statusCode, 403, `${url}: ${denied.body}`);
      assert.deepEqual(denied.json(), { error: { code: 'access_required', message: 'Kian access has not been granted' } });
    }
    assert.equal((await get('/v1/session', 'stranger')).statusCode, 401);
    assert.equal((await get('/health/live', 'member')).statusCode, 200);

    const granted = await server.app.inject({
      method: 'PUT', url: `/v1/access/${principalId(memberSubject)}`, headers: { authorization: 'Bearer owner' },
      payload: { scopes: ['chat:read'], enabled: true },
    });
    assert.equal(granted.statusCode, 200, granted.body);
    const session = await get('/v1/session', 'member');
    assert.equal(session.statusCode, 200, session.body);
    assert.deepEqual(session.json().data.scopes, ['chat:read']);
    assert.equal((await get('/v1/conversations', 'member')).statusCode, 200);
    const outside = await get('/v1/tasks', 'member');
    assert.equal(outside.statusCode, 403, outside.body);
    assert.equal(outside.json().error.code, 'forbidden');
  } finally {
    await server.close();
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx --test test/access.test.ts`

Expected: `ℹ tests 5`, `ℹ pass 1`, `ℹ fail 4`. The second test already passes. The four failures are:

```
✖ a signed-in principal without an access record is rejected with access_required
  AssertionError [ERR_ASSERTION]: Missing expected rejection: account
✖ a principal without issuer or subject is rejected outside development mode
  AssertionError [ERR_ASSERTION]: Missing expected rejection: account
✖ development mode returns every identity unchanged without reading the store
  AssertionError [ERR_ASSERTION]: Expected "actual" to be reference-equal to "expected":
✖ every authenticated route answers 403 access_required until the owner grants access
  AssertionError [ERR_ASSERTION]: /v1/session: {"data":{...,"level":2,"scopes":["chat:read","chat:write",...]}}
  200 !== 403
```

- [ ] **Step 3: Write minimal implementation**

In `src/access.ts` replace these two existing lines (the second one is the 18-scope default list that is being removed):

```ts
export interface AccessGrant { scopes: string[]; enabled: boolean }
const defaultScopes = ['chat:read', 'chat:write', 'task:read', 'task:write', 'memory:read', 'memory:write', 'agent:read', 'agent:write', 'schedule:read', 'schedule:write', 'model:read', 'notification:read', 'notification:write', 'artifact:read', 'artifact:write', 'workspace:read', 'device:read', 'approval:write'];
```

with:

```ts
export interface AccessGrant { scopes: string[]; enabled: boolean }

function accessRequired(): DomainError {
  return new DomainError('access_required', 'Kian access has not been granted', 403);
}
```

Then replace the existing method:

```ts
  async authorize(identity: Principal): Promise<Principal> {
    if (!identity.issuer || !identity.subject) return identity;
    const grant = await this.store.get<AccessGrant>('access', identity.id, identity.id);
    if (grant && !grant.data.enabled) throw new DomainError('access_revoked', 'Kian access has been revoked', 403);
    const scopes = identity.subject === this.ownerSubject ? ['*'] : grant?.data.scopes ?? defaultScopes;
    return { ...identity, ...(identity.subject === this.ownerSubject ? { level: 1 as const } : {}), scopes };
  }
```

with:

```ts
  async authorize(identity: Principal): Promise<Principal> {
    if (this.identityMode === 'development') return identity;
    if (!identity.issuer || !identity.subject) throw accessRequired();
    const grant = await this.store.get<AccessGrant>('access', identity.id, identity.id);
    if (grant && !grant.data.enabled) throw new DomainError('access_revoked', 'Kian access has been revoked', 403);
    if (identity.subject === this.ownerSubject) return { ...identity, level: 1, scopes: ['*'] };
    if (!grant) throw accessRequired();
    return { ...identity, scopes: [...grant.data.scopes] };
  }
```

Do not touch `grant` or `validateDelegation` in this task. `validateDelegation` calls `this.authorize(principal)` first, so it now rejects with `access_required` for a stored principal that is no longer admitted; both callers (`src/bootstrap.ts` and the fallback in `src/http/server.ts`) let that error propagate.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx tsx --test test/access.test.ts test/auth.test.ts`

Expected: `ℹ tests 12`, `ℹ pass 12`, `ℹ fail 0`.

Run: `npx tsc --noEmit`

Expected: no output, exit code 0.

- [ ] **Step 5: Commit**

```bash
git add src/access.ts test/access.test.ts
git commit -m "修復：沒有存取紀錄的非擁有者預設拒絕存取"
```

---

### Task 3: A2 level floor for non-owners

**Files:**
- Modify: `src/access.ts` (`AccessService.authorize`, the last two lines of the method as written in Task 2)
- Test: `test/access.test.ts` (import block at the top; append at the end)

**Interfaces:**
- Consumes: Task 2's `AccessService.authorize` and the fixtures of `test/access.test.ts` (`identity`, `accountAccess`, `storeRecord`, `accessServer`, `reauthorizeWith`, `hasCode`, `accountCheck`, `conversation`, `ownerSubject`, `memberSubject`, `serviceToken`). Existing repo APIs: `requireOwner(principal: Principal): void` from `src/auth.ts` (throws `owner_required`, 403, when `level !== 1`); `new TaskService(store, runner, { reauthorize })`, `TaskService.enqueue(principal, conversationId, prompt)`, `TaskService.drain()`, `TaskService.close()` from `src/tasks.ts`.
- Produces: `AccessService.authorize` returns `level: 1` only for the configured owner subject; every other admitted principal gets `level = Math.max(identity.level, 2)`. Applying `authorize` to its own output returns a deep-equal principal. Plan C relies on this ("level floor").

No other file changes: the three existing owner checks (`requireOwner` in `src/auth.ts`, `assertScheduleActor` in `src/scheduler.ts`, `assertOwnerActor` in `src/event-triggers.ts`) test `level !== 1` and become correct once level 1 can only come from `developmentAuth` or from `AccessService` for the owner subject. `revalidatedPrincipal` in `src/tasks.ts` keeps `Math.max(granted.level, current.level)`, which raises a stale stored level 1 to the floored value.

- [ ] **Step 1: Write the failing test**

In `test/access.test.ts` replace the import block lines:

```ts
import { AccessService, type AccessGrant } from '../src/access.js';
import { DomainError, type Principal } from '../src/contracts.js';
import type { Conversation } from '../src/domain.js';
import { createServer } from '../src/http/server.js';
import { SqliteStore } from '../src/storage/sqlite.js';
import type { Store } from '../src/storage/store.js';
```

with:

```ts
import { AccessService, type AccessGrant } from '../src/access.js';
import { requireOwner } from '../src/auth.js';
import { DomainError, type Principal } from '../src/contracts.js';
import type { Conversation, Task } from '../src/domain.js';
import { createServer } from '../src/http/server.js';
import { SqliteStore } from '../src/storage/sqlite.js';
import type { Store } from '../src/storage/store.js';
import { TaskService } from '../src/tasks.js';
```

Then append to the end of `test/access.test.ts`:

```ts

// ---------------------------------------------------------------------------
// A2: level floor
// ---------------------------------------------------------------------------

test('a non-owner that the identity service reports as level 1 is floored to level 2 and cannot use owner routes', async () => {
  const store = new SqliteStore();
  const access = accountAccess(store);
  await storeRecord(store, memberSubject, ['memory:read', 'chat:read']);
  const server = await accessServer(store, access, {
    owner: identity(ownerSubject, 4),
    member: identity(memberSubject, 1),
  });
  const get = (url: string, bearer: string) => server.app.inject({ method: 'GET', url, headers: { authorization: `Bearer ${bearer}` } });
  try {
    const member = await access.authorize(identity(memberSubject, 1));
    assert.equal(member.level, 2);
    assert.throws(() => requireOwner(member), hasCode('owner_required', 403));

    const session = await get('/v1/session', 'member');
    assert.equal(session.statusCode, 200, session.body);
    assert.equal(session.json().data.level, 2);
    const reviews = await get('/v1/memories/reviews', 'member');
    assert.equal(reviews.statusCode, 403, reviews.body);
    assert.equal(reviews.json().error.code, 'owner_required');

    const ownerSession = await get('/v1/session', 'owner');
    assert.equal(ownerSession.json().data.level, 1);
    assert.equal((await get('/v1/memories/reviews', 'owner')).statusCode, 200);
  } finally {
    await server.close();
  }
});

test('only the configured owner subject is level 1, whatever level is reported', async () => {
  const store = new SqliteStore();
  try {
    await storeRecord(store, memberSubject, ['chat:read']);
    const access = accountAccess(store);
    assert.equal((await access.authorize(identity(ownerSubject, 5))).level, 1);
    assert.equal((await access.authorize(identity(memberSubject, 1))).level, 2);
    assert.equal((await access.authorize(identity(memberSubject, 2))).level, 2);
    assert.equal((await access.authorize(identity(memberSubject, 3))).level, 3);
    assert.equal((await access.authorize(identity(memberSubject, 4))).level, 4);

    const once = await access.authorize(identity(memberSubject, 1));
    assert.deepEqual(await access.authorize(once), once, 'authorize is idempotent on a stored, already authorized principal');

    for (const unset of [undefined, '']) {
      const ownerless = new AccessService(store, unset, serviceToken, 'account', undefined, accountCheck().fetcher);
      assert.equal((await ownerless.authorize(identity(memberSubject, 1))).level, 2, 'nobody is level 1 without a configured owner');
      await assert.rejects(ownerless.authorize(identity(ownerSubject, 1)), hasCode('access_required', 403));
    }

    const oidc = new AccessService(store, ownerSubject, undefined, 'oidc');
    assert.equal((await oidc.authorize(identity(ownerSubject, 5))).level, 1);
  } finally {
    await store.close();
  }
});

test('a stored task principal with a stale level 1 is persisted as level 2 at the next revalidation', async () => {
  const store = new SqliteStore();
  const access = accountAccess(store);
  const service = new TaskService(store, async () => ({ text: 'done' }), { reauthorize: reauthorizeWith(access) });
  try {
    await storeRecord(store, memberSubject, ['chat:read']);
    const stale: Principal = { ...identity(memberSubject, 1), scopes: ['chat:read'] };
    const thread = await store.create<Conversation>('conversation', stale.id, conversation);
    const task = await service.enqueue(stale, thread.id, 'answer');
    assert.equal(task.data.principal.level, 1);
    await service.drain();
    const finished = await store.get<Task>('task', task.id, stale.id);
    assert.equal(finished?.data.state, 'completed', finished?.data.error);
    assert.equal(finished?.data.principal.level, 2);
    assert.deepEqual(finished?.data.principal.scopes, ['chat:read']);
  } finally {
    await service.close();
    await store.close();
  }
});
```

`GET /v1/memories/reviews` is used because it is an owner-only route (`requireOwner` in `src/memory-conflicts.ts`) whose scope, `memory:read`, stays inside the level ceiling that Task 4 introduces, so this test keeps passing after Task 4.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx --test test/access.test.ts`

Expected: `ℹ tests 8`, `ℹ pass 5`, `ℹ fail 3`. Each of the three new tests fails on its first level assertion:

```
✖ a non-owner that the identity service reports as level 1 is floored to level 2 and cannot use owner routes
  AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:
  1 !== 2
✖ only the configured owner subject is level 1, whatever level is reported
  1 !== 2
✖ a stored task principal with a stale level 1 is persisted as level 2 at the next revalidation
  1 !== 2
```

- [ ] **Step 3: Write minimal implementation**

In `src/access.ts`, inside `authorize`, replace these existing lines:

```ts
    if (!grant) throw accessRequired();
    return { ...identity, scopes: [...grant.data.scopes] };
```

with:

```ts
    if (!grant) throw accessRequired();
    const level = Math.max(identity.level, 2) as Principal['level'];
    return { ...identity, level, scopes: [...grant.data.scopes] };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx tsx --test test/access.test.ts`

Expected: `ℹ tests 8`, `ℹ pass 8`, `ℹ fail 0`.

Run: `npx tsc --noEmit`

Expected: no output, exit code 0.

- [ ] **Step 5: Commit**

```bash
git add src/access.ts test/access.test.ts
git commit -m "修復：只有設定的擁有者可取得第一級，其他主體最低為第二級"
```

---

### Task 4: A3 level ceilings

**Files:**
- Modify: `src/access.ts` (import line 1; the block above `class AccessService`; the constructor parameter list, lines 11-18 as of commit 17d571f; the end of `authorize` as written in Task 3; the scope-coverage line of `validateDelegation`, line 39 as of commit 17d571f)
- Test: `test/access.test.ts` (import line, the `accountAccess` helper, append at the end)

**Interfaces:**
- Consumes: `scopeAllows(grants: readonly string[], scope: string): boolean` from Task 1; `accessRequired()` and the `authorize` body from Tasks 2 and 3; the fixtures of `test/access.test.ts`.
- Produces:
  - `export type LevelCeilings = Partial<Record<2 | 3 | 4 | 5, readonly string[]>>` in `src/access.ts`.
  - `AccessService` constructor gains a seventh optional parameter; the first six are unchanged: `(store: Store, ownerSubject?: string, serviceToken?: string, identityMode: 'account' | 'oidc' | 'development' = 'account', accountApiUrl?: string, fetcher: typeof fetch = fetch, levelCeilings: LevelCeilings = {})`.
  - `AccessService.authorize`: for a non-owner the scopes are the two-way intersection of the record scopes and the ceiling of its level (`levelCeilings[level]` when present, otherwise the built-in ceiling), under `scopeAllows`: every record scope the ceiling allows, followed by every ceiling scope the record allows, without duplicates. An empty result rejects with `access_required` (403). Built-in ceilings: levels 2, 3 and 4 share the 17 scopes `chat:read`, `chat:write`, `task:read`, `task:write`, `memory:read`, `memory:write`, `agent:read`, `agent:write`, `artifact:read`, `artifact:write`, `notification:read`, `notification:write`, `model:read`, `workspace:read`, `device:read`, `approval:write`, `schedule:read`; level 5 is empty.
  - `AccessService.validateDelegation(principal: Principal): Promise<boolean>` (signature unchanged): stored scopes are compared with `scopeAllows` instead of exact string or literal `'*'`. Everything after that line is untouched (plan C rewrites it).
  - Test fixtures added to `test/access.test.ts`: `accountAccess(store: Store, fetcher: typeof fetch = accountCheck().fetcher, levelCeilings: LevelCeilings = {}): AccessService`; `const conversationalCeiling: string[]`; `const legacyDefaultScopes: string[]`; `effectiveScopesOf(recordScopes: string[], level: Principal['level'] = 2, levelCeilings: LevelCeilings = {}): Promise<string[]>`.

Why a two-way intersection and not a plain filter: a record scope such as `chat:*`, `kiancode:chat:read` or a legacy `*` is not itself a member of the ceiling, so a one-way filter would silently leave that principal with nothing. Every scope that is kept is one the other side allows, so wildcard or prefixed record forms become the plain ceiling names they cover; with the built-in ceilings (plain names only) the result is exactly the ceiling scopes the record allows. The rule works entry by entry and is not a full intersection of two wildcard languages: when an operator override and a record both use wildcard or `kiancode:`-prefixed entries, a scope both sides allow can be dropped (`chat:*` against `kiancode:chat:read` keeps nothing), and the one form `kiancode:<namespace>:*` on one side is matched by `<namespace>:*` on the other. Both corners are accepted; do not add a second matcher for them.

- [ ] **Step 1: Write the failing test**

In `test/access.test.ts` replace the import line:

```ts
import { AccessService, type AccessGrant } from '../src/access.js';
```

with:

```ts
import { AccessService, type AccessGrant, type LevelCeilings } from '../src/access.js';
```

Replace the existing helper:

```ts
/** Account-mode AccessService whose owner is `ownerSubject`. */
function accountAccess(store: Store, fetcher: typeof fetch = accountCheck().fetcher): AccessService {
  return new AccessService(store, ownerSubject, serviceToken, 'account', undefined, fetcher);
}
```

with:

```ts
/** Account-mode AccessService whose owner is `ownerSubject`; `levelCeilings` overrides the built-in ceilings. */
function accountAccess(
  store: Store,
  fetcher: typeof fetch = accountCheck().fetcher,
  levelCeilings: LevelCeilings = {},
): AccessService {
  return new AccessService(store, ownerSubject, serviceToken, 'account', undefined, fetcher, levelCeilings);
}
```

Then append to the end of `test/access.test.ts`:

```ts

// ---------------------------------------------------------------------------
// A3: level ceilings
// ---------------------------------------------------------------------------

/** The built-in ceiling shared by levels 2, 3 and 4, in the order AccessService declares it. */
const conversationalCeiling = [
  'chat:read', 'chat:write', 'task:read', 'task:write', 'memory:read', 'memory:write',
  'agent:read', 'agent:write', 'artifact:read', 'artifact:write', 'notification:read', 'notification:write',
  'model:read', 'workspace:read', 'device:read', 'approval:write', 'schedule:read',
];

/** The scope list that was handed to every non-owner before default-deny (18 entries). */
const legacyDefaultScopes = [
  'chat:read', 'chat:write', 'task:read', 'task:write', 'memory:read', 'memory:write', 'agent:read', 'agent:write',
  'schedule:read', 'schedule:write', 'model:read', 'notification:read', 'notification:write', 'artifact:read',
  'artifact:write', 'workspace:read', 'device:read', 'approval:write',
];

/** Effective scopes of `memberSubject` at `level` when its record holds `recordScopes`. */
async function effectiveScopesOf(
  recordScopes: string[],
  level: Principal['level'] = 2,
  levelCeilings: LevelCeilings = {},
): Promise<string[]> {
  const store = new SqliteStore();
  try {
    await storeRecord(store, memberSubject, recordScopes);
    const access = accountAccess(store, accountCheck().fetcher, levelCeilings);
    return (await access.authorize(identity(memberSubject, level))).scopes;
  } finally {
    await store.close();
  }
}

test('a legacy record with wildcard, tool and admin scopes is clamped to the level ceiling', async () => {
  const legacy = [...legacyDefaultScopes, 'shell:execute', 'workspace:write', 'admin:grant', '*', 'kiancode:*'];
  for (const level of [2, 3, 4] as const) {
    const scopes = await effectiveScopesOf(legacy, level);
    assert.equal(scopes.length, 17, `level ${level}: ${scopes.join(' ')}`);
    assert.deepEqual([...scopes].sort(), [...conversationalCeiling].sort(), `level ${level}`);
    assert.equal(scopes.includes('schedule:write'), false);
  }
  assert.deepEqual(await effectiveScopesOf(['*']), conversationalCeiling);
  assert.deepEqual(await effectiveScopesOf(['kiancode:*'], 4), conversationalCeiling);
});

test('record scopes in wildcard or prefixed form are reduced to the ceiling scopes they cover', async () => {
  assert.deepEqual(await effectiveScopesOf(['chat:read', 'shell:execute']), ['chat:read']);
  assert.deepEqual(await effectiveScopesOf(['chat:*']), ['chat:read', 'chat:write']);
  assert.deepEqual(await effectiveScopesOf(['chat:read', 'chat:*']), ['chat:read', 'chat:write']);
  assert.deepEqual(await effectiveScopesOf(['kiancode:chat:read']), ['chat:read']);
  assert.deepEqual(await effectiveScopesOf(['schedule:*']), ['schedule:read']);
});

test('level 5 and an empty effective scope set are rejected with access_required', async () => {
  await assert.rejects(effectiveScopesOf(['chat:read'], 5), hasCode('access_required', 403));
  await assert.rejects(effectiveScopesOf(['*'], 5), hasCode('access_required', 403));
  await assert.rejects(effectiveScopesOf([], 3), hasCode('access_required', 403));
  await assert.rejects(effectiveScopesOf(['shell:execute', 'workspace:write', 'admin:grant'], 3), hasCode('access_required', 403));

  const store = new SqliteStore();
  try {
    await storeRecord(store, memberSubject, ['chat:read']);
    const oidc = new AccessService(store, ownerSubject, undefined, 'oidc');
    await assert.rejects(oidc.authorize(identity(memberSubject, 5)), hasCode('access_required', 403));
    const owner = await oidc.authorize(identity(ownerSubject, 5));
    assert.equal(owner.level, 1);
    assert.deepEqual(owner.scopes, ['*']);
  } finally {
    await store.close();
  }
});

test('a configured ceiling replaces the built-in one for that level only', async () => {
  assert.deepEqual(await effectiveScopesOf(['chat:read', 'chat:write'], 5, { 5: ['chat:read'] }), ['chat:read']);
  assert.deepEqual(await effectiveScopesOf(['chat:read', 'chat:write'], 2, { 5: ['chat:read'] }), ['chat:read', 'chat:write']);
  await assert.rejects(effectiveScopesOf(['chat:read'], 3, { 3: [] }), hasCode('access_required', 403));
  assert.deepEqual(await effectiveScopesOf(['chat:read'], 2, { 3: [] }), ['chat:read']);
  assert.deepEqual(await effectiveScopesOf(['shell:execute'], 2, { 2: ['*'] }), ['shell:execute']);
  assert.deepEqual(await effectiveScopesOf(['chat:read'], 2, { 2: ['chat:*'] }), ['chat:read']);
  assert.deepEqual(await effectiveScopesOf(['chat:*'], 2, { 2: ['chat:*'] }), ['chat:*']);
  await assert.rejects(effectiveScopesOf(['task:read'], 2, { 2: ['chat:*'] }), hasCode('access_required', 403));
});

test('validateDelegation accepts stored scopes covered by a wildcard grant and rejects scopes outside it', async () => {
  const store = new SqliteStore();
  try {
    await storeRecord(store, memberSubject, ['chat:*']);
    const account = accountCheck();
    const access = accountAccess(store, account.fetcher, { 2: ['chat:*'] });
    assert.equal(await access.validateDelegation({ ...identity(memberSubject, 2), scopes: ['chat:read'] }), true);
    assert.equal(account.requests.length, 1);
    assert.equal(await access.validateDelegation({ ...identity(memberSubject, 2), scopes: ['chat:read', 'shell:execute'] }), false);
    assert.equal(account.requests.length, 1, 'a scope outside the grant is refused before the Account check');
    assert.equal(await access.validateDelegation({ ...identity(ownerSubject, 1), scopes: ['workspace:write', '*'] }), true);
    assert.equal(
      await access.validateDelegation({ ...identity(memberSubject, 2), scopes: ['chat:read'], expiresAt: new Date(Date.now() - 1_000).toISOString() }),
      false,
    );
    const oidc = new AccessService(store, ownerSubject, undefined, 'oidc');
    assert.equal(await oidc.validateDelegation({ ...identity(ownerSubject, 1), scopes: ['*'], expiresAt: undefined }), false);
  } finally {
    await store.close();
  }
});

test('a stored task keeps its narrowed scopes, and one holding a scope outside the ceiling pauses with grant_revoked', async () => {
  const store = new SqliteStore();
  const access = accountAccess(store);
  const prompts: string[] = [];
  const service = new TaskService(store, async ({ task }) => { prompts.push(task.data.prompt); return { text: 'done' }; }, {
    reauthorize: reauthorizeWith(access),
  });
  try {
    await storeRecord(store, memberSubject, legacyDefaultScopes);
    const member = identity(memberSubject, 2);
    const thread = await store.create<Conversation>('conversation', member.id, conversation);
    const narrowed = await service.enqueue({ ...member, scopes: ['memory:read'] }, thread.id, 'narrowed');
    const stale = await service.enqueue({ ...member, scopes: ['chat:read', 'schedule:write'] }, thread.id, 'stale');
    await service.drain();

    const kept = await store.get<Task>('task', narrowed.id, member.id);
    assert.equal(kept?.data.state, 'completed', kept?.data.error);
    assert.deepEqual(kept?.data.principal.scopes, ['memory:read']);
    const paused = await store.get<Task>('task', stale.id, member.id);
    assert.equal(paused?.data.state, 'paused');
    assert.match(paused?.data.error ?? '', /expired or been revoked/);
    assert.deepEqual(prompts, ['narrowed']);
  } finally {
    await service.close();
    await store.close();
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx --test test/access.test.ts`

Expected: `ℹ tests 14`, `ℹ pass 8`, `ℹ fail 6`. (`tsx` erases the type-only `LevelCeilings` import, so the file loads and the new tests fail on their assertions.) The six failures start with:

```
✖ a legacy record with wildcard, tool and admin scopes is clamped to the level ceiling
  AssertionError [ERR_ASSERTION]: level 2: chat:read chat:write ... shell:execute workspace:write admin:grant * kiancode:*
  23 !== 17
✖ record scopes in wildcard or prefixed form are reduced to the ceiling scopes they cover
  actual: [ 'chat:read', 'shell:execute' ], expected: [ 'chat:read' ]
✖ level 5 and an empty effective scope set are rejected with access_required
  AssertionError [ERR_ASSERTION]: Missing expected rejection.
✖ a configured ceiling replaces the built-in one for that level only
  actual: [ 'chat:read', 'chat:write' ], expected: [ 'chat:read' ]
✖ validateDelegation accepts stored scopes covered by a wildcard grant and rejects scopes outside it
  false !== true
✖ a stored task keeps its narrowed scopes, and one holding a scope outside the ceiling pauses with grant_revoked
  + 'completed'
  - 'paused'
```

- [ ] **Step 3: Write minimal implementation**

All five edits are in `src/access.ts`.

(a) Replace the first import line:

```ts
import { requireScope, secureAccountApiOrigin } from './auth.js';
```

with:

```ts
import { requireScope, scopeAllows, secureAccountApiOrigin } from './auth.js';
```

(b) Replace the block written in Task 2:

```ts
export interface AccessGrant { scopes: string[]; enabled: boolean }

function accessRequired(): DomainError {
  return new DomainError('access_required', 'Kian access has not been granted', 403);
}
```

with:

```ts
export interface AccessGrant { scopes: string[]; enabled: boolean }

/** Operator overrides of the built-in scope ceiling, per non-owner level. An override replaces the whole list. */
export type LevelCeilings = Partial<Record<2 | 3 | 4 | 5, readonly string[]>>;

const conversationalCeiling: readonly string[] = [
  'chat:read', 'chat:write', 'task:read', 'task:write', 'memory:read', 'memory:write',
  'agent:read', 'agent:write', 'artifact:read', 'artifact:write', 'notification:read', 'notification:write',
  'model:read', 'workspace:read', 'device:read', 'approval:write', 'schedule:read',
];
const builtInCeilings: Record<2 | 3 | 4 | 5, readonly string[]> = {
  2: conversationalCeiling,
  3: conversationalCeiling,
  4: conversationalCeiling,
  5: [],
};

function accessRequired(): DomainError {
  return new DomainError('access_required', 'Kian access has not been granted', 403);
}

/** Record scopes the ceiling allows, plus ceiling scopes the record allows, without duplicates. */
function intersectScopes(record: readonly string[], ceiling: readonly string[]): string[] {
  return [...new Set([
    ...record.filter((scope) => scopeAllows(ceiling, scope)),
    ...ceiling.filter((scope) => scopeAllows(record, scope)),
  ])];
}
```

(c) In the constructor parameter list replace:

```ts
    accountApiUrl?: string,
    private fetcher: typeof fetch = fetch,
  ) {
```

with:

```ts
    accountApiUrl?: string,
    private fetcher: typeof fetch = fetch,
    private levelCeilings: LevelCeilings = {},
  ) {
```

(d) In `authorize` replace the lines written in Task 3:

```ts
    if (!grant) throw accessRequired();
    const level = Math.max(identity.level, 2) as Principal['level'];
    return { ...identity, level, scopes: [...grant.data.scopes] };
```

with:

```ts
    if (!grant) throw accessRequired();
    const level = Math.max(identity.level, 2) as 2 | 3 | 4 | 5;
    const scopes = intersectScopes(grant.data.scopes, this.levelCeilings[level] ?? builtInCeilings[level]);
    if (scopes.length === 0) throw accessRequired();
    return { ...identity, level, scopes };
```

(e) In `validateDelegation` replace the existing line:

```ts
    if (!principal.scopes.every((scope) => fresh.scopes.includes('*') || fresh.scopes.includes(scope))) return false;
```

with:

```ts
    if (!principal.scopes.every((scope) => scopeAllows(fresh.scopes, scope))) return false;
```

Leave every other line of `validateDelegation` exactly as it is.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx tsx --test test/access.test.ts test/auth.test.ts`

Expected: `ℹ tests 21`, `ℹ pass 21`, `ℹ fail 0`. The existing test `account API endpoint is separate from the canonical identity issuer` in `test/auth.test.ts` passes unmodified (same request order and URLs).

Run: `npx tsc --noEmit`

Expected: no output, exit code 0.

- [ ] **Step 5: Commit**

```bash
git add src/access.ts test/access.test.ts
git commit -m "實現：非擁有者的有效權限受等級上限約束"
```

---

### Task 5: `access_required` pauses tasks and disables automations

**Files:**
- Modify: `src/tasks.ts` (`authorizationPauseCodes`, lines 956-962 as of commit 17d571f)
- Modify: `src/scheduler.ts` (`permanentAuthorizationCodes`, lines 85-96 as of commit 17d571f)
- Modify: `src/event-triggers.ts` (`permanentAuthorizationCodes`, lines 174-185 as of commit 17d571f)
- Test: `test/access.test.ts` (import block; append at the end)

**Interfaces:**
- Consumes: `AccessService.authorize` / `validateDelegation` rejecting with `access_required` (Tasks 2 and 4); the fixtures of `test/access.test.ts`. Existing repo APIs: `TaskService.control(ownerId, id, 'resume', hashes, actor)`, `TaskService.events(ownerId, taskId)`, `TaskService.setReconciler(fn)`; `new SchedulerService(store, dispatcher, { enabled, now, reauthorize })` with `create(actor, input)` and `reconcile()`; `new EventTriggerService(store, dispatcher, { enabled, reauthorize })` with `create`, `ingestWebhook`, `reconcile`, `list`; `new AutomationDispatcher(store, tasks, now?)`; `new NotificationService(store, { now })`.
- Produces: the string `'access_required'` is the first entry of `authorizationPauseCodes` (`src/tasks.ts`) and of both `permanentAuthorizationCodes` sets (`src/scheduler.ts`, `src/event-triggers.ts`). Consequences: a task whose revalidation rejects with `access_required` becomes `paused` with `pauseRequested: true` and the error message preserved; a schedule occurrence or event inbox item becomes `rejected` with `rejectionCode: 'access_required'` and its schedule or trigger is disabled. No new event types, entity kinds or fields. Plan C relies on the entry being at the top of each set.

Only a code is added to three sets. The order of the task failure classifier in `TaskService` (`waiting_for_device`, then authorization pause, then unresolved side effect → `unknown`, then aborted → `queued`, then `failed`) is not touched, so dispatched, confirmed and unknown outcomes stay distinguished.

- [ ] **Step 1: Write the failing test**

In `test/access.test.ts` replace the import lines:

```ts
import type { Conversation, Task } from '../src/domain.js';
import { createServer } from '../src/http/server.js';
import { SqliteStore } from '../src/storage/sqlite.js';
import type { Store } from '../src/storage/store.js';
import { TaskService } from '../src/tasks.js';
```

with:

```ts
import type { Conversation, Task } from '../src/domain.js';
import { AutomationDispatcher, EventTriggerService, type EventInboxItem } from '../src/event-triggers.js';
import { createServer } from '../src/http/server.js';
import { NotificationService } from '../src/notifications.js';
import { SchedulerService, type AutomationSchedule, type ScheduleOccurrence } from '../src/scheduler.js';
import { SqliteStore } from '../src/storage/sqlite.js';
import type { Store } from '../src/storage/store.js';
import { TaskService } from '../src/tasks.js';
```

Then append to the end of `test/access.test.ts`:

```ts

// ---------------------------------------------------------------------------
// access_required in background work: tasks pause, automations are rejected and disabled
// ---------------------------------------------------------------------------

test('a task whose principal has no access record pauses and resumes after the owner grants access', async () => {
  const store = new SqliteStore();
  const access = accountAccess(store);
  let runs = 0;
  const service = new TaskService(store, async () => { runs += 1; return { text: 'done' }; }, {
    reauthorize: reauthorizeWith(access),
    notifications: new NotificationService(store),
  });
  try {
    const member: Principal = { ...identity(memberSubject, 2), scopes: ['chat:read'] };
    const thread = await store.create<Conversation>('conversation', member.id, conversation);
    const task = await service.enqueue(member, thread.id, 'answer');
    await service.drain();

    const paused = await store.get<Task>('task', task.id, member.id);
    assert.equal(paused?.data.state, 'paused', paused?.data.error);
    assert.equal(paused?.data.pauseRequested, true);
    assert.equal(paused?.data.error, 'Kian access has not been granted');
    assert.equal(runs, 0);
    const notifications = await store.scan<{ type: string }>('notification', member.id);
    assert.equal(notifications.some((row) => row.data.type === 'task_failed'), false);

    await storeRecord(store, memberSubject, ['chat:read']);
    await service.control(member.id, task.id, 'resume', [], await access.authorize(identity(memberSubject, 2)));
    await service.drain();
    const finished = await store.get<Task>('task', task.id, member.id);
    assert.equal(finished?.data.state, 'completed', finished?.data.error);
    assert.equal(runs, 1);
  } finally {
    await service.close();
    await store.close();
  }
});

test('access_required at tool dispatch pauses the task without recording a dispatch', async () => {
  const store = new SqliteStore();
  const access = accountAccess(store);
  const member: Principal = { ...identity(memberSubject, 2), scopes: ['chat:read'] };
  let actionRan = false;
  const service = new TaskService(store, async ({ onEvent }) => {
    const record = await store.get('access', member.id, member.id);
    assert.ok(record);
    await store.remove('access', member.id, member.id, record.revision);
    await onEvent({ type: 'tool_dispatched', toolCallId: 'write-1', sideEffect: 'write' });
    actionRan = true;
    return { text: 'done' };
  }, { reauthorize: reauthorizeWith(access) });
  try {
    await storeRecord(store, memberSubject, ['chat:read']);
    const thread = await store.create<Conversation>('conversation', member.id, conversation);
    const task = await service.enqueue(member, thread.id, 'write something');
    await service.drain();

    assert.equal(actionRan, false);
    const stopped = await store.get<Task>('task', task.id, member.id);
    assert.equal(stopped?.data.state, 'paused', stopped?.data.error);
    const events = await service.events(member.id, task.id);
    assert.equal(events.some((event) => event.data.type === 'tool_dispatched'), false);
  } finally {
    await service.close();
    await store.close();
  }
});

test('a schedule whose stored actor is no longer admitted is rejected and disabled', async () => {
  const store = new SqliteStore();
  const access = accountAccess(store);
  const now = Date.now();
  const service = new TaskService(store, async () => ({ text: 'done' }), {
    now: () => now,
    notifications: new NotificationService(store, { now: () => new Date(now) }),
  });
  try {
    // A stored actor that was level 1 with every scope, but is not the configured owner subject.
    const former: Principal = { ...identity(memberSubject, 1), scopes: ['*'] };
    const thread = await store.create<Conversation>('conversation', former.id, conversation);
    const scheduler = new SchedulerService(store, new AutomationDispatcher(store, service, () => now), {
      enabled: true,
      now: () => now,
      reauthorize: reauthorizeWith(access),
    });
    const schedule = await scheduler.create(former, {
      name: 'Stale actor',
      prompt: 'scheduled',
      nextAt: new Date(now - 1_000).toISOString(),
      enabled: true,
      settings: { conversationId: thread.id, permissions: ['model:read'], notification: { type: 'in_app' } },
    });
    service.setReconciler(() => scheduler.reconcile());
    await service.drain();
    await service.drain();

    const occurrences = await store.scan<ScheduleOccurrence>('schedule_occurrence', former.id);
    assert.equal(occurrences.length, 1);
    assert.equal(occurrences[0]?.data.status, 'rejected');
    assert.equal(occurrences[0]?.data.rejectionCode, 'access_required');
    const stored = await store.get<AutomationSchedule>('automation_schedule', schedule.id, former.id);
    assert.equal(stored?.data.enabled, false);
    assert.ok(stored?.data.authorizationFailedAt);
    assert.equal((await store.scan<Task>('task', former.id)).length, 0);
    const notifications = await store.scan<{ type: string }>('notification', former.id);
    assert.deepEqual(notifications.map((row) => row.data.type), ['schedule_authorization_failed']);
  } finally {
    await service.close();
    await store.close();
  }
});

test('an event trigger whose stored actor is no longer admitted is rejected and disabled', async () => {
  const store = new SqliteStore();
  const access = accountAccess(store);
  const tasks = new TaskService(store, async () => ({ text: 'unused' }));
  try {
    const former: Principal = { ...identity(memberSubject, 1), scopes: ['*'] };
    const thread = await store.create<Conversation>('conversation', former.id, conversation);
    const triggers = new EventTriggerService(store, new AutomationDispatcher(store, tasks), {
      enabled: true,
      reauthorize: reauthorizeWith(access),
    });
    const created = await triggers.create(former, {
      name: 'Stale actor', prompt: 'Never run', enabled: true, type: 'webhook', filter: {},
      settings: { conversationId: thread.id, permissions: ['model:read'], notification: { type: 'none' } },
    });
    await triggers.ingestWebhook(created.trigger.data.webhook!.id, created.secret, {
      eventId: 'stale-1', eventName: 'test', payload: {},
    });
    await triggers.reconcile();

    const inbox = await store.scan<EventInboxItem>('event_inbox', former.id);
    assert.equal(inbox.length, 1);
    assert.equal(inbox[0]?.data.status, 'rejected');
    assert.equal(inbox[0]?.data.rejectionCode, 'access_required');
    assert.equal((await triggers.list(former.id))[0]?.data.enabled, false);
    assert.equal((await store.scan<Task>('task', former.id)).length, 0);
  } finally {
    await tasks.close();
    await store.close();
  }
});
```

The "stored actor" in the two automation tests is level 1 with `['*']` but is not the configured owner subject. That is the shape of a row written before this plan (when a reported level 1 was trusted) or before the owner subject was changed; `assertScheduleActor` / `assertOwnerActor` accept the stored row, and the real `AccessService` then rejects it at revalidation.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx --test test/access.test.ts`

Expected: `ℹ tests 18`, `ℹ pass 14`, `ℹ fail 4`:

```
✖ a task whose principal has no access record pauses and resumes after the owner grants access
  AssertionError [ERR_ASSERTION]: Kian access has not been granted
  'failed' !== 'paused'
✖ access_required at tool dispatch pauses the task without recording a dispatch
  AssertionError [ERR_ASSERTION]: Kian access has not been granted
  'failed' !== 'paused'
✖ a schedule whose stored actor is no longer admitted is rejected and disabled
  + 'pending'
  - 'rejected'
✖ an event trigger whose stored actor is no longer admitted is rejected and disabled
  + 'pending'
  - 'rejected'
```

- [ ] **Step 3: Write minimal implementation**

In `src/tasks.ts` replace:

```ts
const authorizationPauseCodes = new Set([
  'access_revoked',
```

with:

```ts
const authorizationPauseCodes = new Set([
  'access_required',
  'access_revoked',
```

In `src/scheduler.ts` replace:

```ts
const permanentAuthorizationCodes = new Set([
  'access_revoked',
```

with:

```ts
const permanentAuthorizationCodes = new Set([
  'access_required',
  'access_revoked',
```

In `src/event-triggers.ts` make the identical replacement (the set has the same name and the same first entry):

```ts
const permanentAuthorizationCodes = new Set([
  'access_revoked',
```

with:

```ts
const permanentAuthorizationCodes = new Set([
  'access_required',
  'access_revoked',
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx tsx --test test/access.test.ts test/tasks.test.ts test/event-triggers.test.ts`

Expected: `ℹ tests 53`, `ℹ pass 53`, `ℹ fail 0` (18 in `test/access.test.ts`; the existing task and automation suites are unchanged. If an earlier plan added tests to those two files the total is higher; `ℹ fail 0` is what matters).

Run: `npx tsc --noEmit`

Expected: no output, exit code 0.

- [ ] **Step 5: Commit**

```bash
git add src/tasks.ts src/scheduler.ts src/event-triggers.ts test/access.test.ts
git commit -m "修復：access_required 令任務暫停並停用排程與事件觸發"
```

---

### Task 6: A4 owner-only, validated access grants

**Files:**
- Modify: `src/access.ts` (import line 1; the constants above `accessRequired`; `AccessService.grant`, lines 29-33 as of commit 17d571f)
- Test: `test/access.test.ts` (append at the end)

**Interfaces:**
- Consumes: `scopeAllows(grants: readonly string[], scope: string): boolean` from Task 1; `requireOwner(principal: Principal): void` and `requireScope(principal: Principal, scope: string): void` from `src/auth.ts`; the fixtures of `test/access.test.ts` (`identity`, `principalId`, `accountAccess`, `accountCheck`, `storeRecord`, `accessServer`, `hasCode`, `ownerSubject`, `memberSubject`). The existing route in `src/http/server.ts`, which is **not edited**: `PUT /v1/access/:id` parses the body with `z.object({ scopes: z.array(z.string().min(1).max(100)).max(100), enabled: z.boolean() }).strict()` (a violation is 400 `invalid_input`) and returns `{ data: await options.access.grant(principal(request), params(request).id, body) }`; without an `AccessService` it answers 503 `unavailable`.
- Produces:
  - `AccessService.grant(actor: Principal, principalId: string, grant: AccessGrant)` (signature and return value unchanged). Checks run in this order and the first failure wins; nothing is written unless all pass:
    1. `requireOwner(actor)` → `owner_required`, 403 (a non-owner is refused even when its effective scopes contain `admin:grant`);
    2. `requireScope(actor, 'admin:grant')` → `forbidden`, 403;
    3. `principalId === actor.id` → `DomainError('invalid_principal', 'The owner does not need an access record', 400)` (every identity mode);
    4. outside development identity mode, `principalId` not matching `/^[0-9a-f]{64}$/` → `DomainError('invalid_principal', 'Access records are addressed by a 64-character lowercase hex principal id', 400)`;
    5. any scope not matching `/^[\x21-\x7e]{1,100}$/` → `DomainError('invalid_scope', 'Scopes must be 1 to 100 printable ASCII characters without spaces', 400)`;
    6. any scope `s` with `scopeAllows([s], 'admin:grant')` (that is `*`, `kiancode:*`, `admin:*`, `admin:grant`, `kiancode:admin:grant`) → ``DomainError('invalid_scope', `Scope cannot be granted: ${s}`, 400)``.
  - New error codes `invalid_principal` (400) and `invalid_scope` (400).
  - Test fixtures added to `test/access.test.ts`: `const otherSubject: string`; `putAccess(server, bearer: string, id: string, payload: unknown)` — `PUT /v1/access/:id` through `server.app.inject`.

The reserved-scope test is "would this single scope satisfy `requireScope(…, 'admin:grant')`", so it covers every form the matcher accepts and nothing else. Because of step 3 the owner can never disable itself: a disabled record on the owner's id is the one thing that locks the owner out (`access_revoked` is checked before the owner branch in `authorize`), and after this task no request can create one.

- [ ] **Step 1: Write the failing test**

Append to the end of `test/access.test.ts`:

```ts

// ---------------------------------------------------------------------------
// A4: grants
// ---------------------------------------------------------------------------

const otherSubject = `acct_${'c'.repeat(32)}`;

/** PUT /v1/access/:id as `bearer`. */
function putAccess(server: Awaited<ReturnType<typeof accessServer>>, bearer: string, id: string, payload: unknown) {
  return server.app.inject({
    method: 'PUT', url: `/v1/access/${encodeURIComponent(id)}`, headers: { authorization: `Bearer ${bearer}` }, payload: payload as object,
  });
}

test('only the owner can write access records, even when another principal holds admin:grant', async () => {
  const store = new SqliteStore();
  // A widened level-2 ceiling lets a legacy record carry admin:grant into the effective scopes.
  const access = accountAccess(store, accountCheck().fetcher, { 2: ['*'] });
  await storeRecord(store, memberSubject, ['admin:grant', 'chat:read']);
  const server = await accessServer(store, access, { owner: identity(ownerSubject, 1), member: identity(memberSubject, 1) });
  try {
    const member = await access.authorize(identity(memberSubject, 1));
    assert.deepEqual(member.scopes, ['admin:grant', 'chat:read']);
    const target = principalId(otherSubject);
    await assert.rejects(access.grant(member, target, { scopes: ['chat:read'], enabled: true }), hasCode('owner_required', 403));
    await assert.rejects(access.grant(member, member.id, { scopes: ['*'], enabled: true }), hasCode('owner_required', 403));
    const denied = await putAccess(server, 'member', target, { scopes: ['chat:read'], enabled: true });
    assert.equal(denied.statusCode, 403, denied.body);
    assert.equal(denied.json().error.code, 'owner_required');
    assert.equal(await store.get('access', target, target), undefined);

    const levelOneWithoutGrantScope: Principal = { ...identity(ownerSubject, 1), scopes: ['chat:read'] };
    await assert.rejects(access.grant(levelOneWithoutGrantScope, target, { scopes: ['chat:read'], enabled: true }), hasCode('forbidden', 403));
    assert.equal(await store.get('access', target, target), undefined);
  } finally {
    await server.close();
  }
});

test('the owner cannot write a record for its own id', async () => {
  const store = new SqliteStore();
  const access = accountAccess(store);
  const server = await accessServer(store, access, { owner: identity(ownerSubject, 1) });
  try {
    const ownerId = principalId(ownerSubject);
    for (const payload of [{ scopes: ['chat:read'], enabled: false }, { scopes: ['chat:read'], enabled: true }]) {
      const response = await putAccess(server, 'owner', ownerId, payload);
      assert.equal(response.statusCode, 400, response.body);
      assert.equal(response.json().error.code, 'invalid_principal');
    }
    assert.equal(await store.get('access', ownerId, ownerId), undefined);
    const session = await server.app.inject({ method: 'GET', url: '/v1/session', headers: { authorization: 'Bearer owner' } });
    assert.equal(session.statusCode, 200, session.body);

    const development = new AccessService(store, undefined, undefined, 'development');
    const local: Principal = { id: 'local-owner', level: 1, scopes: ['*'] };
    await assert.rejects(development.grant(local, local.id, { scopes: ['chat:read'], enabled: false }), hasCode('invalid_principal', 400));
  } finally {
    await server.close();
  }
});

test('in account and oidc modes the record id must be a 64-character lowercase hex principal id', async () => {
  const store = new SqliteStore();
  const access = accountAccess(store);
  const server = await accessServer(store, access, { owner: identity(ownerSubject, 1) });
  try {
    const valid = principalId(memberSubject);
    for (const id of [memberSubject, valid.toUpperCase(), valid.slice(1), `${valid}0`, 'local-owner']) {
      const response = await putAccess(server, 'owner', id, { scopes: ['chat:read'], enabled: true });
      assert.equal(response.statusCode, 400, `${id}: ${response.body}`);
      assert.equal(response.json().error.code, 'invalid_principal', id);
    }
    const oidc = new AccessService(store, ownerSubject, undefined, 'oidc');
    const oidcOwner = await oidc.authorize(identity(ownerSubject, 5));
    await assert.rejects(oidc.grant(oidcOwner, memberSubject, { scopes: ['chat:read'], enabled: true }), hasCode('invalid_principal', 400));
    assert.equal((await store.scan('access')).length, 0);

    const development = new AccessService(store, undefined, undefined, 'development');
    const local: Principal = { id: 'local-owner', level: 1, scopes: ['*'] };
    const written = await development.grant(local, 'device-user', { scopes: ['chat:read'], enabled: true });
    assert.equal(written.id, 'device-user');
  } finally {
    await server.close();
  }
});

test('reserved and malformed scopes are rejected with invalid_scope and nothing is written', async () => {
  const store = new SqliteStore();
  const access = accountAccess(store);
  const server = await accessServer(store, access, { owner: identity(ownerSubject, 1) });
  try {
    const target = principalId(memberSubject);
    const first = await putAccess(server, 'owner', target, { scopes: ['chat:read'], enabled: true });
    assert.equal(first.statusCode, 200, first.body);
    const before = await store.get<AccessGrant>('access', target, target);

    const invalidScope = [
      ['*'], ['kiancode:*'], ['admin:*'], ['admin:grant'], ['kiancode:admin:grant'],
      ['chat:read', 'admin:grant', 'task:read'],
      [' '], ['chat: read'], ['chat\tread'], ['chat\u0000read'], ['café:read'],
    ];
    for (const scopes of invalidScope) {
      const response = await putAccess(server, 'owner', target, { scopes, enabled: true });
      assert.equal(response.statusCode, 400, `${JSON.stringify(scopes)}: ${response.body}`);
      assert.equal(response.json().error.code, 'invalid_scope', JSON.stringify(scopes));
    }
    const invalidInput: unknown[] = [
      { scopes: [''], enabled: true },
      { scopes: ['x'.repeat(101)], enabled: true },
      { scopes: [7], enabled: true },
      { scopes: Array.from({ length: 101 }, (_, index) => `chat:${index}`), enabled: true },
      { scopes: ['chat:read'] },
      { scopes: ['chat:read'], enabled: true, level: 1 },
    ];
    for (const payload of invalidInput) {
      const response = await putAccess(server, 'owner', target, payload);
      assert.equal(response.statusCode, 400, `${JSON.stringify(payload).slice(0, 80)}: ${response.body}`);
      assert.equal(response.json().error.code, 'invalid_input');
    }
    const owner = await access.authorize(identity(ownerSubject, 1));
    await assert.rejects(access.grant(owner, target, { scopes: ['x'.repeat(101)], enabled: true }), hasCode('invalid_scope', 400));
    assert.deepEqual(await store.get<AccessGrant>('access', target, target), before);

    const accepted = await putAccess(server, 'owner', target, { scopes: ['mcp:MyPlugin', 'workspace:abc:read', 'chat:*'], enabled: true });
    assert.equal(accepted.statusCode, 200, accepted.body);
    assert.equal(accepted.json().data.revision, 2);
  } finally {
    await server.close();
  }
});

test('the owner grants, updates, disables and re-enables access over HTTP', async () => {
  const store = new SqliteStore();
  const server = await accessServer(store, accountAccess(store), {
    owner: identity(ownerSubject, 1),
    member: identity(memberSubject, 3),
  });
  const session = () => server.app.inject({ method: 'GET', url: '/v1/session', headers: { authorization: 'Bearer member' } });
  try {
    const target = principalId(memberSubject);
    const created = await putAccess(server, 'owner', target, { scopes: ['chat:read', 'task:read'], enabled: true });
    assert.equal(created.statusCode, 200, created.body);
    const row = created.json().data;
    assert.equal(row.id, target);
    assert.equal(row.ownerId, target);
    assert.equal(row.revision, 1);
    assert.deepEqual(row.data, { scopes: ['chat:read', 'task:read'], enabled: true });
    assert.deepEqual((await session()).json().data.scopes, ['chat:read', 'task:read']);

    const updated = await putAccess(server, 'owner', target, { scopes: ['chat:read'], enabled: true });
    assert.equal(updated.json().data.revision, 2);
    assert.deepEqual((await session()).json().data.scopes, ['chat:read']);

    assert.equal((await putAccess(server, 'owner', target, { scopes: ['chat:read'], enabled: false })).statusCode, 200);
    const revoked = await session();
    assert.equal(revoked.statusCode, 403, revoked.body);
    assert.equal(revoked.json().error.code, 'access_revoked');

    assert.equal((await putAccess(server, 'owner', target, { scopes: ['chat:read'], enabled: true })).statusCode, 200);
    assert.equal((await session()).statusCode, 200);
  } finally {
    await server.close();
  }
});

test('access management answers 503 when the server has no AccessService', async () => {
  const store = new SqliteStore();
  const server = await createServer({
    store,
    authenticate: async () => ({ id: 'local-owner', level: 1, scopes: ['*'] }),
    runner: async () => ({ text: 'unused' }),
  });
  try {
    const response = await server.app.inject({
      method: 'PUT', url: `/v1/access/${principalId(memberSubject)}`, headers: { authorization: 'Bearer any' },
      payload: { scopes: ['chat:read'], enabled: true },
    });
    assert.equal(response.statusCode, 503, response.body);
    assert.equal(response.json().error.code, 'unavailable');
  } finally {
    await server.close();
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx --test test/access.test.ts`

Expected: `ℹ tests 24`, `ℹ pass 20`, `ℹ fail 4`. The last two new tests already pass (they pin behaviour that must survive). The four failures are:

```
✖ only the owner can write access records, even when another principal holds admin:grant
  AssertionError [ERR_ASSERTION]: Missing expected rejection.
✖ the owner cannot write a record for its own id
  AssertionError [ERR_ASSERTION]: {"data":{"id":"9a27…","ownerId":"9a27…","data":{"scopes":["chat:read"],"enabled":false},"revision":1,…}}
  200 !== 400
✖ in account and oidc modes the record id must be a 64-character lowercase hex principal id
  AssertionError [ERR_ASSERTION]: acct_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb: {"data":{"id":"acct_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",…}}
  200 !== 400
✖ reserved and malformed scopes are rejected with invalid_scope and nothing is written
  AssertionError [ERR_ASSERTION]: ["*"]: {"data":{…,"revision":2,…,"data":{"scopes":["*"],"enabled":true}}}
  200 !== 400
```

- [ ] **Step 3: Write minimal implementation**

All three edits are in `src/access.ts`.

(a) Replace the import line written in Task 4:

```ts
import { requireScope, scopeAllows, secureAccountApiOrigin } from './auth.js';
```

with:

```ts
import { requireOwner, requireScope, scopeAllows, secureAccountApiOrigin } from './auth.js';
```

(b) Replace these existing lines (the end of `builtInCeilings` and the start of `accessRequired`, both written in Task 4):

```ts
  5: [],
};

function accessRequired(): DomainError {
```

with:

```ts
  5: [],
};

const principalIdPattern = /^[0-9a-f]{64}$/;
const scopePattern = /^[\x21-\x7e]{1,100}$/;

function accessRequired(): DomainError {
```

(c) Replace the first two lines of the existing method `grant`:

```ts
  async grant(actor: Principal, principalId: string, grant: AccessGrant) {
    requireScope(actor, 'admin:grant');
```

with:

```ts
  async grant(actor: Principal, principalId: string, grant: AccessGrant) {
    requireOwner(actor);
    requireScope(actor, 'admin:grant');
    if (principalId === actor.id) {
      throw new DomainError('invalid_principal', 'The owner does not need an access record', 400);
    }
    if (this.identityMode !== 'development' && !principalIdPattern.test(principalId)) {
      throw new DomainError('invalid_principal', 'Access records are addressed by a 64-character lowercase hex principal id', 400);
    }
    for (const scope of grant.scopes) {
      if (!scopePattern.test(scope)) {
        throw new DomainError('invalid_scope', 'Scopes must be 1 to 100 printable ASCII characters without spaces', 400);
      }
      if (scopeAllows([scope], 'admin:grant')) {
        throw new DomainError('invalid_scope', `Scope cannot be granted: ${scope}`, 400);
      }
    }
```

The two lines that follow (`const existing = await this.store.get<AccessGrant>('access', principalId, principalId);` and the `return existing ? this.store.put(…) : this.store.create(…);` line) stay exactly as they are. Do not edit `src/http/server.ts`.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx tsx --test test/access.test.ts`

Expected: `ℹ tests 24`, `ℹ pass 24`, `ℹ fail 0`.

Run: `npx tsc --noEmit`

Expected: no output, exit code 0.

- [ ] **Step 5: Commit**

```bash
git add src/access.ts test/access.test.ts
git commit -m "修復：只有擁有者可寫入存取紀錄並驗證對象與權限範圍"
```

---

### Task 7: Config key `auth.levelCeilings` and bootstrap wiring

**Files:**
- Modify: `src/config.ts` (the constant `defaultTerminalReadOnlyPaths`, line 7, and the `auth` object of `configSchema` with its `.default({...})` literal, lines 28-47 as of commit 17d571f)
- Modify: `src/bootstrap.ts` (the `new AccessService(` call inside `bootstrap`, lines 68-74 as of commit 17d571f)
- Test: `test/config.test.ts` (import lines 1-3; append after line 129)
- Test: `test/access.test.ts` (import block; append at the end)

**Interfaces:**
- Consumes: `LevelCeilings` and the seventh `AccessService` constructor parameter from Task 4; `putAccess` and `otherSubject` from Task 6; the fixtures of `test/access.test.ts` (`issuer`, `ownerSubject`, `memberSubject`, `principalId`). Existing repo APIs: `configSchema` and `type Configuration` from `src/config.ts`; `bootstrap(config: Configuration, options?: BootstrapOptions)` from `src/bootstrap.ts`, whose result has `app.inject(...)` and `close()`.
- Produces:
  - Config key `auth.levelCeilings`: a strict object whose only allowed keys are `"2"`, `"3"`, `"4"` and `"5"`, each optional, each an array of at most 100 strings matching `/^[\x21-\x7e]{1,100}$/`. Default `{}`. Level 1 is not configurable. `Configuration['auth']['levelCeilings']` is `{ 2?: string[]; 3?: string[]; 4?: string[]; 5?: string[] }`, which is assignable to `LevelCeilings`.
  - `bootstrap` constructs `AccessService` with `fetch` as the sixth argument and `config.auth.levelCeilings` as the seventh. The second argument is still `process.env[config.auth.ownerSubjectEnv]` (Task 8 replaces it).

zod 4 applies an object-level `.default(...)` as an already-parsed output value, so `levelCeilings: {}` must be added to the `auth` default literal as well; without it a configuration file that omits `auth` gets `levelCeilings: undefined`.

The bootstrap test replaces `globalThis.fetch` for its own duration with `context.mock.method`, so no socket is opened: `bootstrap` hands the global `fetch` to `accountAuth`, which asks `GET /api/mobile-auth/session/` on the issuer origin. The issuer is a reserved `.test` name that cannot resolve.

- [ ] **Step 1: Write the failing test**

In `test/config.test.ts` replace the three import lines:

```ts
import assert from 'node:assert/strict';
import test from 'node:test';
import { configSchema } from '../src/config.js';
```

with:

```ts
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { ZodError } from 'zod';
import { configSchema } from '../src/config.js';
```

Then append to the end of `test/config.test.ts`:

```ts

test('auth.levelCeilings defaults to no overrides and accepts a scope list per non-owner level', async () => {
  assert.deepEqual(configSchema.parse({}).auth.levelCeilings, {});
  assert.deepEqual(configSchema.parse({ auth: { audience: 'kiancode' } }).auth.levelCeilings, {});

  const fromJson = configSchema.parse(JSON.parse('{"auth":{"levelCeilings":{"5":["chat:read"],"2":[],"3":["chat:*","mcp:MyPlugin"]}}}'));
  assert.deepEqual(fromJson.auth.levelCeilings, { 2: [], 3: ['chat:*', 'mcp:MyPlugin'], 5: ['chat:read'] });

  const example = JSON.parse(await readFile(new URL('../deploy/config.example.json', import.meta.url), 'utf8')) as unknown;
  assert.deepEqual(configSchema.parse(example).auth.levelCeilings, {});
});

test('auth.levelCeilings rejects unknown levels and malformed scope lists', () => {
  const rejected: unknown[] = [
    { 1: ['chat:read'] },
    { 6: ['chat:read'] },
    { two: ['chat:read'] },
    { 2: 'chat:read' },
    { 2: [''] },
    { 2: ['chat: read'] },
    { 2: [7] },
    { 2: ['x'.repeat(101)] },
    { 2: Array.from({ length: 101 }, (_, index) => `chat:${index}`) },
    ['chat:read'],
  ];
  for (const levelCeilings of rejected) {
    assert.throws(
      () => configSchema.parse({ auth: { levelCeilings } }),
      (error: unknown) => error instanceof ZodError,
      JSON.stringify(levelCeilings).slice(0, 60),
    );
  }
});
```

In `test/access.test.ts` replace the import lines:

```ts
import { createHash } from 'node:crypto';
import test from 'node:test';
import { AccessService, type AccessGrant, type LevelCeilings } from '../src/access.js';
import { requireOwner } from '../src/auth.js';
```

with:

```ts
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { AccessService, type AccessGrant, type LevelCeilings } from '../src/access.js';
import { requireOwner } from '../src/auth.js';
import { bootstrap } from '../src/bootstrap.js';
import { configSchema } from '../src/config.js';
```

Then append to the end of `test/access.test.ts`:

```ts

// ---------------------------------------------------------------------------
// Bootstrap wiring: the owner subject and auth.levelCeilings reach AccessService
// ---------------------------------------------------------------------------

test('bootstrap applies the configured owner subject and auth.levelCeilings to every request', async (context) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'kiancode-access-'));
  const ownerEnv = 'KIANCODE_ACCESS_TEST_OWNER_SUBJECT';
  const previousOwner = process.env[ownerEnv];
  process.env[ownerEnv] = ownerSubject;
  // The Account session endpoint, answered in-process: `Bearer <name>` is the session of `sessions[name]`.
  const sessions: Record<string, { subject: string; level: number }> = {
    owner: { subject: ownerSubject, level: 3 },
    member: { subject: memberSubject, level: 1 },
    guest: { subject: otherSubject, level: 5 },
  };
  context.mock.method(globalThis, 'fetch', (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const session = sessions[new Headers(init?.headers).get('authorization')?.replace(/^Bearer /, '') ?? ''];
    if (url.origin !== issuer || url.pathname !== '/api/mobile-auth/session/' || !session) return new Response(null, { status: 401 });
    return Response.json({ success: true, data: { session: {
      ...session, scopes: ['*'], expiresAt: Math.floor(Date.now() / 1_000) + 600,
      applicationId: 'kiancode', audience: 'kiancode', credentialVersion: 1,
    } } });
  }) as typeof fetch);
  const start = (levelCeilings: Record<string, string[]>) => bootstrap(configSchema.parse({
    stateDirectory: path.join(directory, 'state'),
    checkpointDirectory: path.join(directory, 'checkpoints'),
    database: { urlEnv: 'KIANCODE_ACCESS_TEST_DATABASE_URL', sqlitePath: path.join(directory, 'core.sqlite') },
    auth: { mode: 'account', issuer, ownerSubjectEnv: ownerEnv, levelCeilings },
    attachments: { localDirectory: path.join(directory, 'attachments') },
  }));
  let server: Awaited<ReturnType<typeof bootstrap>> | undefined;
  const session = (bearer: string) => server!.app.inject({ method: 'GET', url: '/v1/session', headers: { authorization: `Bearer ${bearer}` } });
  try {
    server = await start({});
    const owner = await session('owner');
    assert.equal(owner.statusCode, 200, owner.body);
    assert.equal(owner.json().data.level, 1);
    assert.deepEqual(owner.json().data.scopes, ['*']);

    const beforeGrant = await session('member');
    assert.equal(beforeGrant.statusCode, 403, beforeGrant.body);
    assert.equal(beforeGrant.json().error.code, 'access_required');

    assert.equal((await putAccess(server, 'owner', principalId(memberSubject), { scopes: ['chat:read', 'shell:execute'], enabled: true })).statusCode, 200);
    const member = await session('member');
    assert.equal(member.statusCode, 200, member.body);
    assert.equal(member.json().data.level, 2);
    assert.deepEqual(member.json().data.scopes, ['chat:read']);

    assert.equal((await putAccess(server, 'owner', principalId(otherSubject), { scopes: ['chat:read', 'chat:write'], enabled: true })).statusCode, 200);
    const guest = await session('guest');
    assert.equal(guest.statusCode, 403, guest.body);
    assert.equal(guest.json().error.code, 'access_required');
    await server.close();
    server = undefined;

    server = await start({ 5: ['chat:read'] });
    const admitted = await session('guest');
    assert.equal(admitted.statusCode, 200, admitted.body);
    assert.equal(admitted.json().data.level, 5);
    assert.deepEqual(admitted.json().data.scopes, ['chat:read']);
    assert.deepEqual((await session('member')).json().data.scopes, ['chat:read']);
  } finally {
    await server?.close();
    if (previousOwner === undefined) delete process.env[ownerEnv];
    else process.env[ownerEnv] = previousOwner;
    await rm(directory, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx --test test/config.test.ts test/access.test.ts`

Expected: `ℹ tests 33`, `ℹ pass 31`, `ℹ fail 2`. (`auth.levelCeilings rejects unknown levels and malformed scope lists` already passes, because the strict `auth` object rejects the unknown key `levelCeilings` itself; it starts testing the new schema once Step 3 is done.) The two failures are:

```
✖ bootstrap applies the configured owner subject and auth.levelCeilings to every request
  ZodError: [
    {
      "code": "unrecognized_keys",
      "keys": [
        "levelCeilings"
      ],
      "path": [
        "auth"
      ],
      "message": "Unrecognized key: \"levelCeilings\""
    }
  ]
✖ auth.levelCeilings defaults to no overrides and accepts a scope list per non-owner level
  AssertionError [ERR_ASSERTION]: Expected values to be strictly deep-equal:
  undefined !== {}
```

- [ ] **Step 3: Write minimal implementation**

(a) In `src/config.ts` replace the existing line:

```ts
const defaultTerminalReadOnlyPaths = ['/usr'];
```

with:

```ts
const defaultTerminalReadOnlyPaths = ['/usr'];
const levelCeilingSchema = z.array(z.string().regex(/^[\x21-\x7e]{1,100}$/)).max(100);
```

(b) In `src/config.ts`, inside the `auth` object of `configSchema`, replace the existing lines:

```ts
    developmentTokenEnv: z.string().default('KIANCODE_DEV_TOKEN'),
  }).strict().default({
```

with:

```ts
    developmentTokenEnv: z.string().default('KIANCODE_DEV_TOKEN'),
    levelCeilings: z.object({
      2: levelCeilingSchema.optional(),
      3: levelCeilingSchema.optional(),
      4: levelCeilingSchema.optional(),
      5: levelCeilingSchema.optional(),
    }).strict().default({}),
  }).strict().default({
```

(c) In `src/config.ts`, in the default literal that follows, replace the existing lines:

```ts
    developmentTokenEnv: 'KIANCODE_DEV_TOKEN',
  }),
```

with:

```ts
    developmentTokenEnv: 'KIANCODE_DEV_TOKEN',
    levelCeilings: {},
  }),
```

(d) In `src/bootstrap.ts` replace the existing call:

```ts
    const access = new AccessService(
      store,
      process.env[config.auth.ownerSubjectEnv],
      process.env[config.auth.serviceTokenEnv],
      authMode,
      config.auth.accountApiUrl,
    );
```

with:

```ts
    const access = new AccessService(
      store,
      process.env[config.auth.ownerSubjectEnv],
      process.env[config.auth.serviceTokenEnv],
      authMode,
      config.auth.accountApiUrl,
      fetch,
      config.auth.levelCeilings,
    );
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx tsx --test test/config.test.ts test/access.test.ts`

Expected: `ℹ tests 33`, `ℹ pass 33`, `ℹ fail 0` (8 in `test/config.test.ts`, 25 in `test/access.test.ts`).

Run: `npx tsc --noEmit`

Expected: no output, exit code 0.

- [ ] **Step 5: Commit**

```bash
git add src/config.ts src/bootstrap.ts test/config.test.ts test/access.test.ts
git commit -m "實現：auth.levelCeilings 設定各等級的權限上限"
```

---

### Task 8: A5 production requires the owner subject (startup, `config-check`, README)

**Files:**
- Modify: `src/config.ts` (append after `loadConfig`, the last line, line 163 as of commit 17d571f)
- Modify: `src/bootstrap.ts` (import line 7; the first statement of `bootstrap`, lines 32-34; the `new AccessService(` call, lines 68-74 as of commit 17d571f)
- Modify: `src/cli.ts` (import line 6; the `config-check` branch of `main`, line 96 as of commit 17d571f)
- Modify: `README.md` (section `## Deployment`, the paragraph at line 80 as of commit 17d571f)
- Test: `test/config.test.ts` (import block; append at the end)

**Interfaces:**
- Consumes: `configSchema`, `type Configuration` and `loadConfig(file: string): Promise<Configuration>` from `src/config.ts`; the `AccessService` construction in `bootstrap` as written in Task 7; `PostgresStore.connect(connectionString: string): Promise<PostgresStore>` (static, `src/storage/postgres.ts`), which the test replaces with a mock.
- Produces:
  - `export function requireOwnerSubject(config: Configuration, env: NodeJS.ProcessEnv = process.env): string | undefined` in `src/config.ts` (re-exported from the package root by the existing `export *`). It reads `env[config.auth.ownerSubjectEnv]`. When `config.mode === 'production'` and the authentication mode (`config.auth.mode`, or `'account'` when an issuer is set) is not `'development'`, it throws ``new Error(`Production requires the owner subject in ${config.auth.ownerSubjectEnv}`)`` if the value is unset, empty, or differs from its trimmed form. Otherwise it returns the value verbatim (`undefined` when unset). The message names the variable and never contains the value.
  - `bootstrap(config, options)` calls `requireOwnerSubject(config)` as its first statement, before the database variable is read and before any store is opened, and passes the result to `AccessService` as the owner subject.
  - `kiancode config-check` runs `requireOwnerSubject` on the loaded configuration: exit code 1 with the message on stderr when it throws, otherwise `Configuration valid` on stdout as before.
  - `configSchema` stays free of environment reads: parsing a production configuration with no environment still succeeds (the existing tests at the top of `test/config.test.ts` pin that).

- [ ] **Step 1: Write the failing test**

In `test/config.test.ts` replace the import block written in Task 7:

```ts
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { ZodError } from 'zod';
import { configSchema } from '../src/config.js';
```

with:

```ts
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { ZodError } from 'zod';
import { bootstrap } from '../src/bootstrap.js';
import { configSchema, requireOwnerSubject } from '../src/config.js';
import { PostgresStore } from '../src/storage/postgres.js';
```

Then append to the end of `test/config.test.ts`:

```ts

// ---------------------------------------------------------------------------
// A5: production requires the owner subject
// ---------------------------------------------------------------------------

const execFileAsync = promisify(execFile);
const repositoryRoot = fileURLToPath(new URL('..', import.meta.url));
const exampleOwner = `acct_${'0'.repeat(32)}`;

/** A production configuration that reads the owner subject from `ownerSubjectEnv`. */
function productionConfig(mode: 'account' | 'oidc', ownerSubjectEnv: string, databaseUrlEnv = 'DATABASE_URL') {
  return {
    mode: 'production',
    database: { urlEnv: databaseUrlEnv },
    auth: {
      mode,
      issuer: 'https://account.example.com',
      ...(mode === 'oidc' ? { jwksUri: 'https://account.example.com/jwks' } : {}),
      ownerSubjectEnv,
    },
    attachments: { url: 'https://storage.example.com' },
  };
}

/** Runs `kiancode config-check --config <file>` from source in a child process with exactly `env`. */
function configCheck(file: string, env: NodeJS.ProcessEnv) {
  return execFileAsync(process.execPath, ['--import', 'tsx', 'src/cli.ts', 'config-check', '--config', file], { cwd: repositoryRoot, env });
}

test('requireOwnerSubject fails in production when the owner subject is unset, empty or padded', () => {
  for (const mode of ['account', 'oidc'] as const) {
    const config = configSchema.parse(productionConfig(mode, 'CUSTOM_OWNER_SUBJECT'));
    for (const value of [undefined, '', '   ', ` ${exampleOwner}`, `${exampleOwner}\n`]) {
      assert.throws(
        () => requireOwnerSubject(config, { KIANCODE_OWNER_SUBJECT: exampleOwner, ...(value === undefined ? {} : { CUSTOM_OWNER_SUBJECT: value }) }),
        (error: unknown) => error instanceof Error && error.message === 'Production requires the owner subject in CUSTOM_OWNER_SUBJECT',
        `${mode}: ${JSON.stringify(value)}`,
      );
    }
    assert.equal(requireOwnerSubject(config, { CUSTOM_OWNER_SUBJECT: exampleOwner }), exampleOwner);
  }
  const byDefaultName = configSchema.parse({
    mode: 'production',
    auth: { mode: 'account', issuer: 'https://account.example.com' },
    attachments: { url: 'https://storage.example.com' },
  });
  assert.throws(() => requireOwnerSubject(byDefaultName, {}), /owner subject in KIANCODE_OWNER_SUBJECT$/);
  assert.equal(requireOwnerSubject(byDefaultName, { KIANCODE_OWNER_SUBJECT: exampleOwner }), exampleOwner);
});

test('requireOwnerSubject does not require an owner outside production', () => {
  const development = configSchema.parse({});
  assert.equal(requireOwnerSubject(development, {}), undefined);
  assert.equal(requireOwnerSubject(development, { KIANCODE_OWNER_SUBJECT: exampleOwner }), exampleOwner);
  const developmentAccount = configSchema.parse({ auth: { mode: 'account', issuer: 'https://account.example.com' } });
  assert.equal(requireOwnerSubject(developmentAccount, {}), undefined);
  assert.equal(requireOwnerSubject(developmentAccount, { KIANCODE_OWNER_SUBJECT: '' }), '');
});

test('bootstrap refuses a production start without the owner subject before touching the database', async (context) => {
  const ownerEnv = 'KIANCODE_CONFIG_TEST_OWNER_SUBJECT';
  const databaseEnv = 'KIANCODE_CONFIG_TEST_DATABASE_URL';
  const previous = { owner: process.env[ownerEnv], database: process.env[databaseEnv] };
  const connect = context.mock.method(PostgresStore, 'connect', async () => { throw new Error('database connection attempted'); });
  const config = configSchema.parse(productionConfig('account', ownerEnv, databaseEnv));
  try {
    delete process.env[ownerEnv];
    process.env[databaseEnv] = 'postgres://unused';
    await assert.rejects(bootstrap(config), { message: `Production requires the owner subject in ${ownerEnv}` });
    assert.equal(connect.mock.callCount(), 0);

    delete process.env[databaseEnv];
    await assert.rejects(bootstrap(config), { message: `Production requires the owner subject in ${ownerEnv}` });

    process.env[ownerEnv] = exampleOwner;
    process.env[databaseEnv] = 'postgres://unused';
    await assert.rejects(bootstrap(config), { message: 'database connection attempted' });
    assert.equal(connect.mock.callCount(), 1);
  } finally {
    for (const [name, value] of [[ownerEnv, previous.owner], [databaseEnv, previous.database]] as const) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
});

test('config-check fails without the owner subject and passes with it', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'kiancode-config-check-'));
  const ownerEnv = 'KIANCODE_CONFIG_TEST_OWNER_SUBJECT';
  const env = { ...process.env };
  delete env[ownerEnv];
  try {
    const production = path.join(directory, 'production.json');
    await writeFile(production, JSON.stringify(productionConfig('account', ownerEnv)));
    await assert.rejects(configCheck(production, env), (error: unknown) => {
      const failure = error as { code?: unknown; stdout?: string; stderr?: string };
      assert.equal(failure.code, 1);
      assert.equal(failure.stdout, '');
      assert.match(failure.stderr ?? '', new RegExp(`^Production requires the owner subject in ${ownerEnv}$`, 'm'));
      return true;
    });
    const passed = await configCheck(production, { ...env, [ownerEnv]: exampleOwner });
    assert.equal(passed.stdout, 'Configuration valid\n');

    const development = path.join(directory, 'development.json');
    await writeFile(development, '{}');
    assert.equal((await configCheck(development, env)).stdout, 'Configuration valid\n');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
```

The connection string `postgres://unused` is never used: `PostgresStore.connect` is replaced by a mock for the duration of that test. The CLI test starts three short-lived child processes (`node --import tsx src/cli.ts config-check`); they only read a configuration file and exit.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx --test test/config.test.ts`

Expected: the file fails to load, and the runner reports 1 failing test for the whole file:

```
SyntaxError: The requested module '../src/config.js' does not provide an export named 'requireOwnerSubject'
✖ test/config.test.ts
ℹ pass 0
ℹ fail 1
```

- [ ] **Step 3: Write minimal implementation**

(a) Append to the end of `src/config.ts` (after the `loadConfig` line):

```ts

/**
 * The configured owner subject, read from the environment variable named by `auth.ownerSubjectEnv`.
 * Production with account or OIDC authentication cannot run without it: nobody would be the owner,
 * so nobody could grant access. The value itself never appears in the error message.
 */
export function requireOwnerSubject(config: Configuration, env: NodeJS.ProcessEnv = process.env): string | undefined {
  const value = env[config.auth.ownerSubjectEnv];
  const authMode = config.auth.mode ?? (config.auth.issuer ? 'account' : 'development');
  if (config.mode === 'production' && authMode !== 'development' && (!value || value !== value.trim())) {
    throw new Error(`Production requires the owner subject in ${config.auth.ownerSubjectEnv}`);
  }
  return value;
}
```

Run `npx tsx --test test/config.test.ts` once more at this point. Expected: `ℹ tests 12`, `ℹ pass 10`, `ℹ fail 2`; the two `requireOwnerSubject` tests pass and the two wiring tests fail, which proves they test the wiring and not the function:

```
✖ bootstrap refuses a production start without the owner subject before touching the database
  AssertionError [ERR_ASSERTION]: Expected values to be strictly deep-equal:
  +   message: 'database connection attempted'
  -   message: 'Production requires the owner subject in KIANCODE_CONFIG_TEST_OWNER_SUBJECT'
✖ config-check fails without the owner subject and passes with it
  AssertionError [ERR_ASSERTION]: Missing expected rejection.
```

(b) In `src/bootstrap.ts` replace the existing import line:

```ts
import { type Configuration } from './config.js';
```

with:

```ts
import { requireOwnerSubject, type Configuration } from './config.js';
```

(c) In `src/bootstrap.ts` replace the existing lines:

```ts
export async function bootstrap(config: Configuration, options: BootstrapOptions = {}) {
  const databaseUrl = process.env[config.database.urlEnv];
```

with:

```ts
export async function bootstrap(config: Configuration, options: BootstrapOptions = {}) {
  const ownerSubject = requireOwnerSubject(config);
  const databaseUrl = process.env[config.database.urlEnv];
```

(d) In `src/bootstrap.ts`, in the `new AccessService(` call, replace the existing lines:

```ts
      store,
      process.env[config.auth.ownerSubjectEnv],
      process.env[config.auth.serviceTokenEnv],
```

with:

```ts
      store,
      ownerSubject,
      process.env[config.auth.serviceTokenEnv],
```

(e) In `src/cli.ts` replace the existing import line:

```ts
import { loadConfig } from './config.js';
```

with:

```ts
import { loadConfig, requireOwnerSubject } from './config.js';
```

(f) In `src/cli.ts` replace the existing line:

```ts
  if (command === 'config-check') { await loadConfig(configFile); process.stdout.write('Configuration valid\n'); return; }
```

with:

```ts
  if (command === 'config-check') { requireOwnerSubject(await loadConfig(configFile)); process.stdout.write('Configuration valid\n'); return; }
```

The existing `main().catch(...)` at the bottom of `src/cli.ts` already prints the error message to stderr and sets exit code 1.

(g) In `README.md`, under `## Deployment`, replace the existing paragraph:

```markdown
Production startup fails closed when that PostgreSQL environment variable is absent. `database.sqlitePath` is for development and tests only.
```

with:

````markdown
Production startup fails closed when that PostgreSQL environment variable is absent. `database.sqlitePath` is for development and tests only.

Production with Account or OIDC authentication also requires the owner's subject in the environment variable named by `auth.ownerSubjectEnv` (`KIANCODE_OWNER_SUBJECT` by default). Startup and `config-check` both fail when it is unset, empty or padded with whitespace, so run `config-check` with the same environment the service receives. Only that subject is level 1 and holds every capability; a level reported by the identity provider never makes anyone else the owner.

Every other signed-in principal is refused with 403 `access_required` until the owner writes an access record for it:

```sh
curl -X PUT "$KIANCODE_URL/v1/access/$PRINCIPAL_ID" \
  -H "authorization: Bearer $OWNER_SESSION_TOKEN" -H 'content-type: application/json' \
  -d '{"scopes":["chat:read","chat:write","task:read"],"enabled":true}'
```

The principal id is the lowercase hexadecimal SHA-256 of the issuer, one NUL byte and the subject; the issuer is the origin of `auth.issuer` for Account authentication and `auth.issuer` without a trailing slash for OIDC. `*`, `admin:*` and `admin:grant` cannot be granted, and the owner cannot write a record for its own id. `"enabled": false` revokes access. Upgrading from a release that admitted every signed-in principal locks existing non-owners out until their records are written: their tasks pause and can be resumed after the grant, and a schedule or event trigger stored under such a principal is disabled at its next run.

A record never grants more than the ceiling of the principal's level. Levels 2, 3 and 4 share one ceiling: read and write for `chat`, `task`, `memory`, `agent`, `artifact` and `notification`, plus `model:read`, `workspace:read`, `device:read`, `approval:write` and `schedule:read`. Level 5 has an empty built-in ceiling, so a level-5 principal is refused even when it has a record. OIDC principals are level 5, so an OIDC deployment serves only the owner unless the operator overrides that level. `auth.levelCeilings` replaces the built-in ceiling per level, for example `"levelCeilings": { "5": ["chat:read", "chat:write"] }`; a level that is not listed keeps its built-in ceiling.
````

- [ ] **Step 4: Run test to verify it passes**

Run: `npx tsx --test test/config.test.ts test/access.test.ts`

Expected: `ℹ tests 37`, `ℹ pass 37`, `ℹ fail 0` (12 in `test/config.test.ts`, 25 in `test/access.test.ts`; plan C adds more to `test/access.test.ts` later).

Run: `npx tsc --noEmit`

Expected: no output, exit code 0.

- [ ] **Step 5: Commit**

```bash
git add src/config.ts src/bootstrap.ts src/cli.ts test/config.test.ts
git commit -m "修復：正式環境缺少擁有者主體時拒絕啟動，設定檢查亦會失敗"
git add README.md
git commit -m "文件：說明擁有者主體、存取紀錄與等級權限上限"
```

- [ ] **Step 6: Run the full check**

Run: `npm run check`

Expected: exit code 0. The type check prints nothing; the test run ends with `ℹ fail 0` (251 tests on commit 17d571f plus this plan alone: 217 existing, 3 added to `test/auth.test.ts`, 25 in `test/access.test.ts`, 6 added to `test/config.test.ts`; the total is higher by the tests plan G added; its PostgreSQL cases are reported as `skipped` when `KIANCODE_TEST_DATABASE_URL` is unset and its known store divergences as `todo`, and neither counts as a failure); the build prints nothing and writes `dist/`. The `Warning: UnknownErrorException: Ensure that the ... API parameter is provided.` line in the test output (it names `standardFontDataUrl`) comes from an existing PDF test and is not a failure.

If the check fails, fix the cause inside the files this plan lists, re-run `npm run check`, and commit the fix with a `修復：` subject. Do not hand the work over with a failing check.
