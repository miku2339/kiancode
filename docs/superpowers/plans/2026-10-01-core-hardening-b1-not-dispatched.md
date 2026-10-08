# Not-Dispatched Marker and Its Consumers (B1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A tool failure that happened before anything was dispatched becomes an ordinary failed tool result (or a failed task for a workspace operation) instead of an `unknown` task and a write-blocked workspace, while every failure that may have happened after dispatch keeps today's `unknown` behaviour.

**Architecture:** `DomainError` gains one boolean, `notDispatched`, that only the throw site can set (helpers `notDispatched()`, `asNotDispatched()`, `isNotDispatched()` in `src/contracts.ts`); there is no code list and no subclass, because the same error code can sit on both sides of the line. Four consumers read the marker: the agent runtime's tool loop, the internal workspace-operation path, the workspace write lease and the device connector. Device dispatch sets it for a job that never reached a device. Every pre-dispatch throw site in the terminal, workspace, browser, Mac app, MCP and plugin tools is then classified and marked; everything else is left exactly as it is.

**Tech Stack:** TypeScript (NodeNext modules), Node.js 24, Fastify 5, `node:test` run through `tsx --test`, in-memory `SqliteStore` for tests. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-10-01-core-hardening-design.md` (section B, subsection B1)

## Global Constraints

- Node.js 24 or later. TypeScript with two-space indent, single quotes, semicolons and explicit public interfaces.
- Tests use `node:test` and run with `tsx --test`. Behaviour is tested through public interfaces. `npm run check` (typecheck, tests, build) passes before delivery.
- No new runtime dependencies.
- SQLite is for development and tests; PostgreSQL is production. Entities already stored in a deployed database must remain readable without a data rewrite. (This plan adds no entity kind and no stored field; the only persisted addition is the optional `notDispatched: true` key on `tool_result` event payloads.)
- Development authentication mode keeps its current behaviour.
- Errors are `DomainError(code, message, statusCode)` with snake_case codes. Existing codes and HTTP statuses do not change unless a workstream says so. (This plan changes the codes listed under "Deliberate code changes" below and nothing else.)
- The distinction between dispatched, confirmed and unknown external outcomes is preserved.
- No personal data, hostnames, secrets or production configuration in the repository.
- Line numbers in this plan refer to commit `17d571f`; function and symbol names are the stable anchors once earlier workstreams have landed.
- Execution order is G, A, C, B1, B2, D, E, F. This plan runs after G, A and C. Of the files this plan modifies, earlier plans touch only `src/auth.ts` (`requireScope`, rewritten by plan A to call `scopeAllows`; the `throw` line this plan replaces is unchanged), `src/bootstrap.ts` (plan A edits the `AccessService` construction and the first statement of `bootstrap`; this plan edits the server tool wrapper further down) and `README.md` (G, A and C edit other sections and bullets). Locate every edit by the quoted text, not by the line number. The edits of this plan were replayed on a copy with G, A and C applied: every block matched once and the suite passed.
- Commit subjects are in Traditional Chinese with a type prefix and a full-width colon (`修復：…`, `實現：…`, `測試：…`, `文件：…`).
- Run every command from the repository root.

## Review Focus

Most likely first. Each line names the task that owns the code and the test that pins it.

1. **The model (or a workspace operation from the client) calls `terminal.run`, `workspace.write` or `workspace.patch` with an argument that is refused before anything runs: a `cwd` outside the workspace, a stale `expectedHash`, a shell that is not allowed.** Expected: the task fails with the tool's own message (or the model gets a failed tool result and continues); it is never `unknown`, on a server workspace and on a device workspace alike. Task 4, test `a workspace operation that was refused before dispatch ends failed with the tool's message (write tool)` and its `(external tool)` twin; Task 6, test `terminal.run marks every refusal that happens before a process exists`; Task 7, test `workspace.write marks every refusal that happens before the file is touched`; Task 9, test `a marked failure from a write or external tool is submitted as failed`.
2. **A task is waiting for an offline device and the user cancels or pauses it, or the job expires before any device picked it up.** Expected: `cancelled` (a pause takes the same code path and ends `paused`), respectively an ordinary `device_not_dispatched` failure, because nothing was sent to the device; today both become `unknown`. Task 3, test `cancelling a task that is only waiting for its device ends cancelled, not unknown`; Task 4, test `a workspace operation waiting for its device can be cancelled and ends cancelled`; Task 8, test `a job that expired before any device took it is reported as not dispatched`.
3. **One write in a workspace ended `unknown`, or was refused before it started, and another task then writes to the same workspace.** Expected: a refusal before the write releases the workspace; after a genuinely unknown write the next writer gets an ordinary `workspace_writer_unverified` failure without running, instead of becoming `unknown` itself and spreading the state to every later task. Task 12, tests `a not-dispatched failure releases the lease and the next writer proceeds`, `an unmarked failure keeps the lease unknown whatever its code, and the next writer is refused without running` and, through HTTP and a bootstrapped server, `after an unverified write the next write in that workspace fails without running and does not become unknown`.
4. **A failure that really may have happened after dispatch carries a harmless-looking code (`forbidden`, `invalid_input`) or is an `AbortError`: a remote service refusing the request, the Mac helper answering `ok: false`, an MCP server dying during `tools/call`, a navigation that fails.** Expected: still `unknown`; the code alone never downgrades it and nothing is retried. Task 2, test `an unmarked error from an external tool stays unknown even when its code looks harmless`; Task 10, test `plugin.call marks everything that fails before the MCP tool is called, and nothing after`; Task 11, tests `Mac app tools mark refusals before the helper starts, and helper failures only when the helper says so` and (the failed navigation) the extended `browser tools navigate, snapshot, fill, and click a configured localhost fixture`.
5. **After a not-dispatched failure the model asks for the action again.** Expected: the retry is a new tool call with a new approval hash and needs its own approval; in act mode the task cannot finish while the failed action is unrepaired. Task 2, tests `an approved external action that was never dispatched leaves the task running, and the retry needs its own approval` and `act mode still requires a repaired retry after a not-dispatched failure, and the retry needs its own approval`.

## The Rule Every Task Applies

A throw site is **PRE** (marked) only when the code that throws can prove that no part of the requested side effect was started: input validation, capability and scope checks, path resolution, reading the file that is about to be changed, a process that never got a pid. Everything else is **POST** (left unmarked): any rejection from the call that performs the effect, anything after it, and any error whose origin the core cannot see (a remote service, the Mac helper, Playwright, an MCP server). When in doubt a site is POST. Two helpers set the marker:

- `notDispatched(code, message, statusCode)` replaces `new DomainError(code, message, statusCode)` at a PRE throw statement.
- `asNotDispatched(error, code, statusCode)` converts whatever was caught at a boundary where *every* possible error is PRE. It must never wrap a region that contains the effect.

`waiting_for_device` is the one code that is always treated as not dispatched, marked or not (existing behaviour of the runtime and of the lease).

Not handled here, on purpose (spec B1, last bullet): a call that is in flight when the run is aborted (pause, cancel, shutdown, lost task lease) still ends `unknown`, even if the tool then reports not-dispatched, because `TaskService` decides from the event log before aborting and the event stream is closed after the abort. Plan B2 recovers those tasks. Unmarked throws from `write` tools also keep today's behaviour (a failed result in the model loop, `unknown` for a workspace operation and for the lease). `src/tools/script-adapter.ts` and `DeviceService.executeModel` are not in the spec's list and are not touched.

### Deliberate code changes

| Where | Before | After | Why |
| --- | --- | --- | --- |
| `WorkspaceWriteLeaseService.acquire`, previous writer unverified | `outcome_unknown` 409 | `workspace_writer_unverified` 409, marked; message unchanged | The acquiring call dispatched nothing; with the old code it turned every later task in that workspace `unknown`. |
| `DeviceService.dispatch`, job cancelled before a device took it | `outcome_unknown` 409 | `device_not_dispatched` 409, marked | Same reason: `dispatchedAt` is empty, so nothing ran. |
| Abort observed before the effect in `workspace.write`, `workspace.patch`, `workspace.restore`, `workspace.export` | `AbortError` (`DOMException`) | `DomainError('aborted', 'Operation was cancelled before it started', 499)`, marked | An `AbortError` cannot carry the marker. |
| Abort observed before the Mac helper is spawned | `AbortError` (`DOMException`) | `DomainError('desktop_aborted', 'Mac helper request was cancelled before it started', 499)`, marked | Same. |
| Raw errors raised before the effect | raw `Error` | New codes `terminal_environment_unavailable` 503, `terminal_spawn_failed` 503, `workspace_read_failed` 503, `checkpoint_write_failed` 503, `workspace_lease_unavailable` 409; existing codes reused: `plugin_unavailable` 503 (connection failure in `plugin.call`), `browser_unavailable` 503 (page cannot be opened), `desktop_unavailable` 503 (helper cannot be spawned), `workspace_unavailable` 404 (workspace root cannot be resolved or inspected), `checkpoint_not_found` 404 (checkpoint file is not JSON) | A raw error needs a code to become a marked `DomainError`. Except for `workspace_unavailable`, which uses the fixed message `Workspace root is unavailable`, the message is the original message. |

The first two rows are required, not cosmetic: `TaskService.execute` (`src/tasks.ts`, which this plan does not edit) ends a task `unknown` whenever the error that reaches it has the code `outcome_unknown`, before it looks at the event log. A not-dispatched error must therefore never carry that code, marked or not. Do not keep the old code "for compatibility"; Task 12 pins the result through HTTP.

### How the code changes are written

From Task 6 on, the edits to tool files are many one-line replacements of `new DomainError(` by `notDispatched(` with the arguments unchanged. They are written as a unified diff of the file: every `-` line is the exact existing line and the `+` line directly below it is its replacement; lines without a prefix are unchanged context. The diffs were produced against commit `17d571f` with the earlier tasks of this plan applied and can be applied with `git apply` or by hand. Lines that are not in a diff are not changed: in particular, do not mark a `throw` that the task's classification table lists as POST.

### Readings of the spec

Where the spec text leaves room, this plan fixes one reading. Implement what the tasks say.

- **"becomes an ordinary failed tool result fed back to the model".** Ordinary includes act mode's verification gate: the failed action must be repaired by a confirmed call with the same failure key before the task may complete (Task 2).
- **"`waiting_for_device` remains not-dispatched".** It is still rethrown and still suspends the task; in addition the runtime and the workspace-operation path now close the dispatch record with a failed `tool_result` carrying `notDispatched: true`, because without it a pause or cancel of a task that only waits for its device ends `unknown` (Tasks 3 and 4).
- **"Any other error thrown after dispatch may have started keeps today's behaviour".** That includes today's inconsistency for `write` tools: an unmarked throw is a failed result in the model loop but `unknown` for a workspace operation and for the lease.
- **"Every pre-dispatch throw site ... is classified".** Each of Tasks 5 to 12 carries a table with every throw site of the file it edits and its side. Read tools and construction-time checks are listed as not applicable: nothing reads the marker there.
- **"A Mac helper response may carry `notDispatched: true`".** Only the JSON boolean `true` on an error response counts; the field is documented in `README.md` because the helper lives in another repository (Task 11).
- **Order.** The lease change is the last task, not the fifth as in the design notes: it removes the code allowlist, which is only safe after every allowlisted site is marked. Every commit of this plan leaves `npm run check` green.
- **Files left alone.** `src/tools/workspace-export.ts` and `src/tools/workspace-patch.ts` are not edited; their errors are marked where `workspace.ts` calls them (Task 7), because the export helpers also run after dispatch in the device connector.

## File Structure

| File | Action | Responsibility |
| --- | --- | --- |
| `src/contracts.ts` | modify | `DomainErrorOptions`, `DomainError.notDispatched`, `notDispatched()`, `asNotDispatched()`, `isNotDispatched()`. |
| `src/runtime/types.ts` | modify | Optional `notDispatched?: true` on the `tool_result` runtime event. |
| `src/runtime/agent-runtime.ts` | modify | `executeToolCalls`: marked errors become failed tool results; failures before the dispatch record propagate unchanged; a device wait closes its dispatch record. |
| `src/runtime-adapter.ts` | modify | Internal workspace-operation path records a failed `tool_result` for marked errors and device waits. |
| `src/workspace-write-lease.ts` | modify | Lease release decided by the marker; acquisition failures are marked; `workspace_writer_unverified`. |
| `src/auth.ts` | modify | `requireScope` throws a marked `forbidden`. |
| `src/bootstrap.ts` | modify | Server tool wrapper: marked `workspace_unavailable` / `workspace_denied`. |
| `src/tools/terminal.ts` | modify | Mark validation, cwd, environment and spawn-failure sites. |
| `src/tools/workspace.ts` | modify | Mark helper, write, patch, restore and export pre-dispatch sites, including the calls into `workspace-export.ts` and `workspace-patch.ts` (those two files are not edited). |
| `src/devices.ts` | modify | Mark `execute` preconditions and `device_not_dispatched`; a job cancelled before dispatch is not-dispatched. |
| `src/connectors/device.ts` | modify | Report marked throws as job status `failed`. |
| `src/plugins.ts` | modify | `plugin.call`: one marked boundary around everything before the inner tool call. |
| `src/tools/mcp.ts` | modify | Mark `invalid_tool_input`. |
| `src/tools/browser.ts` | modify | Mark input, pre-action abort and requested-origin sites; `allowedUrl` takes a stage. |
| `src/tools/mac-app.ts` | modify | Mark input, allowlist and capability sites, pre-spawn abort and spawn failure; honour `notDispatched: true` in a helper response. |
| `README.md` | modify | Components list: the helper protocol field `notDispatched`. |
| `test/not-dispatched.test.ts` | create | Marker helpers; marked `requireScope`. |
| `test/not-dispatched-flow.test.ts` | create | `TaskService` + `createTaskRunner` + `AgentRuntime` flows: marked failure, device wait and cancel. |
| `test/workspace-operations.test.ts` | create | Internal workspace-operation outcomes through HTTP. |
| `test/bootstrap-server-tools.test.ts` | create (Task 5), append (Task 12) | Bootstrapped server tool wrapper outcomes; the next writer after an unverified write. |
| `test/runtime.test.ts` | modify (append) | Runtime tool-loop behaviours. |
| `test/connector-terminal.test.ts` | modify (append) | Terminal classification. |
| `test/workspace-tools.test.ts` | modify (append) | Workspace write, restore and export classification. |
| `test/workspace-patch.test.ts` | modify (append) | Patch classification. |
| `test/devices.test.ts` | modify (append) | Device execute and dispatch classification. |
| `test/connector-device.test.ts` | modify (append) | Connector status for marked throws. |
| `test/plugins.test.ts` | modify (append) | `plugin.call` preparation errors and MCP input validation are marked; a failing `tools/call` is not. |
| `test/mac-app-tools.test.ts` | modify (append) | Mac app classification (darwin only). |
| `test/plugins-browser.test.ts` | modify | Browser classification (skips without Chrome). |
| `test/workspace-write-lease.test.ts` | modify (append) | Marker-based lease release, marked acquisition failures. |

---

### Task 1: Not-dispatched marker on `DomainError`

**Files:**
- Modify: `src/contracts.ts` (class `DomainError`, lines 56-61 as of commit 17d571f; new exports appended after it)
- Test: `test/not-dispatched.test.ts` (create)

**Interfaces:**
- Consumes: nothing.
- Produces (all exported from `src/contracts.ts`, and from the package root through the existing `export * from './contracts.js'` in `src/index.ts`):
  - `interface DomainErrorOptions { notDispatched?: boolean }`
  - `class DomainError extends Error { code: string; statusCode: number; readonly notDispatched: boolean; constructor(code: string, message: string, statusCode = 400, options: DomainErrorOptions = {}) }` — the three positional parameters are unchanged.
  - `function notDispatched(code: string, message: string, statusCode = 400): DomainError` — a marked error.
  - `function asNotDispatched(error: unknown, code: string, statusCode = 400): DomainError` — a `DomainError` input keeps its code, message and status and comes back marked (the same instance when it already was); any other value becomes `DomainError(code, <its message or String(value)>, statusCode)`, marked.
  - `function isNotDispatched(error: unknown): error is DomainError` — true only for a `DomainError` whose `notDispatched` is true.

- [ ] **Step 1: Write the failing test**

Create `test/not-dispatched.test.ts`:

```ts
import assert from 'node:assert/strict';
import test from 'node:test';
import { asNotDispatched, DomainError, isNotDispatched, notDispatched } from '../src/contracts.js';

test('a DomainError is not marked unless the throw site says so', () => {
  const plain = new DomainError('invalid_input', 'bad');
  assert.equal(plain.notDispatched, false);
  assert.equal(plain.name, 'DomainError');
  assert.equal(plain.statusCode, 400);
  assert.equal(new DomainError('conflict', 'busy', 409).notDispatched, false);
  assert.equal(new DomainError('conflict', 'busy', 409, {}).notDispatched, false);
  assert.equal(isNotDispatched(plain), false);
});

test('notDispatched builds a marked DomainError with the given code, message and status', () => {
  const error = notDispatched('forbidden', 'Missing capability: shell:execute', 403);
  assert.ok(error instanceof DomainError);
  assert.equal(error.code, 'forbidden');
  assert.equal(error.message, 'Missing capability: shell:execute');
  assert.equal(error.statusCode, 403);
  assert.equal(error.notDispatched, true);
  assert.equal(notDispatched('invalid_input', 'bad').statusCode, 400);
  assert.equal(isNotDispatched(error), true);
});

test('asNotDispatched marks a DomainError without changing its code, message or status', () => {
  const original = new DomainError('write_conflict', 'File changed', 409);
  const marked = asNotDispatched(original, 'fallback_code', 503);
  assert.notEqual(marked, original);
  assert.equal(original.notDispatched, false);
  assert.deepEqual(
    [marked.code, marked.message, marked.statusCode, marked.notDispatched],
    ['write_conflict', 'File changed', 409, true],
  );
  assert.equal(asNotDispatched(marked, 'fallback_code', 503), marked);
});

test('asNotDispatched converts any other thrown value using the fallback code and status', () => {
  const fromError = asNotDispatched(new Error('ENOENT: no such file'), 'workspace_unavailable', 404);
  assert.deepEqual(
    [fromError.code, fromError.message, fromError.statusCode, fromError.notDispatched],
    ['workspace_unavailable', 'ENOENT: no such file', 404, true],
  );
  const fromAbort = asNotDispatched(new DOMException('The operation was aborted.', 'AbortError'), 'aborted', 499);
  assert.deepEqual([fromAbort.code, fromAbort.message, fromAbort.statusCode], ['aborted', 'The operation was aborted.', 499]);
  const fromString = asNotDispatched('plain text', 'tool_failed');
  assert.deepEqual(
    [fromString.code, fromString.message, fromString.statusCode, fromString.notDispatched],
    ['tool_failed', 'plain text', 400, true],
  );
});

test('isNotDispatched accepts only a marked DomainError', () => {
  assert.equal(isNotDispatched(new Error('boom')), false);
  assert.equal(isNotDispatched(undefined), false);
  assert.equal(isNotDispatched(null), false);
  assert.equal(isNotDispatched({ code: 'invalid_input', message: 'bad', statusCode: 400, notDispatched: true }), false);
  assert.equal(isNotDispatched(new DomainError('invalid_input', 'bad', 400, { notDispatched: true })), true);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx --test test/not-dispatched.test.ts`

Expected: the file fails to load with

```
SyntaxError: The requested module '../src/contracts.js' does not provide an export named 'asNotDispatched'
```

and the summary shows `ℹ pass 0`, `ℹ fail 1`.

- [ ] **Step 3: Write minimal implementation**

In `src/contracts.ts` replace:

```ts
export class DomainError extends Error {
  constructor(public code: string, message: string, public statusCode = 400) {
    super(message);
    this.name = 'DomainError';
  }
}
```

with:

```ts
export interface DomainErrorOptions {
  notDispatched?: boolean;
}

export class DomainError extends Error {
  public readonly notDispatched: boolean;

  constructor(public code: string, message: string, public statusCode = 400, options: DomainErrorOptions = {}) {
    super(message);
    this.name = 'DomainError';
    this.notDispatched = options.notDispatched === true;
  }
}

/**
 * Builds an error whose thrower guarantees that no part of the requested
 * side effect was started. Use it only at a throw site that runs before the effect.
 */
export function notDispatched(code: string, message: string, statusCode = 400): DomainError {
  return new DomainError(code, message, statusCode, { notDispatched: true });
}

/**
 * Marks an error caught at a boundary where nothing can have been dispatched yet.
 * A DomainError keeps its code, message and status; anything else takes the fallback code and status.
 */
export function asNotDispatched(error: unknown, code: string, statusCode = 400): DomainError {
  if (error instanceof DomainError) {
    return error.notDispatched
      ? error
      : new DomainError(error.code, error.message, error.statusCode, { notDispatched: true });
  }
  return new DomainError(code, error instanceof Error ? error.message : String(error), statusCode, { notDispatched: true });
}

export function isNotDispatched(error: unknown): error is DomainError {
  return error instanceof DomainError && error.notDispatched;
}
```

The marker is never serialised: the HTTP error handler in `src/http/server.ts` builds `{ error: { code, message } }` from the two named properties, so response bodies do not change (Task 5 pins this).

- [ ] **Step 4: Run test to verify it passes**

Run: `npx tsx --test test/not-dispatched.test.ts`

Expected: `ℹ tests 5`, `ℹ pass 5`, `ℹ fail 0`.

Run: `npx tsc --noEmit`

Expected: no output (every existing `new DomainError(code, message, status)` call still type-checks).

- [ ] **Step 5: Commit**

```bash
git add src/contracts.ts test/not-dispatched.test.ts
git commit -m "實現：DomainError 新增未派發標記與輔助函式"
```

---

### Task 2: The runtime feeds marked errors back as failed tool results

**Files:**
- Modify: `src/runtime/types.ts` (`RuntimeEvent`, the `tool_result` member, line 103 as of commit 17d571f)
- Modify: `src/runtime/agent-runtime.ts` (import on line 2; `executeToolCalls`, lines 349-350, 406-433 and 451-461 as of commit 17d571f)
- Test: `test/runtime.test.ts` (append), `test/not-dispatched-flow.test.ts` (create)

**Interfaces:**
- Consumes: `notDispatched(code, message, statusCode?)` and `isNotDispatched(error)` from `src/contracts.ts` (Task 1). Existing test helpers in `test/runtime.test.ts`: `principal`, `class ScriptedProvider` (`calls: ChatRequest[]`), `approvedActionHash(taskId, callId, tool, input)`.
- Produces:
  - Runtime event `{ type: 'tool_result'; ...; notDispatched?: true }`. A never-dispatched call is `outcome: 'failed'` plus `notDispatched: true`; the outcome enum is not extended.
  - Behaviour: an error for which `isNotDispatched(error)` is true, thrown by a `write` or `external` tool, becomes the tool message `Tool error: <message>` with `toolOutcome: 'failed'`, a `tool_result` event with `outcome: 'failed'`, `isError: true`, `notDispatched: true` and `checkpointMessages`, and the loop continues. Unmarked errors are handled exactly as before.
  - A marked error from a `read` tool was already a failed result and stays one; its `tool_result` event now also carries `notDispatched: true`, because read tools share the input and path helpers that Tasks 5 to 7 mark. Nothing reads the field for a read tool.
  - Test helpers appended to `test/runtime.test.ts` and reused by Task 3: `sideEffectTool(name: string, sideEffect: 'write' | 'external', execute: ToolDefinition['execute']): ToolDefinition` and `toolRuntime(provider: ModelProvider, tools: ToolDefinition[]): AgentRuntime`.
  - Test helpers in `test/not-dispatched-flow.test.ts` reused by Task 3: `principal`, `conversation`, `scripted(responses: ChatResponse[]): ModelProvider`, `externalTool(name, execute): ToolDefinition`, `service(store, provider, tool): TaskService`, `stored(store, id): Promise<Task>`.

Act mode keeps its verification gate: a failed non-read action must be repaired by a confirmed call with the same failure key (the first of `path`, `target`, `url`, `resourceId`, `id` in the arguments, or the whole argument object; `terminal.run` always uses the whole argument object) before the task may complete. A not-dispatched failure is an ordinary failure for that gate, which is why the test arguments below carry a `target`.

- [ ] **Step 1: Write the failing test**

In `test/runtime.test.ts` replace the import on line 4:

```ts
import { DomainError, type Principal, type ToolDefinition } from '../src/contracts.js';
```

with:

```ts
import { DomainError, notDispatched, type Principal, type ToolDefinition } from '../src/contracts.js';
```

and append at the end of the file:

