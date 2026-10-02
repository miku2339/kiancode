# Workstream B2 — Reconciling Unknown Outcomes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A task that stopped in state `unknown` because a dispatched side effect was never confirmed can be reconciled by its owner as `applied`, `not_applied` or `abandon`, and then continues from its checkpoint (or ends) without the action ever being replayed.

**Architecture:** `TaskService.reconcileOutcome(actor, taskId, input)` is the single entry point, exposed as `POST /v1/tasks/:id/reconcile`. It finds the unresolved dispatch in the task's event log, releases the task's workspace write lease, records the operator's statement as a closing `tool_result` event with a deterministic id (so two concurrent answers cannot both be recorded), and only then changes the task: an agent task gets one synthetic tool message appended to its stored checkpoint by the pure runtime helper `reconcileToolCall` and is requeued exactly like a resume; an internal workspace-operation task is closed in place; a pending cancel wins. A `reconcile` audit event records who and what. Nothing in this plan ever calls a tool.

**Tech Stack:** TypeScript (NodeNext ESM), Node.js 24, Fastify 5, zod 4, `node:test` run with `tsx --test`, in-memory `SqliteStore` in tests, no new dependencies.

**Spec:** `docs/superpowers/specs/2026-10-01-core-hardening-design.md` (section B, subsection B2)

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
- Execution order is G, A, C, B1, B2, D, E, F. This plan runs after G, A, C and B1. Those plans edit `src/tasks.ts`, `src/runtime/agent-runtime.ts`, `src/workspace-write-lease.ts`, `src/http/server.ts` and `README.md`, so every line number below is approximate by then. Always locate code by the quoted text.
- Tasks 1 to 9 are applied in order. Every "Replace … with …" block quotes the text as it is at that point (as of commit `17d571f`, or as left by the earlier plan or task that the step names).
- Commit subjects are in Traditional Chinese with a type prefix and a full-width colon (`修復：…`, `實現：…`, `測試：…`, `文件：…`).

## Review Focus

Most likely first. Each line names the task that owns the code and the test that pins it.

1. **The operator answers `applied` because the side effect really happened (a message was sent, a command ran).** Expected: the task continues from where it stopped and the action is never executed a second time, also when the service restarts in between. — Task 9, `applied: the task continues from its checkpoint and the tool is not executed again` and `a restart between reconciliation and the next run still resumes from the stored checkpoint`; Task 4, `applied records the outcome as confirmed and resumes the task from its checkpoint`; Task 1, `a checkpoint reconciled as applied continues without executing the tool again`.
2. **The operator answers `not_applied` and the model then asks for the same action again, with a new tool-call id or with the very same id and arguments.** Expected: nothing runs on the strength of the old approval; the task stops in `waiting_for_approval` until the owner approves again. — Task 1, `after a not-applied reconciliation the model needs a fresh approval to try again`; Task 4, `not_applied records a failed outcome and withdraws the approval so nothing is replayed`; Task 9, `not_applied: a retry needs a new approval before the tool runs a second time`.
3. **A request that does not fit: a wrong or already answered target, a task that is not `unknown`, a double submit, two people answering differently at the same moment, a retry after a crash half-way.** Expected: 409 with a specific code and nothing written, and exactly one recorded outcome that matches the state of the task. — Task 3, `a reconciliation target must name an unresolved dispatched action of that task` and `only a task in the unknown state can be reconciled`; Task 4, `two operators answering differently at the same time record exactly one outcome` and `repeating a reconciliation after a crash does not record the outcome twice`; Task 8, `POST /v1/tasks/:id/reconcile reports another owner, a wrong state and a wrong target with their own codes`.
4. **The task is not an ordinary resumable one: its owner had already pressed cancel when the outcome became unknown, or it is a workspace operation started from the client's file or terminal view (no model loop).** Expected: the cancel is honoured (`cancelled`, nothing resumes); an operation is closed as `completed` or `failed`, its tool never runs again, and its result is still a string the client can decode. — Task 4, `a task that became unknown while a cancel was pending is recorded and ends cancelled`; Task 5, `an internal workspace operation reconciled as applied completes with a JSON result and never runs again`, `an internal workspace operation reconciled as not applied fails without running again` and `a workspace operation with a pending cancel ends cancelled whatever the answer`; Task 8, `an unknown workspace operation is closed over HTTP and only a new request runs the tool again`.
5. **The workspace is write-blocked because the unknown task still holds its write lease.** Expected: `applied` / `not_applied` unblock it (but not while that writer is still active); `abandon` leaves it blocked for the lease endpoint, and that endpoint is no longer dead-locked by a device job whose outcome is itself unknown. — Task 6, `reconciliation releases the workspace write lease held by the task`, `reconciliation waits for an active writer and changes nothing until it has stopped` and `abandon leaves the workspace write lease for the lease endpoint`; Task 2, `a crashed or unknown writer blocks writes until stopped operation is verified` (updated) and `releaseForTask refuses a writer that is still active and never touches another task's lease`.

Also pinned, because each would be a silent regression:

- A principal without `approval:write`, or one that does not own the task, can reconcile nothing. — Task 3, `reconcileOutcome requires approval:write and the owner of the task`; Task 8, `POST /v1/tasks/:id/reconcile requires a bearer token, task:write and approval:write`.
- A task idle for hours is not immediately paused again with `grant_expired` after it is reconciled. — Task 4, `reconciliation renews an expired grant from the signed-in actor and rejects an expired session`.
- Reconciling is not a way to widen a delegated task: an actor whose scopes no longer cover an orchestration task's own scopes is refused with `grant_revoked` and nothing is written. — Task 4, `a reconciled orchestration task keeps its own scopes and a parent in its children phase waits again`.
- A task without a usable checkpoint is refused instead of being requeued into a replay. — Task 5, `an agent task without a matching checkpoint cannot be resumed but can be abandoned`.
- A parent that was `unknown` only because of the reconciled child waits again; a parent with its own reasons, and dependents that already failed, are left alone. — Task 7, `reconciling a child restores the parent that was waiting for it` and `a parent that stopped for its own reasons is not restored by its child`; Task 4, `a dependent that already failed is not revived by reconciliation`.

## File Structure

| File | Action | Responsibility |
| --- | --- | --- |
| `src/runtime/agent-runtime.ts` | modify | Export `reconcileToolCall` and `ToolCallReconciliation`: append the operator's answer for a pending tool call to a checkpoint. |
| `src/runtime/index.ts` | modify | Re-export `reconcileToolCall` and `ToolCallReconciliation`. |
| `src/workspace-write-lease.ts` | modify | New `releaseForTask`; the lease endpoint guard refuses only `queued` and `dispatched` device jobs. |
| `src/tasks.ts` | modify | `TaskReconciliation` types, `sideEffectDispatches` scan, `TaskService.reconcileOutcome`, parent restoration, `reconcile` and reconciliation `tool_result` events. |
| `src/http/server.ts` | modify | Route `POST /v1/tasks/:id/reconcile`. |
| `README.md` | modify | Components list: describe reconciliation and the relaxed lease guard. |
| `test/runtime-reconcile.test.ts` | create | `reconcileToolCall` and how `AgentRuntime.run` resumes from a reconciled checkpoint. |
| `test/workspace-write-lease.test.ts` | modify | One existing test updated for the relaxed guard; three appended tests for `releaseForTask`. |
| `test/task-reconcile.test.ts` | create | `TaskService.reconcileOutcome` behaviours (Tasks 3 to 7 append to it). |
| `test/task-reconcile-http.test.ts` | create | Route authentication, validation, error codes, and the workspace-operation flow over HTTP. |
| `test/unknown-outcomes.test.ts` | create | End-to-end regression with the real `AgentRuntime` and `createTaskRunner`. |

## Client Compatibility

Checked against the native client package (`Sources/KianCodeClient`, `Sources/KianCodeUI`) and the Plus services (`services/src`) as they are today. Nothing here breaks them; no server-side workaround was needed.

- **New task event type `reconcile`.** The Swift `TaskEvent` model decodes `type` as a plain `String` and `payload` as a free-form JSON value, and the views print both as text. The client reads events only through `GET /v1/tasks/:id/events` (it does not use the SSE stream). The Plus task runner passes events through and matches only `token`, `tool_result` with `checkpointMessages`, and `final`. An unknown event type is therefore displayed or ignored, never a decode failure.
- **Extra fields on `tool_result`** (`reconciled` from this plan, `notDispatched` from B1). Same reason: the payload is free-form on every consumer.
- **Operation results after `POST /v1/workspaces/:id/operations`.** The client decodes the response and every later `GET /v1/tasks/:id` as a task whose `result` is an optional string. When the task is `completed` each caller then parses that string as JSON into a tool-specific response type with `try?` and returns silently when it does not match; `workspace.restore` only checks that a result exists. Any other terminal state is shown as an error using `task.error`. So the synthetic result of an operation reconciled as `applied` must be a string, and to stay in the same family as every real operation result it is a JSON object: `{"reconciled":"applied","toolCallId":"<task id>","message":"…","note":"…"}` (`note` only when given). It cannot carry tool-specific fields (a content hash, an exit code) because nobody knows them; a tool-specific decoder simply does not match, exactly as for a real result of an unexpected shape. The task detail view prints `result` as text.
- **No new task state and no new task field.** The Swift `TaskState` enum is closed; this plan adds nothing to it. Unknown JSON keys are ignored by the Swift decoders.
- **Plus services** treat `unknown` as terminal for their own waiting and notification logic. A task that later completes after reconciliation is reported under a different state, so nothing is suppressed. They do not call `reconcileOutcome`.

Follow-up for the clients (outside this repository, listed in the spec): offer the three resolutions on an `unknown` task. The target is the last `tool_dispatched` event without a closing `tool_result` in `GET /v1/tasks/:id/events` (`payload.actionHash`, or `payload.toolCall.id`); for a workspace operation the `toolCallId` is the task id.

## Decisions

Owner decisions this plan implements:

- A task that became `unknown` while a cancel was pending (`cancelRequested`) is not resumed: `applied` / `not_applied` are recorded and the task ends `cancelled`. The same holds for an internal workspace operation: the pending cancel wins over `completed` / `failed` (Task 5).
- Internal workspace-operation tasks have no model loop: `applied` ends them `completed`, `not_applied` ends them `failed`. They are never run again.
- `abandon` never touches the workspace write lease. The lease endpoint `POST /v1/workspaces/:id/write-lease/reconcile` now refuses only while the holder's device job is `queued` or `dispatched`; a device job in `unknown` no longer blocks it.

Decisions made while writing the plan (each is pinned by a test):

- The closing `tool_result` event of a reconciliation is created with the id `<taskId>:<12-digit sequence of the tool_dispatched event>:reconciled`. Creating the same id twice is a store conflict, which is what makes two concurrent, different answers impossible to record together (Task 4).
- Events first, task state last: after a crash between the two, the task is still `unknown`, its dispatch is closed, and repeating the same resolution finishes the job without a second event. The opposite resolution is refused (Task 4).
- An agent task is resumable only when the dispatch event names both the tool call id and the action hash and the stored checkpoint still has that call pending. Otherwise `applied` / `not_applied` are refused with `not_resumable` and only `abandon` remains (Task 5). When a cancel is pending no checkpoint is needed, because nothing resumes.
- `releaseForTask` does not consult device jobs. The operator has stated the outcome, a device stops writing within a second once its task is no longer `running` (the existing device-side lease check), and consulting them would recreate the deadlock the relaxed guard removes (Task 2).
- Releasing the lease through task reconciliation needs only what the spec asks of the caller (owner of the task, `approval:write`, plus `task:write` over HTTP), whereas the lease endpoint needs a level-1 principal (`requireOwner`) and `workspace:write`. This is intended: the release is tied to an explicit statement about that task's own dispatched action, and it only ever touches a lease held by that task (Task 6).
- A parent is restored when its current child plan lists the reconciled child, not by comparing `planId` fields, because a task that is both a child and a parent stores only its own child plan id (Task 7).
- `TaskService.reconcileOutcome` accepts `actionHash`, `toolCallId` or both (both must name the same dispatch). The HTTP route requires exactly one for `applied` / `not_applied` (Task 8).
- The tests of Task 1 live in a new file, `test/runtime-reconcile.test.ts`, instead of being appended to `test/runtime.test.ts`, which plan B1 also appends to.

Known limits that this plan leaves as they are:

- A task that is `unknown` without a write or external dispatch in its event log (a parent whose child is unknown, or a read tool on a device whose result timed out) offers nothing to mark as `applied` or `not_applied`; it can only be abandoned, or, for a parent, be restored by reconciling the child.
- Tool-call ids that repeat inside one task. The existing module-private `pendingToolCalls` matches answered calls by id over the whole checkpoint, and the Ollama provider numbers its calls `call-1`, `call-2`, … per response, so ids repeat across turns. Two consequences, both on the safe side (nothing runs without approval, nothing runs twice) and both pre-existing behaviour of resume that this plan does not change: (a) when the unknown call reuses an id that was already answered earlier in the task, the checkpoint does not show it as pending and `applied` / `not_applied` are refused with `not_resumable`; (b) after `not_applied`, a retry that reuses the reconciled call's id stops for a fresh approval as required, but once approved it is skipped on resume because its id already has an answer, so the retry never executes and an act task then ends `failed` with `verification_failed`. Making `pendingToolCalls` positional is a separate fix outside this workstream.
- A requeued child is not counted again in the three-child slot ledger, and a second `unknown` on the same task does not notify again (the notification dedupe key is per task and state).
- A device job left in `dispatched` by a server process that died still blocks the lease endpoint until the device reports; `applied` or `not_applied` on the task releases the lease regardless.
- `reconcileOutcome` is several separate store writes. It is safe to repeat up to the change of the task (lease, outcome event, task). If the process stops after the task has changed, the restoration of a waiting parent or the `reconcile` audit event can be missing: the recorded `tool_result` with `reconciled` still shows the answer, the call cannot be repeated (the task is no longer `unknown`), and a parent left `unknown` can then only be abandoned.
- The principal and grant of a restored parent are not renewed; it pauses with `grant_expired` at integration if its grant lapsed while it waited, as it would today.

## What This Plan Needs From Earlier Plans, And How It Was Validated

From plan C (`2026-10-01-core-hardening-c-automation-auth.md`, Tasks 9 and 10): `TaskServiceOptions.durableGrants?: boolean` and the four-parameter `resumedPrincipal(task, actor, now, durableGrants)`. Used by Task 4 only; Task 4 says what to change when plan C is not in the tree.

From plan B1 (`2026-10-01-core-hardening-b1-not-dispatched.md`, Tasks 1 to 3): `notDispatched(code, message, statusCode?)` exported from `src/contracts.ts`; the runtime rule that a marked error from a write or external tool becomes a failed tool result; the failed `tool_result` that closes the dispatch record before a `waiting_for_device` task is parked. Used by Task 9 only: `test/unknown-outcomes.test.ts` imports `notDispatched`, and its last two tests assert B1 behaviour. Tasks 1 to 8 need nothing from B1.

Plans G and A change none of the text this plan quotes and none of the signatures it calls.

The plan was written against stand-ins for B1 and C and then replayed in review, literally and in order (every code block applied by exact text match, every "replace" block required to match exactly once), on three private copies:

1. Commit `17d571f` plus only plan C's `durableGrants` option and four-parameter `resumedPrincipal`: Tasks 1 to 8.
2. Commit `17d571f` with nothing else, using the three-parameter adaptation described in Task 4: Tasks 1 to 8.
3. A tree with plans G, A, C and B1 applied from their plan files: Tasks 1 to 9, then `npm run check`.

On all three every block matched once, `npx tsc --noEmit` was clean after each task, and the red and green steps behaved as written below. On the third copy `npm run check` passed with `fail 0`.

---

### Task 1: `reconcileToolCall` checkpoint helper

**Files:**
- Modify: `src/runtime/agent-runtime.ts` (insert between `pendingToolCalls`, lines 650-661, and `stableJson`, line 663, as of commit 17d571f)
- Modify: `src/runtime/index.ts` (line 1)
- Test: `test/runtime-reconcile.test.ts` (create)

**Interfaces:**
- Consumes: module-private `pendingToolCalls(messages: ChatMessage[]): ToolCall[]` in `src/runtime/agent-runtime.ts` (existing: the calls of the last assistant message that have no tool message with their id); `ChatMessage` from `src/runtime/types.ts` (existing fields `role`, `content`, `name`, `toolCallId`, `actionHash`, `toolOutcome`).
- Produces, exported from `src/runtime/agent-runtime.ts` and re-exported from `src/runtime/index.ts`:

```ts
export interface ToolCallReconciliation {
  toolCallId: string;
  resolution: 'applied' | 'not_applied';
  actionHash?: string;
  note?: string;
}
export function reconcileToolCall(messages: ChatMessage[], reconciliation: ToolCallReconciliation): ChatMessage[] | undefined;
```

  It returns `undefined` unless `toolCallId` is pending in `messages`. Otherwise it returns a new array (the input is not mutated) with one appended message `{ role: 'tool', name: <call name>, toolCallId, toolOutcome, content }`: for `applied`, `toolOutcome: 'confirmed'` plus `actionHash` when one was given; for `not_applied`, `toolOutcome: 'failed'` and never an `actionHash`. `content` starts with `Reconciled by an operator: this action was applied.` or `Reconciled by an operator: this action was not applied`, and ends with a line `Operator note: <note>` when a note was given.

Why the two shapes differ: on resume the runtime treats every tool message that carries an `actionHash` as "this approved action was already dispatched" and refuses to run it again (`not_replayed`). That is right for `applied`. For `not_applied` the action did not happen, so the message carries no hash; Task 4 additionally removes the hash from the task's approvals, so asking again needs a fresh approval.

- [ ] **Step 1: Write the failing test**

Create `test/runtime-reconcile.test.ts`:

```ts
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import type { Principal, ToolDefinition } from '../src/contracts.js';
import {
  AgentRuntime,
  reconcileToolCall,
  type ChatMessage,
  type ChatRequest,
  type ChatResponse,
  type ModelProvider,
} from '../src/runtime/index.js';

const principal: Principal = { id: 'owner-1', level: 3, scopes: ['workspace:read', 'workspace:write'] };

class ScriptedProvider implements ModelProvider {
  public readonly id = 'scripted';
  public readonly locality = 'local';
  public readonly calls: ChatRequest[] = [];

  public constructor(private readonly responses: ChatResponse[]) {}

  public async chat(request: ChatRequest): Promise<ChatResponse> {
    this.calls.push(request);
    const response = this.responses.shift();
    assert.ok(response, 'unexpected provider call');
    return response;
  }
}

function hashFor(taskId: string, callId: string, tool: string, input: Record<string, unknown>): string {
  return createHash('sha256')
    .update(`${principal.id}\0${taskId}\0${callId}\0${tool}\0${JSON.stringify(input)}`)
    .digest('hex');
}

function sendTool(executions: string[]): ToolDefinition {
  return {
    name: 'send',
    description: 'Send externally',
    inputSchema: { type: 'object' },
    requiredCapabilities: [],
    sideEffect: 'external',
    async execute(input) {
      executions.push(String(input.message));
      return { content: 'sent' };
    },
  };
}

function runtimeWith(provider: ModelProvider, tools: ToolDefinition[]): AgentRuntime {
  return new AgentRuntime({
    providers: [provider],
    models: [{ id: 'local-model', providerId: provider.id, locality: 'local', capabilities: ['tools'] }],
    tools,
  });
}

const pendingSend: ChatMessage[] = [
  { role: 'user', content: 'send hello' },
  { role: 'assistant', content: '', toolCalls: [{ id: 'send-1', name: 'send', arguments: { message: 'hello' } }] },
];

test('reconcileToolCall only answers a tool call that is still pending in the checkpoint', () => {
  const answered: ChatMessage[] = [...pendingSend, { role: 'tool', content: 'sent', name: 'send', toolCallId: 'send-1' }];
  const superseded: ChatMessage[] = [
    ...answered,
    { role: 'assistant', content: '', toolCalls: [{ id: 'send-2', name: 'send', arguments: { message: 'again' } }] },
  ];
  assert.equal(reconcileToolCall([{ role: 'user', content: 'hi' }], { toolCallId: 'send-1', resolution: 'applied' }), undefined);
  assert.equal(reconcileToolCall(answered, { toolCallId: 'send-1', resolution: 'applied' }), undefined);
  assert.equal(reconcileToolCall(superseded, { toolCallId: 'send-1', resolution: 'not_applied' }), undefined);
  assert.equal(reconcileToolCall(pendingSend, { toolCallId: 'other', resolution: 'applied' }), undefined);
  assert.equal(reconcileToolCall([], { toolCallId: 'send-1', resolution: 'applied' }), undefined);
});

test('reconcileToolCall appends a confirmed or failed tool message without mutating its input', () => {
  const before = JSON.stringify(pendingSend);
  const note = `line one\nline two ${'x'.repeat(1_980)}`;
  const applied = reconcileToolCall(pendingSend, { toolCallId: 'send-1', resolution: 'applied', actionHash: 'a'.repeat(64), note });
  assert.equal(JSON.stringify(pendingSend), before);
  assert.equal(applied?.length, 3);
  assert.deepEqual(applied?.slice(0, 2), pendingSend);
  const confirmed = applied?.at(-1);
  assert.equal(confirmed?.role, 'tool');
  assert.equal(confirmed?.name, 'send');
  assert.equal(confirmed?.toolCallId, 'send-1');
  assert.equal(confirmed?.actionHash, 'a'.repeat(64));
  assert.equal(confirmed?.toolOutcome, 'confirmed');
  assert.match(confirmed?.content ?? '', /^Reconciled by an operator: this action was applied\./);
  assert.ok(confirmed?.content.endsWith(`\nOperator note: ${note}`));

  const notApplied = reconcileToolCall(pendingSend, { toolCallId: 'send-1', resolution: 'not_applied', actionHash: 'a'.repeat(64) });
  const failed = notApplied?.at(-1);
  assert.equal(failed?.toolOutcome, 'failed');
  assert.equal(failed?.toolCallId, 'send-1');
  assert.equal('actionHash' in (failed ?? {}), false);
  assert.match(failed?.content ?? '', /^Reconciled by an operator: this action was not applied/);
  assert.equal(failed?.content.includes('Operator note'), false);
});

test('a checkpoint reconciled as applied continues without executing the tool again', async () => {
  const executions: string[] = [];
  const provider = new ScriptedProvider([
    { message: { role: 'assistant', content: 'The message was sent.' }, usage: { inputTokens: 1, outputTokens: 1 } },
  ]);
  const hash = hashFor('applied-task', 'send-1', 'send', { message: 'hello' });
  const messages = reconcileToolCall(pendingSend, { toolCallId: 'send-1', resolution: 'applied', actionHash: hash, note: 'seen in the outbox' });
  assert.ok(messages);

  const result = await runtimeWith(provider, [sendTool(executions)]).run({
    principal,
    taskId: 'applied-task',
    messages,
    mode: 'act',
    strategy: 'single',
    approvedActionHashes: new Set([hash]),
  });

  assert.equal(result.status, 'completed');
  assert.equal(result.content, 'The message was sent.');
  assert.deepEqual(executions, []);
  const seen = provider.calls[0]?.messages.at(-1);
  assert.equal(seen?.role, 'tool');
  assert.match(seen?.content ?? '', /was applied[\s\S]*Operator note: seen in the outbox$/);
});

test('an applied reconciliation clears an earlier failed attempt of the same action', async () => {
  const executions: string[] = [];
  const provider = new ScriptedProvider([
    { message: { role: 'assistant', content: 'Done.' }, usage: { inputTokens: 1, outputTokens: 1 } },
  ]);
  const checkpoint: ChatMessage[] = [
    { role: 'user', content: 'send hello' },
    { role: 'assistant', content: '', toolCalls: [{ id: 'send-0', name: 'send', arguments: { message: 'hello' } }] },
    { role: 'tool', content: 'Tool error: offline', name: 'send', toolCallId: 'send-0', toolOutcome: 'failed' },
    { role: 'assistant', content: '', toolCalls: [{ id: 'send-1', name: 'send', arguments: { message: 'hello' } }] },
  ];
  const hash = hashFor('repair-task', 'send-1', 'send', { message: 'hello' });
  const messages = reconcileToolCall(checkpoint, { toolCallId: 'send-1', resolution: 'applied', actionHash: hash });
  assert.ok(messages);

  const result = await runtimeWith(provider, [sendTool(executions)]).run({
    principal, taskId: 'repair-task', messages, mode: 'act', strategy: 'single', approvedActionHashes: new Set([hash]),
  });

  assert.equal(result.status, 'completed');
  assert.deepEqual(executions, []);
});

test('a checkpoint reconciled as not applied cannot finish an act task without a successful retry', async () => {
  const executions: string[] = [];
  const provider = new ScriptedProvider([
    { message: { role: 'assistant', content: 'I will stop here.' }, usage: { inputTokens: 1, outputTokens: 1 } },
  ]);
  const messages = reconcileToolCall(pendingSend, { toolCallId: 'send-1', resolution: 'not_applied' });
  assert.ok(messages);

  await assert.rejects(runtimeWith(provider, [sendTool(executions)]).run({
    principal, taskId: 'not-applied-task', messages, mode: 'act', strategy: 'single', approvedActionHashes: new Set(),
  }), (error: unknown) => error instanceof Error && 'code' in error && error.code === 'verification_failed'
    && /failed send action/.test(error.message));
  assert.deepEqual(executions, []);
});

test('after a not-applied reconciliation the model needs a fresh approval to try again', async () => {
  for (const retryId of ['send-2', 'send-1']) {
    const executions: string[] = [];
    const provider = new ScriptedProvider([{
      message: { role: 'assistant', content: '', toolCalls: [{ id: retryId, name: 'send', arguments: { message: 'hello' } }] },
      usage: { inputTokens: 1, outputTokens: 1 },
    }]);
    const firstHash = hashFor('retry-task', 'send-1', 'send', { message: 'hello' });
    const messages = reconcileToolCall(pendingSend, { toolCallId: 'send-1', resolution: 'not_applied', actionHash: firstHash });
    assert.ok(messages);
    const events: string[] = [];

    const result = await runtimeWith(provider, [sendTool(executions)]).run({
      principal,
      taskId: 'retry-task',
      messages,
      mode: 'act',
      strategy: 'single',
      // The task service removes the reconciled hash; an unrelated approval stays.
      approvedActionHashes: new Set(['f'.repeat(64)]),
      onEvent(event) { events.push(event.type); },
    });

    assert.equal(result.status, 'waiting_for_approval', retryId);
    assert.deepEqual(executions, [], retryId);
    assert.equal(result.pendingActions?.length, 1);
    assert.equal(result.pendingActions?.[0]?.toolCallId, retryId);
    assert.equal(result.pendingActions?.[0]?.actionHash, hashFor('retry-task', retryId, 'send', { message: 'hello' }));
    assert.equal(result.pendingActions?.[0]?.actionHash === firstHash, retryId === 'send-1');
    assert.equal(events.includes('tool_dispatched'), false, retryId);
  }
});

test('reconciling one call of a batch leaves the remaining calls to the normal approval flow', async () => {
  const executions: string[] = [];
  let lookups = 0;
  const lookup: ToolDefinition = {
    name: 'lookup', description: 'Look up', inputSchema: { type: 'object' }, requiredCapabilities: [], sideEffect: 'read',
    async execute() { lookups += 1; return { content: 'found' }; },
  };
  const provider = new ScriptedProvider([]);
  const checkpoint: ChatMessage[] = [
    { role: 'user', content: 'look up, send twice' },
    { role: 'assistant', content: '', toolCalls: [
      { id: 'look-1', name: 'lookup', arguments: {} },
      { id: 'send-1', name: 'send', arguments: { message: 'one' } },
      { id: 'send-2', name: 'send', arguments: { message: 'two' } },
    ] },
    { role: 'tool', content: 'found', name: 'lookup', toolCallId: 'look-1', toolOutcome: 'confirmed' },
  ];
  const hash = hashFor('batch-task', 'send-1', 'send', { message: 'one' });
  const messages = reconcileToolCall(checkpoint, { toolCallId: 'send-1', resolution: 'applied', actionHash: hash });
  assert.ok(messages);

  const result = await runtimeWith(provider, [lookup, sendTool(executions)]).run({
    principal, taskId: 'batch-task', messages, mode: 'act', strategy: 'single', approvedActionHashes: new Set([hash]),
  });

  assert.equal(result.status, 'waiting_for_approval');
  assert.equal(result.pendingActions?.[0]?.toolCallId, 'send-2');
  assert.equal(lookups, 0);
  assert.deepEqual(executions, []);
  assert.equal(provider.calls.length, 0);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx --test test/runtime-reconcile.test.ts`

Expected: the file fails to load with

```
SyntaxError: The requested module '../src/runtime/index.js' does not provide an export named 'reconcileToolCall'
```

- [ ] **Step 3: Write minimal implementation**

In `src/runtime/agent-runtime.ts`, find the module-private function `pendingToolCalls` and the function `stableJson` that follows it. Insert the new block directly above this existing line:

```ts
function stableJson(value: unknown): string {
```

so that it reads:

```ts
export interface ToolCallReconciliation {
  toolCallId: string;
  resolution: 'applied' | 'not_applied';
  actionHash?: string;
  note?: string;
}

/**
 * Answers a tool call that is still pending in a checkpoint with an operator's statement about its
 * outcome. Returns undefined when the call is not pending. Never executes anything.
 */
export function reconcileToolCall(
  messages: ChatMessage[],
  reconciliation: ToolCallReconciliation,
): ChatMessage[] | undefined {
  const call = pendingToolCalls(messages).find((candidate) => candidate.id === reconciliation.toolCallId);
  if (!call) return undefined;
  const applied = reconciliation.resolution === 'applied';
  const lines = [applied
    ? 'Reconciled by an operator: this action was applied. Its original output is unavailable; inspect the result before relying on it.'
    : 'Reconciled by an operator: this action was not applied and was not retried. Request it again if it is still required; a new approval is needed.'];
  if (reconciliation.note) lines.push(`Operator note: ${reconciliation.note}`);
  return [...messages, {
    role: 'tool',
    content: lines.join('\n'),
    name: call.name,
    toolCallId: call.id,
    ...(applied && reconciliation.actionHash ? { actionHash: reconciliation.actionHash } : {}),
    toolOutcome: applied ? 'confirmed' : 'failed',
  }];
}

function stableJson(value: unknown): string {
```

In `src/runtime/index.ts` replace the first line:

```ts
export { AgentRuntime, createRuntime } from './agent-runtime.js';
```

with:

```ts
export { AgentRuntime, createRuntime, reconcileToolCall } from './agent-runtime.js';
export type { ToolCallReconciliation } from './agent-runtime.js';
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx tsc --noEmit && npx tsx --test test/runtime-reconcile.test.ts test/runtime.test.ts`

Expected: no type errors; `test/runtime-reconcile.test.ts` reports `pass 7`, `fail 0`, and every existing test in `test/runtime.test.ts` still passes.

- [ ] **Step 5: Commit**

```bash
git add src/runtime/agent-runtime.ts src/runtime/index.ts test/runtime-reconcile.test.ts
git commit -m "實現：檢查點可由操作者補記待決工具呼叫的結果"
```

---

### Task 2: `WorkspaceWriteLeaseService.releaseForTask` and the relaxed lease guard

**Files:**
- Modify: `src/workspace-write-lease.ts` (`reconcile`, lines 69-88 as of commit 17d571f; the new method is inserted directly after it)
- Modify: `test/workspace-write-lease.test.ts` (the existing test `a crashed or unknown writer blocks writes until stopped operation is verified`, lines 51-55; three tests appended at the end)
- Test: `test/workspace-write-lease.test.ts`

**Interfaces:**
- Consumes: existing `WorkspaceWriteLeaseService` members `get(ownerId, workspaceId)`, `acquire(context)`, `validate(ownerId, workspaceId, taskId, lease)`, `reconcile(ownerId, workspaceId, revision, note)`, `wrap(tool)`; the record type `WorkspaceWriteLeaseRecord` (`taskId`, `state: 'active' | 'released' | 'unknown'`, `expiresAt`, `holderId`, `epoch`, `verification?: { note: string; verifiedAt: string }`). Nothing from plan B1 is needed: the tests make a lease `unknown` with a wrapped external tool that throws `new DomainError('outcome_unknown', …)`, which leaves the lease `unknown` both before and after B1.
- Produces:
  - `WorkspaceWriteLeaseService.releaseForTask(ownerId: string, workspaceId: string, taskId: string, note: string): Promise<boolean>`. Returns `false` and writes nothing when there is no lease, the lease belongs to another task, or it is already `released`. Throws `DomainError('workspace_busy', 'Workspace writer is still active', 409)` when the lease is `active` and unexpired. Otherwise stores `state: 'released'` with `verification: { note, verifiedAt }` and returns `true`. A concurrent change is retried up to four times, then `DomainError('busy', 'Workspace writer lease is busy; retry', 409)`. It does not look at `device_job` rows.
  - `WorkspaceWriteLeaseService.reconcile` (signature, error codes and messages unchanged) no longer refuses when the holder's device job is in state `unknown`; it still refuses with `outcome_unknown` (409) while one is `queued` or `dispatched`.

- [ ] **Step 1: Write the failing test**

In `test/workspace-write-lease.test.ts`, inside the existing test `a crashed or unknown writer blocks writes until stopped operation is verified`, replace:

```ts
    await store.create('device_job', 'owner', { job: { workspaceWriteLease: stale }, state: 'unknown' }, 'unknown-job');
    await assert.rejects(restarted.reconcile('owner', 'workspace', row.revision, 'checked'), /confirmed outcome/);
    const job = (await store.get<{ job: { workspaceWriteLease: typeof stale }; state: string }>('device_job', 'unknown-job', 'owner'))!;
    await store.put('device_job', job.id, job.ownerId, { ...job.data, state: 'confirmed' }, job.revision);
    await restarted.reconcile('owner', 'workspace', row.revision, 'Confirmed device receipt and read back the file');
```

with:

```ts
    let job = await store.create('device_job', 'owner', { job: { workspaceWriteLease: stale }, state: 'queued' }, 'device-job');
    await assert.rejects(restarted.reconcile('owner', 'workspace', row.revision, 'checked'), /confirmed outcome/);
    job = await store.put('device_job', job.id, job.ownerId, { ...job.data, state: 'dispatched' }, job.revision);
    await assert.rejects(restarted.reconcile('owner', 'workspace', row.revision, 'checked'), /confirmed outcome/);
    await store.put('device_job', job.id, job.ownerId, { ...job.data, state: 'unknown' }, job.revision);
    await restarted.reconcile('owner', 'workspace', row.revision, 'Stopped the device and read back the file');
```

Then append at the end of the same file:

```ts

test('releaseForTask releases a stopped writer held by that task and fences the old holder', async () => {
  const store = new SqliteStore(); let now = Date.parse('2026-10-01T00:00:00.000Z');
  const service = new WorkspaceWriteLeaseService(store, () => now, 100);
  try {
    const unknownTool: ToolDefinition = {
      name: 'terminal.run', description: 'Run', inputSchema: {}, requiredCapabilities: [], requiresWorkspace: true, sideEffect: 'external',
      async execute() { throw new DomainError('outcome_unknown', 'No receipt'); },
    };
    await assert.rejects(service.wrap(unknownTool).execute({}, context('lost')), /No receipt/);
    const unknown = (await service.get('owner', 'workspace'))!;
    assert.equal(unknown.data.state, 'unknown');
    await store.create('device_job', 'owner', { job: { workspaceWriteLease: { holderId: unknown.data.holderId } }, state: 'unknown' }, 'unknown-job');
    await store.create('device_job', 'owner', { job: { workspaceWriteLease: { holderId: unknown.data.holderId } }, state: 'dispatched' }, 'stuck-job');

    assert.equal(await service.releaseForTask('owner', 'workspace', 'lost', 'Task lost reconciled as applied'), true);

    const released = (await service.get('owner', 'workspace'))!;
    assert.equal(released.data.state, 'released');
    assert.deepEqual(released.data.verification, { note: 'Task lost reconciled as applied', verifiedAt: '2026-10-01T00:00:00.000Z' });
    assert.equal(await service.releaseForTask('owner', 'workspace', 'lost', 'again'), false);
    assert.equal((await service.get('owner', 'workspace'))?.revision, released.revision);

    const crashed = await service.acquire(context('crashed'));
    assert.equal(crashed.epoch, unknown.data.epoch + 1);
    now += 101;
    assert.equal(await service.releaseForTask('owner', 'workspace', 'crashed', 'Task crashed reconciled as not_applied'), true);
    assert.equal(await service.validate('owner', 'workspace', 'crashed', crashed), false);
    assert.equal((await service.acquire(context('next'))).epoch, crashed.epoch + 1);
  } finally { await store.close(); }
});

test('releaseForTask refuses a writer that is still active and never touches another task\'s lease', async () => {
  const store = new SqliteStore(); let now = Date.parse('2026-10-01T00:00:00.000Z');
  const service = new WorkspaceWriteLeaseService(store, () => now, 100);
  try {
    assert.equal(await service.releaseForTask('owner', 'workspace', 'nobody', 'no lease yet'), false);
    const active = await service.acquire(context('writer'));
    const before = (await service.get('owner', 'workspace'))!;

    await assert.rejects(service.releaseForTask('owner', 'workspace', 'writer', 'too early'),
      (error: unknown) => error instanceof DomainError && error.code === 'workspace_busy' && error.statusCode === 409);
    assert.equal(await service.releaseForTask('owner', 'workspace', 'someone-else', 'not mine'), false);
    assert.equal(await service.releaseForTask('other-owner', 'workspace', 'writer', 'not mine'), false);
    assert.deepEqual((await service.get('owner', 'workspace')), before);
    assert.equal(await service.validate('owner', 'workspace', 'writer', active), true);

    now += 101;
    assert.equal(await service.releaseForTask('owner', 'workspace', 'someone-else', 'still not mine'), false);
    assert.equal((await service.get('owner', 'workspace'))?.data.state, 'active');
  } finally { await store.close(); }
});

test('two concurrent releases of the same lease produce exactly one release', async () => {
  const store = new SqliteStore(); let now = Date.parse('2026-10-01T00:00:00.000Z');
  const service = new WorkspaceWriteLeaseService(store, () => now, 100);
  try {
    await service.acquire(context('crashed'));
    now += 101;
    const outcomes = await Promise.all([
      service.releaseForTask('owner', 'workspace', 'crashed', 'first'),
      service.releaseForTask('owner', 'workspace', 'crashed', 'second'),
    ]);
    assert.deepEqual([...outcomes].sort(), [false, true]);
    const row = (await service.get('owner', 'workspace'))!;
    assert.equal(row.data.state, 'released');
    assert.equal(row.revision, 2);
  } finally { await store.close(); }
});
```

The file already imports `DomainError`, `ToolContext`, `ToolDefinition`, `WorkspaceWriteLeaseService` and `SqliteStore`, and already defines `context(taskId)`; nothing else is needed.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx --test test/workspace-write-lease.test.ts`

Expected: four failures.

```
✖ a crashed or unknown writer blocks writes until stopped operation is verified
  Error [DomainError]: Device operation still requires a confirmed outcome
✖ releaseForTask releases a stopped writer held by that task and fences the old holder
  TypeError [Error]: service.releaseForTask is not a function
✖ releaseForTask refuses a writer that is still active and never touches another task's lease
  TypeError [Error]: service.releaseForTask is not a function
✖ two concurrent releases of the same lease produce exactly one release
  TypeError [Error]: service.releaseForTask is not a function
```

- [ ] **Step 3: Write minimal implementation**

In `src/workspace-write-lease.ts`, in `reconcile`, replace:

```ts
      && ['queued', 'dispatched', 'unknown'].includes(job.data.state))) {
      throw new DomainError('outcome_unknown', 'Device operation still requires a confirmed outcome', 409);
    }
    return this.store.put('workspace_write_lease', row.id, ownerId, {
      ...row.data, state: 'released', verification: { note, verifiedAt: new Date(this.now()).toISOString() },
    }, revision);
  }