```ts
function sideEffectTool(
  name: string,
  sideEffect: 'write' | 'external',
  execute: ToolDefinition['execute'],
): ToolDefinition {
  return { name, description: name, inputSchema: { type: 'object' }, requiredCapabilities: [], sideEffect, execute };
}

function toolRuntime(provider: ModelProvider, tools: ToolDefinition[]): AgentRuntime {
  return new AgentRuntime({
    providers: [provider],
    models: [{ id: 'local-model', providerId: provider.id, locality: 'local', capabilities: ['tools'] }],
    tools,
  });
}

for (const sideEffect of ['external', 'write'] as const) {
  test(`a not-dispatched error from an approved ${sideEffect} tool is fed back as a failed result and the run continues`, async () => {
    const provider = new ScriptedProvider([
      {
        message: { role: 'assistant', content: '', toolCalls: [{ id: 'send-1', name: 'send', arguments: { message: 'hello', target: 'room' } }] },
        usage: { inputTokens: 1, outputTokens: 1 },
      },
      {
        message: { role: 'assistant', content: '', toolCalls: [{ id: 'send-2', name: 'send', arguments: { message: 'hi', target: 'room' } }] },
        usage: { inputTokens: 1, outputTokens: 1 },
      },
      { message: { role: 'assistant', content: 'Sent the shorter message.' }, usage: { inputTokens: 1, outputTokens: 1 } },
    ]);
    const events: Array<Record<string, unknown>> = [];
    let executions = 0;
    const runtime = toolRuntime(provider, [sideEffectTool('send', sideEffect, async (input) => {
      executions += 1;
      if (input.message === 'hello') throw notDispatched('invalid_input', 'message is too long');
      return { content: 'sent' };
    })]);
    const firstHash = approvedActionHash('marked-task', 'send-1', 'send', { message: 'hello', target: 'room' });

    const result = await runtime.run({
      principal,
      taskId: 'marked-task',
      prompt: 'send',
      mode: 'act',
      strategy: 'single',
      approvedActionHashes: new Set([firstHash, approvedActionHash('marked-task', 'send-2', 'send', { message: 'hi', target: 'room' })]),
      onEvent(event) { events.push(event as unknown as Record<string, unknown>); },
    });

    assert.equal(result.status, 'completed');
    assert.equal(result.content, 'Sent the shorter message.');
    assert.equal(executions, 2);
    const fedBack = provider.calls[1]?.messages.at(-1);
    assert.equal(fedBack?.role, 'tool');
    assert.equal(fedBack?.content, 'Tool error: message is too long');
    assert.equal(fedBack?.toolOutcome, 'failed');
    assert.equal(fedBack?.toolCallId, 'send-1');
    const toolEvents = events.filter((event) => String(event.type).startsWith('tool_'));
    assert.deepEqual(toolEvents.map((event) => event.type), [
      'tool_call', 'tool_dispatched', 'tool_result',
      'tool_call', 'tool_dispatched', 'tool_result',
    ]);
    const failed = toolEvents[2]!;
    assert.equal(failed.outcome, 'failed');
    assert.equal(failed.isError, true);
    assert.equal(failed.notDispatched, true);
    assert.equal(failed.sideEffect, sideEffect);
    assert.equal(failed.actionHash, firstHash);
    assert.ok(Array.isArray(failed.checkpointMessages));
    assert.equal(toolEvents[5]!.outcome, 'confirmed');
    assert.equal('notDispatched' in toolEvents[5]!, false);
  });
}

test('an unmarked error from an external tool stays unknown even when its code looks harmless', async () => {
  for (const thrown of [
    new DomainError('forbidden', 'Remote service refused the request', 403),
    new DomainError('invalid_input', 'Remote service rejected the payload'),
    new DOMException('The operation was aborted.', 'AbortError'),
  ]) {
    const provider = new ScriptedProvider([{
      message: { role: 'assistant', content: '', toolCalls: [{ id: 'send-1', name: 'send', arguments: {} }] },
      usage: { inputTokens: 1, outputTokens: 1 },
    }]);
    const events: Array<Record<string, unknown>> = [];
    const runtime = toolRuntime(provider, [sideEffectTool('send', 'external', async () => { throw thrown; })]);
    await assert.rejects(runtime.run({
      principal,
      taskId: 'unmarked-task',
      prompt: 'send',
      mode: 'act',
      strategy: 'single',
      approvedActionHashes: new Set([approvedActionHash('unmarked-task', 'send-1', 'send', {})]),
      onEvent(event) { events.push(event as unknown as Record<string, unknown>); },
    }), (error: unknown) => error instanceof DomainError && error.code === 'outcome_unknown');
    assert.equal(events.at(-1)?.outcome, 'unknown');
    assert.equal(events.at(-1)?.notDispatched, undefined);
    assert.equal(provider.calls.length, 1);
  }
});

test('act mode still requires a repaired retry after a not-dispatched failure, and the retry needs its own approval', async () => {
  const failing = sideEffectTool('send', 'external', async () => {
    throw notDispatched('invalid_input', 'message is too long');
  });
  const gaveUp = new ScriptedProvider([
    {
      message: { role: 'assistant', content: '', toolCalls: [{ id: 'send-1', name: 'send', arguments: { message: 'hello' } }] },
      usage: { inputTokens: 1, outputTokens: 1 },
    },
    { message: { role: 'assistant', content: 'Done.' }, usage: { inputTokens: 1, outputTokens: 1 } },
  ]);
  await assert.rejects(toolRuntime(gaveUp, [failing]).run({
    principal,
    taskId: 'act-marked',
    prompt: 'send',
    mode: 'act',
    strategy: 'single',
    approvedActionHashes: new Set([approvedActionHash('act-marked', 'send-1', 'send', { message: 'hello' })]),
  }), (error: unknown) => error instanceof DomainError && error.code === 'verification_failed' && /send/.test(error.message));

  const retried = new ScriptedProvider([
    {
      message: { role: 'assistant', content: '', toolCalls: [{ id: 'send-1', name: 'send', arguments: { message: 'hello' } }] },
      usage: { inputTokens: 1, outputTokens: 1 },
    },
    {
      message: { role: 'assistant', content: '', toolCalls: [{ id: 'send-2', name: 'send', arguments: { message: 'hello' } }] },
      usage: { inputTokens: 1, outputTokens: 1 },
    },
  ]);
  let executions = 0;
  const waiting = await toolRuntime(retried, [sideEffectTool('send', 'external', async () => {
    executions += 1;
    throw notDispatched('invalid_input', 'message is too long');
  })]).run({
    principal,
    taskId: 'act-marked',
    prompt: 'send',
    mode: 'act',
    strategy: 'single',
    approvedActionHashes: new Set([approvedActionHash('act-marked', 'send-1', 'send', { message: 'hello' })]),
  });
  assert.equal(waiting.status, 'waiting_for_approval');
  assert.equal(executions, 1);
  assert.equal(waiting.pendingActions?.[0]?.toolCallId, 'send-2');
  assert.equal(waiting.pendingActions?.[0]?.actionHash, approvedActionHash('act-marked', 'send-2', 'send', { message: 'hello' }));
});
```

Create `test/not-dispatched-flow.test.ts`:

```ts
import assert from 'node:assert/strict';
import test from 'node:test';
import { notDispatched, type Principal, type ToolDefinition } from '../src/contracts.js';
import type { Conversation, Task } from '../src/domain.js';
import { createTaskRunner } from '../src/runtime-adapter.js';
import { AgentRuntime, type ChatResponse, type ModelProvider } from '../src/runtime/index.js';
import { SqliteStore } from '../src/storage/sqlite.js';
import { TaskService } from '../src/tasks.js';

const principal: Principal = { id: 'owner', level: 1, scopes: ['*'] };
const conversation: Conversation = {
  title: 'Flow', scope: 'private', modelPolicy: 'local', strategy: 'single', mode: 'act', archived: false,
};

function scripted(responses: ChatResponse[]): ModelProvider {
  return {
    id: 'scripted',
    locality: 'local',
    async chat() {
      const response = responses.shift();
      assert.ok(response, 'unexpected provider call');
      return response;
    },
  };
}

function externalTool(name: string, execute: ToolDefinition['execute']): ToolDefinition {
  return { name, description: name, inputSchema: { type: 'object' }, requiredCapabilities: [], sideEffect: 'external', execute };
}

function service(store: SqliteStore, provider: ModelProvider, tool: ToolDefinition): TaskService {
  const runtime = new AgentRuntime({
    providers: [provider],
    models: [{ id: 'local-model', providerId: provider.id, locality: 'local', capabilities: ['tools'] }],
    tools: [tool],
  });
  return new TaskService(store, createTaskRunner(store, runtime, [tool]), { reauthorize: async (current) => current });
}

async function stored(store: SqliteStore, id: string): Promise<Task> {
  return (await store.get<Task>('task', id, principal.id))!.data;
}

test('an approved external action that was never dispatched leaves the task running, and the retry needs its own approval', async () => {
  const store = new SqliteStore();
  let executions = 0;
  const tasks = service(store, scripted([
    { message: { role: 'assistant', content: '', toolCalls: [{ id: 'send-1', name: 'send', arguments: { target: 'room', message: 'hello' } }] }, usage: { inputTokens: 1, outputTokens: 1 } },
    { message: { role: 'assistant', content: '', toolCalls: [{ id: 'send-2', name: 'send', arguments: { target: 'room', message: 'hi' } }] }, usage: { inputTokens: 1, outputTokens: 1 } },
    { message: { role: 'assistant', content: 'Sent the shorter message.' }, usage: { inputTokens: 1, outputTokens: 1 } },
  ]), externalTool('send', async (input) => {
    executions += 1;
    if (input.message === 'hello') throw notDispatched('invalid_input', 'message is too long');
    return { content: 'sent' };
  }));
  try {
    const thread = await store.create<Conversation>('conversation', principal.id, conversation);
    const task = await tasks.enqueue(principal, thread.id, 'send it');
    await tasks.drain();
    const first = await stored(store, task.id);
    assert.equal(first.state, 'waiting_for_approval');
    const firstHash = first.pendingActions[0]!.hash;

    await tasks.control(principal.id, task.id, 'resume', [firstHash], principal);
    await tasks.drain();
    const second = await stored(store, task.id);
    assert.equal(second.state, 'waiting_for_approval', second.error);
    assert.equal(executions, 1);
    const secondHash = second.pendingActions[0]!.hash;
    assert.notEqual(secondHash, firstHash);
    const failed = (await tasks.events(principal.id, task.id))
      .map((row) => row.data.payload as { type?: string; outcome?: string; notDispatched?: boolean; actionHash?: string })
      .filter((payload) => payload.type === 'tool_result');
    assert.deepEqual(failed.map((payload) => [payload.outcome, payload.notDispatched, payload.actionHash]), [['failed', true, firstHash]]);

    await tasks.control(principal.id, task.id, 'resume', [secondHash], principal);
    await tasks.drain();
    const done = await stored(store, task.id);
    assert.equal(done.state, 'completed', done.error);
    assert.equal(done.result, 'Sent the shorter message.');
    assert.equal(executions, 2);
  } finally { await tasks.close(); await store.close(); }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx --test test/runtime.test.ts test/not-dispatched-flow.test.ts`

Expected: four failures, all other tests pass.

```
✖ a not-dispatched error from an approved external tool is fed back as a failed result and the run continues
  Error [DomainError]: External action was dispatched but its result was not confirmed. Verify the outcome before retrying.
    code: 'outcome_unknown',
✖ a not-dispatched error from an approved write tool is fed back as a failed result and the run continues
  AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:
  + undefined
  - true
✖ act mode still requires a repaired retry after a not-dispatched failure, and the retry needs its own approval
  AssertionError [ERR_ASSERTION]: The validation function is expected to return "true". Received false
✖ an approved external action that was never dispatched leaves the task running, and the retry needs its own approval
  AssertionError [ERR_ASSERTION]: A side effect was dispatched but its result was not confirmed. Verify the outcome before retrying.
  + 'unknown'
  - 'waiting_for_approval'
```

`an unmarked error from an external tool stays unknown even when its code looks harmless` already passes; it pins the behaviour that must survive this task.

- [ ] **Step 3: Write minimal implementation**

In `src/runtime/types.ts` replace the `tool_result` member of `RuntimeEvent`:

```ts
  | { type: 'tool_result'; taskId: string; toolCallId: string; isError: boolean; outcome: 'confirmed' | 'failed' | 'unknown' | 'not_replayed'; actionHash?: string; sideEffect?: ToolDefinition['sideEffect']; result?: ToolResult; checkpointMessages?: ChatMessage[] }
```

with:

```ts
  | { type: 'tool_result'; taskId: string; toolCallId: string; isError: boolean; outcome: 'confirmed' | 'failed' | 'unknown' | 'not_replayed'; notDispatched?: true; actionHash?: string; sideEffect?: ToolDefinition['sideEffect']; result?: ToolResult; checkpointMessages?: ChatMessage[] }
```

In `src/runtime/agent-runtime.ts` replace the import on line 2:

```ts
import { DomainError, type ToolDefinition, type ToolResult } from '../contracts.js';
```

with:

```ts
import { DomainError, isNotDispatched, type ToolDefinition, type ToolResult } from '../contracts.js';
```

In `executeToolCalls` replace:

```ts
      let outcome: 'confirmed' | 'failed' | 'unknown' | 'not_replayed' = 'failed';
      let result: ToolResult | undefined;
```

with:

```ts
      let outcome: 'confirmed' | 'failed' | 'unknown' | 'not_replayed' = 'failed';
      let neverDispatched = false;
      let result: ToolResult | undefined;
```

In the `catch (error)` block of the same method replace:

```ts
          if (tool.sideEffect === 'external'
            || (error instanceof DomainError && error.code === 'outcome_unknown')) {
```

with:

```ts
          if (!isNotDispatched(error) && (tool.sideEffect === 'external'
            || (error instanceof DomainError && error.code === 'outcome_unknown'))) {
```

and, at the end of that `catch` block, replace:

```ts
          content = `Tool error: ${error instanceof Error ? error.message : String(error)}`;
          isError = true;
          outcome = 'failed';
        }
```

with:

```ts
          content = `Tool error: ${error instanceof Error ? error.message : String(error)}`;
          isError = true;
          outcome = 'failed';
          neverDispatched = isNotDispatched(error);
        }
```

In the final `tool_result` event of the loop body (the one that carries `checkpointMessages`) replace:

```ts
        isError,
        outcome,
        actionHash: toolCall.actionHash,
```

with:

```ts
        isError,
        outcome,
        ...(neverDispatched ? { notDispatched: true as const } : {}),
        actionHash: toolCall.actionHash,
```

`consumedActionHashes` is deliberately not touched in the `catch` block: an action that never ran has not consumed its approval.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx tsx --test test/runtime.test.ts test/not-dispatched-flow.test.ts`

Expected: `ℹ fail 0` (22 tests in `test/runtime.test.ts` at commit 17d571f plus the four added here, and one flow test).

Run: `npx tsc --noEmit`

Expected: no output.

- [ ] **Step 5: Commit**

```bash
git add src/runtime/types.ts src/runtime/agent-runtime.ts test/runtime.test.ts test/not-dispatched-flow.test.ts
git commit -m "修復：未派發的工具錯誤回饋為一般失敗結果，不再標記為未知"
```

---

### Task 3: Failures before the dispatch record propagate unchanged; a device wait closes its dispatch record

**Files:**
- Modify: `src/runtime/agent-runtime.ts` (`executeToolCalls`, the `execute` closure and the head of its `catch` block, lines 378-409 as of commit 17d571f)
- Test: `test/runtime.test.ts` (append), `test/not-dispatched-flow.test.ts` (append)

**Interfaces:**
- Consumes: from Task 2, `sideEffectTool(name, sideEffect, execute)` and `toolRuntime(provider, tools)` in `test/runtime.test.ts`; `principal`, `conversation`, `scripted`, `externalTool`, `service`, `stored` in `test/not-dispatched-flow.test.ts`; the `notDispatched?: true` field of the `tool_result` runtime event. Existing: `TaskService.control(ownerId, id, 'pause' | 'resume' | 'cancel', hashes?, actor?)`.
- Produces (behaviour of `AgentRuntime.run`):
  - An error raised before the `tool_dispatched` event was accepted (the event sink threw, reauthorization failed, the run was aborted while waiting for the per-workspace write limiter) is rethrown unchanged for every tool kind; the tool is not executed and no `tool_result` is emitted.
  - `DomainError` with code `waiting_for_device` from a `write` or `external` tool: the runtime first emits `{ type: 'tool_result', taskId, toolCallId, isError: true, outcome: 'failed', notDispatched: true, actionHash, sideEffect }` **without** `checkpointMessages` and **without** adding a tool message, then rethrows the same error. The call therefore stays pending in the checkpoint and is executed again when the task is retried, while the dispatch record in the task's event log is closed.

Why the closing event matters: `TaskService.control` turns a pause or cancel into `unknown` when the event log holds a `tool_dispatched` for a write or external tool with no later `tool_result` of outcome `confirmed`, `failed` or `not_replayed`. Before this task every task that was merely waiting for an offline device was in that state.

- [ ] **Step 1: Write the failing test**

Append to `test/runtime.test.ts`:

```ts
test('a failure while recording the dispatch is rethrown unchanged and the tool never runs', async () => {
  const provider = new ScriptedProvider([{
    message: { role: 'assistant', content: '', toolCalls: [{ id: 'send-1', name: 'send', arguments: {} }] },
    usage: { inputTokens: 1, outputTokens: 1 },
  }]);
  let executions = 0;
  const events: Array<Record<string, unknown>> = [];
  const runtime = toolRuntime(provider, [sideEffectTool('send', 'external', async () => {
    executions += 1;
    return { content: 'sent' };
  })]);

  await assert.rejects(runtime.run({
    principal,
    taskId: 'revoked-task',
    prompt: 'send',
    mode: 'act',
    strategy: 'single',
    approvedActionHashes: new Set([approvedActionHash('revoked-task', 'send-1', 'send', {})]),
    onEvent(event) {
      if (event.type === 'tool_dispatched') throw new DomainError('grant_revoked', 'Task capabilities have been reduced or revoked', 403);
      events.push(event as unknown as Record<string, unknown>);
    },
  }), (error: unknown) => error instanceof DomainError && error.code === 'grant_revoked' && error.statusCode === 403);

  assert.equal(executions, 0);
  assert.equal(events.some((event) => event.type === 'tool_result'), false);
});

test('a device wait after dispatch closes the dispatch record and leaves the call pending', async () => {
  const toolCalls = [{ id: 'run-1', name: 'remote', arguments: { command: 'make' } }];
  const provider = new ScriptedProvider([
    { message: { role: 'assistant', content: '', toolCalls }, usage: { inputTokens: 1, outputTokens: 1 } },
    { message: { role: 'assistant', content: 'Built.' }, usage: { inputTokens: 1, outputTokens: 1 } },
  ]);
  let online = false;
  let executions = 0;
  const events: Array<Record<string, unknown>> = [];
  const runtime = toolRuntime(provider, [sideEffectTool('remote', 'external', async () => {
    executions += 1;
    if (!online) throw new DomainError('waiting_for_device', 'Waiting for the authorized device to reconnect');
    return { content: 'ok' };
  })]);
  const hash = approvedActionHash('device-task', 'run-1', 'remote', { command: 'make' });
  const input = {
    principal,
    taskId: 'device-task',
    mode: 'act' as const,
    strategy: 'single' as const,
    approvedActionHashes: new Set([hash]),
    onEvent(event: { type: string }) { events.push(event as unknown as Record<string, unknown>); },
  };

  await assert.rejects(runtime.run({ ...input, prompt: 'build' }),
    (error: unknown) => error instanceof DomainError && error.code === 'waiting_for_device');

  assert.equal(executions, 1);
  const closing = events.at(-1)!;
  assert.equal(closing.type, 'tool_result');
  assert.equal(closing.outcome, 'failed');
  assert.equal(closing.isError, true);
  assert.equal(closing.notDispatched, true);
  assert.equal(closing.actionHash, hash);
  assert.equal(closing.toolCallId, 'run-1');
  assert.equal(closing.sideEffect, 'external');
  assert.equal('checkpointMessages' in closing, false);

  online = true;
  const resumed = await runtime.run({
    ...input,
    messages: [{ role: 'user', content: 'build' }, { role: 'assistant', content: '', toolCalls }],
  });
  assert.equal(resumed.status, 'completed');
  assert.equal(resumed.content, 'Built.');
  assert.equal(executions, 2);
  assert.deepEqual(
    events.filter((event) => event.type === 'tool_result').map((event) => event.outcome),
    ['failed', 'confirmed'],
  );
});

test('a read tool that waits for its device emits no closing result', async () => {
  const provider = new ScriptedProvider([{
    message: { role: 'assistant', content: '', toolCalls: [{ id: 'read-1', name: 'remote.read', arguments: {} }] },
    usage: { inputTokens: 1, outputTokens: 1 },
  }]);
  const events: Array<Record<string, unknown>> = [];
  const runtime = toolRuntime(provider, [{
    name: 'remote.read',
    description: 'Read remotely',
    inputSchema: { type: 'object' },
    requiredCapabilities: [],
    sideEffect: 'read',
    async execute() { throw new DomainError('waiting_for_device', 'Waiting for the authorized device to reconnect'); },
  }]);

  await assert.rejects(runtime.run({
    principal,
    taskId: 'device-read-task',
    prompt: 'read',
    mode: 'ask',
    strategy: 'single',
    onEvent(event) { events.push(event as unknown as Record<string, unknown>); },
  }), (error: unknown) => error instanceof DomainError && error.code === 'waiting_for_device');

  assert.equal(events.at(-1)?.type, 'tool_dispatched');
});
```

In `test/not-dispatched-flow.test.ts` replace the import:

```ts
import { notDispatched, type Principal, type ToolDefinition } from '../src/contracts.js';
```

with:

```ts
import { DomainError, notDispatched, type Principal, type ToolDefinition } from '../src/contracts.js';
```

and append at the end of the file:

```ts
test('cancelling a task that is only waiting for its device ends cancelled, not unknown', async () => {
  const store = new SqliteStore();
  let executions = 0;
  const tasks = service(store, scripted([
    { message: { role: 'assistant', content: '', toolCalls: [{ id: 'run-1', name: 'remote', arguments: { command: 'make' } }] }, usage: { inputTokens: 1, outputTokens: 1 } },
  ]), externalTool('remote', async () => {
    executions += 1;
    throw new DomainError('waiting_for_device', 'Waiting for the authorized device to reconnect');
  }));
  try {
    const thread = await store.create<Conversation>('conversation', principal.id, conversation);
    const task = await tasks.enqueue(principal, thread.id, 'build it');
    await tasks.drain();
    const hash = (await stored(store, task.id)).pendingActions[0]!.hash;
    await tasks.control(principal.id, task.id, 'resume', [hash], principal);
    await tasks.drain();
    const waiting = await stored(store, task.id);
    assert.equal(waiting.state, 'waiting_for_device', waiting.error);
    assert.equal(executions, 1);

    const cancelled = await tasks.control(principal.id, task.id, 'cancel');
    assert.equal(cancelled.data.state, 'cancelled');
    assert.equal(cancelled.data.error, 'Waiting for the authorized device to reconnect');
  } finally { await tasks.close(); await store.close(); }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx --test test/runtime.test.ts test/not-dispatched-flow.test.ts`

Expected: three failures.

```
✖ a failure while recording the dispatch is rethrown unchanged and the tool never runs
  AssertionError [ERR_ASSERTION]: The validation function is expected to return "true". Received false
  Caught error:
  DomainError: External action was dispatched but its result was not confirmed. Verify the outcome before retrying.
✖ a device wait after dispatch closes the dispatch record and leaves the call pending
  AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:
  + 'tool_dispatched'
  - 'tool_result'
✖ cancelling a task that is only waiting for its device ends cancelled, not unknown
  AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:
  + 'unknown'
  - 'cancelled'
```

`a read tool that waits for its device emits no closing result` already passes and stays as a pin.

- [ ] **Step 3: Write minimal implementation**

In `src/runtime/agent-runtime.ts`, inside `executeToolCalls`, replace:

```ts
        const execute = async (): Promise<ToolResult> => {
          await input.onEvent?.({
            type: 'tool_dispatched',
            taskId: input.taskId,
            toolCall,
            actionHash: toolCall.actionHash!,
            sideEffect: tool.sideEffect,
          });
          return tool.execute(toolCall.arguments, {
```

with:

```ts
        let dispatched = false;
        const execute = async (): Promise<ToolResult> => {
          await input.onEvent?.({
            type: 'tool_dispatched',
            taskId: input.taskId,
            toolCall,
            actionHash: toolCall.actionHash!,
            sideEffect: tool.sideEffect,
          });
          dispatched = true;
          return tool.execute(toolCall.arguments, {
```

and replace the head of the `catch` block:

```ts
        } catch (error) {
          if (error instanceof DomainError && error.code === 'waiting_for_device') {
            throw error;
          }
```

with:

```ts
        } catch (error) {
          if (!dispatched) {
            throw error;
          }
          if (error instanceof DomainError && error.code === 'waiting_for_device') {
            if (tool.sideEffect !== 'read') {
              await input.onEvent?.({
                type: 'tool_result',
                taskId: input.taskId,
                toolCallId: toolCall.id,
                isError: true,
                outcome: 'failed',
                notDispatched: true,
                actionHash: toolCall.actionHash,
                sideEffect: tool.sideEffect,
              });
            }
            throw error;
          }
```

After this task the whole `catch` block reads:

```ts
        } catch (error) {
          if (!dispatched) {
            throw error;
          }
          if (error instanceof DomainError && error.code === 'waiting_for_device') {
            if (tool.sideEffect !== 'read') {
              await input.onEvent?.({
                type: 'tool_result',
                taskId: input.taskId,
                toolCallId: toolCall.id,
                isError: true,
                outcome: 'failed',
                notDispatched: true,
                actionHash: toolCall.actionHash,
                sideEffect: tool.sideEffect,
              });
            }
            throw error;
          }
          if (!isNotDispatched(error) && (tool.sideEffect === 'external'
            || (error instanceof DomainError && error.code === 'outcome_unknown'))) {
            await input.onEvent?.({
              type: 'tool_result',
              taskId: input.taskId,
              toolCallId: toolCall.id,
              isError: true,
              outcome: 'unknown',
              actionHash: toolCall.actionHash,
              sideEffect: tool.sideEffect,
            });
            throw new DomainError(
              'outcome_unknown',
              'External action was dispatched but its result was not confirmed. Verify the outcome before retrying.',
              409,
            );
          }
          if (isAbortError(error)) {
            throw error;
          }
          content = `Tool error: ${error instanceof Error ? error.message : String(error)}`;
          isError = true;
          outcome = 'failed';
          neverDispatched = isNotDispatched(error);
        }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx tsx --test test/runtime.test.ts test/not-dispatched-flow.test.ts`

Expected: `ℹ fail 0`.

Run: `npx tsx --test test/tasks.test.ts test/agents-runtime.test.ts test/api.test.ts`

Expected: `ℹ fail 0` (no existing task, agent or API test depends on the old behaviour).

- [ ] **Step 5: Commit**

```bash
git add src/runtime/agent-runtime.ts test/runtime.test.ts test/not-dispatched-flow.test.ts
git commit -m "修復：派發紀錄寫入前的失敗原樣拋出，等待裝置時結清派發紀錄"
```

---

### Task 4: The internal workspace-operation path records a failed `tool_result`

**Files:**
- Modify: `src/runtime-adapter.ts` (import on line 2; the `catch (error)` block of the internal-operation branch in `createTaskRunner`, lines 160-163 as of commit 17d571f)
- Test: `test/workspace-operations.test.ts` (create)

**Interfaces:**
- Consumes: `notDispatched(code, message, statusCode?)`, `isNotDispatched(error)` from `src/contracts.ts` (Task 1). Existing: `createServer({ store, tools, authenticate, runner, reauthorize })`, `developmentAuth(token)` (principal id `local-owner`, level 1, scopes `['*']`), `createTaskRunner(store, runtime, tools)`, `POST /v1/workspaces/:id/operations` with body `{ tool, input, requestId }`, `POST /v1/tasks/:id/control` with body `{ action }`, `server.tasks.drain()`, `server.tasks.events(ownerId, taskId)`.
- Produces: for a workspace operation (a task whose conversation has `internalOperation`), a marked error or a `waiting_for_device` error from the tool is recorded as the task event `{ type: 'tool_result', taskId, toolCallId: <task id>, outcome: 'failed', isError: true, notDispatched: true, actionHash?: string, sideEffect }` before the error is rethrown. `actionHash` is present only for `workspace.export` (the only operation that has one). `TaskService` then ends the task `failed` with the tool's message, or `waiting_for_device`, because no dispatch is left unresolved. Unmarked errors are unchanged: an `external` tool gives `outcome_unknown`, a `write` tool rethrows, and both end `unknown`.

- [ ] **Step 1: Write the failing test**

Create `test/workspace-operations.test.ts`:

```ts
import assert from 'node:assert/strict';
import test from 'node:test';
import { developmentAuth } from '../src/auth.js';
import { DomainError, notDispatched, type ToolDefinition } from '../src/contracts.js';
import type { Task } from '../src/domain.js';
import { createServer } from '../src/http/server.js';
import { createTaskRunner } from '../src/runtime-adapter.js';
import { SqliteStore } from '../src/storage/sqlite.js';

const token = 'workspace-operations-development-token-thirty-two';
const headers = { authorization: `Bearer ${token}` };

interface EventPayload {
  type?: string;
  toolCallId?: string;
  outcome?: string;
  isError?: boolean;
  notDispatched?: boolean;
  sideEffect?: string;
}

function fakeTool(sideEffect: 'write' | 'external', execute: ToolDefinition['execute']): ToolDefinition {
  return {
    name: sideEffect === 'write' ? 'fake.write' : 'fake.run',
    description: 'Fake workspace tool',
    inputSchema: { type: 'object' },
    requiredCapabilities: [],
    requiresWorkspace: true,
    sideEffect,
    execute,
  };
}

async function harness(tool: ToolDefinition) {
  const store = new SqliteStore();
  const server = await createServer({
    store,
    tools: [tool],
    authenticate: developmentAuth(token),
    runner: createTaskRunner(store, { run: async () => { throw new Error('model must not run'); } }, [tool]),
    reauthorize: async (current) => current,
  });
  const workspace = await store.create('workspace', 'local-owner', {
    name: 'Local', root: '/project', deviceId: 'server', capabilities: [], allowCloud: false,
  });
  return {
    store,
    server,
    async operate(requestId: string): Promise<string> {
      const response = await server.app.inject({
        method: 'POST',
        url: `/v1/workspaces/${workspace.id}/operations`,
        headers,
        payload: { tool: tool.name, input: { path: 'a.txt' }, requestId },
      });
      assert.equal(response.statusCode, 202, response.body);
      await server.tasks.drain();
      return response.json().data.id as string;
    },
    async task(id: string): Promise<Task> {
      return (await store.get<Task>('task', id, 'local-owner'))!.data;
    },
    async payloads(id: string): Promise<EventPayload[]> {
      return (await server.tasks.events('local-owner', id)).map((row) => row.data.payload as EventPayload);
    },
    async close(): Promise<void> { await server.close(); await store.close(); },
  };
}

for (const [sideEffect, error] of [
  ['write', notDispatched('write_conflict', 'File changed since it was read', 409)],
  ['external', notDispatched('terminal_sandbox_required', 'Production terminal execution requires an operating-system sandbox', 503)],
] as const) {
  test(`a workspace operation that was refused before dispatch ends failed with the tool's message (${sideEffect} tool)`, async () => {
    let executions = 0;
    const context = await harness(fakeTool(sideEffect, async () => { executions += 1; throw error; }));
    try {
      const id = await context.operate('refused-1');
      const task = await context.task(id);
      assert.equal(task.state, 'failed');
      assert.equal(task.error, error.message);
      const events = (await context.payloads(id)).filter((payload) => payload.type?.startsWith('tool_'));
      assert.deepEqual(events.map((payload) => payload.type), ['tool_dispatched', 'tool_result']);
      assert.deepEqual(
        [events[1]!.toolCallId, events[1]!.outcome, events[1]!.isError, events[1]!.notDispatched, events[1]!.sideEffect],
        [id, 'failed', true, true, sideEffect],
      );
      assert.equal(await context.operate('refused-1'), id);
      assert.equal(executions, 1);
    } finally { await context.close(); }
  });

  test(`an unmarked failure of a workspace operation still ends unknown (${sideEffect} tool)`, async () => {
    const context = await harness(fakeTool(sideEffect, async () => { throw new DomainError('invalid_input', 'Remote side rejected the request'); }));
    try {
      const id = await context.operate('unmarked-1');
      assert.equal((await context.task(id)).state, 'unknown');
      const events = (await context.payloads(id)).filter((payload) => payload.type?.startsWith('tool_'));
      assert.deepEqual(events.map((payload) => payload.type), ['tool_dispatched']);
    } finally { await context.close(); }
  });
}

test('a workspace operation waiting for its device can be cancelled and ends cancelled', async () => {
  const context = await harness(fakeTool('external', async () => {
    throw new DomainError('waiting_for_device', 'Waiting for the authorized device to reconnect');
  }));
  try {
    const id = await context.operate('offline-1');
    assert.equal((await context.task(id)).state, 'waiting_for_device');
    const events = (await context.payloads(id)).filter((payload) => payload.type?.startsWith('tool_'));
    assert.deepEqual(events.map((payload) => [payload.type, payload.outcome, payload.notDispatched]), [
      ['tool_dispatched', undefined, undefined],
      ['tool_result', 'failed', true],
    ]);
    const cancelled = await context.server.app.inject({
      method: 'POST', url: `/v1/tasks/${id}/control`, headers, payload: { action: 'cancel' },
    });
    assert.equal(cancelled.statusCode, 200, cancelled.body);
    assert.equal(cancelled.json().data.data.state, 'cancelled');
  } finally { await context.close(); }
});

test('a workspace operation that waited for its device runs once the device is back', async () => {
  let online = false;
  let executions = 0;
  const context = await harness(fakeTool('write', async () => {
    executions += 1;
    if (!online) throw new DomainError('waiting_for_device', 'Waiting for the authorized device to reconnect');
    return { content: 'saved' };
  }));
  try {
    const id = await context.operate('offline-2');
    assert.equal((await context.task(id)).state, 'waiting_for_device');
    online = true;
    const row = (await context.store.get<Task>('task', id, 'local-owner'))!;
    await context.store.put('task', row.id, row.ownerId, { ...row.data, nextAttemptAt: new Date(0).toISOString() }, row.revision);
    await context.server.tasks.drain();
    const task = await context.task(id);
    assert.equal(task.state, 'completed', task.error);
    assert.equal(task.result, 'saved');
    assert.equal(executions, 2);
    const outcomes = (await context.payloads(id)).filter((payload) => payload.type === 'tool_result').map((payload) => payload.outcome);
    assert.deepEqual(outcomes, ['failed', 'confirmed']);
  } finally { await context.close(); }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx --test test/workspace-operations.test.ts`

Expected: `ℹ tests 6`, `ℹ pass 2`, `ℹ fail 4`. The two `unmarked failure` tests pass (they pin what must not change). The failures:

```
✖ a workspace operation that was refused before dispatch ends failed with the tool's message (write tool)
  + 'unknown'
  - 'failed'
✖ a workspace operation that was refused before dispatch ends failed with the tool's message (external tool)
  + 'unknown'
  - 'failed'
✖ a workspace operation waiting for its device can be cancelled and ends cancelled
    actual: [ [ 'tool_dispatched', undefined, undefined ] ],
    expected: [ [ 'tool_dispatched', undefined, undefined ], [ 'tool_result', 'failed', true ] ],
✖ a workspace operation that waited for its device runs once the device is back
    actual: [ 'confirmed' ],
    expected: [ 'failed', 'confirmed' ],
```

- [ ] **Step 3: Write minimal implementation**

In `src/runtime-adapter.ts` replace the import on line 2:

```ts
import { DomainError, type Principal, type RunMode, type ToolDefinition } from './contracts.js';
```

with:

```ts
import { DomainError, isNotDispatched, type Principal, type RunMode, type ToolDefinition } from './contracts.js';
```

In `createTaskRunner`, inside `if (conversation.data.internalOperation) { ... }`, replace:

```ts
      catch (error) {
        if (tool.sideEffect === 'external' && !(error instanceof DomainError && error.code === 'waiting_for_device')) throw new DomainError('outcome_unknown', 'Workspace operation stopped without a confirmed result');
        throw error;
      }
```

with:

```ts
      catch (error) {
        if (isNotDispatched(error) || (error instanceof DomainError && error.code === 'waiting_for_device')) {
          await onEvent({ type: 'tool_result', taskId: task.id, toolCallId: task.id, outcome: 'failed', isError: true, notDispatched: true, ...(actionHash ? { actionHash } : {}), sideEffect: tool.sideEffect });
          throw error;
        }
        if (tool.sideEffect === 'external') throw new DomainError('outcome_unknown', 'Workspace operation stopped without a confirmed result');
        throw error;
      }
```

If `onEvent` itself throws here (the run was aborted while the tool was failing), that error propagates and the dispatch stays unresolved, so the task ends `unknown`. That is the accepted abort window (spec B1, last bullet).

- [ ] **Step 4: Run test to verify it passes**

Run: `npx tsx --test test/workspace-operations.test.ts`

Expected: `ℹ tests 6`, `ℹ pass 6`, `ℹ fail 0`.

Run: `npx tsx --test test/workspace-export.test.ts test/api.test.ts test/tasks.test.ts`

Expected: `ℹ fail 0`.

- [ ] **Step 5: Commit**

```bash
git add src/runtime-adapter.ts test/workspace-operations.test.ts
git commit -m "修復：工作區操作在派發前被拒時記錄失敗結果，不再標記為未知"
```

---

### Task 5: Scope checks and the server tool wrapper are marked

**Files:**
- Modify: `src/auth.ts` (import on line 3; `requireScope`, lines 218-221 as of commit 17d571f — after plan A the function body calls `scopeAllows`, the `throw` line is the same)
- Modify: `src/bootstrap.ts` (import on line 8; the `localTools.map` wrapper inside `bootstrap`, lines 131-139 as of commit 17d571f)
- Test: `test/not-dispatched.test.ts` (append), `test/bootstrap-server-tools.test.ts` (create)

**Interfaces:**
- Consumes: `notDispatched(code, message, statusCode?)`, `isNotDispatched(error)` from `src/contracts.ts` (Task 1); the internal-operation behaviour of Task 4 (a marked error ends the operation `failed`). Existing: `bootstrap(config)` returning `{ app, store, tasks, close, ... }`, `configSchema`, `createServer`, `WorkspaceWriteLeaseRecord` from `src/workspace-write-lease.ts`.
- Produces:
  - `requireScope(principal: Principal, scope: string): void` — unchanged signature, code `forbidden`, status 403 and message `` `Missing capability: ${scope}` ``; the error is now marked. Every tool calls `requireScope` before its effect, so the marker is always true there; on HTTP routes the marker is ignored and never serialised.
  - The server tool wrapper in `bootstrap` throws marked `workspace_unavailable` (404, `Workspace root is unavailable`) when the workspace root cannot be resolved (previously a raw `ENOENT` error) and marked `workspace_denied` (403, message unchanged) when it is outside the configured roots.

**Throw sites edited in this task**

| Site (lines as of 17d571f) | Code | Side | Change |
| --- | --- | --- | --- |
| `src/auth.ts` 220, `requireScope` | `forbidden` | PRE | `notDispatched(...)` |
| `src/bootstrap.ts` 134, device workspace | — | delegated | none; `devices.remoteTool` is classified in Task 8 |
| `src/bootstrap.ts` 135, `realpath(context.workspace.root)` rejects | raw `Error` | PRE | marked `workspace_unavailable` 404 |
| `src/bootstrap.ts` 136, root outside `serverWorkspaceRoots` | `workspace_denied` | PRE | `notDispatched(...)` |
| `src/bootstrap.ts` 137, `tool.execute(input, context)` | — | delegated | none; each tool is classified in Tasks 6 and 7 |

- [ ] **Step 1: Write the failing test**

In `test/not-dispatched.test.ts` replace the import of `../src/contracts.js`:

```ts
import { asNotDispatched, DomainError, isNotDispatched, notDispatched } from '../src/contracts.js';
```

with:

```ts
import { requireScope } from '../src/auth.js';
import { asNotDispatched, DomainError, isNotDispatched, notDispatched, type Principal } from '../src/contracts.js';
import { createServer } from '../src/http/server.js';
import { SqliteStore } from '../src/storage/sqlite.js';
```

and append at the end of the file:

```ts
test('requireScope throws a marked forbidden and the HTTP error body does not expose the marker', async () => {
  const limited: Principal = { id: 'limited', level: 2, scopes: ['chat:read', 'kiancode:task:read', 'workspace:*'] };
  for (const scope of ['chat:read', 'task:read', 'workspace:write']) {
    assert.equal(requireScope(limited, scope), undefined);
  }
  assert.throws(() => requireScope(limited, 'shell:execute'), (error: unknown) => isNotDispatched(error)
    && error.code === 'forbidden' && error.statusCode === 403 && error.message === 'Missing capability: shell:execute');

  const store = new SqliteStore();
  const server = await createServer({ store, authenticate: async () => limited, runner: async () => ({ text: 'unused' }) });
  try {
    const response = await server.app.inject({ method: 'GET', url: '/v1/memories' });
    assert.equal(response.statusCode, 403, response.body);
    assert.deepEqual(response.json(), { error: { code: 'forbidden', message: 'Missing capability: memory:read' } });
  } finally { await server.close(); await store.close(); }
});
```

Create `test/bootstrap-server-tools.test.ts`:

```ts
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { bootstrap } from '../src/bootstrap.js';
import { configSchema } from '../src/config.js';
import type { Task } from '../src/domain.js';
import type { WorkspaceWriteLeaseRecord } from '../src/workspace-write-lease.js';

const tokenEnv = 'KIANCODE_BOOTSTRAP_SERVER_TOOLS_TEST_TOKEN';
const token = 'bootstrap-server-tools-test-token-with-thirty-two-characters';
const headers = { authorization: `Bearer ${token}` };

test('a server workspace the wrapper refuses ends the operation failed and leaves the workspace writable', async () => {
  const directory = await realpath(await mkdtemp(path.join(tmpdir(), 'kiancode-bootstrap-server-tools-')));
  const root = path.join(directory, 'root');
  await mkdir(path.join(root, 'inside'), { recursive: true });
  await mkdir(path.join(directory, 'outside'));
  const priorToken = process.env[tokenEnv];
  process.env[tokenEnv] = token;
  const server = await bootstrap(configSchema.parse({
    mode: 'development',
    stateDirectory: path.join(directory, 'state'),
    checkpointDirectory: path.join(directory, 'checkpoints'),
    database: { sqlitePath: path.join(directory, 'core.sqlite') },
    auth: { developmentTokenEnv: tokenEnv },
    serverWorkspaceRoots: [root],
    attachments: { localDirectory: path.join(directory, 'attachments') },
  }));
  const run = async (name: string, workspaceRoot: string): Promise<{ task: Task; lease?: WorkspaceWriteLeaseRecord }> => {
    const workspace = await server.store.create('workspace', 'local-owner', {
      name, root: workspaceRoot, deviceId: 'server', capabilities: ['shell:execute'], allowCloud: false,
    });
    const started = await server.app.inject({
      method: 'POST',
      url: `/v1/workspaces/${workspace.id}/operations`,
      headers,
      payload: { tool: 'terminal.run', input: { command: 'printf ok', shell: '/bin/sh' }, requestId: `run-${name}` },
    });
    assert.equal(started.statusCode, 202, started.body);
    await server.tasks.drain();
    const task = (await server.store.get<Task>('task', started.json().data.id as string, 'local-owner'))!.data;
    const lease = (await server.store.scan<WorkspaceWriteLeaseRecord>('workspace_write_lease', 'local-owner'))
      .find((row) => row.data.workspaceId === workspace.id)?.data;
    return { task, ...(lease ? { lease } : {}) };
  };
  try {
    const outside = await run('outside', path.join(directory, 'outside'));
    assert.equal(outside.task.state, 'failed');
    assert.equal(outside.task.error, 'Workspace is outside configured server roots');
    assert.equal(outside.lease?.state, 'released');

    const missing = await run('missing', path.join(root, 'missing'));
    assert.equal(missing.task.state, 'failed');
    assert.equal(missing.task.error, 'Workspace root is unavailable');
    assert.equal(missing.lease?.state, 'released');

    const inside = await run('inside', path.join(root, 'inside'));
    assert.equal(inside.task.state, 'completed', inside.task.error);
    assert.equal(JSON.parse(inside.task.result!).stdout, 'ok');
    assert.equal(inside.lease?.state, 'released');
  } finally {
    await server.close();
    if (priorToken === undefined) delete process.env[tokenEnv];
    else process.env[tokenEnv] = priorToken;
    await rm(directory, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx --test test/not-dispatched.test.ts test/bootstrap-server-tools.test.ts`

Expected: two failures.

```
✖ a server workspace the wrapper refuses ends the operation failed and leaves the workspace writable
  AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:
  + 'unknown'
  - 'failed'
✖ requireScope throws a marked forbidden and the HTTP error body does not expose the marker
  AssertionError [ERR_ASSERTION]: The validation function is expected to return "true". Received false
  Caught error:
  DomainError: Missing capability: shell:execute
```

- [ ] **Step 3: Write minimal implementation**

In `src/auth.ts` replace the import on line 3:

```ts
import { DomainError, type Principal } from './contracts.js';
```

with:

```ts
import { DomainError, notDispatched, type Principal } from './contracts.js';
```

and in `requireScope` replace:

```ts
  throw new DomainError('forbidden', `Missing capability: ${scope}`, 403);
```

with:

```ts
  throw notDispatched('forbidden', `Missing capability: ${scope}`, 403);
```

In `src/bootstrap.ts` replace the import on line 8:

```ts
import { DomainError, type ToolDefinition } from './contracts.js';
```

with:

```ts
import { DomainError, notDispatched, type ToolDefinition } from './contracts.js';
```

and in the `localTools.map` wrapper replace:

```ts
        const actual = await realpath(context.workspace.root);
        if (!roots.some((root) => { const relative = path.relative(root, actual); return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative)); })) throw new DomainError('workspace_denied', 'Workspace is outside configured server roots', 403);
```

with:

```ts
        const actual = await realpath(context.workspace.root).catch(() => {
          throw notDispatched('workspace_unavailable', 'Workspace root is unavailable', 404);
        });
        if (!roots.some((root) => { const relative = path.relative(root, actual); return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative)); })) throw notDispatched('workspace_denied', 'Workspace is outside configured server roots', 403);
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx tsx --test test/not-dispatched.test.ts test/bootstrap-server-tools.test.ts`

Expected: `ℹ tests 7`, `ℹ pass 7`, `ℹ fail 0`.

Run: `npx tsc --noEmit && npx tsx --test test/auth.test.ts test/api.test.ts test/bootstrap-device-tools.test.ts`

Expected: no type errors and `ℹ fail 0`.

- [ ] **Step 5: Commit**

```bash
git add src/auth.ts src/bootstrap.ts test/not-dispatched.test.ts test/bootstrap-server-tools.test.ts
git commit -m "修復：權限檢查與伺服器工作區檢查標記為未派發"
```

---

### Task 6: Classify the `terminal.run` throw sites

**Files:**
- Modify: `src/tools/terminal.ts` (import on line 6; `resolveCwd`, lines 125-142; new helper `startProcess` before `stopProcess`, line 210; `createTerminalTool` → `execute`, lines 248-297, as of commit 17d571f)
- Test: `test/connector-terminal.test.ts` (append)

**Interfaces:**
- Consumes: `notDispatched(code, message, statusCode?)`, `asNotDispatched(error, code, statusCode?)`, `isNotDispatched(error)` from `src/contracts.ts` (Task 1); marked `requireScope` (Task 5). Existing test helper `context(root: string, signal: AbortSignal): ToolContext` in `test/connector-terminal.test.ts`.
- Produces: `createTerminalTool(options).execute` rejects with a marked `DomainError` for every refusal before a process exists. New codes: `terminal_environment_unavailable` (503, message of the underlying error) when the isolated environment cannot be prepared, `terminal_spawn_failed` (503, message of the underlying error) when the process never got a pid. All other codes, messages and statuses are unchanged. Once a process has a pid, the tool behaves as before: it resolves a `ToolResult` (non-zero exit, timeout and abort are `isError: true`), and an `error` event from a running child is rejected unmarked.

**Throw sites in `src/tools/terminal.ts` (lines as of 17d571f)**

| Line | Site | Code | Side | Change |
| --- | --- | --- | --- | --- |
| 59 | `commandEnvironment`: reserved environment name | raw `Error` | PRE | converted at the call on line 266 |
| 79-90 | `commandEnvironment`: `mkdir` / `realpath` / `chmod` of the runtime directories | raw `Error` | PRE | converted at the call on line 266 |
| 109-113 | `validateBubblewrap` | raw `Error` | not a tool throw (runs in `createTerminalTool`) | none |
| 127 | `resolveCwd`: no workspace | `workspace_required` | PRE | marked |
| 129 | `resolveCwd`: workspace of another owner | `forbidden` | PRE | marked |
| 131-133 | `resolveCwd`: workspace root missing | `workspace_unavailable` | PRE | marked |
| 134 | `resolveCwd`: `cwd` not a string | `invalid_input` | PRE | marked |
| 136 | `resolveCwd`: lexical escape | `path_outside_workspace` | PRE | marked |
| 137-139 | `resolveCwd`: `cwd` missing | `path_not_found` | PRE | marked |
| 140 | `resolveCwd`: symlink escape | `path_outside_workspace` | PRE | marked |
| 250 | sandbox required | `terminal_sandbox_required` | PRE | marked |
| 252 | workspace lacks `shell:execute` (also when there is no workspace) | `capability_required` | PRE | marked |
| 253 | `requireScope` | `forbidden` | PRE | marked in Task 5 |
| 256 | `command` empty or not a string | `invalid_input` | PRE | marked |
| 257 | shell missing or not allowed | `shell_not_allowed` | PRE | marked |
| 259-261 | `timeoutMs` out of range | `invalid_input` | PRE | marked |
| 266 | `commandEnvironment(...)` rejects | raw `Error` | PRE | `asNotDispatched(error, 'terminal_environment_unavailable', 503)` |
| 276 | `spawn(...)` throws synchronously | raw `Error` | PRE | `asNotDispatched(error, 'terminal_spawn_failed', 503)` in `startProcess` |
| 293-297 | child `error` event, `child.pid === undefined` | raw `Error` | PRE | `notDispatched('terminal_spawn_failed', error.message, 503)` |
| 293-297 | child `error` event, `child.pid` defined | raw `Error` | POST | none |
| 298-320 | child `close` | not thrown: resolves a `ToolResult` | known outcome | none |

- [ ] **Step 1: Write the failing test**

In `test/connector-terminal.test.ts` replace the two imports:

```ts
import { access, chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
```

```ts
import type { ToolContext } from '../src/contracts.js';
```

with:

```ts
import { access, chmod, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
```

```ts
import { isNotDispatched, type ToolContext } from '../src/contracts.js';
```

and append at the end of the file:

```ts
function refusedBeforeDispatch(code: string): (error: unknown) => boolean {
  return (error) => {
    assert.ok(isNotDispatched(error), `expected a not-dispatched ${code}, got ${String(error)}`);
    assert.equal(error.code, code);
    return true;
  };
}

test('terminal.run marks every refusal that happens before a process exists', async () => {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'kiancode-terminal-refused-')));
  const outside = await realpath(await mkdtemp(path.join(tmpdir(), 'kiancode-terminal-outside-')));
  const marker = path.join(root, 'ran');
  const signal = new AbortController().signal;
  const run = { command: `touch ${marker}`, shell: '/bin/sh' };
  try {
    await symlink(outside, path.join(root, 'escape'));
    await writeFile(path.join(root, 'regular-file'), '');
    const tool = createTerminalTool({ allowedShells: ['/bin/sh'], maxTimeoutMs: 1_000 });
    const inputs: Array<[Record<string, unknown>, string]> = [
      [{ ...run, command: '' }, 'invalid_input'],
      [{ ...run, command: 7 }, 'invalid_input'],
      [{ ...run, shell: '/bin/zsh' }, 'shell_not_allowed'],
      [{ command: run.command }, 'shell_not_allowed'],
      [{ ...run, timeoutMs: 0 }, 'invalid_input'],
      [{ ...run, timeoutMs: -1 }, 'invalid_input'],
      [{ ...run, timeoutMs: 1.5 }, 'invalid_input'],
      [{ ...run, timeoutMs: '10' }, 'invalid_input'],
      [{ ...run, timeoutMs: 1_001 }, 'invalid_input'],
      [{ ...run, cwd: '../elsewhere' }, 'path_outside_workspace'],
      [{ ...run, cwd: outside }, 'path_outside_workspace'],
      [{ ...run, cwd: 'escape' }, 'path_outside_workspace'],
      [{ ...run, cwd: 'missing' }, 'path_not_found'],
      [{ ...run, cwd: 7 }, 'invalid_input'],
    ];
    for (const [input, code] of inputs) {
      await assert.rejects(tool.execute(input, context(root, signal)), refusedBeforeDispatch(code), JSON.stringify(input));
    }

    const withoutCapability = context(root, signal);
    withoutCapability.workspace!.capabilities = [];
    await assert.rejects(tool.execute(run, withoutCapability), refusedBeforeDispatch('capability_required'));
    const withoutScope = context(root, signal);
    withoutScope.principal.scopes = [];
    await assert.rejects(tool.execute(run, withoutScope), refusedBeforeDispatch('forbidden'));
    const foreign = context(root, signal);
    foreign.workspace!.ownerId = 'someone-else';
    await assert.rejects(tool.execute(run, foreign), refusedBeforeDispatch('forbidden'));
    await assert.rejects(
      tool.execute(run, context(path.join(root, 'no-such-root'), signal)),
      refusedBeforeDispatch('workspace_unavailable'),
    );
    const { workspace: _workspace, ...withoutWorkspace } = context(root, signal);
    await assert.rejects(tool.execute(run, withoutWorkspace), refusedBeforeDispatch('capability_required'));

    await assert.rejects(
      createTerminalTool({ allowedShells: ['/bin/sh'], requireSandbox: true }).execute(run, context(root, signal)),
      refusedBeforeDispatch('terminal_sandbox_required'),
    );
    await assert.rejects(
      createTerminalTool({ allowedShells: ['/bin/sh'], environment: { HOME: '/elsewhere' } }).execute(run, context(root, signal)),
      refusedBeforeDispatch('terminal_environment_unavailable'),
    );
    await assert.rejects(
      createTerminalTool({ allowedShells: ['/bin/sh'], runtimeDirectory: path.join(root, 'regular-file', 'runtime') })
        .execute(run, context(root, signal)),
      refusedBeforeDispatch('terminal_environment_unavailable'),
    );
    const missingShell = path.join(root, 'no-such-shell');
    await assert.rejects(
      createTerminalTool({ allowedShells: [missingShell], runtimeDirectory: path.join(root, '.runtime') })
        .execute({ ...run, shell: missingShell }, context(root, signal)),
      refusedBeforeDispatch('terminal_spawn_failed'),
    );
    await assert.rejects(access(marker));
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test('a command that ran and failed is a result, never a thrown error', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'kiancode-terminal-ran-'));
  try {
    const tool = createTerminalTool({ allowedShells: ['/bin/sh'], runtimeDirectory: path.join(root, '.runtime') });
    const failed = await tool.execute({ command: 'exit 3', shell: '/bin/sh' }, context(root, new AbortController().signal));
    assert.equal(failed.isError, true);
    assert.equal((JSON.parse(failed.content) as { exitCode: number }).exitCode, 3);
    const timedOut = await tool.execute({ command: 'sleep 5', shell: '/bin/sh', timeoutMs: 50 }, context(root, new AbortController().signal));
    assert.equal(timedOut.isError, true);
    assert.equal((JSON.parse(timedOut.content) as { timedOut: boolean }).timedOut, true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx --test test/connector-terminal.test.ts`

Expected: one failure; `a command that ran and failed is a result, never a thrown error` passes (a pin).

```
✖ terminal.run marks every refusal that happens before a process exists
  AssertionError [ERR_ASSERTION]: expected a not-dispatched invalid_input, got DomainError: command must be a non-empty string
```

- [ ] **Step 3: Write minimal implementation**

Apply to `src/tools/terminal.ts`:

```diff
--- a/src/tools/terminal.ts
+++ b/src/tools/terminal.ts
@@ -4,5 +4,5 @@ import { chmod, mkdir, realpath } from 'node:fs/promises';
 import { tmpdir } from 'node:os';
 import path from 'node:path';
-import { DomainError, type ToolContext, type ToolDefinition } from '../contracts.js';
+import { asNotDispatched, notDispatched, type ToolContext, type ToolDefinition } from '../contracts.js';
 import { requireScope } from '../auth.js';
 
@@ -125,18 +125,18 @@ function shellArguments(shell: string, command: string): string[] {
 async function resolveCwd(context: ToolContext, requested: unknown): Promise<{ root: string; cwd: string }> {
   const workspace = context.workspace;
-  if (!workspace) throw new DomainError('workspace_required', 'A workspace is required');
+  if (!workspace) throw notDispatched('workspace_required', 'A workspace is required');
   if (workspace.ownerId !== context.principal.id && !hasScope(context, `workspace:${workspace.id}`)) {
-    throw new DomainError('forbidden', 'Principal cannot access this workspace', 403);
+    throw notDispatched('forbidden', 'Principal cannot access this workspace', 403);
   }
   const root = await realpath(workspace.root).catch(() => {
-    throw new DomainError('workspace_unavailable', 'Workspace root is unavailable', 404);
+    throw notDispatched('workspace_unavailable', 'Workspace root is unavailable', 404);
   });
-  if (requested !== undefined && typeof requested !== 'string') throw new DomainError('invalid_input', 'cwd must be a string');
+  if (requested !== undefined && typeof requested !== 'string') throw notDispatched('invalid_input', 'cwd must be a string');
   const lexical = path.resolve(root, requested ?? '.');
-  if (!within(root, lexical)) throw new DomainError('path_outside_workspace', 'cwd is outside workspace', 403);
+  if (!within(root, lexical)) throw notDispatched('path_outside_workspace', 'cwd is outside workspace', 403);
   const resolved = await realpath(lexical).catch(() => {
-    throw new DomainError('path_not_found', 'cwd was not found', 404);
+    throw notDispatched('path_not_found', 'cwd was not found', 404);
   });
-  if (!within(root, resolved)) throw new DomainError('path_outside_workspace', 'cwd resolves outside workspace', 403);
+  if (!within(root, resolved)) throw notDispatched('path_outside_workspace', 'cwd resolves outside workspace', 403);
   return { root, cwd: resolved };
 }
@@ -208,4 +208,17 @@ function bubblewrapArguments(
 }
 
+function startProcess(executable: string, arguments_: string[], cwd: string, environment: NodeJS.ProcessEnv) {
+  try {
+    return spawn(executable, arguments_, {
+      cwd,
+      detached: process.platform !== 'win32',
+      env: environment,
+      stdio: ['ignore', 'pipe', 'pipe'],
+    });
+  } catch (error) {
+    throw asNotDispatched(error, 'terminal_spawn_failed', 503);
+  }
+}
+
 function stopProcess(pid: number | undefined): void {
   if (!pid) return;
@@ -248,15 +261,15 @@ export function createTerminalTool(options: TerminalToolOptions = {}): ToolDefin
     async execute(input, context) {
       if (options.requireSandbox) {
-        throw new DomainError('terminal_sandbox_required', 'Server terminal execution requires an OS sandbox', 503);
+        throw notDispatched('terminal_sandbox_required', 'Server terminal execution requires an OS sandbox', 503);
       }
-      if (!context.workspace?.capabilities.includes('shell:execute')) throw new DomainError('capability_required', 'Missing shell:execute capability', 403);
+      if (!context.workspace?.capabilities.includes('shell:execute')) throw notDispatched('capability_required', 'Missing shell:execute capability', 403);
       requireScope(context.principal, 'shell:execute');
       const command = input.command;
       const shell = input.shell;
-      if (typeof command !== 'string' || command.length === 0) throw new DomainError('invalid_input', 'command must be a non-empty string');
-      if (typeof shell !== 'string' || !allowedShells.includes(shell)) throw new DomainError('shell_not_allowed', 'Shell is not explicitly allowed', 403);
+      if (typeof command !== 'string' || command.length === 0) throw notDispatched('invalid_input', 'command must be a non-empty string');
+      if (typeof shell !== 'string' || !allowedShells.includes(shell)) throw notDispatched('shell_not_allowed', 'Shell is not explicitly allowed', 403);
       const timeoutMs = input.timeoutMs === undefined ? Math.min(30_000, maxTimeoutMs) : input.timeoutMs;
       if (!Number.isInteger(timeoutMs) || (timeoutMs as number) <= 0 || (timeoutMs as number) > maxTimeoutMs) {
-        throw new DomainError('invalid_input', `timeoutMs must be from 1 to ${maxTimeoutMs}`);
+        throw notDispatched('invalid_input', `timeoutMs must be from 1 to ${maxTimeoutMs}`);
       }
       const { root, cwd } = await resolveCwd(context, input.cwd);
@@ -264,5 +277,7 @@ export function createTerminalTool(options: TerminalToolOptions = {}): ToolDefin
       const stderr: CapturedOutput = { text: '', bytes: 0, truncated: false };
       const startedAt = Date.now();
-      const environment = await commandEnvironment(context, shell, options);
+      const environment = await commandEnvironment(context, shell, options).catch((error: unknown) => {
+        throw asNotDispatched(error, 'terminal_environment_unavailable', 503);
+      });
       const sandbox = options.bubblewrap
         ? bubblewrapArguments(options.bubblewrap, context, root, cwd, shell, command)
@@ -274,10 +289,5 @@ export function createTerminalTool(options: TerminalToolOptions = {}): ToolDefin
         let timedOut = false;
         let aborted = context.signal.aborted;
-        const child = spawn(executable, arguments_, {
-          cwd,
-          detached: process.platform !== 'win32',
-          env: environment,
-          stdio: ['ignore', 'pipe', 'pipe'],
-        });
+        const child = startProcess(executable, arguments_, cwd, environment);
         const timeout = setTimeout(() => {
           timedOut = true;
@@ -294,5 +304,5 @@ export function createTerminalTool(options: TerminalToolOptions = {}): ToolDefin
           clearTimeout(timeout);
           context.signal.removeEventListener('abort', abort);
-          reject(error);
+          reject(child.pid === undefined ? notDispatched('terminal_spawn_failed', error.message, 503) : error);
         });
         child.once('close', (exitCode, signal) => {
```

`DomainError` is no longer referenced in this file, which is why the import drops it.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx tsx --test test/connector-terminal.test.ts`

Expected: `ℹ tests 10`, `ℹ pass 10`, `ℹ fail 0`.

Run: `npx tsc --noEmit`

Expected: no output.

- [ ] **Step 5: Commit**

```bash
git add src/tools/terminal.ts test/connector-terminal.test.ts
git commit -m "修復：terminal.run 於建立程序前的拒絕標記為未派發"
```

---

### Task 7: Classify the workspace write, patch, restore and export throw sites

**Files:**
- Modify: `src/tools/workspace.ts` (import on line 17; helpers `stringInput` to `resolveForWrite`, lines 73-161; `exportTool.execute`, lines 352-365; `write.execute`, lines 441-488; `patchTool.execute`, lines 513-571; `restore.execute`, lines 613-644, as of commit 17d571f)
- Not modified, on purpose: `src/tools/workspace-export.ts` and `src/tools/workspace-patch.ts` (see the note under the table)
- Test: `test/workspace-tools.test.ts` (append), `test/workspace-patch.test.ts` (append)

**Interfaces:**
- Consumes: `notDispatched`, `asNotDispatched`, `isNotDispatched` from `src/contracts.ts` (Task 1); marked `requireScope` (Task 5). Existing test helpers `context(root, taskId?, principalId?, workspaceId?)` in `test/workspace-tools.test.ts` and `context(root)`, `sha256(content)` in `test/workspace-patch.test.ts`.
- Produces: `workspace.write`, `workspace.patch`, `workspace.restore` and `workspace.export` reject with a marked `DomainError` for every refusal that happens before the workspace file is changed (or, for export, before the artifact is handed to `exportArtifact`). Codes, messages and statuses are unchanged except:
  - an abort observed before the effect is `DomainError('aborted', 'Operation was cancelled before it started', 499)`, marked, instead of an `AbortError`;
  - raw file-system errors before the effect become marked `workspace_read_failed` (503), `checkpoint_write_failed` (503) or `checkpoint_not_found` (404, a checkpoint file that is not valid JSON), keeping the original message;
  - a workspace root that cannot be inspected is `workspace_unavailable` (404) instead of a raw `stat` error.
- Two private helpers in `src/tools/workspace.ts`: `assertNotCancelledBeforeEffect(signal: AbortSignal): void` and `beforeEffect<T>(code: string, statusCode: number, step: () => T | Promise<T>): Promise<T>`.

**Throw sites (lines as of 17d571f)**

| Line | Site | Code | Side | Change |
| --- | --- | --- | --- | --- |
| 76 | `stringInput` | `invalid_input` | PRE | marked |
| 84 | `numberInput` | `invalid_input` | PRE | marked |
| 100 | `requireWorkspace`: no workspace | `workspace_required` | PRE | marked |
| 106 | `requireWorkspace`: not owner, no delegation | `forbidden` | PRE | marked |
| 107 | `requireWorkspace`: workspace lacks the capability | `capability_required` | PRE | marked |
| 108 | `requireWorkspace`: `requireScope` | `forbidden` | PRE | marked in Task 5 |
| 113-115 | `existingWorkspaceRoot`: root missing | `workspace_unavailable` | PRE | marked |
| 116 | `existingWorkspaceRoot`: `stat` rejects | raw `Error` | PRE | marked `workspace_unavailable` 404 |
| 117 | `existingWorkspaceRoot`: not a directory | `workspace_unavailable` | PRE | marked |
| 123, 127 | `resolveExisting` | `path_outside_workspace` | PRE | marked |
| 125 | `resolveExisting` | `path_not_found` | PRE | marked |
| 134, 141, 145, 148, 160 | `resolveForWrite` | `path_outside_workspace` | PRE | marked |
| 252-268 | `atomicWrite`: `mkdir`, `stat`, temporary `writeFile`, `rename` | raw `Error` | POST | none |
| 278 | `createWorkspaceTools` | `invalid_configuration` | not a tool throw | none |
| 337-339, 403 and the other throws inside `workspace.list`, `workspace.read`, `workspace.search`, `workspace.status` | `not_a_file`, `file_too_large`, `invalid_input` | read tools: no effect, no consumer reads the marker | none |
| 354 | export: abort check | `AbortError` | PRE | marked `aborted` 499 |
| 361 | export: extension not exportable | `unsupported_export_type` | PRE | marked |
| 362 | export: `readStableWorkspaceExport` (`workspace-export.ts` 45-51 `export_conflict` / `path_outside_workspace`, 62-67 `path_outside_workspace` or raw `open` error, 71 `not_a_file`, 73-75 and 85-87 `file_too_large`, 92 `export_conflict`, raw `stat` / `read` errors) | several | PRE: reading the local file is not the export | marked at the call: `beforeEffect('workspace_read_failed', 503, ...)` |
| 363 | export: `validateWorkspaceExport` (`workspace-export.ts` 102-133 `invalid_export`, `file_too_large`) | several | PRE | marked at the call: `beforeEffect('invalid_export', 400, ...)` |
| 365 | export: abort check | `AbortError` | PRE | marked `aborted` 499 |
| 367 | export: `options.exportArtifact(...)` rejects | any | POST: the upload may have happened | none |
| 450-454 | write: `readFile` fails other than `ENOENT` (for example the path is a directory) | raw `Error` | PRE | `asNotDispatched(error, 'workspace_read_failed', 503)` |
| 457 | write: existing file, no hash | `hash_required` | PRE | marked |
| 460 | write: hash mismatch | `write_conflict` | PRE | marked |
| 480, 483 | write: abort checks | `AbortError` | PRE | marked `aborted` 499 |
| 481 | write: checkpoint `writeFile` (checkpoint directory, not the workspace) | raw `Error` | PRE | `beforeEffect('checkpoint_write_failed', 503, ...)` |
| 484 | write: `atomicWrite` | raw `Error` | POST | none |
| 516 | patch: `parseWorkspacePatch` (`workspace-patch.ts` 34 `invalid_patch`, 39, 45, 99 `patch_too_large`) | several | PRE | marked at the call: `beforeEffect('invalid_patch', 400, ...)` |
| 518-521 | patch: `stat` | `path_not_found` / raw `Error` | PRE | marked / `asNotDispatched(error, 'workspace_read_failed', 503)` |
| 522 | patch: not a file | `not_a_file` | PRE | marked |
| 523 | patch: too large | `file_too_large` | PRE | marked |
| 525-527 | patch: `expectedHash` format | `invalid_input` | PRE | marked |
| 528, 543 | patch: `readFile` | raw `Error` | PRE | `beforeEffect('workspace_read_failed', 503, ...)` |
| 531, 545 | patch: hash mismatch | `write_conflict` | PRE | marked |
| 537 | patch: not UTF-8 | `binary_file` | PRE | marked |
| 539 | patch: `applyWorkspacePatch` (`workspace-patch.ts` 134 `patch_ambiguous`, 137 `patch_context_not_found`, 141 `binary_file`, 143, 146 `unsupported_line_endings`) | several | PRE | marked at the call: `beforeEffect('invalid_patch', 400, ...)` |
| 541 | patch: no change | `no_change` | PRE | marked |
| 563, 566 | patch: abort checks | `AbortError` | PRE | marked `aborted` 499 |
| 564 | patch: checkpoint `writeFile` | raw `Error` | PRE | `beforeEffect('checkpoint_write_failed', 503, ...)` |
| 567 | patch: `atomicWrite` | raw `Error` | POST | none |
| 617, 620 | restore: checkpoint id format | `invalid_input` | PRE | marked |
| 621-623 | restore: checkpoint unreadable / not JSON | `checkpoint_not_found` / raw `SyntaxError` | PRE | marked / `beforeEffect('checkpoint_not_found', 404, ...)` |
| 624, 627, 630 | restore: other principal, other task without token, other workspace | `checkpoint_forbidden` | PRE | marked |
| 635 | restore: file changed since the write | `restore_conflict` | PRE | marked |
| 638, 641 | restore: abort checks | `AbortError` | PRE | marked `aborted` 499 (one check before the branch) |
| 639 | restore: `atomicWrite` | raw `Error` | POST | none |
| 642 | restore: `rm(target)` | raw `Error` | POST | none |
| 644 | restore: `rm(resolvedCheckpoint)` after the file was restored | raw `Error` | POST | none |

`workspace-export.ts` and `workspace-patch.ts` are not edited. `readStableWorkspaceExport` and `validateWorkspaceExport` also run *after* a tool executed (in `DeviceConnector.prepareResult` and when the server stores a device result), so marking their `throw` statements would put a marker on errors raised after dispatch. The two patch functions are pure and only called from `workspace.patch`; they are marked at the same kind of boundary for consistency.

- [ ] **Step 1: Write the failing test**

In `test/workspace-tools.test.ts` replace these three imports:

```ts
import { createHash } from 'node:crypto';
import { access, chmod, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
```

```ts
import type { ToolContext, Workspace } from '../src/contracts.js';
```

with:

```ts
import { createHash, randomUUID } from 'node:crypto';
import { access, chmod, mkdir, mkdtemp, readdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
```

```ts
import { DomainError, isNotDispatched, type ToolContext, type Workspace } from '../src/contracts.js';
```

and append at the end of the file:

```ts
function refusedBeforeDispatch(code: string): (error: unknown) => boolean {
  return (error) => {
    assert.ok(isNotDispatched(error), `expected a not-dispatched ${code}, got ${String(error)}`);
    assert.equal(error.code, code);
    return true;
  };
}

function abortedContext(root: string): ToolContext {
  const controller = new AbortController();
  controller.abort();
  return { ...context(root), signal: controller.signal };
}

function sha256(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

test('workspace.write marks every refusal that happens before the file is touched', async () => {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'kiancode-workspace-refused-')));
  const outside = await realpath(await mkdtemp(path.join(tmpdir(), 'kiancode-workspace-outside-')));
  const checkpoints = await mkdtemp(path.join(tmpdir(), 'kiancode-checkpoints-'));
  try {
    await writeFile(path.join(root, 'existing.txt'), 'original');
    await mkdir(path.join(root, 'folder'));
    await symlink(outside, path.join(root, 'escape'));
    const write = (await createWorkspaceTools({ checkpointDirectory: checkpoints })).find((tool) => tool.name === 'workspace.write');
    assert.ok(write);
    const inputs: Array<[Record<string, unknown>, string]> = [
      [{ path: '../new.txt', content: 'no' }, 'path_outside_workspace'],
      [{ path: path.join(outside, 'new.txt'), content: 'no' }, 'path_outside_workspace'],
      [{ path: '', content: 'no' }, 'path_outside_workspace'],
      [{ path: '.', content: 'no' }, 'path_outside_workspace'],
      [{ path: 'escape/new.txt', content: 'no' }, 'path_outside_workspace'],
      [{ path: 7, content: 'no' }, 'invalid_input'],
      [{ path: 'new.txt', content: 7 }, 'invalid_input'],
      [{ path: 'existing.txt', content: 'no' }, 'hash_required'],
      [{ path: 'existing.txt', content: 'no', expectedHash: sha256('something else') }, 'write_conflict'],
      [{ path: 'new.txt', content: 'no', expectedHash: sha256('something else') }, 'write_conflict'],
      [{ path: 'folder', content: 'no' }, 'workspace_read_failed'],
    ];
    for (const [input, code] of inputs) {
      await assert.rejects(write.execute(input, context(root)), refusedBeforeDispatch(code), JSON.stringify(input));
    }
    const create = { path: 'new.txt', content: 'no' };
    await assert.rejects(write.execute(create, abortedContext(root)), (error: unknown) => refusedBeforeDispatch('aborted')(error)
      && (error as DomainError).statusCode === 499);
    const withoutCapability = context(root);
    withoutCapability.workspace!.capabilities = ['workspace:read'];
    await assert.rejects(write.execute(create, withoutCapability), refusedBeforeDispatch('capability_required'));
    const withoutScope = context(root);
    withoutScope.principal.scopes = ['workspace:read'];
    await assert.rejects(write.execute(create, withoutScope), refusedBeforeDispatch('forbidden'));
    await assert.rejects(write.execute(create, context(root, 'task-1', 'someone-else')), refusedBeforeDispatch('forbidden'));
    await assert.rejects(write.execute(create, context(path.join(root, 'no-such-root'))), refusedBeforeDispatch('workspace_unavailable'));
    const { workspace: _workspace, ...withoutWorkspace } = context(root);
    await assert.rejects(write.execute(create, withoutWorkspace), refusedBeforeDispatch('workspace_required'));

    assert.equal(await readFile(path.join(root, 'existing.txt'), 'utf8'), 'original');
    await assert.rejects(access(path.join(root, 'new.txt')));
    assert.deepEqual(await readdir(outside), []);
    assert.deepEqual(await readdir(checkpoints), []);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
    await rm(checkpoints, { recursive: true, force: true });
  }
});

test('a write that fails while changing the workspace is not marked', { skip: process.getuid?.() === 0 }, async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'kiancode-workspace-locked-'));
  const checkpoints = await mkdtemp(path.join(tmpdir(), 'kiancode-checkpoints-'));
  const locked = path.join(root, 'locked');
  try {
    await mkdir(locked, { mode: 0o500 });
    const write = (await createWorkspaceTools({ checkpointDirectory: checkpoints })).find((tool) => tool.name === 'workspace.write');
    assert.ok(write);
    await assert.rejects(write.execute({ path: 'locked/new.txt', content: 'no' }, context(root)), (error: unknown) => {
      assert.equal(isNotDispatched(error), false);
      assert.equal((error as NodeJS.ErrnoException).code, 'EACCES');
      return true;
    });
    assert.deepEqual(await readdir(checkpoints), []);
  } finally {
    await chmod(locked, 0o700).catch(() => undefined);
    await rm(root, { recursive: true, force: true });
    await rm(checkpoints, { recursive: true, force: true });
  }
});

test('workspace.restore marks every refusal that happens before the file is touched', async () => {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'kiancode-workspace-restore-')));
  const checkpoints = await mkdtemp(path.join(tmpdir(), 'kiancode-checkpoints-'));
  try {
    const tools = await createWorkspaceTools({ checkpointDirectory: checkpoints });
    const write = tools.find((tool) => tool.name === 'workspace.write');
    const restore = tools.find((tool) => tool.name === 'workspace.restore');
    assert.ok(write && restore);
    const target = path.join(root, 'note.txt');
    const { checkpointId } = JSON.parse((await write.execute({ path: 'note.txt', content: 'written' }, context(root))).content) as { checkpointId: string };
    const corrupt = randomUUID();
    await writeFile(path.join(checkpoints, `${corrupt}.json`), 'not json');
    const delegate = context(root, 'task-1', 'delegate');
    delegate.principal.scopes.push('workspace:workspace-1');

    await assert.rejects(restore.execute({ checkpointId: 'not-a-checkpoint' }, context(root)), refusedBeforeDispatch('invalid_input'));
    await assert.rejects(restore.execute({ checkpointId: 7 }, context(root)), refusedBeforeDispatch('invalid_input'));
    await assert.rejects(restore.execute({ checkpointId: randomUUID() }, context(root)), refusedBeforeDispatch('checkpoint_not_found'));
    await assert.rejects(restore.execute({ checkpointId: corrupt }, context(root)), refusedBeforeDispatch('checkpoint_not_found'));
    await assert.rejects(restore.execute({ checkpointId }, delegate), refusedBeforeDispatch('checkpoint_forbidden'));
    await assert.rejects(restore.execute({ checkpointId }, context(root, 'another-task')), refusedBeforeDispatch('checkpoint_forbidden'));
    await assert.rejects(restore.execute({ checkpointId }, context(root, 'task-1', 'user-1', 'workspace-2')), refusedBeforeDispatch('checkpoint_forbidden'));
    await assert.rejects(restore.execute({ checkpointId }, abortedContext(root)), refusedBeforeDispatch('aborted'));
    assert.equal(await readFile(target, 'utf8'), 'written');
    await writeFile(target, 'edited by someone else');
    await assert.rejects(restore.execute({ checkpointId }, context(root)), refusedBeforeDispatch('restore_conflict'));
    assert.equal(await readFile(target, 'utf8'), 'edited by someone else');
    assert.equal((await readdir(checkpoints)).includes(`${checkpointId}.json`), true);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(checkpoints, { recursive: true, force: true });
  }
});

test('workspace.export marks refusals before anything leaves the workspace, and a failed upload is not marked', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'kiancode-workspace-export-refused-'));
  let uploads = 0;
  try {
    await writeFile(path.join(root, 'result.md'), '# Result\n');
    await writeFile(path.join(root, 'script.sh'), 'x');
    await writeFile(path.join(root, 'empty.txt'), '');
    await writeFile(path.join(root, 'large.txt'), 'x'.repeat(65));
    await writeFile(path.join(root, 'bad.pdf'), 'not a pdf');
    await writeFile(path.join(root, 'bad.png'), 'not a png');
    await writeFile(path.join(root, 'bad.txt'), Buffer.from([0xff, 0xfe, 0xfd]));
    await writeFile(path.join(root, 'bad.json'), '{');
    const exportTool = (await createWorkspaceTools({
      checkpointDirectory: path.join(root, '.checkpoints'),
      maxExportBytes: 64,
      exportArtifact: async () => {
        uploads += 1;
        throw new DomainError('storage_unavailable', 'Blob store is unavailable', 503);
      },
    })).find((tool) => tool.name === 'workspace.export');
    assert.ok(exportTool);
    const authorized = (): ToolContext => {
      const granted = context(root);
      granted.principal.scopes.push('workspace:export');
      granted.workspace!.capabilities.push('workspace:export');
      return granted;
    };
    await assert.rejects(exportTool.execute({ path: 'result.md' }, context(root)), refusedBeforeDispatch('capability_required'));
    const inputs: Array<[string, string]> = [
      ['missing.md', 'path_not_found'],
      ['script.sh', 'unsupported_export_type'],
      ['empty.txt', 'file_too_large'],
      ['large.txt', 'file_too_large'],
      ['bad.pdf', 'invalid_export'],
      ['bad.png', 'invalid_export'],
      ['bad.txt', 'invalid_export'],
      ['bad.json', 'invalid_export'],
    ];
    for (const [file, code] of inputs) {
      await assert.rejects(exportTool.execute({ path: file }, authorized()), refusedBeforeDispatch(code), file);
    }
    await assert.rejects(exportTool.execute({ path: 'result.md' }, { ...authorized(), signal: abortedContext(root).signal }), refusedBeforeDispatch('aborted'));
    assert.equal(uploads, 0);

    await assert.rejects(exportTool.execute({ path: 'result.md' }, authorized()), (error: unknown) => {
      assert.equal(isNotDispatched(error), false);
      assert.equal((error as DomainError).code, 'storage_unavailable');
      return true;
    });
    assert.equal(uploads, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
```

In `test/workspace-patch.test.ts` replace these two imports:

```ts
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
```

```ts
import type { ToolContext, Workspace } from '../src/contracts.js';
```

with:

```ts
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
```

```ts
import { isNotDispatched, type ToolContext, type Workspace } from '../src/contracts.js';
```

and append at the end of the file:

```ts
test('workspace.patch marks every refusal that happens before the file is touched', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'kiancode-workspace-patch-refused-'));
  const checkpoints = await mkdtemp(path.join(tmpdir(), 'kiancode-workspace-checkpoints-'));
  const files: Record<string, string | Buffer> = {
    'message.txt': 'alpha\nbeta\n',
    'repeated.txt': 'same\nvalue\nsame\nvalue\n',
    'mixed.txt': 'alpha\r\nbeta\ngamma\n',
    'binary.txt': Buffer.from([0xff, 0xfe, 0xfd]),
    'large.txt': `${'x'.repeat(200)}\n`,
  };
  const patch = (file: string, ...lines: string[]): string => ['*** Begin Patch', `*** Update File: ${file}`, ...lines, '*** End Patch'].join('\n');
  const hashOf = (file: string): string => createHash('sha256').update(files[file]!).digest('hex');
  try {
    for (const [name, content] of Object.entries(files)) await writeFile(path.join(root, name), content);
    await mkdir(path.join(root, 'folder'));
    const patchTool = (await createWorkspaceTools({ checkpointDirectory: checkpoints, maxReadBytes: 128, maxPatchBytes: 512 }))
      .find((tool) => tool.name === 'workspace.patch');
    assert.ok(patchTool);
    const change = patch('message.txt', '@@', '-beta', '+gamma');
    const inputs: Array<[Record<string, unknown>, string]> = [
      [{ patch: 'not a patch', expectedHash: hashOf('message.txt') }, 'invalid_patch'],
      [{ patch: patch('message.txt', '@@', '-beta', '+gamma', '*** Update File: other.txt', '@@', '-a', '+b'), expectedHash: hashOf('message.txt') }, 'invalid_patch'],
      [{ patch: `${change}\n${'x'.repeat(512)}`, expectedHash: hashOf('message.txt') }, 'patch_too_large'],
      [{ patch: 7, expectedHash: hashOf('message.txt') }, 'invalid_input'],
      [{ patch: patch('missing.txt', '@@', '-beta', '+gamma'), expectedHash: hashOf('message.txt') }, 'path_not_found'],
      [{ patch: patch('folder', '@@', '-beta', '+gamma'), expectedHash: hashOf('message.txt') }, 'not_a_file'],
      [{ patch: patch('large.txt', '@@', '-beta', '+gamma'), expectedHash: hashOf('large.txt') }, 'file_too_large'],
      [{ patch: change, expectedHash: 'ABC' }, 'invalid_input'],
      [{ patch: change, expectedHash: hashOf('repeated.txt') }, 'write_conflict'],
      [{ patch: patch('binary.txt', '@@', '-beta', '+gamma'), expectedHash: hashOf('binary.txt') }, 'binary_file'],
      [{ patch: patch('message.txt', '@@', '-delta', '+gamma'), expectedHash: hashOf('message.txt') }, 'patch_context_not_found'],
      [{ patch: patch('repeated.txt', '@@', '-same', '-value', '+changed'), expectedHash: hashOf('repeated.txt') }, 'patch_ambiguous'],
      [{ patch: patch('message.txt', '@@', '-beta', '+beta'), expectedHash: hashOf('message.txt') }, 'no_change'],
      [{ patch: patch('mixed.txt', '@@', '-beta', '+delta'), expectedHash: hashOf('mixed.txt') }, 'unsupported_line_endings'],
    ];
    for (const [input, code] of inputs) {
      await assert.rejects(patchTool.execute(input, context(root)), (error: unknown) => {
        assert.ok(isNotDispatched(error), `expected a not-dispatched ${code}, got ${String(error)}`);
        assert.equal(error.code, code);
        return true;
      }, code);
    }
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(
      patchTool.execute({ patch: change, expectedHash: hashOf('message.txt') }, { ...context(root), signal: controller.signal }),
      (error: unknown) => isNotDispatched(error) && error.code === 'aborted' && error.statusCode === 499,
    );
    for (const [name, content] of Object.entries(files)) {
      assert.deepEqual(await readFile(path.join(root, name)), Buffer.from(content), name);
    }
    assert.deepEqual(await readdir(checkpoints), []);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(checkpoints, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx --test test/workspace-tools.test.ts test/workspace-patch.test.ts`

Expected: `ℹ tests 14`, `ℹ pass 10`, `ℹ fail 4`. `a write that fails while changing the workspace is not marked` already passes (a pin).

```
✖ workspace.patch marks every refusal that happens before the file is touched
  AssertionError [ERR_ASSERTION]: expected a not-dispatched invalid_patch, got DomainError: Patch must start with '*** Begin Patch' and end with '*** End Patch'.
✖ workspace.write marks every refusal that happens before the file is touched
  AssertionError [ERR_ASSERTION]: expected a not-dispatched path_outside_workspace, got DomainError: Path is outside workspace
✖ workspace.restore marks every refusal that happens before the file is touched
  AssertionError [ERR_ASSERTION]: expected a not-dispatched invalid_input, got DomainError: Invalid checkpointId
✖ workspace.export marks refusals before anything leaves the workspace, and a failed upload is not marked
  AssertionError [ERR_ASSERTION]: expected a not-dispatched capability_required, got DomainError: Missing workspace:export capability
```

- [ ] **Step 3: Write minimal implementation**

Apply to `src/tools/workspace.ts`:

```diff
--- a/src/tools/workspace.ts
+++ b/src/tools/workspace.ts
@@ -15,5 +15,5 @@ import { tmpdir } from 'node:os';
 import path from 'node:path';
 import { spawn } from 'node:child_process';
-import { DomainError, type ToolContext, type ToolDefinition, type Workspace } from '../contracts.js';
+import { asNotDispatched, DomainError, notDispatched, type ToolContext, type ToolDefinition, type Workspace } from '../contracts.js';
 import { requireScope } from '../auth.js';
 import { applyWorkspacePatch, parseWorkspacePatch } from './workspace-patch.js';
@@ -71,8 +71,22 @@ function validRestoreToken(checkpoint: Checkpoint, token: string | undefined): b
 }
 
+/** Throws when the run was cancelled before the tool changed or exported anything. */
+function assertNotCancelledBeforeEffect(signal: AbortSignal): void {
+  if (signal.aborted) throw notDispatched('aborted', 'Operation was cancelled before it started', 499);
+}
+
+/** Runs a step that happens before the tool's effect; whatever it throws is marked as not dispatched. */
+async function beforeEffect<T>(code: string, statusCode: number, step: () => T | Promise<T>): Promise<T> {
+  try {
+    return await step();
+  } catch (error) {
+    throw asNotDispatched(error, code, statusCode);
+  }
+}
+
 function stringInput(input: Record<string, unknown>, key: string, required = true): string | undefined {
   const value = input[key];
   if (value === undefined && !required) return undefined;
-  if (typeof value !== 'string') throw new DomainError('invalid_input', `${key} must be a string`);
+  if (typeof value !== 'string') throw notDispatched('invalid_input', `${key} must be a string`);
   return value;
 }
@@ -82,5 +96,5 @@ function numberInput(input: Record<string, unknown>, key: string, fallback: numb
   if (value === undefined) return fallback;
   if (!Number.isInteger(value) || (value as number) <= 0 || (value as number) > maximum) {
-    throw new DomainError('invalid_input', `${key} must be an integer from 1 to ${maximum}`);
+    throw notDispatched('invalid_input', `${key} must be an integer from 1 to ${maximum}`);
   }
   return value as number;
@@ -98,5 +112,5 @@ function hasScope(context: ToolContext, scope: string): boolean {
 function requireWorkspace(context: ToolContext, capability: string): Workspace {
   const workspace = context.workspace;
-  if (!workspace) throw new DomainError('workspace_required', 'A workspace is required', 400);
+  if (!workspace) throw notDispatched('workspace_required', 'A workspace is required', 400);
   const workspaceScope = `workspace:${workspace.id}`;
   const isOwner = workspace.ownerId === context.principal.id;
@@ -104,6 +118,6 @@ function requireWorkspace(context: ToolContext, capability: string): Workspace {
   const hasDelegation = hasScope(context, workspaceScope)
     || hasScope(context, `${workspaceScope}:${delegatedAction}`);
-  if (!isOwner && !hasDelegation) throw new DomainError('forbidden', 'Principal cannot access this workspace', 403);
-  if (!workspace.capabilities.includes(capability)) throw new DomainError('capability_required', `Missing ${capability} capability`, 403);
+  if (!isOwner && !hasDelegation) throw notDispatched('forbidden', 'Principal cannot access this workspace', 403);
+  if (!workspace.capabilities.includes(capability)) throw notDispatched('capability_required', `Missing ${capability} capability`, 403);
   requireScope(context.principal, capability);
   return workspace;
@@ -112,8 +126,10 @@ function requireWorkspace(context: ToolContext, capability: string): Workspace {
 async function existingWorkspaceRoot(workspace: Workspace): Promise<string> {
   const resolved = await realpath(workspace.root).catch(() => {
-    throw new DomainError('workspace_unavailable', 'Workspace root is unavailable', 404);
+    throw notDispatched('workspace_unavailable', 'Workspace root is unavailable', 404);
+  });
+  const details = await stat(resolved).catch(() => {
+    throw notDispatched('workspace_unavailable', 'Workspace root is unavailable', 404);
   });
-  const details = await stat(resolved);
-  if (!details.isDirectory()) throw new DomainError('workspace_unavailable', 'Workspace root is not a directory', 400);
+  if (!details.isDirectory()) throw notDispatched('workspace_unavailable', 'Workspace root is not a directory', 400);
   return resolved;
 }
@@ -121,9 +137,9 @@ async function existingWorkspaceRoot(workspace: Workspace): Promise<string> {
 async function resolveExisting(root: string, requested: string): Promise<string> {
   const lexical = path.resolve(root, requested || '.');
-  if (!isWithin(root, lexical)) throw new DomainError('path_outside_workspace', 'Path is outside workspace', 403);
+  if (!isWithin(root, lexical)) throw notDispatched('path_outside_workspace', 'Path is outside workspace', 403);
   const resolved = await realpath(lexical).catch(() => {
-    throw new DomainError('path_not_found', 'Workspace path was not found', 404);
+    throw notDispatched('path_not_found', 'Workspace path was not found', 404);
   });
-  if (!isWithin(root, resolved)) throw new DomainError('path_outside_workspace', 'Path resolves outside workspace', 403);
+  if (!isWithin(root, resolved)) throw notDispatched('path_outside_workspace', 'Path resolves outside workspace', 403);
   return resolved;
 }
@@ -132,5 +148,5 @@ async function resolveForWrite(root: string, requested: string): Promise<string>
   const lexical = path.resolve(root, requested);
   if (!requested || !isWithin(root, lexical) || lexical === root) {
-    throw new DomainError('path_outside_workspace', 'Path is outside workspace', 403);
+    throw notDispatched('path_outside_workspace', 'Path is outside workspace', 403);
   }
   let ancestor = path.dirname(lexical);
@@ -139,12 +155,12 @@ async function resolveForWrite(root: string, requested: string): Promise<string>
       const resolvedAncestor = await realpath(ancestor);
       if (!isWithin(root, resolvedAncestor)) {
-        throw new DomainError('path_outside_workspace', 'Path resolves outside workspace', 403);
+        throw notDispatched('path_outside_workspace', 'Path resolves outside workspace', 403);
       }
       const suffix = path.relative(ancestor, lexical);
       const target = path.resolve(resolvedAncestor, suffix);
-      if (!isWithin(root, target)) throw new DomainError('path_outside_workspace', 'Path resolves outside workspace', 403);
+      if (!isWithin(root, target)) throw notDispatched('path_outside_workspace', 'Path resolves outside workspace', 403);
       try {
         const targetRealpath = await realpath(target);
-        if (!isWithin(root, targetRealpath)) throw new DomainError('path_outside_workspace', 'Path resolves outside workspace', 403);
+        if (!isWithin(root, targetRealpath)) throw notDispatched('path_outside_workspace', 'Path resolves outside workspace', 403);
         return targetRealpath;
       } catch (error) {
@@ -158,5 +174,5 @@ async function resolveForWrite(root: string, requested: string): Promise<string>
     }
   }
-  throw new DomainError('path_outside_workspace', 'Path resolves outside workspace', 403);
+  throw notDispatched('path_outside_workspace', 'Path resolves outside workspace', 403);
 }
 
@@ -352,5 +368,5 @@ export async function createWorkspaceTools(options: WorkspaceToolOptions = {}):
     async execute(input, context) {
       const workspace = requireWorkspace(context, EXPORT_CAPABILITY);
-      context.signal.throwIfAborted();
+      assertNotCancelledBeforeEffect(context.signal);
       const root = await existingWorkspaceRoot(workspace);
       const requested = stringInput(input, 'path')!;
@@ -359,9 +375,9 @@ export async function createWorkspaceTools(options: WorkspaceToolOptions = {}):
       const relativePath = path.relative(root, path.resolve(root, requested));
       const mimeType = workspaceExportMimeType(name);
-      if (!mimeType) throw new DomainError('unsupported_export_type', 'Workspace file type cannot be exported', 415);
-      const bytes = await readStableWorkspaceExport(target, maxExportBytes, root);
-      validateWorkspaceExport(bytes, name, mimeType);
+      if (!mimeType) throw notDispatched('unsupported_export_type', 'Workspace file type cannot be exported', 415);
+      const bytes = await beforeEffect('workspace_read_failed', 503, () => readStableWorkspaceExport(target, maxExportBytes, root));
+      await beforeEffect('invalid_export', 400, () => validateWorkspaceExport(bytes, name, mimeType));
       const sha256 = hash(bytes);
-      context.signal.throwIfAborted();
+      assertNotCancelledBeforeEffect(context.signal);
       if (options.exportArtifact) {
         const exported = await options.exportArtifact({
@@ -451,12 +467,12 @@ export async function createWorkspaceTools(options: WorkspaceToolOptions = {}):
       } catch (error) {
         const code = (error as NodeJS.ErrnoException).code;
-        if (code !== 'ENOENT') throw error;
+        if (code !== 'ENOENT') throw asNotDispatched(error, 'workspace_read_failed', 503);
       }
       const previousHash = previous ? hash(previous) : undefined;
       if (previous && expectedHash === undefined) {
-        throw new DomainError('hash_required', 'expectedHash is required when replacing an existing file', 409);
+        throw notDispatched('hash_required', 'expectedHash is required when replacing an existing file', 409);
       }
       if (previousHash !== expectedHash && (previous !== undefined || expectedHash !== undefined)) {
-        throw new DomainError('write_conflict', 'File changed since it was read (hash conflict)', 409);
+        throw notDispatched('write_conflict', 'File changed since it was read (hash conflict)', 409);
       }
       const writtenHash = hash(content);
@@ -478,8 +494,8 @@ export async function createWorkspaceTools(options: WorkspaceToolOptions = {}):
       };
       const checkpointPath = path.join(checkpointRoot, `${checkpointId}.json`);
-      context.signal.throwIfAborted();
-      await writeFile(checkpointPath, JSON.stringify(checkpoint), { flag: 'wx', mode: 0o600 });
+      assertNotCancelledBeforeEffect(context.signal);
+      await beforeEffect('checkpoint_write_failed', 503, () => writeFile(checkpointPath, JSON.stringify(checkpoint), { flag: 'wx', mode: 0o600 }));
       try {
-        context.signal.throwIfAborted();
+        assertNotCancelledBeforeEffect(context.signal);
         await atomicWrite(target, content);
       } catch (error) {
@@ -514,20 +530,20 @@ export async function createWorkspaceTools(options: WorkspaceToolOptions = {}):
       const workspace = requireWorkspace(context, WRITE_CAPABILITY);
       const root = await existingWorkspaceRoot(workspace);
-      const parsed = parseWorkspacePatch(stringInput(input, 'patch')!, { maxBytes: maxPatchBytes });
+      const parsed = await beforeEffect('invalid_patch', 400, () => parseWorkspacePatch(stringInput(input, 'patch')!, { maxBytes: maxPatchBytes }));
       const target = await resolveForWrite(root, parsed.path);
       const details = await stat(target).catch((error: NodeJS.ErrnoException) => {
-        if (error.code === 'ENOENT') throw new DomainError('path_not_found', 'Workspace path was not found', 404);
-        throw error;
+        if (error.code === 'ENOENT') throw notDispatched('path_not_found', 'Workspace path was not found', 404);
+        throw asNotDispatched(error, 'workspace_read_failed', 503);
       });
-      if (!details.isFile()) throw new DomainError('not_a_file', 'Workspace path is not a file');
-      if (details.size > maxReadBytes) throw new DomainError('file_too_large', `File exceeds ${maxReadBytes} bytes`, 413);
+      if (!details.isFile()) throw notDispatched('not_a_file', 'Workspace path is not a file');
+      if (details.size > maxReadBytes) throw notDispatched('file_too_large', `File exceeds ${maxReadBytes} bytes`, 413);
       const expectedHash = stringInput(input, 'expectedHash')!;
       if (!/^[0-9a-f]{64}$/.test(expectedHash)) {
-        throw new DomainError('invalid_input', 'expectedHash must be a lowercase SHA-256 hash');
+        throw notDispatched('invalid_input', 'expectedHash must be a lowercase SHA-256 hash');
       }
-      const previous = await readFile(target);
+      const previous = await beforeEffect('workspace_read_failed', 503, () => readFile(target));
       const previousHash = hash(previous);
       if (previousHash !== expectedHash) {
-        throw new DomainError('write_conflict', 'File changed since it was read (hash conflict)', 409);
+        throw notDispatched('write_conflict', 'File changed since it was read (hash conflict)', 409);
       }
       let previousText: string;
@@ -535,13 +551,13 @@ export async function createWorkspaceTools(options: WorkspaceToolOptions = {}):
         previousText = new TextDecoder('utf-8', { fatal: true }).decode(previous);
       } catch {
-        throw new DomainError('binary_file', 'Only valid UTF-8 text files can be patched.');
+        throw notDispatched('binary_file', 'Only valid UTF-8 text files can be patched.');
       }
-      const content = applyWorkspacePatch(previousText, parsed);
+      const content = await beforeEffect('invalid_patch', 400, () => applyWorkspacePatch(previousText, parsed));
       const writtenHash = hash(content);
-      if (writtenHash === previousHash) throw new DomainError('no_change', 'Patch does not change the file.', 409);
+      if (writtenHash === previousHash) throw notDispatched('no_change', 'Patch does not change the file.', 409);
       const restoreToken = randomBytes(32).toString('base64url');
-      const current = await readFile(target);
+      const current = await beforeEffect('workspace_read_failed', 503, () => readFile(target));
       if (hash(current) !== previousHash) {
-        throw new DomainError('write_conflict', 'File changed while the patch was prepared (hash conflict)', 409);
+        throw notDispatched('write_conflict', 'File changed while the patch was prepared (hash conflict)', 409);
       }
       const checkpointId = randomUUID();
@@ -561,8 +577,8 @@ export async function createWorkspaceTools(options: WorkspaceToolOptions = {}):
       };
       const checkpointPath = path.join(checkpointRoot, `${checkpointId}.json`);
-      context.signal.throwIfAborted();
-      await writeFile(checkpointPath, JSON.stringify(checkpoint), { flag: 'wx', mode: 0o600 });
+      assertNotCancelledBeforeEffect(context.signal);
+      await beforeEffect('checkpoint_write_failed', 503, () => writeFile(checkpointPath, JSON.stringify(checkpoint), { flag: 'wx', mode: 0o600 }));
       try {
-        context.signal.throwIfAborted();
+        assertNotCancelledBeforeEffect(context.signal);
         await atomicWrite(target, content);
       } catch (error) {
@@ -615,29 +631,28 @@ export async function createWorkspaceTools(options: WorkspaceToolOptions = {}):
       const root = await existingWorkspaceRoot(workspace);
       const checkpointId = stringInput(input, 'checkpointId')!;
-      if (!/^[0-9a-f-]{36}$/i.test(checkpointId)) throw new DomainError('invalid_input', 'Invalid checkpointId');
+      if (!/^[0-9a-f-]{36}$/i.test(checkpointId)) throw notDispatched('invalid_input', 'Invalid checkpointId');
       const checkpointPath = path.join(checkpointRoot, `${checkpointId}.json`);
       const resolvedCheckpoint = path.resolve(checkpointPath);
-      if (!isWithin(checkpointRoot, resolvedCheckpoint)) throw new DomainError('invalid_input', 'Invalid checkpointId');
-      const checkpoint = JSON.parse(await readFile(resolvedCheckpoint, 'utf8').catch(() => {
-        throw new DomainError('checkpoint_not_found', 'Checkpoint was not found', 404);
-      })) as Checkpoint;
-      if (checkpoint.principalId !== context.principal.id) throw new DomainError('checkpoint_forbidden', 'Checkpoint belongs to another principal', 403);
+      if (!isWithin(checkpointRoot, resolvedCheckpoint)) throw notDispatched('invalid_input', 'Invalid checkpointId');
+      const checkpoint = await beforeEffect('checkpoint_not_found', 404, async () => JSON.parse(await readFile(resolvedCheckpoint, 'utf8').catch(() => {
+        throw notDispatched('checkpoint_not_found', 'Checkpoint was not found', 404);
+      })) as Checkpoint);
+      if (checkpoint.principalId !== context.principal.id) throw notDispatched('checkpoint_forbidden', 'Checkpoint belongs to another principal', 403);
       const restoreToken = stringInput(input, 'restoreToken', false);
       if (checkpoint.taskId !== context.taskId && !validRestoreToken(checkpoint, restoreToken)) {
-        throw new DomainError('checkpoint_forbidden', 'A valid restore token is required outside the creating task', 403);
+        throw notDispatched('checkpoint_forbidden', 'A valid restore token is required outside the creating task', 403);
       }
       if (checkpoint.workspaceId !== workspace.id || checkpoint.workspaceRoot !== root) {
-        throw new DomainError('checkpoint_forbidden', 'Checkpoint belongs to another workspace', 403);
+        throw notDispatched('checkpoint_forbidden', 'Checkpoint belongs to another workspace', 403);
       }
       const target = await resolveForWrite(root, checkpoint.relativePath);
       const current = await readFile(target).catch(() => undefined);
       if (!current || hash(current) !== checkpoint.writtenHash) {
-        throw new DomainError('restore_conflict', 'File changed after this checkpoint (restore conflict)', 409);
+        throw notDispatched('restore_conflict', 'File changed after this checkpoint (restore conflict)', 409);
       }
+      assertNotCancelledBeforeEffect(context.signal);
       if (checkpoint.previousExists) {
-        context.signal.throwIfAborted();
         await atomicWrite(target, Buffer.from(checkpoint.previousContent ?? '', 'base64'));
       } else {
-        context.signal.throwIfAborted();
         await rm(target);
       }
```

After the change `new DomainError(` remains in this file only at the `invalid_configuration` check of `createWorkspaceTools` and inside the read tools (`workspace.read`, `workspace.search`), and `context.signal.throwIfAborted()` no longer appears.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx tsx --test test/workspace-tools.test.ts test/workspace-patch.test.ts test/workspace-export.test.ts`

Expected: `ℹ tests 15`, `ℹ pass 15`, `ℹ fail 0` (when the suite runs as root, `a write that fails while changing the workspace is not marked` is reported as skipped instead).

Run: `npx tsc --noEmit`

Expected: no output.

- [ ] **Step 5: Commit**

```bash
git add src/tools/workspace.ts test/workspace-tools.test.ts test/workspace-patch.test.ts
git commit -m "修復：工作區寫入、修補、還原與匯出於變更前的拒絕標記為未派發"
```

---

### Task 8: Classify the device dispatch throw sites

**Files:**
- Modify: `src/devices.ts` (import on line 7; `DeviceService.execute`, lines 230-245; the `catch` block of `DeviceService.dispatch`, lines 261-268, as of commit 17d571f)
- Test: `test/devices.test.ts` (append)

**Interfaces:**
- Consumes: `notDispatched`, `isNotDispatched` from `src/contracts.ts` (Task 1); marked `requireScope` (Task 5). Existing: `new DeviceService(store, now?)`, `createPairing`, `pair`, `authenticate`, `heartbeat`, `grant`, `control`, `poll`, `submit`, `remoteTool(spec).execute(input, context)`.
- Produces: `DeviceService.remoteTool(...).execute` rejects with a marked `DomainError` when no job reached a device:
  - every precondition of `execute` (codes unchanged: `workspace_required`, `waiting_for_device`, `device_revoked`, `workspace_denied`, `forbidden`);
  - `device_not_dispatched` (409) when the wait stopped while the job was still `queued` (existing code, now marked);
  - `device_not_dispatched` (409, message = the job's `error`, for example `Expired before dispatch`) when the job row is `cancelled` and its `job.dispatchedAt` is empty. Before this task that case was `outcome_unknown`.
  - Everything a device may have started stays unmarked: the job is `dispatched`, `unknown`, or `cancelled` with `dispatchedAt` set.

**Throw sites in `src/devices.ts` (lines as of 17d571f)**

| Line | Site | Code | Side | Change |
| --- | --- | --- | --- | --- |
| 205-209 | `executeModel` preconditions | `device_revoked`, `forbidden`, `waiting_for_device` | model provider path, not a tool | none |
| 232 | `execute`: no workspace | `workspace_required` | PRE | marked |
| 234 | `execute`: unknown device | `waiting_for_device` | PRE | marked |
| 235 | `execute`: revoked device | `device_revoked` | PRE | marked |
| 236 | `execute`: paused or not seen for 45 s | `waiting_for_device` | PRE | marked |
| 237 | `execute`: workspace not granted to the device | `workspace_denied` | PRE | marked |
| 239 | `execute`: `requireScope` | `forbidden` | PRE | marked in Task 5 |
| 240 | `execute`: capability not granted | `forbidden` | PRE | marked |
| 241 | `execute`: capability not reported | `waiting_for_device` | PRE | marked |
| 249 | `dispatch`: creating the job row fails | raw / `conflict` | POST (the row may exist) | none |
| 252, 258 | `dispatch`: abort while waiting | `AbortError` | decided in the `catch` by the job state | none here |
| 254 | `dispatch`: job row missing | `outcome_unknown` | POST | none |
| 256 | `dispatch`: job `failed` | not thrown: returns an `isError` result | known outcome | none |
| 257 | `dispatch`: job `unknown` or `cancelled` | `outcome_unknown` | decided in the `catch` by the job state | none here |
| 260 | `dispatch`: wait timed out | `outcome_unknown` | decided in the `catch` by the job state | none here |
| 262-264 | `catch`: store error while marking the job, including the conflict when a device took it at that moment | raw / `conflict` | POST | none |
| 265 | `catch`: job was still `queued`, now `cancelled` | `device_not_dispatched` | PRE | marked |
| new | `catch`: job is `cancelled` and `job.dispatchedAt` is empty (expired in `poll`, lines 118-121) | was `outcome_unknown` | PRE | marked `device_not_dispatched` 409 |
| 267 | `catch`: job `dispatched` (now `unknown`), `unknown`, or `cancelled` by a device | as thrown | POST | none |

- [ ] **Step 1: Write the failing test**

In `test/devices.test.ts` replace the import:

```ts
import type { Principal, ToolResult, Workspace } from '../src/contracts.js';
```

with:

```ts
import { isNotDispatched, type Principal, type ToolContext, type ToolResult, type Workspace } from '../src/contracts.js';
```

and append at the end of the file:

```ts
const writeTool = { name: 'workspace.write', description: 'Write', inputSchema: {}, requiredCapabilities: ['workspace:write'], sideEffect: 'write' as const };

async function pairedDevice(clock?: () => number) {
  const store = new SqliteStore();
  const service = new DeviceService(store, clock);
  const code = await service.createPairing(owner, ['workspace:write'], []);
  const paired = await service.pair({ code: code.code, name: 'Mac', capabilities: ['workspace:write'] });
  const workspaceRow = await store.create('workspace', owner.id, { name: 'Project', root: '/example', deviceId: paired.deviceId, capabilities: ['workspace:write'], allowCloud: false });
  const workspace: Workspace = { ...workspaceRow.data, id: workspaceRow.id, ownerId: owner.id };
  await service.grant(owner, paired.deviceId, [workspace.id]);
  await store.create('task', owner.id, { state: 'running' }, 'task');
  const device = () => service.authenticate(`Bearer ${paired.token}`, paired.deviceId);
  const context = (overrides: Partial<ToolContext> = {}): ToolContext => ({
    principal: owner, workspace, taskId: 'task', signal: new AbortController().signal, ...overrides,
  });
  const jobs = () => store.scan<{ state: string; error?: string }>('device_job', owner.id);
  const queued = async (): Promise<void> => {
    for (let attempt = 0; attempt < 100 && (await jobs()).length === 0; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.equal((await jobs()).length, 1);
  };
  return { store, service, paired, workspace, device, context, jobs, queued, run: (execution: ToolContext) => service.remoteTool(writeTool).execute({ path: 'a.txt' }, execution) };
}

function refusedBeforeDispatch(code: string): (error: unknown) => boolean {
  return (error) => {
    assert.ok(isNotDispatched(error), `expected a not-dispatched ${code}, got ${String(error)}`);
    assert.equal(error.code, code);
    return true;
  };
}

function stillUnknown(error: unknown): boolean {
  assert.equal(isNotDispatched(error), false);
  return true;
}

test('a device tool refused before a job exists is marked and queues nothing', async () => {
  let now = Date.now();
  const { store, service, paired, workspace, device, context, jobs, run } = await pairedDevice(() => now);
  try {
    const { workspace: _workspace, ...withoutWorkspace } = context();
    await assert.rejects(run(withoutWorkspace), refusedBeforeDispatch('workspace_required'));
    await assert.rejects(run(context({ workspace: { ...workspace, deviceId: 'no-such-device' } })), refusedBeforeDispatch('waiting_for_device'));
    await assert.rejects(run(context({ principal: { ...owner, scopes: [] } })), refusedBeforeDispatch('forbidden'));
    await assert.rejects(run(context({ workspace: { ...workspace, capabilities: [] } })), refusedBeforeDispatch('forbidden'));

    await service.control(owner.id, paired.deviceId, 'pause');
    await assert.rejects(run(context()), refusedBeforeDispatch('waiting_for_device'));
    await service.control(owner.id, paired.deviceId, 'resume');

    now += 45_001;
    await assert.rejects(run(context()), refusedBeforeDispatch('waiting_for_device'));
    await service.heartbeat(await device(), []);
    await assert.rejects(run(context()), refusedBeforeDispatch('waiting_for_device'));
    await service.heartbeat(await device(), ['workspace:write']);

    await service.grant(owner, paired.deviceId, []);
    await assert.rejects(run(context()), refusedBeforeDispatch('workspace_denied'));
    await service.grant(owner, paired.deviceId, [workspace.id]);

    await service.control(owner.id, paired.deviceId, 'revoke');
    await assert.rejects(run(context()), refusedBeforeDispatch('device_revoked'));
    assert.deepEqual(await jobs(), []);
  } finally { await store.close(); }
});

test('stopping while the job is still queued reports device_not_dispatched', async () => {
  const { store, context, jobs, queued, run } = await pairedDevice();
  try {
    const controller = new AbortController();
    const operation = run(context({ signal: controller.signal }));
    const rejected = assert.rejects(operation, refusedBeforeDispatch('device_not_dispatched'));
    await queued();
    controller.abort();
    await rejected;
    assert.deepEqual((await jobs()).map((row) => row.data.state), ['cancelled']);
  } finally { await store.close(); }
});

test('a job that expired before any device took it is reported as not dispatched', async () => {
  for (const cancelledByPoll of [false, true]) {
    let now = Date.now();
    const { store, service, device, context, jobs, queued, run } = await pairedDevice(() => now);
    try {
      const rejected = assert.rejects(run(context()), refusedBeforeDispatch('device_not_dispatched'));
      await queued();
      now += 300_001;
      if (cancelledByPoll) {
        assert.deepEqual((await service.poll(await device())).jobs, []);
        assert.deepEqual((await jobs()).map((row) => row.data.error), ['Expired before dispatch']);
      }
      await rejected;
      assert.deepEqual((await jobs()).map((row) => row.data.state), ['cancelled']);
    } finally { await store.close(); }
  }
});

test('stopping after a device took the job stays unknown', async () => {
  const { store, service, device, context, jobs, queued, run } = await pairedDevice();
  try {
    const controller = new AbortController();
    const rejected = assert.rejects(run(context({ signal: controller.signal })), stillUnknown);
    await queued();
    assert.equal((await service.poll(await device())).jobs.length, 1);
    controller.abort();
    await rejected;
    assert.deepEqual((await jobs()).map((row) => row.data.state), ['unknown']);
  } finally { await store.close(); }
});

test('outcomes reported by the device keep their meaning', async () => {
  for (const status of ['unknown', 'cancelled', 'failed'] as const) {
    const { store, service, device, context, queued, run } = await pairedDevice();
    try {
      const operation = run(context());
      const settled = status === 'failed'
        ? operation.then((result) => assert.deepEqual(result, { content: 'File changed since it was read', isError: true }))
        : assert.rejects(operation, (error: unknown) => stillUnknown(error) && (error as { code?: string }).code === 'outcome_unknown');
      await queued();
      const [job] = (await service.poll(await device())).jobs;
      await service.submit(await device(), job!.id, { status, error: 'File changed since it was read' });
      await settled;
    } finally { await store.close(); }
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx --test test/devices.test.ts`

Expected: `ℹ tests 6`, `ℹ pass 3`, `ℹ fail 3`. `stopping after a device took the job stays unknown` and `outcomes reported by the device keep their meaning` already pass (pins).

```
✖ a device tool refused before a job exists is marked and queues nothing
  AssertionError [ERR_ASSERTION]: expected a not-dispatched workspace_required, got DomainError: Select a workspace before using device tools
✖ stopping while the job is still queued reports device_not_dispatched
  AssertionError [ERR_ASSERTION]: expected a not-dispatched device_not_dispatched, got DomainError: Device operation stopped before dispatch
✖ a job that expired before any device took it is reported as not dispatched
  AssertionError [ERR_ASSERTION]: expected a not-dispatched device_not_dispatched, got DomainError: Device operation stopped before dispatch
```

- [ ] **Step 3: Write minimal implementation**

Apply to `src/devices.ts`:

```diff
--- a/src/devices.ts
+++ b/src/devices.ts
@@ -5,5 +5,5 @@ import type { FastifyInstance, FastifyRequest } from 'fastify';
 import { z } from 'zod';
 import { bearer, requireScope, tokenHash } from './auth.js';
-import { DomainError, type Principal, type ToolContext, type ToolDefinition, type ToolResult } from './contracts.js';
+import { DomainError, notDispatched, type Principal, type ToolContext, type ToolDefinition, type ToolResult } from './contracts.js';
 import type { DeviceJob, DeviceJobResult, DevicePairRequest, InlineDeviceArtifact } from './connectors/device.js';
 import type { Entity, Store } from './storage/store.js';
@@ -230,14 +230,14 @@ export class DeviceService {
   private async execute(tool: Omit<ToolDefinition, 'execute'>, input: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
     const workspace = context.workspace;
-    if (!workspace) throw new DomainError('workspace_required', 'Select a workspace before using device tools');
+    if (!workspace) throw notDispatched('workspace_required', 'Select a workspace before using device tools');
     const device = await this.store.get<Device>('device', workspace.deviceId, context.principal.id);
-    if (!device) throw new DomainError('waiting_for_device', 'Waiting for an authorized workspace device');
-    if (device.data.revokedAt) throw new DomainError('device_revoked', 'Device is no longer authorized', 403);
-    if (device.data.paused || !device.data.lastSeen || this.now() - Date.parse(device.data.lastSeen) > 45000) throw new DomainError('waiting_for_device', 'Waiting for the authorized device to reconnect');
-    if (!device.data.workspaceIds.includes(workspace.id)) throw new DomainError('workspace_denied', 'Workspace is not granted to this device', 403);
+    if (!device) throw notDispatched('waiting_for_device', 'Waiting for an authorized workspace device');
+    if (device.data.revokedAt) throw notDispatched('device_revoked', 'Device is no longer authorized', 403);
+    if (device.data.paused || !device.data.lastSeen || this.now() - Date.parse(device.data.lastSeen) > 45000) throw notDispatched('waiting_for_device', 'Waiting for the authorized device to reconnect');
+    if (!device.data.workspaceIds.includes(workspace.id)) throw notDispatched('workspace_denied', 'Workspace is not granted to this device', 403);
     for (const capability of tool.requiredCapabilities) {
       requireScope(context.principal, capability);
-      if (!workspace.capabilities.includes(capability) || !device.data.capabilities.includes(capability)) throw new DomainError('forbidden', 'Tool capability is not granted', 403);
-      if (!device.data.reportedCapabilities.includes(capability)) throw new DomainError('waiting_for_device', `Waiting for device capability ${capability}`);
+      if (!workspace.capabilities.includes(capability) || !device.data.capabilities.includes(capability)) throw notDispatched('forbidden', 'Tool capability is not granted', 403);
+      if (!device.data.reportedCapabilities.includes(capability)) throw notDispatched('waiting_for_device', `Waiting for device capability ${capability}`);
     }
     const job: DeviceJob = { id: randomUUID(), deviceId: device.id, principal: context.principal, taskId: context.taskId, workspace, toolName: tool.name, input, requiredCapabilities: tool.requiredCapabilities, expiresAt: new Date(this.now() + 300000).toISOString(), dispatchedAt: '', workspaceWriteLease: context.workspaceWriteLease };
@@ -263,5 +263,8 @@ export class DeviceService {
       if (row && ['queued', 'dispatched'].includes(row.data.state)) {
         await this.store.put('device_job', row.id, row.ownerId, { ...row.data, state: row.data.state === 'queued' ? 'cancelled' : 'unknown', error: 'Execution stopped before a confirmed result' }, row.revision);
-        if (row.data.state === 'queued') throw new DomainError('device_not_dispatched', 'Device operation stopped before dispatch', 409);
+        if (row.data.state === 'queued') throw notDispatched('device_not_dispatched', 'Device operation stopped before dispatch', 409);
+      }
+      if (row?.data.state === 'cancelled' && !row.data.job.dispatchedAt) {
+        throw notDispatched('device_not_dispatched', row.data.error ?? 'Device operation was cancelled before dispatch', 409);
       }
       throw error;
```

The new branch in the `catch` runs after the existing one, so it only sees a row that somebody else already moved to `cancelled`. `poll` writes `cancelled` without touching `job.dispatchedAt`; a device can only submit `cancelled` for a job that is `dispatched` or `unknown`, whose `dispatchedAt` is set.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx tsx --test test/devices.test.ts`

Expected: `ℹ tests 6`, `ℹ pass 6`, `ℹ fail 0`.

Run: `npx tsc --noEmit && npx tsx --test test/device-websocket.test.ts test/device-artifact.test.ts test/runtime-device-provider.test.ts test/bootstrap-device-tools.test.ts`

Expected: no type errors and `ℹ fail 0`.

- [ ] **Step 5: Commit**

```bash
git add src/devices.ts test/devices.test.ts
git commit -m "修復：裝置工作在送達裝置前停止時標記為未派發"
```

---

### Task 9: The device connector reports marked failures as `failed`

**Files:**
- Modify: `src/connectors/device.ts` (import on line 4; `DeviceConnector.pollOnce`, the `try` / `catch` around `tool.execute`, lines 378-410 as of commit 17d571f)
- Test: `test/connector-device.test.ts` (append)

**Interfaces:**
- Consumes: `notDispatched`, `isNotDispatched` from `src/contracts.ts` (Task 1); the marked tool errors of Tasks 6 and 7 (the connector runs the same `terminal.run` and `workspace.*` tools locally). Existing test helpers in `test/connector-device.test.ts`: `class MemoryTransport` (`jobs`, `results`), `job(overrides)`.
- Produces: in `DeviceConnector.pollOnce`, when a `write` or `external` tool **throws** an error for which `isNotDispatched(error)` is true, the job result is `{ status: 'failed', error: <message> }` instead of `{ status: 'unknown', ... }`, whether or not the job was cancelled meanwhile. An error raised after the tool returned (while the result is prepared for submission) is `unknown` as before, even if it carries the marker. Read tools, unmarked throws, the journal and the wire protocol (`DeviceJobResult`) are unchanged. On the server a `failed` job makes `DeviceService.dispatch` return `{ content: <error>, isError: true }`, an ordinary failed tool result.

**Throw sites in `DeviceConnector.pollOnce` (lines as of 17d571f)**

| Line | Site | Side | Change |
| --- | --- | --- | --- |
| 333-354 | expired job, unknown tool, authorization error | not thrown: recorded as `failed` before the tool starts | none |
| 355-364 | write lease not valid | not thrown: recorded as `failed` | none |
| 367 | `markStarted(...)` rejects before the tool is called (the journal cannot be saved) | PRE, but nothing can be reported: `pollOnce` rejects and the job stays `dispatched` on the server | none (without its journal the connector cannot record or submit a result) |
| 379-385 | `tool.execute(...)` throws a marked error | PRE (the tool says so) | status `failed` |
| 379-385 | `tool.execute(...)` throws anything else | POST | none (`unknown`) |
| 386-400 | `prepareResult` / `discardLocalArtifacts` / `markCompleted` / `submitRecorded` throw (419-486: `invalid_device_artifact`, `export_conflict`, raw `realpath` / `readFile` errors) | POST: the tool already returned | none (`unknown`), guarded by `toolReturned` |

- [ ] **Step 1: Write the failing test**

In `test/connector-device.test.ts` replace the import:

```ts
import type { ToolDefinition, ToolResult } from '../src/contracts.js';
```

with:

```ts
import { notDispatched, type ToolDefinition, type ToolResult } from '../src/contracts.js';
```

and append at the end of the file:

```ts
test('a marked failure from a write or external tool is submitted as failed', async () => {
  for (const sideEffect of ['write', 'external'] as const) {
    const transport = new MemoryTransport();
    let executions = 0;
    const tool: ToolDefinition = {
      name: 'test.write', description: 'test', inputSchema: {}, requiredCapabilities: ['workspace:read'], sideEffect,
      async execute(): Promise<ToolResult> {
        executions += 1;
        throw notDispatched('write_conflict', 'File changed since it was read (hash conflict)', 409);
      },
    };
    const connector = new DeviceConnector({
      deviceId: 'device-1', transport, capabilities: ['workspace:read'], workspaceIds: ['workspace-1'], tools: [tool],
    });
    transport.jobs = [job({ id: 'refused', toolName: 'test.write' })];
    await connector.pollOnce();
    await connector.pollOnce();

    assert.equal(executions, 1);
    assert.deepEqual(transport.results, [{
      jobId: 'refused',
      result: { status: 'failed', error: 'File changed since it was read (hash conflict)' },
    }]);
  }
});

test('a marked failure is still failed when the job was cancelled meanwhile', async () => {
  const transport = new MemoryTransport();
  let entered = false;
  const tool: ToolDefinition = {
    name: 'test.write', description: 'test', inputSchema: {}, requiredCapabilities: ['workspace:read'], sideEffect: 'write',
    async execute(_input, context): Promise<ToolResult> {
      entered = true;
      await new Promise<void>((resolve) => context.signal.addEventListener('abort', () => resolve(), { once: true }));
      throw notDispatched('aborted', 'Operation was cancelled before it started', 499);
    },
  };
  const connector = new DeviceConnector({
    deviceId: 'device-1', transport, capabilities: ['workspace:read'], workspaceIds: ['workspace-1'], tools: [tool],
  });
  transport.jobs = [job({ id: 'cancelled-before-write', toolName: 'test.write' })];
  const polling = connector.pollOnce();
  while (!entered) await new Promise((resolve) => setTimeout(resolve, 1));
  connector.cancel('cancelled-before-write');
  await polling;

  assert.deepEqual(transport.results.map((entry) => entry.result), [
    { status: 'failed', error: 'Operation was cancelled before it started' },
  ]);
});

test('an error raised after the tool returned is unknown even when it carries the marker', async () => {
  const transport = new MemoryTransport();
  const tool: ToolDefinition = {
    name: 'test.write', description: 'test', inputSchema: {}, requiredCapabilities: ['workspace:read'], sideEffect: 'external',
    async execute(): Promise<ToolResult> {
      return {
        content: 'sent',
        get artifacts(): ToolResult['artifacts'] { throw notDispatched('invalid_input', 'raised while the result was prepared'); },
      };
    },
  };
  const connector = new DeviceConnector({
    deviceId: 'device-1', transport, capabilities: ['workspace:read'], workspaceIds: ['workspace-1'], tools: [tool],
  });
  transport.jobs = [job({ id: 'sent', toolName: 'test.write' })];
  await connector.pollOnce();

  assert.deepEqual(transport.results.map((entry) => entry.result), [
    { status: 'unknown', error: 'raised while the result was prepared' },
  ]);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx --test test/connector-device.test.ts`

Expected: `ℹ tests 13`, `ℹ pass 11`, `ℹ fail 2`. `an error raised after the tool returned is unknown even when it carries the marker` already passes; it is the pin that keeps Step 3 from trusting the marker too widely.

```
✖ a marked failure from a write or external tool is submitted as failed
  +       status: 'unknown'
  -       status: 'failed'
✖ a marked failure is still failed when the job was cancelled meanwhile
  +     status: 'unknown'
  -     status: 'failed'
```

- [ ] **Step 3: Write minimal implementation**

In `src/connectors/device.ts` replace the import on line 4:

```ts
import { DomainError, type Principal, type ToolDefinition, type ToolResult, type Workspace } from '../contracts.js';
```

with:

```ts
import { DomainError, isNotDispatched, type Principal, type ToolDefinition, type ToolResult, type Workspace } from '../contracts.js';
```

In `pollOnce` replace:

```ts
      try {
        const rawResult = await tool.execute(job.input, {
          principal: job.principal,
          workspace: local.workspace,
          taskId: job.taskId,
          signal: controller.signal,
          workspaceWriteLease: job.workspaceWriteLease,
        });
        const cancelled = controller.signal.aborted;
```

with:

```ts
      let toolReturned = false;
      try {
        const rawResult = await tool.execute(job.input, {
          principal: job.principal,
          workspace: local.workspace,
          taskId: job.taskId,
          signal: controller.signal,
          workspaceWriteLease: job.workspaceWriteLease,
        });
        toolReturned = true;
        const cancelled = controller.signal.aborted;
```

and in the `catch (error)` block that follows replace:

```ts
        const status = tool.sideEffect === 'read'
          ? (controller.signal.aborted ? 'cancelled' : 'failed')
          : 'unknown';
```

with:

```ts
        const status = tool.sideEffect === 'read'
          ? (controller.signal.aborted ? 'cancelled' : 'failed')
          : (!toolReturned && isNotDispatched(error) ? 'failed' : 'unknown');
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx tsx --test test/connector-device.test.ts`

Expected: `ℹ tests 13`, `ℹ pass 13`, `ℹ fail 0` (including the existing `device connector never reports a cancelled or thrown write as a known outcome`, whose unmarked throws stay `unknown`).

- [ ] **Step 5: Commit**

```bash
git add src/connectors/device.ts test/connector-device.test.ts
git commit -m "修復：裝置連接器將未派發的工具錯誤回報為失敗"
```

---

### Task 10: Classify the `plugin.call` and MCP throw sites

**Files:**
- Modify: `src/plugins.ts` (import on line 3; the `plugin.call` tool in `PluginService.tools`, lines 238-244 as of commit 17d571f)
- Modify: `src/tools/mcp.ts` (import on line 12; `McpToolProvider.asToolDefinitions` → `execute`, lines 199-203 as of commit 17d571f)
- Test: `test/plugins.test.ts` (append)

**Interfaces:**
- Consumes: `notDispatched`, `asNotDispatched`, `isNotDispatched` from `src/contracts.ts` (Task 1); marked `requireScope` (Task 5). Existing: `new PluginService(store, { allowedOrigins, commandProfiles })`, `install`, `tools()`, `close()`; `principal` in `test/plugins.test.ts`.
- Produces:
  - `plugin.call` rejects with a marked error for everything that fails before the inner MCP tool is executed. A `DomainError` keeps its code, message and status (`plugin_not_pinned`, `plugin_version_pinned`, `plugin_unavailable`, `version_not_found`, `invalid_plugin`, `command_not_allowed`, `origin_not_allowed`, `invalid_secret_reference`, `invalid_mcp_config`, `missing_mcp_secret`, `mcp_permission_required`, `invalid_mcp_schema`, `tool_unavailable`); a raw connection or spawn error becomes `plugin_unavailable` (503) with the original message.
  - An MCP tool's `execute` rejects with a marked `invalid_tool_input` when the arguments do not match the declared schema, and with the marked `forbidden` of `requireScope`.
  - Any rejection of `client.callTool` stays unmarked.

**Throw sites (lines as of 17d571f)**

| Line | Site | Code | Side | Change |
| --- | --- | --- | --- | --- |
| `plugins.ts` 240 | `pinnedVersion` (176, 178) | `plugin_not_pinned`, `plugin_version_pinned` | PRE | marked at the `plugin.call` boundary |
| `plugins.ts` 240 | `this.mcp` → `content` (85, 87, 89, 91), 166 | `plugin_unavailable`, `version_not_found`, `invalid_plugin` | PRE | boundary |
| `plugins.ts` 240 | `this.mcp` → `resolveServer` / `requireAllowedServer` (186, 203, 206, 207, 210, 212) | `command_not_allowed`, raw `URL` error, `invalid_secret_reference`, `origin_not_allowed` | PRE | boundary |
| `plugins.ts` 240 | `this.mcp` → `McpToolProvider.connect` (`mcp.ts` 156, 157/83, 160, 169/91/93, 165 and 172/109/111/113, 177-181) | `mcp_permission_required`, `invalid_mcp_config`, `missing_mcp_secret`, raw connect or spawn error | PRE: connecting is what the read tool `plugin.tools` does without approval | boundary; raw errors become `plugin_unavailable` 503 |
| `plugins.ts` 241 | `provider.asToolDefinitions()` (`listTools` transport error, `compileInputSchema` 66, 75, 78) | raw, `invalid_mcp_schema` | PRE: listing tools | boundary |
| `plugins.ts` 242 | unknown tool or invalid arguments | `tool_unavailable` | PRE | boundary |
| `plugins.ts` 243 | `tool.execute(...)` | — | delegated to `mcp.ts` below | outside the boundary |
| `mcp.ts` 200 | `requireScope` | `forbidden` | PRE | marked in Task 5 |
| `mcp.ts` 201-203 | arguments do not match the schema | `invalid_tool_input` | PRE | marked |
| `mcp.ts` 209-213 | `client.callTool` rejects (JSON-RPC error, timeout, `AbortError`, closed transport) | raw | POST | none |
| `mcp.ts` 217-227 | result mapping | raw | POST | none |
| `plugins.ts` 216-237 | `plugin.list`, `skill.read`, `plugin.tools` | several | read tools | none |
| `plugins.ts` 99-163 | `listVersions`, `install`, `configure`, `validateVersion` | several | management paths, not tools | none |

The shared helpers (`content`, `resolveServer`, `requireAllowedServer`, `McpToolProvider.connect`) are not marked at their own `throw` statements because the management paths use them too; the boundary inside `plugin.call` is the single marking point.

- [ ] **Step 1: Write the failing test**

In `test/plugins.test.ts` replace these two imports:

```ts
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
```

```ts
import type { Principal } from '../src/contracts.js';
```

with:

```ts
import { access, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
```

```ts
import { isNotDispatched, type Principal, type ToolContext } from '../src/contracts.js';
```

and append at the end of the file:

```ts
function refusedBeforeDispatch(code: string): (error: unknown) => boolean {
  return (error) => {
    assert.ok(isNotDispatched(error), `expected a not-dispatched ${code}, got ${String(error)}`);
    assert.equal(error.code, code);
    return true;
  };
}

test('plugin.call marks everything that fails before the MCP tool is called, and nothing after', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'kiancode-plugin-call-'));
  const serverFile = path.join(directory, 'server.mjs');
  const callLog = path.join(directory, 'calls.log');
  const sdkRoot = path.resolve('node_modules/@modelcontextprotocol/sdk/dist/esm');
  await writeFile(serverFile, `
import { appendFileSync } from 'node:fs';
import { McpServer } from ${JSON.stringify(pathToFileURL(path.join(sdkRoot, 'server/mcp.js')).href)};
import { StdioServerTransport } from ${JSON.stringify(pathToFileURL(path.join(sdkRoot, 'server/stdio.js')).href)};
import { z } from ${JSON.stringify(pathToFileURL(path.resolve('node_modules/zod/index.js')).href)};
const server = new McpServer({ name: 'call-test', version: '1.0.0' });
server.registerTool('record', { inputSchema: { value: z.string() } }, async ({ value }) => {
  appendFileSync(${JSON.stringify(callLog)}, value + '\\n');
  return { content: [{ type: 'text', text: 'recorded' }] };
});
server.registerTool('crash', { inputSchema: {} }, async () => {
  appendFileSync(${JSON.stringify(callLog)}, 'crash\\n');
  process.exit(1);
});
await server.connect(new StdioServerTransport());
`);
  const store = new SqliteStore();
  const profile = { id: 'trusted', command: process.execPath, args: [serverFile] };
  const plugins = new PluginService(store, { allowedOrigins: ['https://mcp.example'], commandProfiles: [profile] });
  const withoutPolicy = new PluginService(store, { allowedOrigins: [], commandProfiles: [] });
  const brokenCommand = new PluginService(store, {
    allowedOrigins: [], commandProfiles: [{ id: 'trusted', command: path.join(directory, 'no-such-binary') }],
  });
  try {
    const local = await plugins.install(principal, 'local', 'Local', {
      kind: 'mcp', server: { id: 'local', permission: 'configured', transport: 'stdio', profile: 'trusted' },
    });
    const remote = await plugins.install(principal, 'remote', 'Remote', {
      kind: 'mcp', server: { id: 'remote', permission: 'configured', transport: 'http', url: 'https://mcp.example/api' },
    });
    const versions = { local: local.data.activeVersion, remote: remote.data.activeVersion, ghost: 'never-installed' };
    const context = (overrides: Partial<ToolContext> = {}): ToolContext => ({
      principal: { ...principal, scopes: [...principal.scopes, 'mcp:local'] },
      taskId: 'task', signal: new AbortController().signal, pluginVersions: versions, ...overrides,
    });
    const call = (service: PluginService) => service.tools().find((tool) => tool.name === 'plugin.call')!;
    const record = { pluginId: 'local', tool: 'record', arguments: { value: 'once' } };

    await assert.rejects(call(plugins).execute(record, context({ pluginVersions: {} })), refusedBeforeDispatch('plugin_not_pinned'));
    await assert.rejects(call(plugins).execute({ ...record, version: 'another-version' }, context()), refusedBeforeDispatch('plugin_version_pinned'));
    await assert.rejects(call(plugins).execute({ ...record, pluginId: 'ghost' }, context()), refusedBeforeDispatch('plugin_unavailable'));
    await assert.rejects(call(withoutPolicy).execute(record, context()), refusedBeforeDispatch('command_not_allowed'));
    await assert.rejects(call(withoutPolicy).execute({ ...record, pluginId: 'remote' }, context()), refusedBeforeDispatch('origin_not_allowed'));
    await assert.rejects(call(brokenCommand).execute(record, context()), (error: unknown) => refusedBeforeDispatch('plugin_unavailable')(error)
      && (error as { statusCode?: number }).statusCode === 503);
    await assert.rejects(call(plugins).execute({ ...record, tool: 'no-such-tool' }, context()), refusedBeforeDispatch('tool_unavailable'));
    for (const invalid of ['text', ['list'], undefined, null]) {
      await assert.rejects(call(plugins).execute({ ...record, arguments: invalid }, context()), refusedBeforeDispatch('tool_unavailable'));
    }
    await assert.rejects(call(plugins).execute({ ...record, arguments: { value: 7 } }, context()), refusedBeforeDispatch('invalid_tool_input'));
    await assert.rejects(call(plugins).execute(record, context({ principal })), refusedBeforeDispatch('forbidden'));
    await assert.rejects(access(callLog));

    const recorded = await call(plugins).execute(record, context());
    assert.equal(recorded.isError, undefined);
    assert.equal(await readFile(callLog, 'utf8'), 'once\n');

    await assert.rejects(call(plugins).execute({ pluginId: 'local', tool: 'crash', arguments: {} }, context()), (error: unknown) => {
      assert.equal(isNotDispatched(error), false);
      return true;
    });
    assert.equal(await readFile(callLog, 'utf8'), 'once\ncrash\n');
  } finally {
    await plugins.close();
    await withoutPolicy.close();
    await brokenCommand.close();
    await store.close();
    await rm(directory, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx --test test/plugins.test.ts`

Expected: one failure.

```
✖ plugin.call marks everything that fails before the MCP tool is called, and nothing after
  AssertionError [ERR_ASSERTION]: expected a not-dispatched plugin_not_pinned, got DomainError: Plugin was not enabled when this task was created
```

- [ ] **Step 3: Write minimal implementation**

In `src/plugins.ts` replace the import on line 3:

```ts
import { DomainError, type Principal, type ToolDefinition } from './contracts.js';
```

with:

```ts
import { asNotDispatched, DomainError, type Principal, type ToolDefinition } from './contracts.js';
```

and in the `plugin.call` tool replace the body of `execute`:

```ts
        const pluginId = String(input.pluginId);
        const provider = await this.mcp(context.principal.id, pluginId, this.pinnedVersion(context, pluginId, input.version));
        const tool = (await provider.asToolDefinitions()).find((candidate) => candidate.name === `mcp.${String(input.pluginId)}.${String(input.tool)}`);
        if (!tool || !input.arguments || typeof input.arguments !== 'object' || Array.isArray(input.arguments)) throw new DomainError('tool_unavailable', 'MCP tool or arguments are invalid');
        return tool.execute(input.arguments as Record<string, unknown>, context);
```

with:

```ts
        const prepare = async (): Promise<ToolDefinition> => {
          const pluginId = String(input.pluginId);
          const provider = await this.mcp(context.principal.id, pluginId, this.pinnedVersion(context, pluginId, input.version));
          const tool = (await provider.asToolDefinitions()).find((candidate) => candidate.name === `mcp.${String(input.pluginId)}.${String(input.tool)}`);
          if (!tool || !input.arguments || typeof input.arguments !== 'object' || Array.isArray(input.arguments)) throw new DomainError('tool_unavailable', 'MCP tool or arguments are invalid');
          return tool;
        };
        const tool = await prepare().catch((error: unknown) => { throw asNotDispatched(error, 'plugin_unavailable', 503); });
        return tool.execute(input.arguments as Record<string, unknown>, context);
```

The last line must stay outside `prepare`: it is the call that performs the external action.

In `src/tools/mcp.ts` replace the import on line 12:

```ts
import { DomainError, type ToolDefinition } from '../contracts.js';
```

with:

```ts
import { DomainError, notDispatched, type ToolDefinition } from '../contracts.js';
```

and in `asToolDefinitions` → `execute` replace:

```ts
            throw new DomainError('invalid_tool_input', 'MCP tool input does not match its declared schema');
```

with:

```ts
            throw notDispatched('invalid_tool_input', 'MCP tool input does not match its declared schema');
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx tsx --test test/plugins.test.ts test/plugins-mcp.test.ts test/plugins-skills.test.ts`

Expected: `ℹ fail 0` (`test/plugins.test.ts` now has 7 tests).

Run: `npx tsc --noEmit`

Expected: no output.

- [ ] **Step 5: Commit**

```bash
git add src/plugins.ts src/tools/mcp.ts test/plugins.test.ts
git commit -m "修復：plugin.call 與 MCP 工具於呼叫前的失敗標記為未派發"
```

---

### Task 11: Classify the browser and Mac app throw sites

**Files:**
- Modify: `src/tools/browser.ts` (import on line 5; `stringInput`, lines 29-33; `currentPage`, `allowedUrl`, `action`, lines 126-162; the four tools in `tools()`, lines 164-211, as of commit 17d571f)
- Modify: `src/tools/mac-app.ts` (import on line 6; `HelperResponse`, lines 33-38; `stringInput`, `integerInput`, lines 96-106; tool bodies, lines 187-206; `allowedBundle`, `requireCapability`, lines 215-226; `invoke`, lines 270-313, as of commit 17d571f)
- Modify: `README.md` (Components list, the bullet that starts with `- Device connectors pair through a one-use code`, line 63 as of commit 17d571f)
- Test: `test/mac-app-tools.test.ts` (append; runs on macOS only), `test/plugins-browser.test.ts` (modify the existing test; it skips when no Chrome is installed)

**Interfaces:**
- Consumes: `notDispatched`, `asNotDispatched`, `isNotDispatched`, `DomainErrorOptions` (through the fourth constructor argument of `DomainError`) from `src/contracts.ts` (Task 1); marked `requireScope` (Task 5).
- Produces:
  - Browser tools reject marked for: missing scope, invalid `url` / `selector` / `value` input, a requested URL outside the origin allowlist, an abort observed before the action starts, and a page that cannot be opened (`browser_unavailable` 503). `private allowedUrl(raw: string, stage: 'requested' | 'resulting'): URL` marks only for `'requested'`. Every Playwright rejection, an abort during the action and a resulting URL outside the allowlist stay unmarked.
  - Mac app tools reject marked for: invalid input, app or action outside the allowlists, missing scope or workspace capability, an abort before the helper is spawned (`desktop_aborted` 499, replacing the `AbortError`), and a helper that could not be started (`desktop_unavailable` 503).
  - Helper protocol: a helper error response may carry `"notDispatched": true` (strictly the JSON boolean). The core then rejects with the helper's `code` and `error`, marked. Without the field, or with any other value, a helper failure stays unmarked. Abort, timeout, output limit and invalid JSON are decided before the response is read and are never marked.

**Throw sites in `src/tools/browser.ts` (lines as of 17d571f)**

| Line | Site | Code | Side | Change |
| --- | --- | --- | --- | --- |
| 22 | `requireCapability` → `requireScope` | `forbidden` | PRE | marked in Task 5 |
| 31 | `stringInput` | `invalid_input` | PRE | marked; `click` and `fill` now read `selector` before touching the page |
| 96-108 | `launch` | `browser_permission_required`, `invalid_browser_config`, `browser_unavailable` | not a tool throw | none |
| 127 | `currentPage`: `newPage()` rejects | raw | PRE: a blank page is not an effect | `asNotDispatched(error, 'browser_unavailable', 503)` |
| 136, 139 | `allowedUrl` for the requested URL (call on 169) | `invalid_input`, `browser_origin_forbidden` | PRE | marked through stage `'requested'` |
| 136, 139 | `allowedUrl` for the resulting URL (calls on 172, 197, and 182 in the read tool) | same codes | POST | none (stage `'resulting'`) |
| 151 | `action`: aborted before the operation starts | `browser_aborted` | PRE | marked |
| 157 | `action`: aborted while the operation ran | `browser_aborted` | POST | none |
| 158 | `action`: any Playwright rejection from `goto` / `click` / `fill` (navigation error, timeout, selector never appears) | raw | POST | none |
| 173 | `page.title()` after navigation | raw | POST | none |
| 196 | `closeExtraPages()` after a click | raw | POST | none |
| 207 | `fill`: `value` not a string | `invalid_input` | PRE | marked, moved before `currentPage()` |
| 179-187 | `browser.snapshot` | several | read tool | none |

**Throw sites in `src/tools/mac-app.ts` (lines as of 17d571f)**

| Line | Site | Code | Side | Change |
| --- | --- | --- | --- | --- |
| 98 | `stringInput` | `invalid_input` | PRE | marked |
| 104 | `integerInput` | `invalid_input` | PRE | marked |
| 129-145 | `create` | several | not a tool throw | none |
| 189 | window action not `raise` / `minimize` / `unminimize` | `invalid_input` | PRE | marked |
| 197 | AX action not configured | `desktop_action_forbidden` | PRE | marked |
| 204 | `menuPath` invalid | `invalid_input` | PRE | marked |
| 217 | `allowedBundle` (always evaluated as an argument before `invoke`) | `desktop_app_forbidden` | PRE | marked |
| 222 | `requireCapability` → `requireScope` | `forbidden` | PRE | marked in Task 5 |
| 224 | workspace lacks the capability | `workspace_denied` | PRE | marked |
| 251-258 | screenshot file missing, outside its directory or invalid; raw `lstat` / `readFile` | `screenshot_failed` / raw | POST: the helper ran | none |
| 271 | `invoke`: aborted before the helper is spawned | `AbortError` | PRE | marked `desktop_aborted` 499 |
| 279 | `spawn` throws synchronously | raw | PRE | `asNotDispatched(error, 'desktop_unavailable', 503)` in `startHelper` |
| 295 | child `error` event, `child.pid === undefined` | raw | PRE | `notDispatched('desktop_unavailable', error.message, 503)` |
| 295 | child `error` event, `child.pid` defined | raw | POST | none |
| 299 | aborted while the helper ran | `AbortError` | POST | none |
| 300 | helper timed out | `desktop_timeout` | POST | none |
| 301 | helper output too large | `desktop_output_limit` | POST | none |
| 304 | helper output is not JSON | `desktop_protocol_error` | POST | none |
| 305-307 | helper answered `ok: false` or exited non-zero | helper-chosen code | POST, unless the response carries `notDispatched: true` | marker copied from the response |
| 166-180 | `mac.app.health`, `mac.app.list`, `mac.app.snapshot` | several | read tools | none |

- [ ] **Step 1: Write the failing test**

In `test/mac-app-tools.test.ts` replace these two imports:

```ts
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
```

```ts
import type { ToolContext, Workspace } from '../src/contracts.js';
```

with:

```ts
import { access, chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
```

```ts
import { isNotDispatched, type ToolContext, type Workspace } from '../src/contracts.js';
```

and append at the end of the file:

```ts
test('Mac app tools mark refusals before the helper starts, and helper failures only when the helper says so', { skip: process.platform !== 'darwin' }, async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'kiancode-mac-app-refused-'));
  const helper = path.join(directory, 'helper.mjs');
  const startedLog = path.join(directory, 'started.log');
  try {
    await writeFile(helper, `#!/usr/bin/env node
import { appendFileSync } from 'node:fs';
const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const request = JSON.parse(Buffer.concat(chunks).toString('utf8'));
appendFileSync(${JSON.stringify(startedLog)}, request.operation + '\\n');
const mode = request.menuPath?.[0];
if (mode === 'refused') process.stdout.write(JSON.stringify({ ok: false, code: 'invalid_input', error: 'Menu item is disabled' }));
else if (mode === 'never-started') process.stdout.write(JSON.stringify({ ok: false, code: 'desktop_app_not_running', error: 'App is not running', notDispatched: true }));
else if (mode === 'loose-flag') process.stdout.write(JSON.stringify({ ok: false, code: 'desktop_app_not_running', error: 'App is not running', notDispatched: 'true' }));
else if (mode === 'crashed') { process.stdout.write(JSON.stringify({ ok: false, error: 'Helper crashed' })); process.exitCode = 3; }
else if (mode === 'garbage') process.stdout.write('not json');
else if (mode === 'slow') await new Promise((resolve) => setTimeout(resolve, 10_000));
else process.stdout.write(JSON.stringify({ ok: true, data: {} }));
`);
    await chmod(helper, 0o700);
    const provider = await MacAppToolProvider.create({
      permission: 'configured', helperPath: helper, controlFile: path.join(directory, 'control.json'),
      screenshotDirectory: path.join(directory, 'screenshots'), allowedBundleIds: ['com.example.Allowed'], allowedActions: ['AXPress'],
      timeoutMs: 1_500,
    });
    const tools = new Map(provider.asToolDefinitions().map((tool) => [tool.name, tool]));
    const workspace: Workspace = {
      id: 'workspace', ownerId: 'owner', name: 'Mac', root: directory, deviceId: 'device',
      capabilities: ['desktop:read', 'desktop:write', 'desktop:external', 'screenshot:read'], allowCloud: false,
    };
    const context = (overrides: Partial<ToolContext> = {}): ToolContext => ({
      principal: { id: 'owner', level: 4, scopes: ['*'] }, workspace, taskId: 'task', signal: new AbortController().signal, ...overrides,
    });
    const run = (name: string, input: Record<string, unknown>, execution = context()) => tools.get(name)!.execute(input, execution);
    const refused = (code: string) => (error: unknown): boolean => {
      assert.ok(isNotDispatched(error), `expected a not-dispatched ${code}, got ${String(error)}`);
      assert.equal(error.code, code);
      return true;
    };
    const unknown = (code: string) => (error: unknown): boolean => {
      assert.equal(isNotDispatched(error), false, String(error));
      assert.equal((error as { code?: string }).code, code);
      return true;
    };
    const allowed = { bundleId: 'com.example.Allowed' };
    const other = { bundleId: 'com.example.Other' };
    const menu = (mode: string) => run('mac.app.menu', { ...allowed, menuPath: [mode, 'Item'] });

    const refusals: Array<[string, Record<string, unknown>, string]> = [
      ['mac.app.focus', other, 'desktop_app_forbidden'],
      ['mac.app.window', { ...other, action: 'raise' }, 'desktop_app_forbidden'],
      ['mac.app.action', { ...other, action: 'AXPress', elementRef: 'e1' }, 'desktop_app_forbidden'],
      ['mac.app.menu', { ...other, menuPath: ['File'] }, 'desktop_app_forbidden'],
      ['mac.app.screenshot', other, 'desktop_app_forbidden'],
      ['mac.app.focus', {}, 'invalid_input'],
      ['mac.app.action', { ...allowed, action: 'AXDelete', elementRef: 'e1' }, 'desktop_action_forbidden'],
      ['mac.app.action', { ...allowed, action: 'AXPress' }, 'invalid_input'],
      ['mac.app.window', { ...allowed, action: 'close' }, 'invalid_input'],
      ['mac.app.window', { ...allowed, action: 'raise', windowIndex: -1 }, 'invalid_input'],
      ['mac.app.window', { ...allowed, action: 'raise', windowIndex: 1.5 }, 'invalid_input'],
      ['mac.app.menu', { ...allowed, menuPath: ['File', ''] }, 'invalid_input'],
      ['mac.app.menu', { ...allowed, menuPath: 'File' }, 'invalid_input'],
      ['mac.app.screenshot', { ...allowed, windowIndex: -1 }, 'invalid_input'],
    ];
    for (const [name, input, code] of refusals) {
      await assert.rejects(run(name, input), refused(code), `${name} ${JSON.stringify(input)}`);
    }
    await assert.rejects(
      run('mac.app.focus', allowed, context({ workspace: { ...workspace, capabilities: ['desktop:read'] } })),
      refused('workspace_denied'),
    );
    await assert.rejects(run('mac.app.focus', allowed, context({ principal: { id: 'owner', level: 4, scopes: [] } })), refused('forbidden'));
    const cancelled = new AbortController();
    cancelled.abort();
    await assert.rejects(run('mac.app.focus', allowed, context({ signal: cancelled.signal })), refused('desktop_aborted'));
    await assert.rejects(access(startedLog));

    await assert.rejects(menu('never-started'), (error: unknown) => refused('desktop_app_not_running')(error)
      && (error as { statusCode?: number }).statusCode === 400 && (error as Error).message === 'App is not running');
    await assert.rejects(menu('loose-flag'), unknown('desktop_app_not_running'));
    await assert.rejects(menu('refused'), unknown('invalid_input'));
    await assert.rejects(menu('crashed'), unknown('desktop_helper_failed'));
    await assert.rejects(menu('garbage'), unknown('desktop_protocol_error'));
    await assert.rejects(menu('slow'), unknown('desktop_timeout'));
    assert.equal((await readFile(startedLog, 'utf8')).trim().split('\n').length, 6);

    await chmod(helper, 0o600);
    await assert.rejects(menu('ok'), refused('desktop_unavailable'));
    assert.equal((await readFile(startedLog, 'utf8')).trim().split('\n').length, 6);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
```

In `test/plugins-browser.test.ts` add an import after the `node:test` import:

```ts
import test from 'node:test';
import { isNotDispatched } from '../src/contracts.js';
```

replace:

```ts
  const origin = `http://127.0.0.1:${address.port}`;
  const provider = await BrowserToolProvider.launch({ permission: 'configured', executablePath: chrome, allowedOrigins: [origin] });
```

with (the second origin is a loopback port nothing listens on, so a navigation to it fails inside the browser without leaving the machine):

```ts
  const origin = `http://127.0.0.1:${address.port}`;
  const closed = createServer();
  await new Promise<void>((resolve) => closed.listen(0, '127.0.0.1', resolve));
  const closedAddress = closed.address();
  assert.ok(closedAddress && typeof closedAddress === 'object');
  const unreachable = `http://127.0.0.1:${closedAddress.port}`;
  await new Promise<void>((resolve, reject) => closed.close((error) => error ? reject(error) : resolve()));
  const provider = await BrowserToolProvider.launch({ permission: 'configured', executablePath: chrome, allowedOrigins: [origin, unreachable] });
```

and, inside the `try` block, directly after the existing line

```ts
    await assert.rejects(tools.get('browser.navigate')!.execute({ url: 'https://example.com' }, context), /origin/i);
```

insert:

```ts
    const refused = (code: string) => (error: unknown): boolean => {
      assert.ok(isNotDispatched(error), `expected a not-dispatched ${code}, got ${String(error)}`);
      assert.equal(error.code, code);
      return true;
    };
    const cancelled = new AbortController();
    cancelled.abort();
    await assert.rejects(tools.get('browser.navigate')!.execute({ url: 'https://example.com' }, context), refused('browser_origin_forbidden'));
    await assert.rejects(tools.get('browser.navigate')!.execute({ url: 'not a url' }, context), refused('invalid_input'));
    await assert.rejects(tools.get('browser.navigate')!.execute({}, context), refused('invalid_input'));
    await assert.rejects(tools.get('browser.click')!.execute({ selector: '' }, context), refused('invalid_input'));
    await assert.rejects(tools.get('browser.fill')!.execute({ selector: '#name', value: 7 }, context), refused('invalid_input'));
    await assert.rejects(tools.get('browser.fill')!.execute({ selector: '', value: 'x' }, context), refused('invalid_input'));
    await assert.rejects(
      tools.get('browser.click')!.execute({ selector: '#save' }, { ...context, signal: cancelled.signal }),
      refused('browser_aborted'),
    );
    await assert.rejects(
      tools.get('browser.navigate')!.execute({ url: origin }, { ...context, principal: { ...context.principal, scopes: [] } }),
      refused('forbidden'),
    );
    await assert.rejects(tools.get('browser.navigate')!.execute({ url: unreachable }, context), (error: unknown) => {
      assert.equal(isNotDispatched(error), false, String(error));
      return true;
    });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx --test test/mac-app-tools.test.ts test/plugins-browser.test.ts`

Expected on macOS with Chrome installed: two failures.

```
✖ Mac app tools mark refusals before the helper starts, and helper failures only when the helper says so
  AssertionError [ERR_ASSERTION]: expected a not-dispatched desktop_app_forbidden, got DomainError: App is outside the configured bundle identifier allowlist
✖ browser tools navigate, snapshot, fill, and click a configured localhost fixture
  AssertionError [ERR_ASSERTION]: expected a not-dispatched browser_origin_forbidden, got DomainError: URL origin is not configured for this browser
```

On another platform the Mac test is reported as skipped, and without Chrome the browser test is reported as skipped; in that case this step shows no failure and the classification of that file is checked by review against the tables above only.

- [ ] **Step 3: Write minimal implementation**

Apply to `src/tools/browser.ts`:

```diff
--- a/src/tools/browser.ts
+++ b/src/tools/browser.ts
@@ -3,5 +3,5 @@ import { access } from 'node:fs/promises';
 import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
 import { requireScope } from '../auth.js';
-import { DomainError, type ToolContext, type ToolDefinition, type ToolSpecification } from '../contracts.js';
+import { asNotDispatched, DomainError, notDispatched, type ToolContext, type ToolDefinition, type ToolSpecification } from '../contracts.js';
 
 export interface BrowserToolOptions {
@@ -29,5 +29,5 @@ function schema(properties: Record<string, unknown>, required: string[] = []): R
 function stringInput(input: Record<string, unknown>, key: string): string {
   const value = input[key];
-  if (typeof value !== 'string' || value.length === 0) throw new DomainError('invalid_input', `${key} must be a non-empty string`);
+  if (typeof value !== 'string' || value.length === 0) throw notDispatched('invalid_input', `${key} must be a non-empty string`);
   return value;
 }
@@ -125,17 +125,28 @@ export class BrowserToolProvider {
 
   private async currentPage(): Promise<Page> {
-    if (!this.page || this.page.isClosed()) this.page = await this.browserContext.newPage();
+    if (!this.page || this.page.isClosed()) {
+      this.page = await this.browserContext.newPage().catch((error: unknown) => {
+        throw asNotDispatched(error, 'browser_unavailable', 503);
+      });
+    }
     return this.page;
   }
 
-  private allowedUrl(raw: string): URL {
+  /**
+   * 'requested' checks the URL the caller asked for, before the page is touched: a refusal is not dispatched.
+   * 'resulting' checks where the page ended up after an action: a refusal there leaves the outcome unknown.
+   */
+  private allowedUrl(raw: string, stage: 'requested' | 'resulting'): URL {
+    const refuse = (code: string, message: string, statusCode: number): DomainError => stage === 'requested'
+      ? notDispatched(code, message, statusCode)
+      : new DomainError(code, message, statusCode);
     let url: URL;
     try {
       url = new URL(raw);
     } catch {
-      throw new DomainError('invalid_input', 'url must be an absolute HTTP or HTTPS URL');
+      throw refuse('invalid_input', 'url must be an absolute HTTP or HTTPS URL', 400);
     }
     if (!['http:', 'https:'].includes(url.protocol) || !this.origins.has(url.origin)) {
-      throw new DomainError('browser_origin_forbidden', 'URL origin is not configured for this browser', 403);
+      throw refuse('browser_origin_forbidden', 'URL origin is not configured for this browser', 403);
     }
     return url;
@@ -149,5 +160,5 @@ export class BrowserToolProvider {
 
   private async action<T>(context: ToolContext, operation: () => Promise<T>): Promise<T> {
-    if (context.signal.aborted) throw new DomainError('browser_aborted', 'Browser action was cancelled', 499);
+    if (context.signal.aborted) throw notDispatched('browser_aborted', 'Browser action was cancelled', 499);
     const abort = (): void => { void this.page?.close(); };
     context.signal.addEventListener('abort', abort, { once: true });
@@ -167,8 +178,8 @@ export class BrowserToolProvider {
       execute: async (input, context) => {
         requireCapability(context);
-        const url = this.allowedUrl(stringInput(input, 'url'));
+        const url = this.allowedUrl(stringInput(input, 'url'), 'requested');
         const page = await this.currentPage();
         const response = await this.action(context, () => page.goto(url.href, { waitUntil: 'domcontentloaded', timeout: 30_000 }));
-        const finalUrl = this.allowedUrl(page.url());
+        const finalUrl = this.allowedUrl(page.url(), 'resulting');
         return { content: JSON.stringify({ url: finalUrl.href, title: await page.title(), status: response?.status() ?? null }) };
       },
@@ -180,5 +191,5 @@ export class BrowserToolProvider {
         requireCapability(context);
         const page = await this.currentPage();
-        if (page.url() !== 'about:blank') this.allowedUrl(page.url());
+        if (page.url() !== 'about:blank') this.allowedUrl(page.url(), 'resulting');
         const maximum = this.options.maxSnapshotCharacters ?? 100_000;
         const visibleText = (await this.action(context, () => page.locator('body').innerText())).slice(0, maximum);
@@ -192,8 +203,9 @@ export class BrowserToolProvider {
       execute: async (input, context) => {
         requireCapability(context);
+        const selector = stringInput(input, 'selector');
         const page = await this.currentPage();
-        await this.action(context, () => page.locator(stringInput(input, 'selector')).click({ timeout: 15_000 }));
+        await this.action(context, () => page.locator(selector).click({ timeout: 15_000 }));
         await this.closeExtraPages();
-        if (page.url() !== 'about:blank') this.allowedUrl(page.url());
+        if (page.url() !== 'about:blank') this.allowedUrl(page.url(), 'resulting');
         return { content: JSON.stringify({ clicked: true, url: page.url() }) };
       },
@@ -204,7 +216,9 @@ export class BrowserToolProvider {
       execute: async (input, context) => {
         requireCapability(context);
+        const selector = stringInput(input, 'selector');
+        const value = input.value;
+        if (typeof value !== 'string') throw notDispatched('invalid_input', 'value must be a string');
         const page = await this.currentPage();
-        if (typeof input.value !== 'string') throw new DomainError('invalid_input', 'value must be a string');
-        await this.action(context, () => page.locator(stringInput(input, 'selector')).fill(input.value as string, { timeout: 15_000 }));
+        await this.action(context, () => page.locator(selector).fill(value, { timeout: 15_000 }));
         return { content: JSON.stringify({ filled: true, url: page.url() }) };
       },
```

Apply to `src/tools/mac-app.ts`:

```diff
--- a/src/tools/mac-app.ts
+++ b/src/tools/mac-app.ts
@@ -4,5 +4,5 @@ import { constants as fsConstants } from 'node:fs';
 import { access, chmod, lstat, mkdir, readFile, realpath, unlink } from 'node:fs/promises';
 import path from 'node:path';
-import { DomainError, type ToolContext, type ToolDefinition, type ToolResult, type ToolSpecification } from '../contracts.js';
+import { asNotDispatched, DomainError, notDispatched, type ToolContext, type ToolDefinition, type ToolResult, type ToolSpecification } from '../contracts.js';
 import { requireScope } from '../auth.js';
 
@@ -36,4 +36,6 @@ interface HelperResponse {
   code?: string;
   data?: unknown;
+  /** Set by the helper when it failed before performing any part of the requested action. */
+  notDispatched?: boolean;
 }
 
@@ -96,5 +98,5 @@ export const macAppToolSpecifications = [
 function stringInput(input: Record<string, unknown>, key: string): string {
   const value = input[key];
-  if (typeof value !== 'string' || !value) throw new DomainError('invalid_input', `${key} must be a non-empty string`);
+  if (typeof value !== 'string' || !value) throw notDispatched('invalid_input', `${key} must be a non-empty string`);
   return value;
 }
@@ -102,5 +104,5 @@ function stringInput(input: Record<string, unknown>, key: string): string {
 function integerInput(input: Record<string, unknown>, key: string, fallback = 0): number {
   const value = input[key] ?? fallback;
-  if (!Number.isInteger(value) || (value as number) < 0) throw new DomainError('invalid_input', `${key} must be a non-negative integer`);
+  if (!Number.isInteger(value) || (value as number) < 0) throw notDispatched('invalid_input', `${key} must be a non-negative integer`);
   return value as number;
 }
@@ -187,5 +189,5 @@ export class MacAppToolProvider {
         execute: async (input, context) => {
           const action = stringInput(input, 'action');
-          if (!['raise', 'minimize', 'unminimize'].includes(action)) throw new DomainError('invalid_input', 'Unsupported window action');
+          if (!['raise', 'minimize', 'unminimize'].includes(action)) throw notDispatched('invalid_input', 'Unsupported window action');
           return { content: JSON.stringify(await this.executeWrite(context, { operation: 'window', bundleId: this.allowedBundle(input), windowIndex: integerInput(input, 'windowIndex'), action })) };
         },
@@ -195,5 +197,5 @@ export class MacAppToolProvider {
         execute: async (input, context) => {
           const action = stringInput(input, 'action');
-          if (!this.actions.has(action)) throw new DomainError('desktop_action_forbidden', 'AX action is not explicitly configured', 403);
+          if (!this.actions.has(action)) throw notDispatched('desktop_action_forbidden', 'AX action is not explicitly configured', 403);
           return { content: JSON.stringify(await this.executeExternal(context, { operation: 'action', bundleId: this.allowedBundle(input), elementRef: stringInput(input, 'elementRef'), action })) };
         },
@@ -202,5 +204,5 @@ export class MacAppToolProvider {
         ...macAppToolSpecifications[6],
         execute: async (input, context) => {
-          if (!Array.isArray(input.menuPath) || input.menuPath.some((item) => typeof item !== 'string' || !item)) throw new DomainError('invalid_input', 'menuPath must contain non-empty strings');
+          if (!Array.isArray(input.menuPath) || input.menuPath.some((item) => typeof item !== 'string' || !item)) throw notDispatched('invalid_input', 'menuPath must contain non-empty strings');
           return { content: JSON.stringify(await this.executeExternal(context, { operation: 'menu', bundleId: this.allowedBundle(input), menuPath: input.menuPath })) };
         },
@@ -215,5 +217,5 @@ export class MacAppToolProvider {
   private allowedBundle(input: Record<string, unknown>): string {
     const bundleId = stringInput(input, 'bundleId');
-    if (!this.bundleIds.has(bundleId)) throw new DomainError('desktop_app_forbidden', 'App is outside the configured bundle identifier allowlist', 403);
+    if (!this.bundleIds.has(bundleId)) throw notDispatched('desktop_app_forbidden', 'App is outside the configured bundle identifier allowlist', 403);
     return bundleId;
   }
@@ -222,5 +224,5 @@ export class MacAppToolProvider {
     requireScope(context.principal, capability);
     if (!context.workspace || !context.workspace.capabilities.includes(capability)) {
-      throw new DomainError('workspace_denied', `Workspace lacks ${capability}`, 403);
+      throw notDispatched('workspace_denied', `Workspace lacks ${capability}`, 403);
     }
   }
@@ -268,6 +270,14 @@ export class MacAppToolProvider {
   }
 
+  private startHelper() {
+    try {
+      return spawn(this.helperPath, [], { detached: true, shell: false, stdio: ['pipe', 'pipe', 'pipe'] });
+    } catch (error) {
+      throw asNotDispatched(error, 'desktop_unavailable', 503);
+    }
+  }
+
   private async invoke(request: Record<string, unknown>, signal: AbortSignal): Promise<unknown> {
-    if (signal.aborted) throw new DOMException('Mac helper request was cancelled', 'AbortError');
+    if (signal.aborted) throw notDispatched('desktop_aborted', 'Mac helper request was cancelled before it started', 499);
     const payload = JSON.stringify({
       ...request,
@@ -277,5 +287,5 @@ export class MacAppToolProvider {
     });
     return new Promise((resolve, reject) => {
-      const child = spawn(this.helperPath, [], { detached: true, shell: false, stdio: ['pipe', 'pipe', 'pipe'] });
+      const child = this.startHelper();
       let stdout: Buffer<ArrayBufferLike> = Buffer.alloc(0);
       let stderr: Buffer<ArrayBufferLike> = Buffer.alloc(0);
@@ -293,5 +303,7 @@ export class MacAppToolProvider {
       child.stdout.on('data', (chunk: Buffer) => { stdout = capture(stdout, chunk); });
       child.stderr.on('data', (chunk: Buffer) => { stderr = capture(stderr, chunk); });
-      child.once('error', reject);
+      child.once('error', (error) => {
+        reject(child.pid === undefined ? notDispatched('desktop_unavailable', error.message, 503) : error);
+      });
       child.once('close', (code) => {
         clearTimeout(timer);
@@ -304,5 +316,10 @@ export class MacAppToolProvider {
         catch { reject(new DomainError('desktop_protocol_error', `Mac helper returned invalid JSON${stderr.length ? `: ${stderr.toString('utf8').slice(0, 500)}` : ''}`, 502)); return; }
         if (code !== 0 || !response.ok) {
-          reject(new DomainError(response.code ?? 'desktop_helper_failed', response.error ?? 'Mac helper failed', code === 0 ? 400 : 502));
+          reject(new DomainError(
+            response.code ?? 'desktop_helper_failed',
+            response.error ?? 'Mac helper failed',
+            code === 0 ? 400 : 502,
+            { notDispatched: response.notDispatched === true },
+          ));
           return;
         }
```

The marker of a helper response is read only in the branch that already handles `code !== 0 || !response.ok`; the abort, timeout and output-limit checks above it run first and stay unmarked whatever the helper printed.

The helper lives in another repository, so its side of the protocol is documented here. In `README.md` replace:

```markdown
- Device connectors pair through a one-use code, connect outbound with a device bearer, and journal execution before returning results. An offline device suspends dependent work.
```

with:

```markdown
- Device connectors pair through a one-use code, connect outbound with a device bearer, and journal execution before returning results. An offline device suspends dependent work. A tool that refuses a request before starting it reports an ordinary failure instead of an unknown outcome; the Mac helper states this by adding `"notDispatched": true` to its error response.
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx tsx --test test/mac-app-tools.test.ts test/plugins-browser.test.ts`

Expected on macOS with Chrome installed: `ℹ tests 3`, `ℹ pass 3`, `ℹ fail 0` (the new Mac test takes about two seconds because it waits for one helper timeout).

Run: `npx tsc --noEmit && npx tsx --test test/bootstrap-device-tools.test.ts test/connector-config.test.ts`

Expected: no type errors and `ℹ fail 0`.

- [ ] **Step 5: Commit**

```bash
git add src/tools/browser.ts src/tools/mac-app.ts README.md test/mac-app-tools.test.ts test/plugins-browser.test.ts
git commit -m "修復：瀏覽器與 Mac 應用工具於動作前的拒絕標記為未派發"
```

---

### Task 12: The write lease decides by the marker; acquisition failures are not-dispatched

This task comes last on purpose: it deletes the lease's code allowlist, which is only safe once every site that used to be recognised by its code is marked (Tasks 5 to 11).

**Files:**
- Modify: `src/workspace-write-lease.ts` (import on line 3; `acquire`, line 43; `wrap`, lines 101-133, as of commit 17d571f)
- Test: `test/workspace-write-lease.test.ts` (append), `test/bootstrap-server-tools.test.ts` (append; created in Task 5)

**Interfaces:**
- Consumes: `notDispatched`, `asNotDispatched`, `isNotDispatched` from `src/contracts.ts` (Task 1); the marked errors of Tasks 5 to 11; the internal-operation behaviour of Task 4 (a marked error ends the operation `failed` with the tool's message). Existing test helper `context(taskId: string): ToolContext` in `test/workspace-write-lease.test.ts`. From Task 5, in `test/bootstrap-server-tools.test.ts`: the constants `tokenEnv`, `token`, `headers` and the imports `bootstrap`, `configSchema`, `Task`, `WorkspaceWriteLeaseRecord`.
- Produces:
  - `WorkspaceWriteLeaseService.wrap(tool)`: after the wrapped tool threw, the lease is `released` when `isNotDispatched(error)` is true or the error's code is `waiting_for_device`, and `unknown` otherwise. The code allowlist is gone; an unmarked error never releases the lease, whatever its code.
  - A failure before the tool starts (while acquiring the lease, or an abort between acquiring and starting) is rethrown marked: a `DomainError` keeps its code, anything else becomes `workspace_lease_unavailable` (409).
  - `WorkspaceWriteLeaseService.acquire(context)`: when the previous writer is unverified it throws marked `workspace_writer_unverified` (409, message `Previous workspace writer must be verified before another write`) instead of `outcome_unknown`. The message must stay exactly as it is: existing tests and plan B2 match it with `/must be verified/`, and B2 relies on the lease states.
  - Unchanged: `update` still throws unmarked `outcome_unknown` (`Workspace writer no longer owns its lease`); `reconcile`, `validate` and `get` are untouched.

**Throw sites in `src/workspace-write-lease.ts` (lines as of 17d571f)**

| Line | Site | Code | Side | Change |
| --- | --- | --- | --- | --- |
| 32 | `acquire`: no workspace | `workspace_required` | PRE | marked at the `wrap` boundary |
| 36, 46 | `acquire`: aborted, or aborted while waiting for the active writer | `AbortError` | PRE | boundary: `workspace_lease_unavailable` 409 |
| 40-41, 55-58 | `acquire`: store errors | raw | PRE | boundary |
| 43 | `acquire`: previous writer unverified | `outcome_unknown` | PRE | marked, code changed to `workspace_writer_unverified` |
| 71-83 | `reconcile` | several | HTTP path, not a tool throw | none |
| 94 | `update`: lease no longer owned (renewal, or release after the tool ran) | `outcome_unknown` | POST | none |
| 114 | `wrap`: aborted after acquiring, before the tool starts | `AbortError` | PRE | lease released (as before), error converted to marked `workspace_lease_unavailable` |
| 116 | `wrap`: the tool throws a marked error or `waiting_for_device` | as thrown | PRE (the tool says so) | lease `released`, error rethrown unchanged |
| 116 | `wrap`: the tool throws anything else | as thrown | POST | lease `unknown`, error rethrown unchanged |
| 117 | `wrap`: aborted after the tool returned | `AbortError` | POST | none |
| 119, 129 | `wrap`: `update` fails while releasing or flagging | `outcome_unknown` / raw | POST | none |

- [ ] **Step 1: Write the failing test**

In `test/workspace-write-lease.test.ts` replace the import:

```ts
import { DomainError, type ToolContext, type ToolDefinition } from '../src/contracts.js';
```

with:

```ts
import { DomainError, isNotDispatched, notDispatched, type ToolContext, type ToolDefinition } from '../src/contracts.js';
```

and append at the end of the file:

```ts
function writer(execute: ToolDefinition['execute']): ToolDefinition {
  return { name: 'workspace.write', description: 'Write', inputSchema: {}, requiredCapabilities: [], requiresWorkspace: true, sideEffect: 'write', execute };
}

test('a not-dispatched failure releases the lease and the next writer proceeds', async () => {
  const store = new SqliteStore(); const service = new WorkspaceWriteLeaseService(store);
  const epochs: number[] = [];
  try {
    const refused = notDispatched('checkpoint_write_failed', 'ENOSPC: no space left on device, write', 503);
    await assert.rejects(service.wrap(writer(async () => { throw refused; })).execute({}, context('refused')), (error: unknown) => error === refused);
    assert.equal((await service.get('owner', 'workspace'))?.data.state, 'released');
    const saved = await service.wrap(writer(async (_input, execution) => {
      epochs.push(execution.workspaceWriteLease!.epoch);
      return { content: 'saved' };
    })).execute({}, context('next'));
    assert.deepEqual(saved, { content: 'saved' });
    assert.deepEqual(epochs, [2]);
    assert.equal((await service.get('owner', 'workspace'))?.data.state, 'released');
  } finally { await store.close(); }
});

test('an unmarked failure keeps the lease unknown whatever its code, and the next writer is refused without running', async () => {
  const store = new SqliteStore(); const service = new WorkspaceWriteLeaseService(store);
  let executions = 0;
  try {
    const thrown = new DomainError('invalid_input', 'The remote side rejected the write');
    await assert.rejects(service.wrap(writer(async () => { throw thrown; })).execute({}, context('uncertain')), (error: unknown) => error === thrown);
    assert.equal((await service.get('owner', 'workspace'))?.data.state, 'unknown');

    const blocked = (error: unknown): boolean => {
      assert.ok(isNotDispatched(error), String(error));
      assert.deepEqual(
        [error.code, error.statusCode, error.message],
        ['workspace_writer_unverified', 409, 'Previous workspace writer must be verified before another write'],
      );
      return true;
    };
    await assert.rejects(service.acquire(context('direct')), blocked);
    await assert.rejects(service.wrap(writer(async () => { executions += 1; return { content: 'saved' }; })).execute({}, context('wrapped')), blocked);
    assert.equal(executions, 0);
    const lease = (await service.get('owner', 'workspace'))!.data;
    assert.deepEqual([lease.state, lease.taskId, lease.epoch], ['unknown', 'uncertain', 1]);
  } finally { await store.close(); }
});

test('a writer that stops before it holds the lease is a not-dispatched refusal', async () => {
  const store = new SqliteStore(); const service = new WorkspaceWriteLeaseService(store);
  let release!: () => void;
  let entered!: () => void;
  const holding = new Promise<void>((resolve) => { entered = resolve; });
  const blocker = new Promise<void>((resolve) => { release = resolve; });
  let executions = 0;
  const waiting = writer(async () => { executions += 1; return { content: 'saved' }; });
  const refused = (error: unknown): boolean => {
    assert.ok(isNotDispatched(error), String(error));
    assert.deepEqual([error.code, error.statusCode], ['workspace_lease_unavailable', 409]);
    return true;
  };
  try {
    const cancelled = new AbortController();
    cancelled.abort();
    await assert.rejects(service.wrap(waiting).execute({}, { ...context('already-cancelled'), signal: cancelled.signal }), refused);
    assert.equal(await service.get('owner', 'workspace'), undefined);

    const first = service.wrap(writer(async () => { entered(); await blocker; return { content: 'first' }; })).execute({}, context('holder'));
    await holding;
    const controller = new AbortController();
    const second = assert.rejects(service.wrap(waiting).execute({}, { ...context('waiter'), signal: controller.signal }), refused);
    await delay(150);
    controller.abort();
    await second;
    const held = (await service.get('owner', 'workspace'))!.data;
    assert.deepEqual([held.state, held.taskId], ['active', 'holder']);
    release();
    assert.deepEqual(await first, { content: 'first' });
    assert.equal(executions, 0);

    const { workspace: _workspace, ...withoutWorkspace } = context('no-workspace');
    await assert.rejects(service.wrap(waiting).execute({}, withoutWorkspace), (error: unknown) => isNotDispatched(error) && error.code === 'workspace_required');
  } finally { release(); await store.close(); }
});

test('a writer whose lease lapsed while the tool ran is unknown, not a not-dispatched refusal', async () => {
  const store = new SqliteStore(); let now = Date.now();
  const service = new WorkspaceWriteLeaseService(store, () => now, 60_000);
  try {
    await assert.rejects(service.wrap(writer(async () => { now += 60_001; return { content: 'saved' }; })).execute({}, context('slow')), (error: unknown) => {
      assert.equal(isNotDispatched(error), false);
      assert.equal((error as DomainError).code, 'outcome_unknown');
      return true;
    });
  } finally { await store.close(); }
});
```

In `test/bootstrap-server-tools.test.ts` (created in Task 5) replace the import:

```ts
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
```

with:

```ts
import { access, chmod, mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
```

and append at the end of the file (the first write fails inside a read-only directory, which is an unmarked failure while changing the workspace; the test is skipped when it runs as root, because root ignores directory permissions):

```ts
test('after an unverified write the next write in that workspace fails without running and does not become unknown', { skip: process.getuid?.() === 0 }, async () => {
  const directory = await realpath(await mkdtemp(path.join(tmpdir(), 'kiancode-bootstrap-server-tools-')));
  const root = path.join(directory, 'root');
  const locked = path.join(root, 'locked');
  await mkdir(locked, { recursive: true });
  await chmod(locked, 0o500);
  const priorToken = process.env[tokenEnv];
  process.env[tokenEnv] = token;
  const server = await bootstrap(configSchema.parse({
    mode: 'development',
    stateDirectory: path.join(directory, 'state'),
    checkpointDirectory: path.join(directory, 'checkpoints'),
    database: { sqlitePath: path.join(directory, 'core.sqlite') },
    auth: { developmentTokenEnv: tokenEnv },
    serverWorkspaceRoots: [root],
    attachments: { localDirectory: path.join(directory, 'attachments') },
  }));
  try {
    const workspace = await server.store.create('workspace', 'local-owner', {
      name: 'Project', root, deviceId: 'server', capabilities: ['workspace:write'], allowCloud: false,
    });
    const write = async (file: string, requestId: string): Promise<Task> => {
      const started = await server.app.inject({
        method: 'POST',
        url: `/v1/workspaces/${workspace.id}/operations`,
        headers,
        payload: { tool: 'workspace.write', input: { path: file, content: 'text' }, requestId },
      });
      assert.equal(started.statusCode, 202, started.body);
      await server.tasks.drain();
      return (await server.store.get<Task>('task', started.json().data.id as string, 'local-owner'))!.data;
    };
    const lease = async (): Promise<WorkspaceWriteLeaseRecord | undefined> => (
      await server.store.scan<WorkspaceWriteLeaseRecord>('workspace_write_lease', 'local-owner')
    ).find((row) => row.data.workspaceId === workspace.id)?.data;

    const uncertain = await write('locked/a.txt', 'write-uncertain');
    assert.equal(uncertain.state, 'unknown');
    const held = await lease();
    assert.equal(held?.state, 'unknown');

    const next = await write('b.txt', 'write-next');
    assert.equal(next.state, 'failed', next.error);
    assert.equal(next.error, 'Previous workspace writer must be verified before another write');
    await assert.rejects(access(path.join(root, 'b.txt')));
    assert.deepEqual(await lease(), held);
  } finally {
    await server.close();
    if (priorToken === undefined) delete process.env[tokenEnv];
    else process.env[tokenEnv] = priorToken;
    await chmod(locked, 0o700).catch(() => undefined);
    await rm(directory, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx --test test/workspace-write-lease.test.ts test/bootstrap-server-tools.test.ts`

Expected: `ℹ tests 11`, `ℹ pass 7`, `ℹ fail 4`. `a writer whose lease lapsed while the tool ran is unknown, not a not-dispatched refusal` and the Task 5 test already pass (pins).

```
✖ after an unverified write the next write in that workspace fails without running and does not become unknown
  AssertionError [ERR_ASSERTION]: A side effect was dispatched but its result was not confirmed. Verify the outcome before retrying.
  + 'unknown'
  - 'failed'
✖ a not-dispatched failure releases the lease and the next writer proceeds
  + 'unknown'
  - 'released'
✖ an unmarked failure keeps the lease unknown whatever its code, and the next writer is refused without running
  + 'released'
  - 'unknown'
✖ a writer that stops before it holds the lease is a not-dispatched refusal
  AssertionError [ERR_ASSERTION]: AbortError: This operation was aborted
```

- [ ] **Step 3: Write minimal implementation**

In `src/workspace-write-lease.ts` replace the import on line 3:

```ts
import { DomainError, type ToolContext, type ToolDefinition } from './contracts.js';
```

with:

```ts
import { asNotDispatched, DomainError, isNotDispatched, notDispatched, type ToolContext, type ToolDefinition } from './contracts.js';
```

In `acquire` replace:

```ts
        throw new DomainError('outcome_unknown', 'Previous workspace writer must be verified before another write', 409);
```

with:

```ts
        throw notDispatched('workspace_writer_unverified', 'Previous workspace writer must be verified before another write', 409);
```

In `wrap` replace:

```ts
      const lease = await this.acquire(context);
```

with:

```ts
      const lease = await this.acquire(context).catch((error: unknown) => {
        throw asNotDispatched(error, 'workspace_lease_unavailable', 409);
      });
```

and replace:

```ts
        const notDispatched = !started || (error instanceof DomainError && [
          'waiting_for_device', 'device_not_dispatched', 'device_revoked', 'workspace_denied', 'forbidden', 'workspace_required', 'capability_required',
          'hash_required', 'write_conflict', 'restore_conflict', 'invalid_input', 'path_not_found', 'not_a_file', 'file_too_large', 'binary_file', 'no_change',
          'checkpoint_not_found', 'checkpoint_forbidden', 'terminal_sandbox_required', 'shell_not_allowed',
          'path_outside_workspace', 'workspace_unavailable', 'invalid_patch', 'patch_ambiguous', 'patch_context_not_found', 'patch_too_large', 'unsupported_line_endings',
        ].includes(error.code));
        await this.update(context, lease, notDispatched ? 'released' : 'unknown');
        throw error;
```

with:

```ts
        const untouched = !started || isNotDispatched(error)
          || (error instanceof DomainError && error.code === 'waiting_for_device');
        await this.update(context, lease, untouched ? 'released' : 'unknown');
        throw started ? error : asNotDispatched(error, 'workspace_lease_unavailable', 409);
```

(The old local variable was named `notDispatched`; it must be renamed because the imported function of that name is now used in `acquire`.)

- [ ] **Step 4: Run test to verify it passes**

Run: `npx tsx --test test/workspace-write-lease.test.ts test/bootstrap-server-tools.test.ts`

Expected: `ℹ tests 11`, `ℹ pass 11`, `ℹ fail 0`, including the three existing tests that match `/must be verified/` and `/no longer owns/`.

Run: `npm run check`

Expected: `tsc --noEmit` prints nothing, the test run ends with `ℹ fail 0` and `ℹ cancelled 0` (at commit `17d571f` plus this plan alone: `ℹ tests 261`, `ℹ pass 261`; the plans applied before this one add their own tests to that number), and `tsc -p tsconfig.build.json` prints nothing. On a machine without Chrome the browser test is counted under `ℹ skipped`, off macOS the two Mac app tests are, and when the suite runs as root the two read-only-directory tests (Task 7 and this task) are.

- [ ] **Step 5: Commit**

```bash
git add src/workspace-write-lease.ts test/workspace-write-lease.test.ts test/bootstrap-server-tools.test.ts
git commit -m "修復：工作區寫入租約依未派發標記決定釋放，取得租約失敗不再造成未知"
```