```

with:

```ts
      && ['queued', 'dispatched'].includes(job.data.state))) {
      throw new DomainError('outcome_unknown', 'Device operation still requires a confirmed outcome', 409);
    }
    return this.store.put('workspace_write_lease', row.id, ownerId, {
      ...row.data, state: 'released', verification: { note, verifiedAt: new Date(this.now()).toISOString() },
    }, revision);
  }

  /**
   * Releases the lease when `taskId` holds it and its writer has stopped: state `unknown`, or `active`
   * but expired. Returns false when that task holds nothing to release. Used when an operator states
   * the outcome of the task's dispatched action, so device jobs are not consulted.
   */
  async releaseForTask(ownerId: string, workspaceId: string, taskId: string, note: string): Promise<boolean> {
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const row = await this.get(ownerId, workspaceId);
      if (!row || row.data.taskId !== taskId || row.data.state === 'released') return false;
      if (row.data.state === 'active' && Date.parse(row.data.expiresAt) > this.now()) {
        throw new DomainError('workspace_busy', 'Workspace writer is still active', 409);
      }
      try {
        await this.store.put('workspace_write_lease', row.id, ownerId, {
          ...row.data, state: 'released', verification: { note, verifiedAt: new Date(this.now()).toISOString() },
        }, row.revision);
        return true;
      } catch (error) { if (!(error instanceof DomainError && error.code === 'conflict')) throw error; }
    }
    throw new DomainError('busy', 'Workspace writer lease is busy; retry', 409);
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx tsc --noEmit && npx tsx --test test/workspace-write-lease.test.ts`

Expected: no type errors; all tests in the file pass (the five tests that exist at commit `17d571f`, whatever plan B1 appended, and the three new ones), `fail 0`.

- [ ] **Step 5: Commit**

```bash
git add src/workspace-write-lease.ts test/workspace-write-lease.test.ts
git commit -m "實現：寫入租約可按任務釋放，裝置工作結果未知時不再阻擋租約對帳"
```

---

### Task 3: `reconcileOutcome` — authorisation, target validation, `abandon` and the `reconcile` event

**Files:**
- Modify: `src/tasks.ts` (after `TaskRunner`, line 26; after `EventSequence`, lines 45-47; after `control`, lines 411-479; `hasUnresolvedSideEffect`, lines 861-886; above `scopeCovered`, line 964; all as of commit 17d571f)
- Test: `test/task-reconcile.test.ts` (create)

**Interfaces:**
- Consumes (all existing in `src/tasks.ts`): `TaskService.events(ownerId, taskId)`, private `TaskService.change(ownerId, id, change)`, private `TaskService.event(task, event)`, module-private `scopeCovered(grants: string[], requested: string): boolean`; `Principal` (`id`, `level`, `scopes`, `applicationId?`) from `src/contracts.ts`.
- Produces:

```ts
export type TaskReconciliationResolution = 'applied' | 'not_applied' | 'abandon';
export interface TaskReconciliation {
  resolution: TaskReconciliationResolution;
  actionHash?: string;
  toolCallId?: string;
  note?: string;
}
// on TaskService:
public async reconcileOutcome(actor: Principal, id: string, input: TaskReconciliation): Promise<Entity<Task>>;
```

  Behaviour delivered by this task, in this order: actor without `approval:write` → `forbidden` (403); task not found for `actor.id` → `not_found` (404); task state other than `unknown` → `not_reconcilable` (409); `applied` / `not_applied` without `actionHash` and `toolCallId` → `invalid_input` (400); a target that is not an unresolved dispatched action of the task → `invalid_reconciliation` (409); `abandon` → task `cancelled` with `cancelRequested: true`, its `error` text kept, one event `{ type: 'reconcile', state: 'cancelled', resolution: 'abandon', toolCallId?, actionHash?, toolName?, note?, actor: { id, level, applicationId? } }`, no `tool_result`. `applied` / `not_applied` with a valid target end in `not_resumable` (409) until Tasks 4 and 5 add their branches.
  - Module-private in `src/tasks.ts`, used by Tasks 4 to 7:

```ts
interface SideEffectDispatch {
  key: string;            // actionHash ?? toolCallId ?? toolCall.id, the existing key rule
  sequence: number;       // sequence of the tool_dispatched event
  toolCallId?: string;
  actionHash?: string;
  toolName?: string;
  sideEffect: 'write' | 'external';
  resolved: boolean;      // closed by a tool_result with outcome confirmed, failed or not_replayed
  reconciled?: 'applied' | 'not_applied';   // set when the closing tool_result came from a reconciliation
}
private async sideEffectDispatches(ownerId: string, taskId: string): Promise<SideEffectDispatch[]>;  // TaskService
function notReconcilable(): DomainError;   // DomainError('not_reconcilable', …, 409)
// undefined when the input names no target; throws invalid_reconciliation (409) when it names one that is not open
function reconciliationTarget(dispatches: SideEffectDispatch[], input: TaskReconciliation): SideEffectDispatch | undefined;
```

  `hasUnresolvedSideEffect` keeps its signature and meaning and becomes `some((dispatch) => !dispatch.resolved)`.
  - Test helpers at the top of `test/task-reconcile.test.ts`, used by Tasks 4 to 7: `principal`, `conversation`, `hash`, `checkpoint`, `interface Harness { store; service; task; resumed }`, `rejectsWith(code, statusCode)`, `payloads(harness, taskId)`, `unknownAgentTask(options?, afterUnknown?)`.

The method is called `reconcileOutcome` because `setReconciler` and the tick's `reconcile` already name the periodic hook.

- [ ] **Step 1: Write the failing test**

Create `test/task-reconcile.test.ts`:

```ts
import assert from 'node:assert/strict';
import test from 'node:test';
import { DomainError, type Principal } from '../src/contracts.js';
import type { Conversation, Task, TaskEvent, TaskState } from '../src/domain.js';
import { SqliteStore } from '../src/storage/sqlite.js';
import type { Entity } from '../src/storage/store.js';
import { TaskService, type TaskRunner, type TaskServiceOptions } from '../src/tasks.js';

const principal: Principal = { id: 'alice', level: 1, scopes: ['*'] };
const conversation: Conversation = { title: 'Project', scope: 'private', modelPolicy: 'cloud', strategy: 'single', mode: 'act', archived: false };
const hash = 'a'.repeat(64);
const checkpoint = [
  { role: 'user', content: 'send hello' },
  { role: 'assistant', content: '', toolCalls: [{ id: 'send-1', name: 'send', arguments: { message: 'hello' } }] },
];

interface Harness {
  store: SqliteStore;
  service: TaskService;
  task: Entity<Task>;
  resumed: Array<Entity<Task>>;
}

function rejectsWith(code: string, statusCode: number): (error: unknown) => boolean {
  return (error) => error instanceof DomainError && error.code === code && error.statusCode === statusCode;
}

async function payloads(harness: Pick<Harness, 'service'>, taskId: string): Promise<Array<Record<string, unknown>>> {
  return (await harness.service.events(principal.id, taskId)).map((row: Entity<TaskEvent>) => row.data.payload as Record<string, unknown>);
}

// An act-mode task whose approved external call `send-1` was dispatched and never confirmed.
// Runs after the unknown outcome are recorded in `resumed` and answered by `afterUnknown`.
async function unknownAgentTask(
  options: TaskServiceOptions = {},
  afterUnknown: TaskRunner = async () => ({ text: 'continued' }),
): Promise<Harness> {
  const store = new SqliteStore();
  const resumed: Array<Entity<Task>> = [];
  let calls = 0;
  const service = new TaskService(store, async (execution) => {
    calls += 1;
    if (calls === 1) {
      return {
        text: '',
        status: 'waiting_for_approval',
        pendingActions: [{ hash, tool: 'send', input: { message: 'hello' } }],
        messages: checkpoint,
      };
    }
    if (calls === 2) {
      await execution.onEvent({
        type: 'tool_dispatched',
        taskId: execution.task.id,
        actionHash: hash,
        sideEffect: 'external',
        toolCall: { id: 'send-1', name: 'send', arguments: { message: 'hello' }, actionHash: hash },
      });
      await execution.onEvent({
        type: 'tool_result', taskId: execution.task.id, toolCallId: 'send-1', actionHash: hash, sideEffect: 'external', outcome: 'unknown', isError: true,
      });
      throw new DomainError('outcome_unknown', 'External action was dispatched but its result was not confirmed.', 409);
    }
    resumed.push(execution.task);
    return afterUnknown(execution);
  }, { reauthorize: async (current) => current, ...options });
  const thread = await store.create('conversation', principal.id, conversation);
  const queued = await service.enqueue(principal, thread.id, 'send hello');
  await service.drain();
  await service.control(principal.id, queued.id, 'resume', [hash], principal);
  await service.drain();
  const task = (await store.get<Task>('task', queued.id, principal.id))!;
  assert.equal(task.data.state, 'unknown');
  return { store, service, task, resumed };
}

test('reconcileOutcome requires approval:write and the owner of the task', async () => {
  const harness = await unknownAgentTask();
  const { store, service, task } = harness;
  try {
    const before = await payloads(harness, task.id);
    await assert.rejects(
      service.reconcileOutcome({ ...principal, scopes: ['task:write', 'task:read'] }, task.id, { resolution: 'abandon' }),
      rejectsWith('forbidden', 403),
    );
    await assert.rejects(
      service.reconcileOutcome({ id: 'bob', level: 1, scopes: ['*'] }, task.id, { resolution: 'abandon' }),
      rejectsWith('not_found', 404),
    );
    await assert.rejects(service.reconcileOutcome(principal, 'missing-task', { resolution: 'abandon' }), rejectsWith('not_found', 404));
    assert.deepEqual(await payloads(harness, task.id), before);
    assert.equal((await store.get<Task>('task', task.id, principal.id))?.revision, task.revision);
    for (const scopes of [['approval:write'], ['approval:*'], ['kiancode:approval:write'], ['kiancode:*']]) {
      const allowed = await unknownAgentTask();
      try {
        const done = await allowed.service.reconcileOutcome({ ...principal, scopes }, allowed.task.id, { resolution: 'abandon' });
        assert.equal(done.data.state, 'cancelled', scopes.join(','));
      } finally { await allowed.service.close(); await allowed.store.close(); }
    }
  } finally { await service.close(); await store.close(); }
});

test('only a task in the unknown state can be reconciled', async () => {
  const store = new SqliteStore();
  const service = new TaskService(store, async () => ({ text: 'unused' }));
  try {
    const thread = await store.create('conversation', principal.id, conversation);
    const states: TaskState[] = ['queued', 'running', 'paused', 'waiting_for_approval', 'waiting_for_device', 'waiting_for_children', 'completed', 'failed', 'cancelled'];
    for (const state of states) {
      const task = await service.enqueue(principal, thread.id, `task in ${state}`);
      const stored = await store.put<Task>('task', task.id, principal.id, { ...task.data, state }, task.revision);
      for (const resolution of ['applied', 'not_applied', 'abandon'] as const) {
        await assert.rejects(
          service.reconcileOutcome(principal, task.id, { resolution, toolCallId: 'send-1' }),
          rejectsWith('not_reconcilable', 409),
          `${state} ${resolution}`,
        );
      }
      assert.equal((await store.get<Task>('task', task.id, principal.id))?.revision, stored.revision);
    }
  } finally { await service.close(); await store.close(); }
});

test('abandon cancels an unknown task and leaves the unresolved dispatch in its events', async () => {
  const harness = await unknownAgentTask();
  const { store, service, task, resumed } = harness;
  try {
    const before = await payloads(harness, task.id);
    const actor: Principal = { ...principal, applicationId: 'mac-app', expiresAt: new Date(Date.now() + 60_000).toISOString() };

    const abandoned = await service.reconcileOutcome(actor, task.id, { resolution: 'abandon', toolCallId: 'send-1', note: 'Not worth checking' });

    assert.equal(abandoned.data.state, 'cancelled');
    assert.equal(abandoned.data.cancelRequested, true);
    assert.equal(abandoned.data.error, task.data.error);
    assert.deepEqual(abandoned.data.runtimeMessages, checkpoint);
    const after = await payloads(harness, task.id);
    assert.deepEqual(after.slice(0, before.length), before);
    assert.deepEqual(after.slice(before.length), [{
      type: 'reconcile',
      state: 'cancelled',
      resolution: 'abandon',
      toolCallId: 'send-1',
      actionHash: hash,
      toolName: 'send',
      note: 'Not worth checking',
      actor: { id: 'alice', level: 1, applicationId: 'mac-app' },
    }]);
    assert.equal(after.filter((event) => event.type === 'tool_result').every((event) => event.outcome === 'unknown'), true);
    const stored = (await service.events(principal.id, task.id)).at(-1)!;
    assert.equal(stored.data.type, 'reconcile');
    assert.ok(Number.isFinite(Date.parse(stored.data.at)));

    await assert.rejects(service.control(principal.id, task.id, 'resume', [], principal), rejectsWith('terminal_task', 409));
    await assert.rejects(service.reconcileOutcome(principal, task.id, { resolution: 'abandon' }), rejectsWith('not_reconcilable', 409));
    await service.drain();
    assert.equal(resumed.length, 0);
    assert.equal((await store.get<Task>('task', task.id, principal.id))?.data.state, 'cancelled');
  } finally { await service.close(); await store.close(); }
});

test('a reconciliation target must name an unresolved dispatched action of that task', async () => {
  const harness = await unknownAgentTask();
  const { store, service, task } = harness;
  try {
    const before = await payloads(harness, task.id);
    for (const resolution of ['applied', 'not_applied'] as const) {
      await assert.rejects(service.reconcileOutcome(principal, task.id, { resolution }), rejectsWith('invalid_input', 400));
    }
    const wrongTargets = [
      { actionHash: 'b'.repeat(64) },
      { toolCallId: 'send-2' },
      { actionHash: hash, toolCallId: 'send-2' },
      { actionHash: 'b'.repeat(64), toolCallId: 'send-1' },
    ];
    for (const target of wrongTargets) {
      for (const resolution of ['applied', 'not_applied', 'abandon'] as const) {
        await assert.rejects(
          service.reconcileOutcome(principal, task.id, { resolution, ...target }),
          rejectsWith('invalid_reconciliation', 409),
          `${resolution} ${JSON.stringify(target)}`,
        );
      }
    }
    assert.deepEqual(await payloads(harness, task.id), before);
    assert.equal((await store.get<Task>('task', task.id, principal.id))?.revision, task.revision);
  } finally { await service.close(); await store.close(); }
});

test('a task that is unknown without a dispatch of its own can only be abandoned', async () => {
  const store = new SqliteStore();
  const service = new TaskService(store, async () => ({ text: 'unused' }));
  try {
    const thread = await store.create('conversation', principal.id, conversation);
    const task = await service.enqueue(principal, thread.id, 'parent of an unknown child');
    await store.put<Task>('task', task.id, principal.id, {
      ...task.data, state: 'unknown', error: 'Delegated work requires attention: worker: unknown',
    }, task.revision);

    await assert.rejects(
      service.reconcileOutcome(principal, task.id, { resolution: 'applied', toolCallId: task.id }),
      rejectsWith('invalid_reconciliation', 409),
    );
    const abandoned = await service.reconcileOutcome(principal, task.id, { resolution: 'abandon' });

    assert.equal(abandoned.data.state, 'cancelled');
    assert.equal(abandoned.data.error, 'Delegated work requires attention: worker: unknown');
    const last = (await service.events(principal.id, task.id)).at(-1)!;
    assert.deepEqual(last.data.payload, { type: 'reconcile', state: 'cancelled', resolution: 'abandon', actor: { id: 'alice', level: 1 } });
  } finally { await service.close(); await store.close(); }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx --test test/task-reconcile.test.ts`

Expected: all five tests fail with

```
TypeError [Error]: service.reconcileOutcome is not a function
```

(`npx tsc --noEmit` reports `Property 'reconcileOutcome' does not exist on type 'TaskService'` until Step 3 is done.)

- [ ] **Step 3: Write minimal implementation**

All edits are in `src/tasks.ts`.

Edit 1 — the public types. Replace:

```ts
export type TaskRunner = (input: TaskExecution) => Promise<ExecutionResult>;
```

with:

```ts
export type TaskRunner = (input: TaskExecution) => Promise<ExecutionResult>;

export type TaskReconciliationResolution = 'applied' | 'not_applied' | 'abandon';

export interface TaskReconciliation {
  resolution: TaskReconciliationResolution;
  actionHash?: string;
  toolCallId?: string;
  note?: string;
}
```

Edit 2 — the private record of one dispatched side effect. Replace:

```ts
interface EventSequence {
  next: number;
}
```

with:

```ts
interface EventSequence {
  next: number;
}

interface SideEffectDispatch {
  key: string;
  sequence: number;
  toolCallId?: string;
  actionHash?: string;
  toolName?: string;
  sideEffect: 'write' | 'external';
  resolved: boolean;
  reconciled?: 'applied' | 'not_applied';
}
```

Edit 3 — the new method, directly after `control`. `control` ends with these lines (unchanged by plans A and C); replace:

```ts
    await this.event(row, { type: action, state: row.data.state });
    return row;
  }
```

with:

```ts
    await this.event(row, { type: action, state: row.data.state });
    return row;
  }

  public async reconcileOutcome(actor: Principal, id: string, input: TaskReconciliation): Promise<Entity<Task>> {
    if (!scopeCovered(actor.scopes, 'approval:write')) {
      throw new DomainError('forbidden', 'Missing capability: approval:write', 403);
    }
    const ownerId = actor.id;
    const task = await this.store.get<Task>('task', id, ownerId);
    if (!task) {
      throw new DomainError('not_found', 'Task not found', 404);
    }
    if (task.data.state !== 'unknown') {
      throw notReconcilable();
    }
    const dispatch = reconciliationTarget(await this.sideEffectDispatches(ownerId, id), input);
    const audit = {
      resolution: input.resolution,
      ...(dispatch?.toolCallId ? { toolCallId: dispatch.toolCallId } : {}),
      ...(dispatch?.actionHash ? { actionHash: dispatch.actionHash } : {}),
      ...(dispatch?.toolName ? { toolName: dispatch.toolName } : {}),
      ...(input.note ? { note: input.note } : {}),
      actor: { id: actor.id, level: actor.level, ...(actor.applicationId ? { applicationId: actor.applicationId } : {}) },
    };
    if (input.resolution === 'abandon') {
      const abandoned = await this.change(ownerId, id, (current) => {
        if (current.state !== 'unknown') {
          throw notReconcilable();
        }
        return { ...current, state: 'cancelled', cancelRequested: true, workerId: undefined, leaseExpiresAt: undefined };
      });
      await this.event(abandoned, { type: 'reconcile', state: abandoned.data.state, ...audit });
      return abandoned;
    }
    if (!dispatch) {
      throw new DomainError('invalid_input', 'Name the dispatched action with actionHash or toolCallId', 400);
    }
    throw new DomainError('not_resumable', 'This task has no checkpoint to continue from; use abandon', 409);
  }
```

Edit 4 — the event-log scan. Replace the whole method:

```ts
  private async hasUnresolvedSideEffect(ownerId: string, taskId: string): Promise<boolean> {
    const unresolved = new Set<string>();
    for (const row of await this.events(ownerId, taskId)) {
      const payload = row.data.payload as {
        type?: string;
        toolCallId?: string;
        actionHash?: string;
        sideEffect?: string;
        outcome?: string;
        toolCall?: { id?: string };
      };
      const key = payload.actionHash ?? payload.toolCallId ?? payload.toolCall?.id;
      if (!key) {
        continue;
      }
      if (row.data.type === 'tool_dispatched'
        && (payload.sideEffect === 'write' || payload.sideEffect === 'external')) {
        unresolved.add(key);
      }
      if (row.data.type === 'tool_result'
        && ['confirmed', 'failed', 'not_replayed'].includes(payload.outcome ?? '')) {
        unresolved.delete(key);
      }
    }
    return unresolved.size > 0;
  }
```

with:

```ts
  private async sideEffectDispatches(ownerId: string, taskId: string): Promise<SideEffectDispatch[]> {
    const dispatches = new Map<string, SideEffectDispatch>();
    for (const row of await this.events(ownerId, taskId)) {
      const payload = row.data.payload as {
        type?: string;
        toolCallId?: string;
        actionHash?: string;
        sideEffect?: string;
        outcome?: string;
        reconciled?: string;
        toolCall?: { id?: string; name?: string };
      };
      const key = payload.actionHash ?? payload.toolCallId ?? payload.toolCall?.id;
      if (!key) {
        continue;
      }
      if (row.data.type === 'tool_dispatched'
        && (payload.sideEffect === 'write' || payload.sideEffect === 'external')) {
        const toolCallId = payload.toolCallId ?? payload.toolCall?.id;
        dispatches.set(key, {
          key,
          sequence: row.data.sequence,
          ...(toolCallId ? { toolCallId } : {}),
          ...(payload.actionHash ? { actionHash: payload.actionHash } : {}),
          ...(payload.toolCall?.name ? { toolName: payload.toolCall.name } : {}),
          sideEffect: payload.sideEffect,
          resolved: false,
        });
      }
      const dispatch = dispatches.get(key);
      if (dispatch && row.data.type === 'tool_result'
        && ['confirmed', 'failed', 'not_replayed'].includes(payload.outcome ?? '')) {
        dispatch.resolved = true;
        if (payload.reconciled === 'applied' || payload.reconciled === 'not_applied') {
          dispatch.reconciled = payload.reconciled;
        }
      }
    }
    return [...dispatches.values()];
  }

  private async hasUnresolvedSideEffect(ownerId: string, taskId: string): Promise<boolean> {
    return (await this.sideEffectDispatches(ownerId, taskId)).some((dispatch) => !dispatch.resolved);
  }
```

Edit 5 — two module-level helpers. Insert directly above this existing line:

```ts
function scopeCovered(grants: string[], requested: string): boolean {
```

so that it reads:

```ts
function notReconcilable(): DomainError {
  return new DomainError('not_reconcilable', 'Only a task whose outcome is unknown can be reconciled', 409);
}

function reconciliationTarget(dispatches: SideEffectDispatch[], input: TaskReconciliation): SideEffectDispatch | undefined {
  if (input.actionHash === undefined && input.toolCallId === undefined) return undefined;
  const named = dispatches.filter((dispatch) => (input.actionHash === undefined || dispatch.actionHash === input.actionHash)
    && (input.toolCallId === undefined || dispatch.toolCallId === input.toolCallId));
  const open = named.filter((dispatch) => !dispatch.resolved);
  if (open.length === 1) return open[0];
  // A repeated call after a crash between recording the outcome and changing the task.
  const repeated = named.filter((dispatch) => dispatch.reconciled !== undefined && dispatch.reconciled === input.resolution);
  if (repeated.length === 1 && dispatches.every((dispatch) => dispatch.resolved)) return repeated[0];
  throw new DomainError('invalid_reconciliation', 'The named action is not an unresolved dispatched action of this task', 409);
}

function scopeCovered(grants: string[], requested: string): boolean {
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx tsc --noEmit && npx tsx --test test/task-reconcile.test.ts test/tasks.test.ts test/agents-runtime.test.ts`

Expected: no type errors; `test/task-reconcile.test.ts` reports its five tests passing; `test/tasks.test.ts` and `test/agents-runtime.test.ts` stay green, in particular `cancelling after external dispatch records unknown instead of claiming cancellation`, `expired leases resume from confirmed checkpoints but stop on unresolved dispatches` and `an unknown child outcome propagates to the parent without blind retry`, which exercise the refactored scan.

- [ ] **Step 5: Commit**

```bash
git add src/tasks.ts test/task-reconcile.test.ts
git commit -m "實現：未知結果任務的對帳入口，支援驗證目標與放棄"
```

---

### Task 4: `reconcileOutcome` — `applied` and `not_applied` for agent tasks

**Files:**
- Modify: `src/tasks.ts` (imports, lines 1-7; private `event`, lines 342-351; the tail of `reconcileOutcome` added in Task 3; above `scopeCovered`, line 964; line numbers as of commit 17d571f)
- Test: `test/task-reconcile.test.ts` (append)

**Interfaces:**
- Consumes:
  - From Task 1: `reconcileToolCall(messages: ChatMessage[], reconciliation: ToolCallReconciliation): ChatMessage[] | undefined` in `src/runtime/agent-runtime.ts`.
  - From Task 3: `TaskReconciliation`, `SideEffectDispatch`, `TaskService.sideEffectDispatches`, `reconciliationTarget`, `notReconcilable`, and the body of `reconcileOutcome` up to the line `throw new DomainError('not_resumable', …)`; the test helpers `principal`, `conversation`, `hash`, `checkpoint`, `Harness`, `rejectsWith`, `payloads`, `unknownAgentTask`.
  - From plan C (already applied): module-private `resumedPrincipal(task: Task, actor: Principal, now: number, durableGrants: boolean): Principal` and the option `TaskServiceOptions.durableGrants?: boolean` in `src/tasks.ts`. If `resumedPrincipal` still has three parameters in your tree (plan C not applied), make three changes to the code below: remove the `durableGrants` parameter of `resumedFromCheckpoint`, remove the argument `this.options.durableGrants === true` where `reconcileOutcome` calls it, and call `resumedPrincipal(task, actor, now)`.
  - Existing in `src/tasks.ts`: module-private `renewedGrantExpiry(principal: Principal, now: number): string`; private `TaskService.change`.
- Produces:
  - `reconcileOutcome` with `applied` / `not_applied` on a task that has a model loop. In order: refuse without writing when the task cannot be resumed (`not_resumable`, 409), when the actor's session has expired (`unauthorized`, 401) or when the actor no longer covers an orchestration task's scopes (`grant_revoked`, 403); write one event `{ type: 'tool_result', taskId, toolCallId?, actionHash?, sideEffect, isError, outcome, reconciled }` (`applied` → `outcome: 'confirmed'`, `isError: false`; `not_applied` → `outcome: 'failed'`, `isError: true`) under the store id `<taskId>:<12-digit dispatch sequence>:reconciled`; change the task; write `{ type: 'reconcile', state: <new state>, resolution, toolCallId?, actionHash?, toolName?, note?, actor }`.
  - Task change when no cancel was pending: `state` `queued` (`waiting_for_children` for a parent in its children phase), `runtimeMessages` = stored checkpoint plus the message from `reconcileToolCall`, `principal` and `grantExpiresAt` renewed from the actor exactly as `control(…, 'resume', …, actor)` does, `pauseRequested: false`, `error`, `nextAttemptAt`, `workerId` and `leaseExpiresAt` cleared, and for `not_applied` the dispatch's hash removed from `approvedActionHashes`.
  - Task change when `cancelRequested` is set: `state: 'cancelled'`, `error` cleared, checkpoint untouched, nothing resumes.
  - A second answer for the same dispatch with a different resolution → `invalid_reconciliation` (409); with the same resolution while the task is still `unknown` → continues without a second `tool_result`; after the task left `unknown` → `not_reconcilable` (409).
  - Private in `src/tasks.ts`, used by Tasks 5 to 7: `TaskService.event(task, event, id?: string)`, `TaskService.recordReconciliation(task: Entity<Task>, dispatch: SideEffectDispatch, resolution: 'applied' | 'not_applied'): Promise<void>`, the local function `next` inside `reconcileOutcome`, and module-level `resumedFromCheckpoint(task, dispatch, resolution, note, actor, now, durableGrants): Task`.
  - Test helpers appended to `test/task-reconcile.test.ts`, used by Tasks 6 and 7: `unknownAfter(action: 'pause' | 'cancel'): Promise<Harness>`, `appliedText`, `notAppliedText`.

- [ ] **Step 1: Write the failing test**

Append to `test/task-reconcile.test.ts`:

```ts

// A task whose dispatched call `send-1` is still in flight when its owner pauses or cancels it.
async function unknownAfter(action: 'pause' | 'cancel'): Promise<Harness> {
  const store = new SqliteStore();
  const resumed: Array<Entity<Task>> = [];
  let calls = 0;
  let dispatched: (() => void) | undefined;
  const dispatchSeen = new Promise<void>((resolve) => { dispatched = resolve; });
  const service = new TaskService(store, async (execution) => {
    calls += 1;
    if (calls === 1) {
      return {
        text: '',
        status: 'waiting_for_approval',
        pendingActions: [{ hash, tool: 'send', input: { message: 'hello' } }],
        messages: checkpoint,
      };
    }
    if (calls === 2) {
      await execution.onEvent({
        type: 'tool_dispatched',
        taskId: execution.task.id,
        actionHash: hash,
        sideEffect: 'external',
        toolCall: { id: 'send-1', name: 'send', arguments: { message: 'hello' }, actionHash: hash },
      });
      dispatched?.();
      await new Promise<void>((_resolve, reject) => {
        execution.signal.addEventListener('abort', () => reject(execution.signal.reason), { once: true });
      });
    }
    resumed.push(execution.task);
    return { text: 'continued' };
  }, { reauthorize: async (current) => current });
  const thread = await store.create('conversation', principal.id, conversation);
  const queued = await service.enqueue(principal, thread.id, 'send hello');
  await service.drain();
  await service.control(principal.id, queued.id, 'resume', [hash], principal);
  service.start(5);
  await dispatchSeen;
  const stopped = await service.control(principal.id, queued.id, action, [], principal);
  assert.equal(stopped.data.state, 'unknown');
  await service.drain();
  const task = (await store.get<Task>('task', queued.id, principal.id))!;
  assert.equal(task.data.state, 'unknown');
  return { store, service, task, resumed };
}

const appliedText = 'Reconciled by an operator: this action was applied. Its original output is unavailable; inspect the result before relying on it.';
const notAppliedText = 'Reconciled by an operator: this action was not applied and was not retried. Request it again if it is still required; a new approval is needed.';

test('applied records the outcome as confirmed and resumes the task from its checkpoint', async () => {
  const harness = await unknownAgentTask();
  const { store, service, task, resumed } = harness;
  try {
    const before = await payloads(harness, task.id);

    const reconciled = await service.reconcileOutcome(principal, task.id, { resolution: 'applied', actionHash: hash, note: 'Seen in the outbox' });

    const expectedMessages = [...checkpoint, {
      role: 'tool',
      content: `${appliedText}\nOperator note: Seen in the outbox`,
      name: 'send',
      toolCallId: 'send-1',
      actionHash: hash,
      toolOutcome: 'confirmed',
    }];
    assert.equal(reconciled.data.state, 'queued');
    assert.equal(reconciled.data.error, undefined);
    assert.equal(reconciled.data.pauseRequested, false);
    assert.deepEqual(reconciled.data.runtimeMessages, expectedMessages);
    assert.deepEqual(reconciled.data.approvedActionHashes, [hash]);
    assert.deepEqual((await payloads(harness, task.id)).slice(before.length), [
      { type: 'tool_result', taskId: task.id, toolCallId: 'send-1', actionHash: hash, sideEffect: 'external', isError: false, outcome: 'confirmed', reconciled: 'applied' },
      { type: 'reconcile', state: 'queued', resolution: 'applied', toolCallId: 'send-1', actionHash: hash, toolName: 'send', note: 'Seen in the outbox', actor: { id: 'alice', level: 1 } },
    ]);
    await assert.rejects(
      service.reconcileOutcome(principal, task.id, { resolution: 'applied', actionHash: hash }),
      rejectsWith('not_reconcilable', 409),
    );

    await service.drain();

    assert.equal(resumed.length, 1);
    assert.deepEqual(resumed[0]?.data.runtimeMessages, expectedMessages);
    const completed = (await store.get<Task>('task', task.id, principal.id))!;
    assert.equal(completed.data.state, 'completed');
    assert.equal(completed.data.result, 'continued');
    assert.equal(completed.data.resultArtifactIds, undefined);
  } finally { await service.close(); await store.close(); }
});

test('not_applied records a failed outcome and withdraws the approval so nothing is replayed', async () => {
  const harness = await unknownAgentTask();
  const { store, service, task, resumed } = harness;
  try {
    const other = 'c'.repeat(64);
    await store.put<Task>('task', task.id, principal.id, { ...task.data, approvedActionHashes: [hash, other] }, task.revision);
    const before = await payloads(harness, task.id);

    const reconciled = await service.reconcileOutcome(principal, task.id, { resolution: 'not_applied', toolCallId: 'send-1' });

    assert.equal(reconciled.data.state, 'queued');
    assert.deepEqual(reconciled.data.approvedActionHashes, [other]);
    assert.deepEqual(reconciled.data.runtimeMessages, [...checkpoint, {
      role: 'tool', content: notAppliedText, name: 'send', toolCallId: 'send-1', toolOutcome: 'failed',
    }]);
    assert.deepEqual((await payloads(harness, task.id)).slice(before.length), [
      { type: 'tool_result', taskId: task.id, toolCallId: 'send-1', actionHash: hash, sideEffect: 'external', isError: true, outcome: 'failed', reconciled: 'not_applied' },
      { type: 'reconcile', state: 'queued', resolution: 'not_applied', toolCallId: 'send-1', actionHash: hash, toolName: 'send', actor: { id: 'alice', level: 1 } },
    ]);

    await service.drain();

    assert.equal(resumed.length, 1);
    assert.deepEqual(resumed[0]?.data.approvedActionHashes, [other]);
    assert.equal((await store.get<Task>('task', task.id, principal.id))?.data.state, 'completed');
  } finally { await service.close(); await store.close(); }
});

test('a reconciled dispatch no longer turns a later failure into an unknown outcome', async () => {
  const harness = await unknownAgentTask({}, async () => { throw new Error('model unavailable'); });
  const { store, service, task } = harness;
  try {
    await service.reconcileOutcome(principal, task.id, { resolution: 'applied', actionHash: hash });
    await service.drain();
    const failed = (await store.get<Task>('task', task.id, principal.id))!;
    assert.equal(failed.data.state, 'failed');
    assert.equal(failed.data.error, 'model unavailable');
  } finally { await service.close(); await store.close(); }
});

test('a task that became unknown while a cancel was pending is recorded and ends cancelled', async () => {
  for (const resolution of ['applied', 'not_applied'] as const) {
    const harness = await unknownAfter('cancel');
    const { store, service, task, resumed } = harness;
    try {
      assert.equal(task.data.cancelRequested, true);
      const before = await payloads(harness, task.id);

      const reconciled = await service.reconcileOutcome(principal, task.id, { resolution, actionHash: hash, note: 'Checked by hand' });

      assert.equal(reconciled.data.state, 'cancelled');
      assert.equal(reconciled.data.cancelRequested, true);
      assert.equal(reconciled.data.error, undefined);
      assert.deepEqual(reconciled.data.runtimeMessages, checkpoint);
      const added = (await payloads(harness, task.id)).slice(before.length);
      assert.deepEqual(added.map((event) => [event.type, event.outcome ?? event.state, event.reconciled ?? event.resolution]), [
        ['tool_result', resolution === 'applied' ? 'confirmed' : 'failed', resolution],
        ['reconcile', 'cancelled', resolution],
      ]);
      await service.drain();
      assert.equal(resumed.length, 0);
      assert.equal((await store.get<Task>('task', task.id, principal.id))?.data.state, 'cancelled');
    } finally { await service.close(); await store.close(); }
  }
});

test('a task that became unknown through a pause resumes when it is reconciled', async () => {
  const harness = await unknownAfter('pause');
  const { store, service, task, resumed } = harness;
  try {
    assert.equal(task.data.pauseRequested, true);

    const reconciled = await service.reconcileOutcome(principal, task.id, { resolution: 'applied', actionHash: hash });

    assert.equal(reconciled.data.state, 'queued');
    assert.equal(reconciled.data.pauseRequested, false);
    await service.drain();
    assert.equal(resumed.length, 1);
    assert.equal((await store.get<Task>('task', task.id, principal.id))?.data.state, 'completed');
  } finally { await service.close(); await store.close(); }
});

test('an unknown task recovered from an expired executor lease can be reconciled', async () => {
  const store = new SqliteStore();
  const now = Date.parse('2026-10-01T00:00:00.000Z');
  const resumed: Array<Entity<Task>> = [];
  const service = new TaskService(store, async ({ task }) => {
    resumed.push(task);
    return { text: 'continued' };
  }, { now: () => now, reauthorize: async (current) => current });
  try {
    const thread = await store.create('conversation', principal.id, conversation);
    const task = await service.enqueue(principal, thread.id, 'send hello');
    await store.put<Task>('task', task.id, task.ownerId, {
      ...task.data,
      state: 'running',
      workerId: 'dead-worker',
      leaseExpiresAt: new Date(now - 1_000).toISOString(),
      runtimeMessages: checkpoint,
      approvedActionHashes: [hash],
    }, task.revision);
    await store.create('event', principal.id, {
      taskId: task.id,
      sequence: 2,
      type: 'tool_dispatched',
      payload: { type: 'tool_dispatched', actionHash: hash, sideEffect: 'external', toolCall: { id: 'send-1', name: 'send', arguments: { message: 'hello' } } },
      at: new Date(now - 2_000).toISOString(),
    });
    await service.drain();
    assert.equal((await store.get<Task>('task', task.id, principal.id))?.data.state, 'unknown');
    assert.equal(resumed.length, 0);

    const reconciled = await service.reconcileOutcome(principal, task.id, { resolution: 'not_applied', toolCallId: 'send-1' });

    assert.equal(reconciled.data.state, 'queued');
    assert.deepEqual(reconciled.data.approvedActionHashes, []);
    await service.drain();
    assert.equal(resumed.length, 1);
    assert.equal((await store.get<Task>('task', task.id, principal.id))?.data.state, 'completed');
  } finally { await service.close(); await store.close(); }
});

test('reconciliation renews an expired grant from the signed-in actor and rejects an expired session', async () => {
  const clock = { now: Date.parse('2026-10-01T00:00:00.000Z') };
  const harness = await unknownAgentTask({ now: () => clock.now });
  const { store, service, task, resumed } = harness;
  try {
    clock.now += 2 * 3_600_000;
    assert.ok(Date.parse(task.data.grantExpiresAt) < clock.now);
    const before = await payloads(harness, task.id);
    const expired: Principal = { ...principal, expiresAt: new Date(clock.now - 1).toISOString() };
    await assert.rejects(
      service.reconcileOutcome(expired, task.id, { resolution: 'applied', actionHash: hash }),
      rejectsWith('unauthorized', 401),
    );
    assert.deepEqual(await payloads(harness, task.id), before);
    assert.equal((await store.get<Task>('task', task.id, principal.id))?.revision, task.revision);

    const actor: Principal = { ...principal, expiresAt: new Date(clock.now + 600_000).toISOString() };
    const reconciled = await service.reconcileOutcome(actor, task.id, { resolution: 'applied', actionHash: hash });

    assert.equal(reconciled.data.grantExpiresAt, actor.expiresAt);
    assert.equal(reconciled.data.principal.expiresAt, actor.expiresAt);
    await service.drain();
    assert.equal(resumed.length, 1);
    assert.equal((await store.get<Task>('task', task.id, principal.id))?.data.state, 'completed');
  } finally { await service.close(); await store.close(); }
});

test('repeating a reconciliation after a crash does not record the outcome twice', async () => {
  const harness = await unknownAgentTask();
  const { store, service, task } = harness;
  try {
    // The state a crash leaves behind: the outcome is recorded, the task is still unknown.
    const last = (await service.events(principal.id, task.id)).at(-1)!;
    await store.create('event', principal.id, {
      taskId: task.id,
      sequence: last.data.sequence + 1,
      type: 'tool_result',
      payload: { type: 'tool_result', taskId: task.id, toolCallId: 'send-1', actionHash: hash, sideEffect: 'external', isError: false, outcome: 'confirmed', reconciled: 'applied' },
      at: new Date().toISOString(),
    });

    await assert.rejects(
      service.reconcileOutcome(principal, task.id, { resolution: 'not_applied', actionHash: hash }),
      rejectsWith('invalid_reconciliation', 409),
    );
    assert.equal((await store.get<Task>('task', task.id, principal.id))?.data.state, 'unknown');
    const reconciled = await service.reconcileOutcome(principal, task.id, { resolution: 'applied', actionHash: hash });

    assert.equal(reconciled.data.state, 'queued');
    const events = await payloads(harness, task.id);
    assert.equal(events.filter((event) => event.type === 'tool_result' && event.reconciled !== undefined).length, 1);
    assert.equal(events.at(-1)?.type, 'reconcile');
  } finally { await service.close(); await store.close(); }
});

test('two operators answering differently at the same time record exactly one outcome', async () => {
  const harness = await unknownAgentTask();
  const { store, service, task } = harness;
  try {
    const answers = await Promise.allSettled([
      service.reconcileOutcome(principal, task.id, { resolution: 'applied', actionHash: hash }),
      service.reconcileOutcome(principal, task.id, { resolution: 'not_applied', actionHash: hash }),
    ]);

    const accepted = answers.filter((answer) => answer.status === 'fulfilled');
    const refused = answers.filter((answer) => answer.status === 'rejected');
    assert.equal(accepted.length, 1);
    assert.equal(refused.length, 1);
    assert.ok(refused[0]?.reason instanceof DomainError && refused[0].reason.statusCode === 409);
    const events = await payloads(harness, task.id);
    const recorded = events.filter((event) => event.type === 'tool_result' && event.reconciled !== undefined);
    const audits = events.filter((event) => event.type === 'reconcile');
    assert.equal(recorded.length, 1);
    assert.equal(audits.length, 1);
    assert.equal(audits[0]?.resolution, recorded[0]?.reconciled);
    const stored = (await store.get<Task>('task', task.id, principal.id))!;
    assert.equal(stored.data.state, 'queued');
    const answer = (stored.data.runtimeMessages as Array<{ toolOutcome?: string }>).at(-1);
    assert.equal(answer?.toolOutcome, recorded[0]?.reconciled === 'applied' ? 'confirmed' : 'failed');
    assert.equal(stored.data.runtimeMessages?.length, checkpoint.length + 1);
  } finally { await service.close(); await store.close(); }
});

test('a dependent that already failed is not revived by reconciliation', async () => {
  const harness = await unknownAgentTask();
  const { store, service, task } = harness;
  try {
    const dependent = await service.enqueue(principal, task.data.conversationId, 'after the send', undefined, [], [task.id]);
    await service.drain();
    assert.equal((await store.get<Task>('task', dependent.id, principal.id))?.data.state, 'failed');

    await service.reconcileOutcome(principal, task.id, { resolution: 'applied', actionHash: hash });
    await service.drain();

    assert.equal((await store.get<Task>('task', task.id, principal.id))?.data.state, 'completed');
    assert.equal((await store.get<Task>('task', dependent.id, principal.id))?.data.state, 'failed');
  } finally { await service.close(); await store.close(); }
});

test('a reconciled orchestration task keeps its own scopes and a parent in its children phase waits again', async () => {
  const harness = await unknownAgentTask();
  const { store, service, task } = harness;
  try {
    const stored = await store.put<Task>('task', task.id, principal.id, {
      ...task.data,
      orchestration: {
        rootTaskId: task.id, planId: 'plan-1', depth: 0, role: 'parent', strategy: 'single', budgetId: 'budget-1', phase: 'children', verification: 'pending',
      },
    }, task.revision);
    const before = await payloads(harness, task.id);

    // The task was granted `*`; an actor that no longer covers that cannot put it back to work.
    await assert.rejects(
      service.reconcileOutcome({ ...principal, scopes: ['approval:write', 'task:write'] }, task.id, { resolution: 'applied', actionHash: hash }),
      rejectsWith('grant_revoked', 403),
    );
    assert.deepEqual(await payloads(harness, task.id), before);
    assert.equal((await store.get<Task>('task', task.id, principal.id))?.revision, stored.revision);

    const reconciled = await service.reconcileOutcome(principal, task.id, { resolution: 'applied', actionHash: hash });

    assert.equal(reconciled.data.state, 'waiting_for_children');
    assert.deepEqual(reconciled.data.principal.scopes, ['*']);
  } finally { await service.close(); await store.close(); }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx --test test/task-reconcile.test.ts`

Expected: `pass 5`, `fail 11`. The five tests of Task 3 pass and the eleven new ones fail, all because `applied` / `not_applied` still end in `not_resumable`. Eight report the error directly:

```
Error [DomainError]: This task has no checkpoint to continue from; use abandon
    code: 'not_resumable',
    statusCode: 409,
```

The other three report it through an assertion:

```
✖ reconciliation renews an expired grant from the signed-in actor and rejects an expired session
  AssertionError [ERR_ASSERTION]: The validation function is expected to return "true". Received false
  DomainError: This task has no checkpoint to continue from; use abandon
✖ two operators answering differently at the same time record exactly one outcome
  AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:
  0 !== 1
✖ a reconciled orchestration task keeps its own scopes and a parent in its children phase waits again
  AssertionError [ERR_ASSERTION]: The validation function is expected to return "true". Received false
  DomainError: This task has no checkpoint to continue from; use abandon
```

- [ ] **Step 3: Write minimal implementation**

All edits are in `src/tasks.ts`.

Edit 1 — imports. Replace:

```ts
import { snapshotEnabledPluginVersions } from './plugins.js';
```

with:

```ts
import { snapshotEnabledPluginVersions } from './plugins.js';
import { reconcileToolCall } from './runtime/agent-runtime.js';
import type { ChatMessage } from './runtime/types.js';
```

(`src/runtime/agent-runtime.ts` and `src/runtime/types.ts` do not import `src/tasks.ts`, so this adds no import cycle.)

Edit 2 — let `event` take an explicit store id. Replace:

```ts
  private async event(task: Pick<Entity<Task>, 'id' | 'ownerId'>, event: { type: string; [key: string]: unknown }): Promise<void> {
    const sequence = await this.nextEventSequence(task.ownerId, task.id);
    await this.store.create<TaskEvent>('event', task.ownerId, {
      taskId: task.id,
      sequence,
      type: event.type,
      payload: event,
      at: new Date(this.now()).toISOString(),
    }, `${task.id}:${String(sequence).padStart(12, '0')}`);
  }
```

with:

```ts
  private async event(
    task: Pick<Entity<Task>, 'id' | 'ownerId'>,
    event: { type: string; [key: string]: unknown },
    id?: string,
  ): Promise<void> {
    const sequence = await this.nextEventSequence(task.ownerId, task.id);
    await this.store.create<TaskEvent>('event', task.ownerId, {
      taskId: task.id,
      sequence,
      type: event.type,
      payload: event,
      at: new Date(this.now()).toISOString(),
    }, id ?? `${task.id}:${String(sequence).padStart(12, '0')}`);
  }
```

Edit 3 — the tail of `reconcileOutcome`. Replace:

```ts
    if (!dispatch) {
      throw new DomainError('invalid_input', 'Name the dispatched action with actionHash or toolCallId', 400);
    }
    throw new DomainError('not_resumable', 'This task has no checkpoint to continue from; use abandon', 409);
  }
```

with:

```ts
    if (!dispatch) {
      throw new DomainError('invalid_input', 'Name the dispatched action with actionHash or toolCallId', 400);
    }
    const resolution = input.resolution;
    const next = (current: Task): Task => {
      if (current.state !== 'unknown') {
        throw notReconcilable();
      }
      const stopped = { ...current, workerId: undefined, leaseExpiresAt: undefined, nextAttemptAt: undefined };
      if (current.cancelRequested) {
        // The owner had already asked to stop: the answer is recorded and the cancel is honoured.
        return { ...stopped, state: 'cancelled', error: undefined };
      }
      return resumedFromCheckpoint(
        stopped, dispatch, resolution, input.note, actor, this.now(), this.options.durableGrants === true,
      );
    };
    // Refuse before anything is written; the same function later produces the stored task.
    next(task.data);
    if (!dispatch.resolved) {
      await this.recordReconciliation(task, dispatch, resolution);
    }
    const updated = await this.change(ownerId, id, next);
    await this.event(updated, { type: 'reconcile', state: updated.data.state, ...audit });
    return updated;
  }

  private async recordReconciliation(
    task: Entity<Task>,
    dispatch: SideEffectDispatch,
    resolution: 'applied' | 'not_applied',
  ): Promise<void> {
    try {
      // One closing event per dispatch event: the fixed id makes a second, different answer a conflict.
      await this.event(task, {
        type: 'tool_result',
        taskId: task.id,
        ...(dispatch.toolCallId ? { toolCallId: dispatch.toolCallId } : {}),
        ...(dispatch.actionHash ? { actionHash: dispatch.actionHash } : {}),
        sideEffect: dispatch.sideEffect,
        isError: resolution !== 'applied',
        outcome: resolution === 'applied' ? 'confirmed' : 'failed',
        reconciled: resolution,
      }, `${task.id}:${String(dispatch.sequence).padStart(12, '0')}:reconciled`);
    } catch (error) {
      if (!(error instanceof DomainError && error.code === 'conflict')) {
        throw error;
      }
      const recorded = (await this.sideEffectDispatches(task.ownerId, task.id))
        .find((candidate) => candidate.key === dispatch.key);
      if (recorded?.reconciled !== resolution) {
        throw new DomainError('invalid_reconciliation', 'This action was already reconciled with a different resolution', 409);
      }
    }
  }
```

Edit 4 — the pure task transformation. Insert directly above this existing line:

```ts
function scopeCovered(grants: string[], requested: string): boolean {
```

so that it reads:

```ts
function resumedFromCheckpoint(
  task: Task,
  dispatch: SideEffectDispatch,
  resolution: 'applied' | 'not_applied',
  note: string | undefined,
  actor: Principal,
  now: number,
  durableGrants: boolean,
): Task {
  const messages = dispatch.toolCallId && dispatch.actionHash && Array.isArray(task.runtimeMessages)
    ? reconcileToolCall(task.runtimeMessages as ChatMessage[], {
        toolCallId: dispatch.toolCallId,
        resolution,
        actionHash: dispatch.actionHash,
        ...(note ? { note } : {}),
      })
    : undefined;
  if (!messages) {
    throw new DomainError('not_resumable', 'This task has no checkpoint to continue from; use abandon', 409);
  }
  const principal = resumedPrincipal(task, actor, now, durableGrants);
  return {
    ...task,
    principal,
    state: task.orchestration?.role === 'parent' && task.orchestration.phase === 'children'
      ? 'waiting_for_children'
      : 'queued',
    pauseRequested: false,
    error: undefined,
    grantExpiresAt: renewedGrantExpiry(principal, now),
    runtimeMessages: messages,
    approvedActionHashes: resolution === 'not_applied'
      ? task.approvedActionHashes.filter((approved) => approved !== dispatch.actionHash)
      : task.approvedActionHashes,
  };
}

function scopeCovered(grants: string[], requested: string): boolean {
```

Why the outcome event is written before the task changes: if the process stops between the two writes, the task is still `unknown` with its dispatch closed, and repeating the same call finishes the job. In the other order a requeued task could run with an unresolved dispatch still in its log and be thrown back to `unknown` by any later error.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx tsc --noEmit && npx tsx --test test/task-reconcile.test.ts test/tasks.test.ts`

Expected: no type errors; `test/task-reconcile.test.ts` reports `pass 16`, `fail 0`; `test/tasks.test.ts` stays green.

- [ ] **Step 5: Commit**

```bash
git add src/tasks.ts test/task-reconcile.test.ts
git commit -m "實現：對帳後由檢查點續跑，已派發的動作不會重播"
```

---

### Task 5: `reconcileOutcome` — internal workspace operations and tasks that cannot be resumed

**Files:**
- Modify: `src/tasks.ts` (the function `next` inside `reconcileOutcome` from Task 4; above `resumedFromCheckpoint` from Task 4)
- Test: `test/task-reconcile.test.ts` (two import lines at the top; tests appended)

**Interfaces:**
- Consumes:
  - From Tasks 3 and 4: `reconcileOutcome`, its local function `next`, `SideEffectDispatch`, `resumedFromCheckpoint`; the test helpers `principal`, `conversation`, `hash`, `checkpoint`, `Harness`, `rejectsWith`, `payloads`, `unknownAgentTask`.
  - Existing: `Conversation.internalOperation?: { tool: string; input: Record<string, unknown> }` in `src/domain.ts`, set only by `POST /v1/workspaces/:id/operations`; `createTaskRunner(store, runtime, tools)` in `src/runtime-adapter.ts`, whose internal-operation branch emits `tool_dispatched` with `toolCall.id` equal to the task id (and an `actionHash` only for `workspace.export`) and turns an unmarked throw from an external tool into `outcome_unknown`.
- Produces:
  - `reconcileOutcome` on a task whose conversation has `internalOperation`: `applied` → `state: 'completed'`, `error` cleared, `pendingActions: []`, no `resultArtifactIds`, and `result` set to the JSON text `{"reconciled":"applied","toolCallId":"<task id>","message":"Reconciled by an operator: the operation was applied. Its original output is unavailable.","note":"<note>"}` (`note` only when given); `not_applied` → `state: 'failed'` with `error` `Reconciled by an operator: the operation was not applied.` followed by ` Operator note: <note>` when given. The task is not queued and its tool never runs again. The same two events as in Task 4 are written. The target is `toolCallId` = the task id, or the `actionHash` of an approved `workspace.export`.
  - Pinned (already true after Task 4, and kept by the order of the branches in Step 3): a workspace operation that became `unknown` while a cancel was pending ends `cancelled` with no `result` and no `error` after either answer; the outcome event is still recorded and the tool never runs again.
  - Pinned (already true after Task 4): an agent task whose checkpoint is missing, empty or no longer has the call pending, or whose dispatch event carries no tool call, refuses `applied` / `not_applied` with `not_resumable` (409) and writes nothing; `abandon` still works.
  - Module-level in `src/tasks.ts`: `closedOperation(task: Task, dispatch: SideEffectDispatch, resolution: 'applied' | 'not_applied', note: string | undefined): Task`.
  - Test helper used by Task 6: `unknownOperation(toolName: 'terminal.run' | 'workspace.export', options: TaskServiceOptions = {}): Promise<Harness & { executions: () => number }>`.

The shape of the synthetic result is explained under "Client Compatibility" at the top of this plan.

- [ ] **Step 1: Write the failing test**

At the top of `test/task-reconcile.test.ts` replace:

```ts
import { DomainError, type Principal } from '../src/contracts.js';
import type { Conversation, Task, TaskEvent, TaskState } from '../src/domain.js';
```

with:

```ts
import { DomainError, type Principal, type ToolDefinition } from '../src/contracts.js';
import type { Conversation, Task, TaskEvent, TaskState } from '../src/domain.js';
import { createTaskRunner } from '../src/runtime-adapter.js';
```

Then append to the same file:

```ts

// A workspace operation (no model loop) whose tool was dispatched and stopped without a confirmed result.
async function unknownOperation(
  toolName: 'terminal.run' | 'workspace.export',
  options: TaskServiceOptions = {},
): Promise<Harness & { executions: () => number }> {
  const store = new SqliteStore();
  let executions = 0;
  const tool: ToolDefinition = {
    name: toolName,
    description: 'Operation',
    inputSchema: { type: 'object' },
    requiredCapabilities: [],
    requiresWorkspace: true,
    sideEffect: 'external',
    async execute() {
      executions += 1;
      throw new Error('connection lost');
    },
  };
  const runner = createTaskRunner(store, { run: async () => { throw new Error('model must not run'); } }, [tool]);
  const service = new TaskService(store, runner, { reauthorize: async (current) => current, ...options });
  const workspace = await store.create('workspace', principal.id, {
    name: 'Project', root: '/project', deviceId: 'server', capabilities: [], allowCloud: false,
  });
  const thread = await store.create<Conversation>('conversation', principal.id, {
    ...conversation,
    title: toolName,
    modelPolicy: 'local',
    workspaceId: workspace.id,
    internalOperation: { tool: toolName, input: { path: 'report.txt' } },
  });
  const queued = await service.enqueue(principal, thread.id, toolName);
  await service.drain();
  const waiting = (await store.get<Task>('task', queued.id, principal.id))!;
  if (waiting.data.state === 'waiting_for_approval') {
    await service.control(principal.id, queued.id, 'resume', waiting.data.pendingActions.map((action) => action.hash), principal);
    await service.drain();
  }
  const task = (await store.get<Task>('task', queued.id, principal.id))!;
  assert.equal(task.data.state, 'unknown');
  assert.equal(executions, 1);
  return { store, service, task, resumed: [], executions: () => executions };
}

test('an internal workspace operation reconciled as applied completes with a JSON result and never runs again', async () => {
  const harness = await unknownOperation('terminal.run');
  const { store, service, task, executions } = harness;
  try {
    const before = await payloads(harness, task.id);

    const reconciled = await service.reconcileOutcome(principal, task.id, {
      resolution: 'applied', toolCallId: task.id, note: 'The command finished; checked the log',
    });

    assert.equal(reconciled.data.state, 'completed');
    assert.equal(reconciled.data.error, undefined);
    assert.equal(reconciled.data.resultArtifactIds, undefined);
    assert.equal(reconciled.data.runtimeMessages, undefined);
    assert.deepEqual(JSON.parse(reconciled.data.result ?? ''), {
      reconciled: 'applied',
      toolCallId: task.id,
      message: 'Reconciled by an operator: the operation was applied. Its original output is unavailable.',
      note: 'The command finished; checked the log',
    });
    assert.deepEqual((await payloads(harness, task.id)).slice(before.length), [
      { type: 'tool_result', taskId: task.id, toolCallId: task.id, sideEffect: 'external', isError: false, outcome: 'confirmed', reconciled: 'applied' },
      {
        type: 'reconcile', state: 'completed', resolution: 'applied', toolCallId: task.id, toolName: 'terminal.run',
        note: 'The command finished; checked the log', actor: { id: 'alice', level: 1 },
      },
    ]);

    await service.drain();

    assert.equal(executions(), 1);
    assert.equal((await store.get<Task>('task', task.id, principal.id))?.data.state, 'completed');
  } finally { await service.close(); await store.close(); }
});

test('an internal workspace operation reconciled as not applied fails without running again', async () => {
  const harness = await unknownOperation('terminal.run');
  const { store, service, task, executions } = harness;
  try {
    const reconciled = await service.reconcileOutcome(principal, task.id, { resolution: 'not_applied', toolCallId: task.id, note: 'No process was started' });

    assert.equal(reconciled.data.state, 'failed');
    assert.equal(reconciled.data.error, 'Reconciled by an operator: the operation was not applied. Operator note: No process was started');
    assert.equal(reconciled.data.result, undefined);
    assert.deepEqual((await payloads(harness, task.id)).slice(-2).map((event) => [event.type, event.outcome ?? event.state]), [
      ['tool_result', 'failed'],
      ['reconcile', 'failed'],
    ]);
    await service.drain();
    assert.equal(executions(), 1);
    assert.equal((await store.get<Task>('task', task.id, principal.id))?.data.state, 'failed');
  } finally { await service.close(); await store.close(); }
});

test('an approved export operation can be named by its action hash', async () => {
  const harness = await unknownOperation('workspace.export');
  const { store, service, task, executions } = harness;
  try {
    const exportHash = task.data.approvedActionHashes[0]!;
    assert.match(exportHash, /^[a-f0-9]{64}$/);

    const reconciled = await service.reconcileOutcome(principal, task.id, { resolution: 'applied', actionHash: exportHash });

    assert.equal(reconciled.data.state, 'completed');
    assert.deepEqual(reconciled.data.pendingActions, []);
    assert.equal(reconciled.data.resultArtifactIds, undefined);
    assert.deepEqual(JSON.parse(reconciled.data.result ?? ''), {
      reconciled: 'applied',
      toolCallId: task.id,
      message: 'Reconciled by an operator: the operation was applied. Its original output is unavailable.',
    });
    await service.drain();
    assert.equal(executions(), 1);
  } finally { await service.close(); await store.close(); }
});

test('a workspace operation with a pending cancel ends cancelled whatever the answer', async () => {
  for (const resolution of ['applied', 'not_applied'] as const) {
    const harness = await unknownOperation('terminal.run');
    const { store, service, task, executions } = harness;
    try {
      // What `control(…, 'cancel')` leaves behind when the operation's tool is still in flight.
      await store.put<Task>('task', task.id, principal.id, { ...task.data, cancelRequested: true }, task.revision);

      const reconciled = await service.reconcileOutcome(principal, task.id, { resolution, toolCallId: task.id });

      assert.equal(reconciled.data.state, 'cancelled', resolution);
      assert.equal(reconciled.data.result, undefined, resolution);
      assert.equal(reconciled.data.error, undefined, resolution);
      assert.deepEqual((await payloads(harness, task.id)).slice(-2).map((event) => [event.type, event.outcome ?? event.state]), [
        ['tool_result', resolution === 'applied' ? 'confirmed' : 'failed'],
        ['reconcile', 'cancelled'],
      ]);
      await service.drain();
      assert.equal(executions(), 1);
      assert.equal((await store.get<Task>('task', task.id, principal.id))?.data.state, 'cancelled', resolution);
    } finally { await service.close(); await store.close(); }
  }
});

test('an agent task without a matching checkpoint cannot be resumed but can be abandoned', async () => {
  const answered = [...checkpoint, { role: 'tool', content: 'sent', name: 'send', toolCallId: 'send-1' }];
  for (const runtimeMessages of [undefined, [], answered]) {
    const harness = await unknownAgentTask();
    const { store, service, task } = harness;
    try {
      const stored = await store.put<Task>('task', task.id, principal.id, { ...task.data, runtimeMessages }, task.revision);
      const before = await payloads(harness, task.id);
      for (const resolution of ['applied', 'not_applied'] as const) {
        await assert.rejects(
          service.reconcileOutcome(principal, task.id, { resolution, actionHash: hash }),
          rejectsWith('not_resumable', 409),
        );
      }
      assert.deepEqual(await payloads(harness, task.id), before);
      assert.equal((await store.get<Task>('task', task.id, principal.id))?.revision, stored.revision);

      const abandoned = await service.reconcileOutcome(principal, task.id, { resolution: 'abandon', actionHash: hash });
      assert.equal(abandoned.data.state, 'cancelled');
    } finally { await service.close(); await store.close(); }
  }
});

test('a dispatch event that does not name its tool call cannot be resumed', async () => {
  const store = new SqliteStore();
  const now = Date.parse('2026-10-01T00:00:00.000Z');
  const service = new TaskService(store, async () => ({ text: 'unused' }), { now: () => now, reauthorize: async (current) => current });
  try {
    const thread = await store.create('conversation', principal.id, conversation);
    const task = await service.enqueue(principal, thread.id, 'send hello');
    await store.put<Task>('task', task.id, task.ownerId, {
      ...task.data,
      state: 'running',
      workerId: 'dead-worker',
      leaseExpiresAt: new Date(now - 1_000).toISOString(),
      runtimeMessages: checkpoint,
      approvedActionHashes: [hash],
    }, task.revision);
    await store.create('event', principal.id, {
      taskId: task.id,
      sequence: 2,
      type: 'tool_dispatched',
      payload: { type: 'tool_dispatched', actionHash: hash, sideEffect: 'external' },
      at: new Date(now - 2_000).toISOString(),
    });
    await service.drain();
    assert.equal((await store.get<Task>('task', task.id, principal.id))?.data.state, 'unknown');

    await assert.rejects(
      service.reconcileOutcome(principal, task.id, { resolution: 'applied', actionHash: hash }),
      rejectsWith('not_resumable', 409),
    );
    assert.equal((await service.reconcileOutcome(principal, task.id, { resolution: 'abandon' })).data.state, 'cancelled');
  } finally { await service.close(); await store.close(); }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx --test test/task-reconcile.test.ts`

Expected: three failures, each with `Error [DomainError]: This task has no checkpoint to continue from; use abandon` (`code: 'not_resumable'`):

```
✖ an internal workspace operation reconciled as applied completes with a JSON result and never runs again
✖ an internal workspace operation reconciled as not applied fails without running again
✖ an approved export operation can be named by its action hash
```

The other three new tests pass already. `an agent task without a matching checkpoint cannot be resumed but can be abandoned` and `a dispatch event that does not name its tool call cannot be resumed` pin the refusal that Task 4 implemented so that this task's new branch cannot swallow it. `a workspace operation with a pending cancel ends cancelled whatever the answer` pins the order of the two branches in Step 3: the pending-cancel branch from Task 4 must stay above the new operation branch (with the two swapped, this test fails: actual `'completed'`, expected `'cancelled'`).

- [ ] **Step 3: Write minimal implementation**

Both edits are in `src/tasks.ts`.

Edit 1 — inside `reconcileOutcome`. Replace:

```ts
    const resolution = input.resolution;
    const next = (current: Task): Task => {
      if (current.state !== 'unknown') {
        throw notReconcilable();
      }
      const stopped = { ...current, workerId: undefined, leaseExpiresAt: undefined, nextAttemptAt: undefined };
      if (current.cancelRequested) {
        // The owner had already asked to stop: the answer is recorded and the cancel is honoured.
        return { ...stopped, state: 'cancelled', error: undefined };
      }
      return resumedFromCheckpoint(
```

with:

```ts
    const resolution = input.resolution;
    const conversation = await this.store.get<Conversation>('conversation', task.data.conversationId, ownerId);
    if (!conversation) {
      throw new DomainError('not_found', 'Conversation not found', 404);
    }
    const internalOperation = conversation.data.internalOperation !== undefined;
    const next = (current: Task): Task => {
      if (current.state !== 'unknown') {
        throw notReconcilable();
      }
      const stopped = { ...current, workerId: undefined, leaseExpiresAt: undefined, nextAttemptAt: undefined };
      if (current.cancelRequested) {
        // The owner had already asked to stop: the answer is recorded and the cancel is honoured.
        return { ...stopped, state: 'cancelled', error: undefined };
      }
      if (internalOperation) {
        // No model loop to resume and the tool must never run again: close the task in place.
        return closedOperation(stopped, dispatch, resolution, input.note);
      }
      return resumedFromCheckpoint(
```

Edit 2 — insert directly above this existing line:

```ts
function resumedFromCheckpoint(
```

so that it reads:

```ts
function closedOperation(
  task: Task,
  dispatch: SideEffectDispatch,
  resolution: 'applied' | 'not_applied',
  note: string | undefined,
): Task {
  if (resolution === 'not_applied') {
    return {
      ...task,
      state: 'failed',
      error: `Reconciled by an operator: the operation was not applied.${note ? ` Operator note: ${note}` : ''}`,
      pendingActions: [],
    };
  }
  return {
    ...task,
    state: 'completed',
    // A JSON object in a string, like every real operation result; clients parse it leniently.
    result: JSON.stringify({
      reconciled: 'applied',
      ...(dispatch.toolCallId ? { toolCallId: dispatch.toolCallId } : {}),
      message: 'Reconciled by an operator: the operation was applied. Its original output is unavailable.',
      ...(note ? { note } : {}),
    }),
    error: undefined,
    pendingActions: [],
    resultArtifactIds: undefined,
  };
}

function resumedFromCheckpoint(
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx tsc --noEmit && npx tsx --test test/task-reconcile.test.ts test/workspace-export.test.ts`

Expected: no type errors; `test/task-reconcile.test.ts` reports `pass 22`, `fail 0`; `test/workspace-export.test.ts` stays green.

- [ ] **Step 5: Commit**

```bash
git add src/tasks.ts test/task-reconcile.test.ts
git commit -m "實現：內部工作區操作對帳後直接結案，不再重跑工具"
```

---

### Task 6: `reconcileOutcome` releases the task's workspace write lease

**Files:**
- Modify: `src/tasks.ts` (imports; inside `reconcileOutcome`, between the validation call `next(task.data)` and the recording of the outcome, both from Task 4)
- Test: `test/task-reconcile.test.ts` (one import line at the top; tests appended)

**Interfaces:**
- Consumes:
  - From Task 2: `WorkspaceWriteLeaseService.releaseForTask(ownerId: string, workspaceId: string, taskId: string, note: string): Promise<boolean>` (throws `workspace_busy`, 409, while the task's writer is still active) and the existing constructor `new WorkspaceWriteLeaseService(store: Store, now?: () => number, durationMs?: number)`, plus `get`, `acquire`, `reconcile`, `wrap`.
  - From Tasks 4 and 5: the locals `next`, `resolution` and `conversation` inside `reconcileOutcome`; the test helpers `unknownOperation(toolName, options?)`, `payloads`, `rejectsWith`, `principal`.
  - Existing: `Task.workspaceId?: string` and `Conversation.workspaceId?: string` in `src/domain.ts`.
- Produces: for `applied` and `not_applied`, after validation and before any event or task change, the lease of the task's workspace (`task.workspaceId`, or the conversation's `workspaceId` for tasks stored without one) is released when this task holds it in state `unknown` or expired `active`, with the verification note `Task <id> reconciled as <resolution>` followed by `: <operator note>` when a note was given. A lease held by another task, or no lease, is left alone. While the task's own writer is still `active` and unexpired the call fails with `workspace_busy` (409) and nothing is written. `abandon` never touches the lease: the workspace stays write-blocked until `POST /v1/workspaces/:id/write-lease/reconcile` is used.

`src/workspace-write-lease.ts` imports only `src/contracts.ts` and the store types, so importing it from `src/tasks.ts` adds no cycle. The service is stateless, so it is constructed at the point of use, as the HTTP routes already do.

- [ ] **Step 1: Write the failing test**

At the top of `test/task-reconcile.test.ts` replace:

```ts
import { TaskService, type TaskRunner, type TaskServiceOptions } from '../src/tasks.js';
```

with:

```ts
import { TaskService, type TaskRunner, type TaskServiceOptions } from '../src/tasks.js';
import { WorkspaceWriteLeaseService } from '../src/workspace-write-lease.js';
```

Then append to the same file:

```ts

function leaseContext(workspaceId: string, taskId: string): Parameters<ToolDefinition['execute']>[1] {
  return {
    principal,
    taskId,
    signal: new AbortController().signal,
    workspace: { id: workspaceId, ownerId: principal.id, name: 'Project', root: '/project', deviceId: 'server', capabilities: [], allowCloud: false },
  };
}

// Leaves the workspace write lease in state `unknown`, held by `taskId`, the way a lost tool result does.
async function leaveLeaseUnknown(leases: WorkspaceWriteLeaseService, workspaceId: string, taskId: string): Promise<void> {
  const lost: ToolDefinition = {
    name: 'terminal.run', description: 'Run', inputSchema: {}, requiredCapabilities: [], requiresWorkspace: true, sideEffect: 'external',
    async execute() { throw new DomainError('outcome_unknown', 'No receipt', 409); },
  };
  await assert.rejects(leases.wrap(lost).execute({}, leaseContext(workspaceId, taskId)), /No receipt/);
  assert.equal((await leases.get(principal.id, workspaceId))?.data.state, 'unknown');
}

test('reconciliation releases the workspace write lease held by the task', async () => {
  for (const resolution of ['applied', 'not_applied'] as const) {
    const harness = await unknownOperation('terminal.run');
    const { store, service, task } = harness;
    try {
      const workspaceId = task.data.workspaceId!;
      const leases = new WorkspaceWriteLeaseService(store);
      await leaveLeaseUnknown(leases, workspaceId, task.id);
      if (resolution === 'not_applied') {
        // A task stored before `workspaceId` existed on tasks: the conversation names the workspace.
        const { workspaceId: _legacy, ...legacy } = task.data;
        await store.put<Task>('task', task.id, principal.id, legacy, task.revision);
      }

      await service.reconcileOutcome(principal, task.id, { resolution, toolCallId: task.id, note: 'Checked the terminal' });

      const lease = (await leases.get(principal.id, workspaceId))!;
      assert.equal(lease.data.state, 'released');
      assert.equal(lease.data.verification?.note, `Task ${task.id} reconciled as ${resolution}: Checked the terminal`);
      assert.equal((await leases.acquire(leaseContext(workspaceId, 'next-task'))).epoch, lease.data.epoch + 1);
    } finally { await service.close(); await store.close(); }
  }
});

test('reconciliation leaves a lease held by another task alone', async () => {
  const harness = await unknownOperation('terminal.run');
  const { store, service, task } = harness;
  try {
    const workspaceId = task.data.workspaceId!;
    const leases = new WorkspaceWriteLeaseService(store);
    await leaveLeaseUnknown(leases, workspaceId, 'another-task');
    const before = (await leases.get(principal.id, workspaceId))!;

    const reconciled = await service.reconcileOutcome(principal, task.id, { resolution: 'applied', toolCallId: task.id });

    assert.equal(reconciled.data.state, 'completed');
    assert.deepEqual(await leases.get(principal.id, workspaceId), before);
  } finally { await service.close(); await store.close(); }
});

test('reconciliation waits for an active writer and changes nothing until it has stopped', async () => {
  const clock = { now: Date.parse('2026-10-01T00:00:00.000Z') };
  const harness = await unknownOperation('terminal.run', { now: () => clock.now });
  const { store, service, task } = harness;
  try {
    const workspaceId = task.data.workspaceId!;
    const leases = new WorkspaceWriteLeaseService(store, () => clock.now, 30_000);
    await leases.acquire(leaseContext(workspaceId, task.id));
    const before = await payloads(harness, task.id);

    for (const resolution of ['applied', 'not_applied'] as const) {
      await assert.rejects(
        service.reconcileOutcome(principal, task.id, { resolution, toolCallId: task.id }),
        rejectsWith('workspace_busy', 409),
      );
    }
    assert.deepEqual(await payloads(harness, task.id), before);
    assert.equal((await store.get<Task>('task', task.id, principal.id))?.revision, task.revision);
    assert.equal((await leases.get(principal.id, workspaceId))?.data.state, 'active');

    clock.now += 30_001;
    const reconciled = await service.reconcileOutcome(principal, task.id, { resolution: 'not_applied', toolCallId: task.id });

    assert.equal(reconciled.data.state, 'failed');
    assert.equal((await leases.get(principal.id, workspaceId))?.data.state, 'released');
  } finally { await service.close(); await store.close(); }
});

test('abandon leaves the workspace write lease for the lease endpoint', async () => {
  const harness = await unknownOperation('terminal.run');
  const { store, service, task } = harness;
  try {
    const workspaceId = task.data.workspaceId!;
    const leases = new WorkspaceWriteLeaseService(store);
    await leaveLeaseUnknown(leases, workspaceId, task.id);

    const abandoned = await service.reconcileOutcome(principal, task.id, { resolution: 'abandon' });

    assert.equal(abandoned.data.state, 'cancelled');
    const lease = (await leases.get(principal.id, workspaceId))!;
    assert.equal(lease.data.state, 'unknown');
    await assert.rejects(leases.acquire(leaseContext(workspaceId, 'next-task')), /must be verified/);
    await leases.reconcile(principal.id, workspaceId, lease.revision, 'Checked the workspace by hand');
    assert.equal((await leases.acquire(leaseContext(workspaceId, 'next-task'))).epoch, lease.data.epoch + 1);
  } finally { await service.close(); await store.close(); }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx --test test/task-reconcile.test.ts`

Expected: two failures.

```
✖ reconciliation releases the workspace write lease held by the task
  AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:
  + 'unknown'
  - 'released'
✖ reconciliation waits for an active writer and changes nothing until it has stopped
  AssertionError [ERR_ASSERTION]: Missing expected rejection.
```

`reconciliation leaves a lease held by another task alone` and `abandon leaves the workspace write lease for the lease endpoint` pass already; they guard the two cases in which the lease must not change.

- [ ] **Step 3: Write minimal implementation**

Both edits are in `src/tasks.ts`.

Edit 1 — imports. Replace:

```ts
import type { ChatMessage } from './runtime/types.js';
```

with:

```ts
import type { ChatMessage } from './runtime/types.js';
import { WorkspaceWriteLeaseService } from './workspace-write-lease.js';
```

Edit 2 — inside `reconcileOutcome`. Replace:

```ts
    // Refuse before anything is written; the same function later produces the stored task.
    next(task.data);
    if (!dispatch.resolved) {
```

with:

```ts
    // Refuse before anything is written; the same function later produces the stored task.
    next(task.data);
    const workspaceId = task.data.workspaceId ?? conversation.data.workspaceId;
    if (workspaceId) {
      // The operator has stated the outcome, so the stopped writer no longer blocks the workspace.
      // Rejects with workspace_busy while this task's writer is still active; nothing is written then.
      await new WorkspaceWriteLeaseService(this.store, () => this.now()).releaseForTask(
        ownerId, workspaceId, id, `Task ${id} reconciled as ${resolution}${input.note ? `: ${input.note}` : ''}`,
      );
    }
    if (!dispatch.resolved) {
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx tsc --noEmit && npx tsx --test test/task-reconcile.test.ts test/workspace-write-lease.test.ts`

Expected: no type errors; `test/task-reconcile.test.ts` reports `pass 26`, `fail 0`; `test/workspace-write-lease.test.ts` stays green.

- [ ] **Step 5: Commit**

```bash
git add src/tasks.ts test/task-reconcile.test.ts
git commit -m "實現：任務對帳時釋放其工作區寫入租約，放棄則保留"
```

---

### Task 7: `reconcileOutcome` restores a parent that was waiting on the reconciled child

**Files:**
- Modify: `src/tasks.ts` (the last lines of `reconcileOutcome` from Task 4; a new private method directly after it)
- Test: `test/task-reconcile.test.ts` (one import line at the top; tests appended)

**Interfaces:**
- Consumes:
  - From Tasks 3 and 4: `reconcileOutcome`, its locals `updated` and `resolution`, private `TaskService.change`, `TaskService.event`, `TaskService.hasUnresolvedSideEffect`; the test helpers `principal`, `conversation`, `hash`, `checkpoint`.
  - Existing: `TaskOrchestration` in `src/domain.ts` (`parentTaskId?`, `planId`, `role: 'parent' | 'child'`, `phase: 'children' | 'integration'`); entity kind `agent_plan` with `OrchestrationPlan.childIds: string[]` (`src/agents/coordinator.ts`); `AgentCoordinator.prepare(ownerId, parentTaskId, { key, children: [{ key, prompt }], budget? })`; `reconcileAgentTasks(store, coordinator)` in `src/runtime-adapter.ts`, which moves a `waiting_for_children` parent to `unknown` when a child is `unknown` and afterwards skips parents that are `failed`, `cancelled` or `unknown`.
- Produces: after a child was moved to `queued` or `waiting_for_children` by `applied` / `not_applied`, each ancestor reached through `orchestration.parentTaskId` that (a) is `unknown`, (b) has `role: 'parent'` and `phase: 'children'`, (c) lists the task below it in the `childIds` of its current plan, and (d) has no unresolved dispatch of its own, is set to `waiting_for_children` with `error` cleared and receives one event `{ type: 'reconcile', state: 'waiting_for_children', resolution, childTaskId }`. The walk stops at the first ancestor that does not qualify. Nothing is restored when the child ends `cancelled` (abandon, or a pending cancel). Dependents that already failed with `dependency_failed` are not touched (pinned in Task 4). The ancestors' principal and grant are not renewed: a parent whose grant lapsed while it waited pauses with `grant_expired` when it is queued for integration, exactly as today.

Why the plan's `childIds` and not a comparison of `planId` fields: a task that is both a child and a parent stores the id of its own child plan in `orchestration.planId`, so the two fields differ on the second hop.

- [ ] **Step 1: Write the failing test**

At the top of `test/task-reconcile.test.ts` replace:

```ts
import { createTaskRunner } from '../src/runtime-adapter.js';
```

with:

```ts
import { AgentCoordinator, type OrchestrationPlan } from '../src/agents/coordinator.js';
import { createTaskRunner, reconcileAgentTasks } from '../src/runtime-adapter.js';
```

Then append to the same file:

```ts

interface Delegation {
  store: SqliteStore;
  service: TaskService;
  coordinator: AgentCoordinator;
  parentId: string;
  childId: string;
  planId: string;
  childRuns: () => number;
}

// A parent waiting for one child whose approved external call `send-1` was dispatched and never
// confirmed. After `reconcileAgentTasks` both the child and the parent are `unknown`.
async function delegatedUnknownChild(): Promise<Delegation> {
  const store = new SqliteStore();
  const coordinator = new AgentCoordinator(store);
  let childRuns = 0;
  const service = new TaskService(store, async ({ task, onEvent }) => {
    if (task.data.orchestration?.role !== 'child') return { text: 'integrated' };
    childRuns += 1;
    if (childRuns > 1) return { text: 'child finished' };
    await onEvent({ type: 'tool_result', taskId: task.id, toolCallId: 'look-1', outcome: 'confirmed', isError: false, sideEffect: 'read', checkpointMessages: checkpoint });
    await onEvent({
      type: 'tool_dispatched', taskId: task.id, actionHash: hash, sideEffect: 'external',
      toolCall: { id: 'send-1', name: 'send', arguments: { message: 'hello' }, actionHash: hash },
    });
    await onEvent({ type: 'tool_result', taskId: task.id, toolCallId: 'send-1', actionHash: hash, sideEffect: 'external', outcome: 'unknown', isError: true });
    throw new DomainError('outcome_unknown', 'Dispatch result was not confirmed', 409);
  }, { reauthorize: async (current) => current });
  const thread = await store.create('conversation', principal.id, conversation);
  const parent = await service.enqueue(principal, thread.id, 'Delegate the send');
  const plan = await coordinator.prepare(principal.id, parent.id, {
    key: 'send-plan',
    children: [{ key: 'worker', prompt: 'Send hello once' }],
    budget: { maxCalls: 4, maxTokens: 1_000 },
  });
  await service.drain();
  await reconcileAgentTasks(store, coordinator);
  const childId = plan.data.childIds[0]!;
  assert.equal((await store.get<Task>('task', childId, principal.id))?.data.state, 'unknown');
  assert.equal((await store.get<Task>('task', parent.id, principal.id))?.data.state, 'unknown');
  return { store, service, coordinator, parentId: parent.id, childId, planId: plan.id, childRuns: () => childRuns };
}

test('reconciling a child restores the parent that was waiting for it', async () => {
  const { store, service, coordinator, parentId, childId, planId, childRuns } = await delegatedUnknownChild();
  try {
    const child = await service.reconcileOutcome(principal, childId, { resolution: 'applied', toolCallId: 'send-1' });

    assert.equal(child.data.state, 'queued');
    const waiting = (await store.get<Task>('task', parentId, principal.id))!;
    assert.equal(waiting.data.state, 'waiting_for_children');
    assert.equal(waiting.data.error, undefined);
    assert.deepEqual((await service.events(principal.id, parentId)).at(-1)?.data.payload, {
      type: 'reconcile', state: 'waiting_for_children', resolution: 'applied', childTaskId: childId,
    });

    await reconcileAgentTasks(store, coordinator);
    assert.equal((await store.get<Task>('task', parentId, principal.id))?.data.state, 'waiting_for_children');
    await service.drain();
    assert.equal(childRuns(), 2);
    assert.equal((await store.get<Task>('task', childId, principal.id))?.data.state, 'completed');
    await reconcileAgentTasks(store, coordinator);
    assert.equal((await store.get<Task>('task', parentId, principal.id))?.data.state, 'queued');
    assert.equal((await store.get<OrchestrationPlan>('agent_plan', planId, principal.id))?.data.state, 'integrating');
  } finally { await service.close(); await store.close(); }
});

test('abandoning a child or honouring its pending cancel leaves the parent unknown', async () => {
  for (const ending of ['abandon', 'cancel'] as const) {
    const { store, service, coordinator, parentId, childId, childRuns } = await delegatedUnknownChild();
    try {
      if (ending === 'cancel') {
        const child = (await store.get<Task>('task', childId, principal.id))!;
        await store.put<Task>('task', childId, principal.id, { ...child.data, cancelRequested: true }, child.revision);
      }

      const stopped = await service.reconcileOutcome(principal, childId, ending === 'abandon'
        ? { resolution: 'abandon' }
        : { resolution: 'applied', toolCallId: 'send-1' });

      assert.equal(stopped.data.state, 'cancelled', ending);
      const parent = (await store.get<Task>('task', parentId, principal.id))!;
      assert.equal(parent.data.state, 'unknown', ending);
      assert.match(parent.data.error ?? '', /Delegated work requires attention/);
      await service.drain();
      await reconcileAgentTasks(store, coordinator);
      assert.equal(childRuns(), 1);
      assert.equal((await store.get<Task>('task', parentId, principal.id))?.data.state, 'unknown', ending);
    } finally { await service.close(); await store.close(); }
  }
});

test('every ancestor waiting on the reconciled child is restored', async () => {
  const store = new SqliteStore();
  const coordinator = new AgentCoordinator(store);
  let leafId = '';
  const service = new TaskService(store, async ({ task, onEvent }) => {
    if (task.id !== leafId) return { text: 'not the leaf' };
    await onEvent({ type: 'tool_result', taskId: task.id, toolCallId: 'look-1', outcome: 'confirmed', isError: false, sideEffect: 'read', checkpointMessages: checkpoint });
    await onEvent({
      type: 'tool_dispatched', taskId: task.id, actionHash: hash, sideEffect: 'external',
      toolCall: { id: 'send-1', name: 'send', arguments: { message: 'hello' }, actionHash: hash },
    });
    throw new DomainError('outcome_unknown', 'Dispatch result was not confirmed', 409);
  }, { reauthorize: async (current) => current });
  try {
    const thread = await store.create('conversation', principal.id, conversation);
    const root = await service.enqueue(principal, thread.id, 'Delegate twice');
    const outer = await coordinator.prepare(principal.id, root.id, {
      key: 'outer', children: [{ key: 'middle', prompt: 'Delegate again' }], budget: { maxCalls: 4, maxTokens: 1_000 },
    });
    const middleId = outer.data.childIds[0]!;
    const inner = await coordinator.prepare(principal.id, middleId, { key: 'inner', children: [{ key: 'leaf', prompt: 'Send hello once' }] });
    leafId = inner.data.childIds[0]!;
    await service.drain();
    await reconcileAgentTasks(store, coordinator);
    await reconcileAgentTasks(store, coordinator);
    for (const id of [leafId, middleId, root.id]) {
      assert.equal((await store.get<Task>('task', id, principal.id))?.data.state, 'unknown', id);
    }

    const leaf = await service.reconcileOutcome(principal, leafId, { resolution: 'not_applied', actionHash: hash });

    assert.equal(leaf.data.state, 'queued');
    assert.equal((await store.get<Task>('task', middleId, principal.id))?.data.state, 'waiting_for_children');
    assert.equal((await store.get<Task>('task', root.id, principal.id))?.data.state, 'waiting_for_children');
    assert.deepEqual((await service.events(principal.id, middleId)).at(-1)?.data.payload, {
      type: 'reconcile', state: 'waiting_for_children', resolution: 'not_applied', childTaskId: leafId,
    });
    assert.deepEqual((await service.events(principal.id, root.id)).at(-1)?.data.payload, {
      type: 'reconcile', state: 'waiting_for_children', resolution: 'not_applied', childTaskId: middleId,
    });
  } finally { await service.close(); await store.close(); }
});

test('a parent that stopped for its own reasons is not restored by its child', async () => {
  for (const reason of ['own dispatch', 'cancelled', 'another plan'] as const) {
    const { store, service, parentId, childId } = await delegatedUnknownChild();
    try {
      const parent = (await store.get<Task>('task', parentId, principal.id))!;
      if (reason === 'own dispatch') {
        const last = (await service.events(principal.id, parentId)).at(-1)!;
        await store.create('event', principal.id, {
          taskId: parentId,
          sequence: last.data.sequence + 1,
          type: 'tool_dispatched',
          payload: { type: 'tool_dispatched', actionHash: 'd'.repeat(64), sideEffect: 'write', toolCall: { id: 'write-1', name: 'workspace.write', arguments: {} } },
          at: new Date().toISOString(),
        });
      }
      if (reason === 'cancelled') {
        await store.put<Task>('task', parentId, principal.id, { ...parent.data, state: 'cancelled' }, parent.revision);
      }
      if (reason === 'another plan') {
        await store.put<Task>('task', parentId, principal.id, {
          ...parent.data, orchestration: { ...parent.data.orchestration!, planId: 'a-later-plan' },
        }, parent.revision);
      }
      const expected = (await store.get<Task>('task', parentId, principal.id))!;

      const child = await service.reconcileOutcome(principal, childId, { resolution: 'applied', toolCallId: 'send-1' });

      assert.equal(child.data.state, 'queued', reason);
      assert.deepEqual(await store.get<Task>('task', parentId, principal.id), expected, reason);
    } finally { await service.close(); await store.close(); }
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx --test test/task-reconcile.test.ts`

Expected: two failures, both

```
✖ reconciling a child restores the parent that was waiting for it
✖ every ancestor waiting on the reconciled child is restored
  AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:
  + 'unknown'
  - 'waiting_for_children'
```

`abandoning a child or honouring its pending cancel leaves the parent unknown` and `a parent that stopped for its own reasons is not restored by its child` pass already; they pin the cases in which the parent must not change.

- [ ] **Step 3: Write minimal implementation**

In `src/tasks.ts`, at the end of `reconcileOutcome`, replace:

```ts
    const updated = await this.change(ownerId, id, next);
    await this.event(updated, { type: 'reconcile', state: updated.data.state, ...audit });
    return updated;
  }
```

with:

```ts
    const updated = await this.change(ownerId, id, next);
    if (updated.data.state === 'queued' || updated.data.state === 'waiting_for_children') {
      await this.restoreWaitingParents(updated, resolution);
    }
    await this.event(updated, { type: 'reconcile', state: updated.data.state, ...audit });
    return updated;
  }

  /**
   * A parent becomes `unknown` only because one of its children did. Once that child runs again the
   * parent goes back to waiting, and the usual child reconciliation integrates or fails it later.
   * A parent that has an unresolved dispatch of its own, or that already stopped, is left alone.
   */
  private async restoreWaitingParents(child: Entity<Task>, resolution: 'applied' | 'not_applied'): Promise<void> {
    const waitsForChildren = (task: Task): boolean => task.state === 'unknown'
      && task.orchestration?.role === 'parent' && task.orchestration.phase === 'children';
    let current = child;
    while (current.data.orchestration?.parentTaskId) {
      const ownerId = current.ownerId;
      const parent = await this.store.get<Task>('task', current.data.orchestration.parentTaskId, ownerId);
      if (!parent?.data.orchestration || !waitsForChildren(parent.data)) {
        return;
      }
      const plan = await this.store.get<{ childIds: string[] }>('agent_plan', parent.data.orchestration.planId, ownerId);
      if (!plan?.data.childIds.includes(current.id) || await this.hasUnresolvedSideEffect(ownerId, parent.id)) {
        return;
      }
      const restored = await this.change(ownerId, parent.id, (task) => (waitsForChildren(task)
        ? { ...task, state: 'waiting_for_children', error: undefined }
        : task));
      if (restored.data.state !== 'waiting_for_children') {
        return;
      }
      await this.event(restored, { type: 'reconcile', state: restored.data.state, resolution, childTaskId: current.id });
      current = restored;
    }
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx tsc --noEmit && npx tsx --test test/task-reconcile.test.ts test/agents-runtime.test.ts test/agents-coordinator.test.ts`

Expected: no type errors; `test/task-reconcile.test.ts` reports `pass 30`, `fail 0`; the two agent test files stay green, in particular `an unknown child outcome propagates to the parent without blind retry`.

- [ ] **Step 5: Commit**

```bash
git add src/tasks.ts test/task-reconcile.test.ts
git commit -m "實現：子任務對帳續跑後，恢復等待它的父任務"
```

---

### Task 8: HTTP route `POST /v1/tasks/:id/reconcile` and README

**Files:**
- Modify: `src/http/server.ts` (directly after the route `POST /v1/tasks/:id/approve`, lines 441-445 as of commit 17d571f)
- Modify: `README.md` (Components list, the bullet at line 59 as of commit 17d571f)
- Test: `test/task-reconcile-http.test.ts` (create)

**Interfaces:**
- Consumes:
  - From Tasks 3 to 7: `TaskService.reconcileOutcome(actor: Principal, id: string, input: TaskReconciliation): Promise<Entity<Task>>` and its error codes.
  - Existing in `src/http/server.ts`: the local helpers `principal(request): Principal` and `params(request): { id: string }`; `requireScope` from `src/auth.ts`; the `onRequest` hook, which already requires `task:write` for every non-GET route under `/v1/tasks`; the error handler, which turns a `DomainError` into `{ error: { code, message } }` with its status and a `ZodError` into 400 `invalid_input`; the `onResponse` hook, which records the route template in the maintenance activity log when a `MaintenanceService` is configured.
- Produces: `POST /v1/tasks/:id/reconcile`.
  - Auth: bearer token; `task:write` (hook) and `approval:write` (handler).
  - Body (strict): `{ resolution: 'applied' | 'not_applied' | 'abandon', actionHash?: 64 lowercase hex characters, toolCallId?: string of 1 to 200 characters, note?: string, trimmed, 1 to 2000 characters }`. `applied` and `not_applied` need exactly one of `actionHash` / `toolCallId`; `abandon` accepts none or one.
  - 200: `{ data: <task entity> }` with the new state.
  - Errors: 400 `invalid_input` (body); 401 `unauthorized`; 403 `forbidden` (missing scope) or `grant_revoked`; 404 `not_found` (unknown id, or a task of another owner); 409 `not_reconcilable` (the task is not `unknown`), `invalid_reconciliation` (the target is not an unresolved dispatched action of this task, or was answered differently), `not_resumable` (no checkpoint to continue from; use `abandon`), `workspace_busy` (the task's workspace writer is still active; retry), `busy` or `conflict` (store contention; retry).
  - The handler does not call `coordinator.propagateControl`: an `unknown` task has no live children to control.

- [ ] **Step 1: Write the failing test**

Create `test/task-reconcile-http.test.ts`:

```ts
import assert from 'node:assert/strict';
import test from 'node:test';
import { developmentAuth } from '../src/auth.js';
import { DomainError, type Principal, type ToolDefinition } from '../src/contracts.js';
import type { Task } from '../src/domain.js';
import { createServer } from '../src/http/server.js';
import { MaintenanceService } from '../src/maintenance.js';
import { createTaskRunner } from '../src/runtime-adapter.js';
import { SqliteStore } from '../src/storage/sqlite.js';
import type { TaskRunner } from '../src/tasks.js';

const token = 'reconcile-owner-token-with-at-least-thirty-two-characters';
const headers = { authorization: `Bearer ${token}` };
const hash = 'a'.repeat(64);
const checkpoint = [
  { role: 'user', content: 'send hello' },
  { role: 'assistant', content: '', toolCalls: [{ id: 'send-1', name: 'send', arguments: { message: 'hello' } }] },
];

type Server = Awaited<ReturnType<typeof createServer>>;

// First run asks for approval of `send-1`, second run dispatches it and loses the result, later runs finish.
function losesTheSendResult(): TaskRunner {
  let calls = 0;
  return async ({ task, onEvent }) => {
    calls += 1;
    if (calls === 1) {
      return {
        text: '',
        status: 'waiting_for_approval',
        pendingActions: [{ hash, tool: 'send', input: { message: 'hello' } }],
        messages: checkpoint,
      };
    }
    if (calls === 2) {
      await onEvent({
        type: 'tool_dispatched', taskId: task.id, actionHash: hash, sideEffect: 'external',
        toolCall: { id: 'send-1', name: 'send', arguments: { message: 'hello' }, actionHash: hash },
      });
      await onEvent({ type: 'tool_result', taskId: task.id, toolCallId: 'send-1', actionHash: hash, sideEffect: 'external', outcome: 'unknown', isError: true });
      throw new DomainError('outcome_unknown', 'External action was dispatched but its result was not confirmed.', 409);
    }
    return { text: 'continued' };
  };
}

async function unknownTask(server: Server): Promise<string> {
  const created = await server.app.inject({ method: 'POST', url: '/v1/conversations', headers, payload: { title: 'Project', mode: 'act', strategy: 'single' } });
  assert.equal(created.statusCode, 201, created.body);
  const sent = await server.app.inject({
    method: 'POST', url: `/v1/conversations/${created.json().data.id}/messages`, headers, payload: { content: 'send hello', requestId: 'message-1' },
  });
  assert.equal(sent.statusCode, 202, sent.body);
  const taskId = sent.json().data.id as string;
  await server.tasks.drain();
  const approved = await server.app.inject({ method: 'POST', url: `/v1/tasks/${taskId}/approve`, headers, payload: { hashes: [hash] } });
  assert.equal(approved.statusCode, 200, approved.body);
  await server.tasks.drain();
  const task = await server.app.inject({ method: 'GET', url: `/v1/tasks/${taskId}`, headers });
  assert.equal(task.json().data.data.state, 'unknown');
  return taskId;
}

function reconcile(server: Server, taskId: string, payload: unknown, requestHeaders: Record<string, string> = headers) {
  return server.app.inject({ method: 'POST', url: `/v1/tasks/${taskId}/reconcile`, headers: requestHeaders, payload: payload as Record<string, unknown> });
}

test('POST /v1/tasks/:id/reconcile requires a bearer token, task:write and approval:write', async () => {
  const body = { resolution: 'abandon' };
  const open = await createServer({ store: new SqliteStore(), authenticate: developmentAuth(token), runner: async () => ({ text: 'unused' }) });
  try {
    assert.equal((await reconcile(open, 'any-task', body, {})).statusCode, 401);
    assert.equal((await reconcile(open, 'any-task', body, { authorization: 'Bearer wrong-token-with-at-least-thirty-two-characters' })).statusCode, 401);
  } finally { await open.close(); }
  for (const scopes of [['task:read', 'task:write'], ['task:read', 'approval:write']]) {
    const authenticate = async (): Promise<Principal> => ({ id: 'limited-owner', level: 1, scopes });
    const limited = await createServer({ store: new SqliteStore(), authenticate, runner: async () => ({ text: 'unused' }) });
    try {
      const response = await reconcile(limited, 'any-task', body);
      assert.equal(response.statusCode, 403, scopes.join(','));
      assert.equal(response.json().error.code, 'forbidden');
    } finally { await limited.close(); }
  }
});

test('POST /v1/tasks/:id/reconcile validates its body before looking at the task', async () => {
  const server = await createServer({ store: new SqliteStore(), authenticate: developmentAuth(token), runner: async () => ({ text: 'unused' }) });
  try {
    const invalid: unknown[] = [
      { resolution: 'maybe', toolCallId: 'send-1' },
      { toolCallId: 'send-1' },
      { resolution: 'applied' },
      { resolution: 'not_applied' },
      { resolution: 'applied', actionHash: hash, toolCallId: 'send-1' },
      { resolution: 'abandon', actionHash: hash, toolCallId: 'send-1' },
      { resolution: 'applied', actionHash: 'A'.repeat(64) },
      { resolution: 'applied', actionHash: 'a'.repeat(63) },
      { resolution: 'applied', toolCallId: '' },
      { resolution: 'applied', toolCallId: 'x'.repeat(201) },
      { resolution: 'applied', toolCallId: 'send-1', note: '   ' },
      { resolution: 'applied', toolCallId: 'send-1', note: 'x'.repeat(2_001) },
      { resolution: 'applied', toolCallId: 'send-1', force: true },
      ['applied'],
    ];
    for (const payload of invalid) {
      const response = await reconcile(server, 'missing-task', payload);
      assert.equal(response.statusCode, 400, JSON.stringify(payload).slice(0, 80));
      assert.equal(response.json().error.code, 'invalid_input');
    }
    for (const payload of [
      { resolution: 'abandon' },
      { resolution: 'abandon', toolCallId: 'send-1' },
      { resolution: 'applied', actionHash: hash, note: ` ${'x'.repeat(2_000)} ` },
      { resolution: 'not_applied', toolCallId: 'x'.repeat(200) },
    ]) {
      const response = await reconcile(server, 'missing-task', payload);
      assert.equal(response.statusCode, 404, JSON.stringify(payload).slice(0, 80));
      assert.equal(response.json().error.code, 'not_found');
    }
  } finally { await server.close(); }
});

test('POST /v1/tasks/:id/reconcile reports another owner, a wrong state and a wrong target with their own codes', async () => {
  const store = new SqliteStore();
  const server = await createServer({ store, authenticate: developmentAuth(token), runner: losesTheSendResult(), reauthorize: async (current) => current });
  try {
    const taskId = await unknownTask(server);
    const foreign = await store.create<Task>('task', 'someone-else', {
      conversationId: 'their-conversation', prompt: 'theirs', principal: { id: 'someone-else', level: 1, scopes: ['*'] }, state: 'unknown',
      grantExpiresAt: new Date(Date.now() + 60_000).toISOString(), pendingActions: [], approvedActionHashes: [],
    });
    const theirs = await reconcile(server, foreign.id, { resolution: 'abandon' });
    assert.equal(theirs.statusCode, 404);
    assert.equal((await store.get<Task>('task', foreign.id, 'someone-else'))?.data.state, 'unknown');

    const wrongTarget = await reconcile(server, taskId, { resolution: 'applied', toolCallId: 'send-2' });
    assert.equal(wrongTarget.statusCode, 409);
    assert.deepEqual(Object.keys(wrongTarget.json()), ['error']);
    assert.equal(wrongTarget.json().error.code, 'invalid_reconciliation');

    const first = await reconcile(server, taskId, { resolution: 'abandon' });
    assert.equal(first.statusCode, 200, first.body);
    const again = await reconcile(server, taskId, { resolution: 'applied', actionHash: hash });
    assert.equal(again.statusCode, 409);
    assert.equal(again.json().error.code, 'not_reconcilable');
  } finally { await server.close(); }
});

test('reconciling over HTTP resumes the task, records who did it and clears it from attention', async () => {
  const store = new SqliteStore();
  const maintenance = new MaintenanceService(store);
  const server = await createServer({
    store, maintenance, authenticate: developmentAuth(token), runner: losesTheSendResult(), reauthorize: async (current) => current,
  });
  try {
    const taskId = await unknownTask(server);
    const attention = async (): Promise<string[]> => (await server.app.inject({ method: 'GET', url: '/v1/maintenance', headers }))
      .json().data.attention.map((row: { id: string }) => row.id);
    assert.deepEqual(await attention(), [taskId]);

    const response = await reconcile(server, taskId, { resolution: 'applied', actionHash: hash, note: '  Seen in the outbox  ' });

    assert.equal(response.statusCode, 200, response.body);
    assert.equal(response.json().data.id, taskId);
    assert.equal(response.json().data.data.state, 'queued');
    const events = (await server.app.inject({ method: 'GET', url: `/v1/tasks/${taskId}/events`, headers })).json().data as Array<{ data: { type: string; at: string; payload: Record<string, unknown> } }>;
    const audit = events.at(-1)!.data;
    assert.equal(audit.type, 'reconcile');
    assert.ok(Number.isFinite(Date.parse(audit.at)));
    assert.deepEqual(audit.payload, {
      type: 'reconcile', state: 'queued', resolution: 'applied', toolCallId: 'send-1', actionHash: hash, toolName: 'send',
      note: 'Seen in the outbox', actor: { id: 'local-owner', level: 1 },
    });
    assert.deepEqual(events.at(-2)!.data.payload, {
      type: 'tool_result', taskId, toolCallId: 'send-1', actionHash: hash, sideEffect: 'external', isError: false, outcome: 'confirmed', reconciled: 'applied',
    });
    const activity = await maintenance.activity({ id: 'local-owner', level: 1, scopes: ['*'] });
    assert.ok(activity.some((row) => row.data.route === '/v1/tasks/:id/reconcile' && row.data.method === 'POST' && row.data.statusCode === 200));

    await server.tasks.drain();

    const finished = await server.app.inject({ method: 'GET', url: `/v1/tasks/${taskId}`, headers });
    assert.equal(finished.json().data.data.state, 'completed');
    assert.equal(finished.json().data.data.result, 'continued');
    assert.deepEqual(await attention(), []);
  } finally { await server.close(); }
});

test('an unknown workspace operation is closed over HTTP and only a new request runs the tool again', async () => {
  const store = new SqliteStore();
  let executions = 0;
  const tool: ToolDefinition = {
    name: 'terminal.run', description: 'Run', inputSchema: { type: 'object' }, requiredCapabilities: [], requiresWorkspace: true, sideEffect: 'external',
    async execute() {
      executions += 1;
      if (executions === 1) throw new Error('connection lost');
      return { content: JSON.stringify({ exitCode: 0, stdout: 'deployed', stderr: '' }) };
    },
  };
  const server = await createServer({
    store,
    tools: [tool],
    authenticate: developmentAuth(token),
    runner: createTaskRunner(store, { run: async () => { throw new Error('model must not run'); } }, [tool]),
    reauthorize: async (current) => current,
  });
  try {
    const workspace = await store.create('workspace', 'local-owner', { name: 'Local', root: '/project', deviceId: 'server', capabilities: [], allowCloud: false });
    const operate = (requestId: string) => server.app.inject({
      method: 'POST', url: `/v1/workspaces/${workspace.id}/operations`, headers, payload: { tool: 'terminal.run', input: { command: 'deploy' }, requestId },
    });
    const started = await operate('deploy-1');
    assert.equal(started.statusCode, 202, started.body);
    const taskId = started.json().data.id as string;
    await server.tasks.drain();
    assert.equal((await server.app.inject({ method: 'GET', url: `/v1/tasks/${taskId}`, headers })).json().data.data.state, 'unknown');

    const closed = await reconcile(server, taskId, { resolution: 'not_applied', toolCallId: taskId, note: 'Nothing was deployed' });

    assert.equal(closed.statusCode, 200, closed.body);
    assert.equal(closed.json().data.data.state, 'failed');
    assert.equal(closed.json().data.data.error, 'Reconciled by an operator: the operation was not applied. Operator note: Nothing was deployed');
    const repeated = await operate('deploy-1');
    assert.equal(repeated.json().data.id, taskId);
    await server.tasks.drain();
    assert.equal(executions, 1);

    const retried = await operate('deploy-2');
    await server.tasks.drain();
    assert.equal(executions, 2);
    const done = await server.app.inject({ method: 'GET', url: `/v1/tasks/${retried.json().data.id}`, headers });
    assert.equal(done.json().data.data.state, 'completed');
    assert.equal(JSON.parse(done.json().data.data.result).stdout, 'deployed');
  } finally { await server.close(); }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx --test test/task-reconcile-http.test.ts`

Expected: all five tests fail because the route does not exist. The first failures read

```
✖ POST /v1/tasks/:id/reconcile requires a bearer token, task:write and approval:write
  AssertionError [ERR_ASSERTION]: task:read,task:write

  404 !== 403
✖ POST /v1/tasks/:id/reconcile validates its body before looking at the task
  AssertionError [ERR_ASSERTION]: {"resolution":"maybe","toolCallId":"send-1"}

  404 !== 400
```

and the fourth shows the framework's own answer: `Route POST:/v1/tasks/<id>/reconcile not found`.

- [ ] **Step 3: Write minimal implementation**

In `src/http/server.ts`, the handler of `POST /v1/tasks/:id/approve` ends with these two lines; replace:

```ts
    return { data: await tasks.control(owner.id, params(request).id, 'resume', body.hashes, owner) };
  });
```

with:

```ts
    return { data: await tasks.control(owner.id, params(request).id, 'resume', body.hashes, owner) };
  });
  app.post('/v1/tasks/:id/reconcile', async (request) => {
    const owner = principal(request); requireScope(owner, 'approval:write');
    const body = z.object({
      resolution: z.enum(['applied', 'not_applied', 'abandon']),
      actionHash: z.string().regex(/^[a-f0-9]{64}$/).optional(),
      toolCallId: z.string().min(1).max(200).optional(),
      note: z.string().trim().min(1).max(2000).optional(),
    }).strict().refine(
      (value) => (value.resolution === 'abandon'
        ? value.actionHash === undefined || value.toolCallId === undefined
        : (value.actionHash === undefined) !== (value.toolCallId === undefined)),
      'Name the dispatched action with exactly one of actionHash or toolCallId',
    ).parse(request.body);
    return { data: await tasks.reconcileOutcome(owner, params(request).id, body) };
  });
```

In `README.md`, in the Components list, find the bullet that starts with `- The runtime executes a model/tool/check loop.` and add two bullets directly after it. As of commit `17d571f` that means replacing:

```markdown
- The runtime executes a model/tool/check loop. Ask and plan modes exclude write tools; act mode uses scoped approvals. Unknown external outcomes stop for reconciliation.
```

with:

```markdown
- The runtime executes a model/tool/check loop. Ask and plan modes exclude write tools; act mode uses scoped approvals. Unknown external outcomes stop for reconciliation.
- A task in state `unknown` is reconciled by its owner with `POST /v1/tasks/:id/reconcile` (`task:write` and `approval:write`). The body names the dispatched action by `actionHash` or `toolCallId`, as shown by the last `tool_dispatched` event in `GET /v1/tasks/:id/events` (for a workspace operation the `toolCallId` is the task id), and gives a `resolution`. `applied` records the action as confirmed and continues from the checkpoint. `not_applied` records it as failed and continues; if the model asks for the action again, a new approval is required. `abandon` cancels the task and leaves the outcome unresolved in its events. Nothing is replayed in any case. An optional `note` is stored with the `reconcile` event and passed to the model. A workspace operation has no model loop, so `applied` completes it and `not_applied` fails it. A task that was being cancelled when its outcome became unknown ends `cancelled` after either answer.
- `applied` and `not_applied` release the workspace write lease the task still holds; they are refused with `workspace_busy` while that writer is still active. `abandon` leaves the lease alone, so a workspace whose writer stopped without a confirmed outcome stays write-blocked until `POST /v1/workspaces/:id/write-lease/reconcile` is called. That endpoint no longer waits for a device job whose own outcome is unknown; it is refused only while the writer is still active, its task is still running, or its device job is still queued or dispatched.
```

(If an earlier plan reworded the first bullet, keep its wording and only add the two new bullets after it.)

- [ ] **Step 4: Run test to verify it passes**

Run: `npx tsc --noEmit && npx tsx --test test/task-reconcile-http.test.ts test/api.test.ts test/maintenance.test.ts`

Expected: no type errors; `test/task-reconcile-http.test.ts` reports `pass 5`, `fail 0`; the other two files stay green.

- [ ] **Step 5: Commit**

```bash
git add src/http/server.ts README.md test/task-reconcile-http.test.ts
git commit -m "實現：新增 POST /v1/tasks/:id/reconcile 對帳端點並更新說明"
```

---

### Task 9: End-to-end regression — unknown, reconcile, continue without replay

**Files:**
- Test: `test/unknown-outcomes.test.ts` (create)
- No production file changes. If a test in this task fails for a reason other than the mutation in Step 2, the defect is in Tasks 1 to 8 (or in plan B1 for the last two tests); fix it there.

**Interfaces:**
- Consumes:
  - From this plan: `TaskService.reconcileOutcome(actor: Principal, id: string, input: TaskReconciliation): Promise<Entity<Task>>`; `reconcileToolCall` (through `resumedFromCheckpoint`).
  - From plan B1 (already applied): `notDispatched(code: string, message: string, statusCode = 400): DomainError` exported from `src/contracts.ts`, which returns a `DomainError` whose read-only `notDispatched` property is `true` (`isNotDispatched(error)` and `asNotDispatched(error, code, statusCode)` are its companions); the runtime rule that such an error thrown by a write or external tool becomes an ordinary failed tool result fed back to the model (the `tool_result` event then carries the optional field `notDispatched: true`); and the rule that `waiting_for_device` closes its dispatch record with a failed `tool_result` before the task is parked, so a later cancel ends `cancelled`.
  - Existing: `createTaskRunner(store, runtime, tools)` in `src/runtime-adapter.ts`; `AgentRuntime` and `ModelProvider` from `src/runtime/index.ts`; `TaskService.enqueue`, `control`, `drain`, `events`, `close`. Without a `notifications` option `TaskService` stores a `notification` row of type `task_unknown` when a task becomes `unknown`.
- Produces: nothing new. The file is the regression net for the whole workstream: the real runtime, runner and task service around a scripted model and one external tool.

- [ ] **Step 1: Write the test**

Create `test/unknown-outcomes.test.ts`:

```ts
import assert from 'node:assert/strict';
import test from 'node:test';
import { DomainError, notDispatched, type Principal, type ToolDefinition, type ToolResult } from '../src/contracts.js';
import type { Conversation, Task } from '../src/domain.js';
import { createTaskRunner } from '../src/runtime-adapter.js';
import { AgentRuntime, type ChatRequest, type ChatResponse, type ModelProvider } from '../src/runtime/index.js';
import { SqliteStore } from '../src/storage/sqlite.js';
import type { Entity } from '../src/storage/store.js';
import { TaskService, type TaskRunner } from '../src/tasks.js';

const principal: Principal = { id: 'alice', level: 1, scopes: ['*'] };
const usage = { inputTokens: 1, outputTokens: 1 };

function asksToSend(id: string): ChatResponse {
  return { message: { role: 'assistant', content: '', toolCalls: [{ id, name: 'send', arguments: { message: 'hello' } }] }, usage };
}

function says(content: string): ChatResponse {
  return { message: { role: 'assistant', content }, usage };
}

class ScriptedProvider implements ModelProvider {
  public readonly id = 'scripted';
  public readonly locality = 'local';
  public readonly calls: ChatRequest[] = [];

  public constructor(private readonly responses: ChatResponse[]) {}

  public async chat(request: ChatRequest): Promise<ChatResponse> {
    this.calls.push(request);
    const response = this.responses.shift();
    assert.ok(response, 'unexpected provider call');
    return response;
  }
}

interface World {
  store: SqliteStore;
  service: TaskService;
  runner: TaskRunner;
  provider: ScriptedProvider;
  taskId: string;
  executions: () => number;
  task: () => Promise<Entity<Task>>;
  approve: () => Promise<string>;
}

// The real runtime, the real task runner and the real task service around a scripted model and one
// external tool `send`, whose n-th execution is decided by `attempts[n - 1]`.
async function world(responses: ChatResponse[], attempts: Array<() => ToolResult>): Promise<World> {
  const store = new SqliteStore();
  const provider = new ScriptedProvider(responses);
  let executions = 0;
  const send: ToolDefinition = {
    name: 'send',
    description: 'Send a message to an external system',
    inputSchema: { type: 'object' },
    requiredCapabilities: [],
    sideEffect: 'external',
    async execute() {
      executions += 1;
      const attempt = attempts[executions - 1];
      assert.ok(attempt, 'unexpected tool execution');
      return attempt();
    },
  };
  const runtime = new AgentRuntime({
    providers: [provider],
    models: [{ id: 'local-model', providerId: provider.id, locality: 'local', capabilities: ['tools'] }],
    tools: [send],
  });
  const runner = createTaskRunner(store, runtime, [send]);
  const service = new TaskService(store, runner, { reauthorize: async (current) => current });
  const thread = await store.create<Conversation>('conversation', principal.id, {
    title: 'Send', scope: 'private', modelPolicy: 'local', strategy: 'single', mode: 'act', archived: false,
  });
  const queued = await service.enqueue(principal, thread.id, 'Send hello');
  const task = async (): Promise<Entity<Task>> => (await store.get<Task>('task', queued.id, principal.id))!;
  const approve = async (): Promise<string> => {
    const waiting = await task();
    assert.equal(waiting.data.state, 'waiting_for_approval');
    const pending = waiting.data.pendingActions.at(-1)!.hash;
    await service.control(principal.id, queued.id, 'resume', [pending], principal);
    return pending;
  };
  await service.drain();
  return { store, service, runner, provider, taskId: queued.id, executions: () => executions, task, approve };
}

const lost = (): ToolResult => { throw new Error('connection lost after dispatch'); };
const sent = (): ToolResult => ({ content: 'sent' });

async function eventPayloads(service: TaskService, taskId: string): Promise<Array<Record<string, unknown>>> {
  return (await service.events(principal.id, taskId)).map((row) => row.data.payload as Record<string, unknown>);
}

test('applied: the task continues from its checkpoint and the tool is not executed again', async () => {
  const { store, service, provider, taskId, executions, task, approve } = await world(
    [asksToSend('send-1'), says('The message went out.')], [lost],
  );
  try {
    const hash = await approve();
    await service.drain();
    assert.equal((await task()).data.state, 'unknown');
    assert.equal(executions(), 1);
    assert.equal((await store.scan<{ type: string; taskId: string }>('notification', principal.id))
      .filter((row) => row.data.type === 'task_unknown' && row.data.taskId === taskId).length, 1);

    await service.reconcileOutcome(principal, taskId, { resolution: 'applied', actionHash: hash, note: 'Seen in the outbox' });
    await service.drain();

    const finished = await task();
    assert.equal(finished.data.state, 'completed');
    assert.equal(finished.data.result, 'The message went out.');
    assert.equal(finished.data.resultArtifactIds, undefined);
    assert.equal(executions(), 1);
    assert.equal(provider.calls.length, 2);
    const answer = provider.calls[1]?.messages.at(-1);
    assert.equal(answer?.role, 'tool');
    assert.equal(answer?.toolCallId, 'send-1');
    assert.match(answer?.content ?? '', /this action was applied[\s\S]*Operator note: Seen in the outbox$/);
    const events = await eventPayloads(service, taskId);
    assert.equal(events.filter((event) => event.type === 'tool_dispatched').length, 1);
  } finally { await service.close(); await store.close(); }
});

test('not_applied: a retry needs a new approval before the tool runs a second time', async () => {
  const { store, service, provider, taskId, executions, task, approve } = await world(
    [asksToSend('send-1'), asksToSend('send-2'), says('Sent on the second attempt.')], [lost, sent],
  );
  try {
    const firstHash = await approve();
    await service.drain();
    assert.equal((await task()).data.state, 'unknown');

    await service.reconcileOutcome(principal, taskId, { resolution: 'not_applied', toolCallId: 'send-1' });
    await service.drain();

    const waiting = await task();
    assert.equal(waiting.data.state, 'waiting_for_approval');
    assert.equal(executions(), 1);
    assert.equal(waiting.data.pendingActions.length, 1);
    assert.notEqual(waiting.data.pendingActions[0]?.hash, firstHash);
    assert.equal(waiting.data.approvedActionHashes.includes(firstHash), false);
    assert.match(provider.calls[1]?.messages.at(-1)?.content ?? '', /this action was not applied/);

    await approve();
    await service.drain();

    assert.equal((await task()).data.state, 'completed');
    assert.equal((await task()).data.result, 'Sent on the second attempt.');
    assert.equal(executions(), 2);
  } finally { await service.close(); await store.close(); }
});

test('abandon: the task is cancelled and the tool is never executed again', async () => {
  const { store, service, provider, taskId, executions, task, approve } = await world([asksToSend('send-1')], [lost]);
  try {
    await approve();
    await service.drain();
    assert.equal((await task()).data.state, 'unknown');

    await service.reconcileOutcome(principal, taskId, { resolution: 'abandon' });
    await service.drain();

    assert.equal((await task()).data.state, 'cancelled');
    assert.equal(executions(), 1);
    assert.equal(provider.calls.length, 1);
    const results = (await eventPayloads(service, taskId)).filter((event) => event.type === 'tool_result');
    assert.deepEqual(results.map((event) => event.outcome), ['unknown']);
  } finally { await service.close(); await store.close(); }
});

test('a restart between reconciliation and the next run still resumes from the stored checkpoint', async () => {
  const { store, service, runner, taskId, executions, task, approve } = await world(
    [asksToSend('send-1'), says('Continued after the restart.')], [lost],
  );
  let restarted: TaskService | undefined;
  try {
    const hash = await approve();
    await service.drain();
    await service.reconcileOutcome(principal, taskId, { resolution: 'applied', actionHash: hash });
    await service.close();

    restarted = new TaskService(store, runner, { reauthorize: async (current) => current });
    await restarted.drain();

    assert.equal((await task()).data.state, 'completed');
    assert.equal((await task()).data.result, 'Continued after the restart.');
    assert.equal(executions(), 1);
  } finally { await restarted?.close(); await service.close(); await store.close(); }
});

// The next two tests pin what plan B1 delivers and this plan relies on: a failure that happened before
// anything was dispatched never produces an unknown task, so there is nothing to reconcile.

test('a failure marked as not dispatched goes back to the model instead of stopping the task', async () => {
  const refused = (): ToolResult => { throw notDispatched('invalid_input', 'The recipient is not allowed'); };
  const { store, service, provider, executions, task, approve } = await world(
    [asksToSend('send-1'), asksToSend('send-2'), says('Sent after the correction.')], [refused, sent],
  );
  try {
    const firstHash = await approve();
    await service.drain();

    const waiting = await task();
    assert.equal(waiting.data.state, 'waiting_for_approval');
    assert.notEqual(waiting.data.pendingActions[0]?.hash, firstHash);
    assert.match(provider.calls[1]?.messages.at(-1)?.content ?? '', /The recipient is not allowed/);

    await approve();
    await service.drain();

    assert.equal((await task()).data.state, 'completed');
    assert.equal(executions(), 2);
  } finally { await service.close(); await store.close(); }
});

test('cancelling a task that only waits for its device does not leave it unknown', async () => {
  const offline = (): ToolResult => { throw new DomainError('waiting_for_device', 'Waiting for the authorized device to reconnect'); };
  const { store, service, taskId, executions, task, approve } = await world([asksToSend('send-1')], [offline]);
  try {
    await approve();
    await service.drain();
    assert.equal((await task()).data.state, 'waiting_for_device');

    const cancelled = await service.control(principal.id, taskId, 'cancel', [], principal);

    assert.equal(cancelled.data.state, 'cancelled');
    assert.equal(executions(), 1);
  } finally { await service.close(); await store.close(); }
});
```

- [ ] **Step 2: Run the test and prove it can fail**

Run: `npx tsx --test test/unknown-outcomes.test.ts`

Expected: `pass 6`, `fail 0`. These tests cover code that Tasks 1 to 8 already delivered, so they pass as soon as they exist. Prove they have teeth with one temporary mutation: in `src/tasks.ts`, in `resumedFromCheckpoint`, delete the line

```ts
    runtimeMessages: messages,
```

and run the same command again. Without the reconciled checkpoint the runtime finds the approved call still pending and dispatches the tool a second time. Expected with the mutation: three failures.

```
✖ applied: the task continues from its checkpoint and the tool is not executed again
  + 'unknown'
  - 'completed'
✖ not_applied: a retry needs a new approval before the tool runs a second time
  AssertionError [ERR_ASSERTION]: Expected "actual" to be strictly unequal to:
✖ a restart between reconciliation and the next run still resumes from the stored checkpoint
  + 'unknown'
  - 'completed'
```

- [ ] **Step 3: Restore the implementation**

Undo the mutation:

```bash
git checkout src/tasks.ts
git status --short
```

Expected: `git status --short` shows no modified file under `src/` and lists the new test as `?? test/unknown-outcomes.test.ts` (files that were already untracked before this plan started, if any, are still listed).

- [ ] **Step 4: Run the test and the full check**

Run: `npx tsx --test test/unknown-outcomes.test.ts`

Expected: `pass 6`, `fail 0`.

Run: `npm run check`

Expected: the typecheck prints nothing, the test run ends with `fail 0` (this plan adds 51 tests: 7 in `test/runtime-reconcile.test.ts`, 3 in `test/workspace-write-lease.test.ts`, 30 in `test/task-reconcile.test.ts`, 5 in `test/task-reconcile-http.test.ts`, 6 in `test/unknown-outcomes.test.ts`), and the build completes without output after the `tsc -p tsconfig.build.json` line. A failure in a test file this plan neither creates nor edits is not explained by this plan: run that file on its own once (in review, `test/mac-app-tools.test.ts` from plan B1 failed once with `Mac helper exceeded its time limit` while the machine was heavily loaded and passed on its own and on the next full run). If it fails again on its own, stop and report it instead of changing code.

- [ ] **Step 5: Commit**

```bash
git add test/unknown-outcomes.test.ts
git commit -m "測試：未知結果對帳後續跑且不重播的端到端回歸"
```
