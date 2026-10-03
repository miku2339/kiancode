import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { Pool } from 'pg';
import { DomainError, type Principal, type ToolDefinition, type Workspace } from '../src/contracts.js';
import type { Conversation, Task, TaskEvent } from '../src/domain.js';
import { createTaskRunner } from '../src/runtime-adapter.js';
import { AgentRuntime, type ChatMessage, type ModelProvider } from '../src/runtime/index.js';
import { PostgresStore } from '../src/storage/postgres.js';
import { SqliteStore } from '../src/storage/sqlite.js';
import type { Entity, Store } from '../src/storage/store.js';
import { TaskService } from '../src/tasks.js';
import { WorkspaceWriteLeaseService } from '../src/workspace-write-lease.js';

const databaseUrl = process.env.KIANCODE_TEST_DATABASE_URL ?? '';

class AuditFaultStore implements Store {
  private failAudit = true;

  public constructor(private readonly inner: Store) {}

  public async create<T>(kind: string, ownerId: string, data: T, id?: string): Promise<Entity<T>> {
    if (this.failAudit && kind === 'event' && id?.endsWith(':audit')) {
      this.failAudit = false;
      throw new Error('Injected audit persistence failure');
    }
    return this.inner.create(kind, ownerId, data, id);
  }

  public get<T>(kind: string, id: string, ownerId: string): Promise<Entity<T> | undefined> {
    return this.inner.get(kind, id, ownerId);
  }

  public scan<T>(kind: string, ownerId?: string): Promise<Array<Entity<T>>> {
    return this.inner.scan(kind, ownerId);
  }

  public put<T>(kind: string, id: string, ownerId: string, data: T, expectedRevision: number): Promise<Entity<T>> {
    return this.inner.put(kind, id, ownerId, data, expectedRevision);
  }

  public remove(kind: string, id: string, ownerId: string, expectedRevision: number): Promise<boolean> {
    return this.inner.remove(kind, id, ownerId, expectedRevision);
  }

  public close(): Promise<void> {
    return this.inner.close();
  }
}

function hasCode(code: string): (error: unknown) => boolean {
  return (error) => error instanceof DomainError && error.code === code;
}

for (const backend of ['SQLite', 'PostgreSQL'] as const) {
  test(`${backend}: reconciliation persists receipt-first recovery across restart (controlled adapter, not a production model/account)`, {
    skip: backend === 'PostgreSQL' && !databaseUrl ? 'KIANCODE_TEST_DATABASE_URL is not set' : false,
  }, async () => {
    const schema = `kiancode_test_${randomBytes(16).toString('hex')}`;
    const admin = backend === 'PostgreSQL'
      ? new Pool({ connectionString: databaseUrl, max: 1, connectionTimeoutMillis: 5000 })
      : undefined;
    let schemaCreated = false;
    let directory: string | undefined;
    let store: Store | undefined;
    let tasks: TaskService | undefined;
    let leases: WorkspaceWriteLeaseService | undefined;
    const principal: Principal = {
      id: 'reconciliation-owner',
      level: 3,
      scopes: ['*'],
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    };
    const workspaceId = 'reconciliation-workspace';
    const attempts = new Map<string, number>();
    let modelCalls = 0;
    const responses: ChatMessage[] = [
      { role: 'assistant', content: '', toolCalls: [{ id: 'call-1', name: 'write', arguments: { effect: 'applied' } }] },
      { role: 'assistant', content: '', toolCalls: [{ id: 'call-1', name: 'write', arguments: { effect: 'applied-next' } }] },
      { role: 'assistant', content: 'Applied effects verified.' },
      { role: 'assistant', content: '', toolCalls: [{ id: 'call-1', name: 'write', arguments: { effect: 'faulted-finish' } }] },
      { role: 'assistant', content: 'Recovered effect verified.' },
      { role: 'assistant', content: '', toolCalls: [{ id: 'call-1', name: 'write', arguments: { effect: 'retry' } }] },
      { role: 'assistant', content: '', toolCalls: [{ id: 'call-1', name: 'write', arguments: { effect: 'retry' } }] },
      { role: 'assistant', content: 'Retry completed.' },
    ];
    const provider: ModelProvider = {
      id: 'controlled-reconciliation-provider',
      locality: 'local',
      async chat() {
        modelCalls += 1;
        const message = responses.shift();
        assert.ok(message, 'Unexpected controlled model call');
        return { message, usage: { inputTokens: 1, outputTokens: 1 } };
      },
    };

    const open = async (failAudit = false): Promise<Store> => {
      await tasks?.close();
      await store?.close();
      const durableStore: Store = backend === 'PostgreSQL'
        ? await PostgresStore.connect(databaseUrl, { schema })
        : new SqliteStore(join(directory!, 'state.sqlite'));
      store = failAudit ? new AuditFaultStore(durableStore) : durableStore;
      leases = new WorkspaceWriteLeaseService(store, Date.now, 300_000);
      const write: ToolDefinition = leases.wrap({
        name: 'write',
        description: 'Apply one controlled persistent effect',
        inputSchema: { type: 'object' },
        requiredCapabilities: [],
        requiresWorkspace: true,
        sideEffect: 'write',
        async execute(input) {
          const effect = String(input.effect);
          const attempt = (attempts.get(effect) ?? 0) + 1;
          attempts.set(effect, attempt);
          if (effect === 'retry' && attempt === 1) {
            throw new Error('Dispatch completed without an effect or receipt');
          }
          const row = await store!.get<{ count: number }>('effect', effect, principal.id);
          assert.ok(row);
          await store!.put('effect', row.id, row.ownerId, { count: row.data.count + 1 }, row.revision);
          if (attempt === 1) throw new Error('Effect completed but its receipt was lost');
          return { content: 'Effect applied' };
        },
      });
      const runtime = new AgentRuntime({
        providers: [provider],
        models: [{ id: 'controlled-model', providerId: provider.id, locality: 'local', capabilities: ['tools'] }],
        tools: [write],
      });
      tasks = new TaskService(store, createTaskRunner(store, runtime, [write]), {
        reauthorize: async (current) => current,
        leaseMs: 300_000,
        heartbeatMs: 100_000,
      });
      return store;
    };

    const makeUnknown = async (conversationId: string, effect: string): Promise<{
      task: Entity<Task>;
      action: Task['pendingActions'][number];
    }> => {
      const created = await tasks!.enqueue(principal, conversationId, `Apply ${effect}`);
      await tasks!.drain();
      let task = (await store!.get<Task>('task', created.id, principal.id))!;
      assert.equal(task.data.state, 'waiting_for_approval', task.data.error);
      const action = task.data.pendingActions[0];
      assert.ok(action?.toolOccurrenceId);
      await tasks!.control(principal.id, task.id, 'resume', [action.hash], principal);
      await tasks!.drain();
      task = (await store!.get<Task>('task', task.id, principal.id))!;
      assert.equal(task.data.state, 'unknown');
      assert.equal((await leases!.get(principal.id, workspaceId))?.data.state, 'unknown');
      return { task, action };
    };

    const taskEvents = async (taskId: string): Promise<Array<Entity<TaskEvent>>> =>
      (await store!.scan<TaskEvent>('event', principal.id)).filter((row) => row.data.taskId === taskId);

    try {
      if (admin) {
        await admin.query(`CREATE SCHEMA ${schema}`);
        schemaCreated = true;
      } else {
        directory = await mkdtemp(join(tmpdir(), 'kiancode-reconcile-'));
      }
      let current = await open();
      const workspace = await current.create<Workspace>('workspace', principal.id, {
        id: workspaceId,
        ownerId: principal.id,
        name: 'Reconciliation',
        root: '/controlled-project',
        deviceId: 'controlled-device',
        capabilities: [],
        allowCloud: false,
      }, workspaceId);
      const conversation = await current.create<Conversation>('conversation', principal.id, {
        title: 'Reconciliation',
        scope: 'private',
        modelPolicy: 'local',
        strategy: 'single',
        mode: 'act',
        archived: false,
        workspaceId: workspace.id,
      });
      for (const effect of ['applied', 'applied-next', 'faulted-finish', 'retry']) {
        await current.create('effect', principal.id, { count: 0 }, effect);
      }

      const applied = await makeUnknown(conversation.id, 'applied');
      const appliedCalls = modelCalls;
      const appliedAttempts = attempts.get('applied');
      const appliedDecision = {
        resolution: 'applied' as const,
        toolOccurrenceId: applied.action.toolOccurrenceId,
        actionHash: applied.action.hash,
        note: 'Effect verified in the controlled store',
      };
      const reconciled = await tasks!.reconcileOutcome(principal, applied.task.id, appliedDecision);
      assert.equal(reconciled.data.reconciliation?.phase, 'complete');
      assert.equal(reconciled.data.state, 'queued');
      assert.equal(modelCalls, appliedCalls);
      assert.equal(attempts.get('applied'), appliedAttempts);

      current = await open();
      await tasks!.drain();
      let appliedTask = (await current.get<Task>('task', applied.task.id, principal.id))!;
      assert.equal(appliedTask.data.state, 'waiting_for_approval', appliedTask.data.error);
      const appliedNextAction = appliedTask.data.pendingActions[0];
      assert.ok(appliedNextAction?.toolOccurrenceId);
      assert.notEqual(appliedNextAction.toolOccurrenceId, applied.action.toolOccurrenceId);
      assert.notEqual(appliedNextAction.hash, applied.action.hash);
      await tasks!.control(principal.id, appliedTask.id, 'resume', [appliedNextAction.hash], principal);
      await tasks!.drain();
      appliedTask = (await current.get<Task>('task', appliedTask.id, principal.id))!;
      assert.equal(appliedTask.data.state, 'unknown');
      assert.equal((await leases!.get(principal.id, workspaceId))?.data.state, 'unknown');
      assert.equal((await current.get<{ count: number }>('effect', 'applied', principal.id))?.data.count, 1);
      assert.equal((await current.get<{ count: number }>('effect', 'applied-next', principal.id))?.data.count, 1);
      assert.equal(attempts.get('applied'), 1);
      assert.equal(attempts.get('applied-next'), 1);

      current = await open();
      const replay = await tasks!.reconcileOutcome(principal, applied.task.id, appliedDecision);
      assert.equal(replay.data.reconciliation?.receiptId, reconciled.data.reconciliation?.receiptId);
      await assert.rejects(tasks!.reconcileOutcome(principal, applied.task.id, {
        ...appliedDecision,
        resolution: 'not_applied',
      }), hasCode('reconciliation_conflict'));

      const appliedNextDecision = {
        resolution: 'applied' as const,
        toolOccurrenceId: appliedNextAction.toolOccurrenceId,
        actionHash: appliedNextAction.hash,
        note: 'Second effect verified in the controlled store',
      };
      const reconciledNext = await tasks!.reconcileOutcome(principal, applied.task.id, appliedNextDecision);
      assert.equal(reconciledNext.data.reconciliation?.phase, 'complete');
      assert.equal(reconciledNext.data.reconciliation?.toolOccurrenceId, appliedNextAction.toolOccurrenceId);
      assert.notEqual(reconciledNext.data.reconciliation?.receiptId, reconciled.data.reconciliation?.receiptId);
      assert.equal(reconciledNext.data.state, 'queued');
      try {
        await tasks!.reconcileOutcome(principal, applied.task.id, appliedDecision);
      } catch (error) {
        assert.equal(error instanceof DomainError ? error.statusCode : undefined, 409);
      }
      const afterLateRetry = (await current.get<Task>('task', applied.task.id, principal.id))!;
      assert.equal(afterLateRetry.data.reconciliation?.receiptId, reconciledNext.data.reconciliation?.receiptId);
      assert.equal(afterLateRetry.data.reconciliation?.toolOccurrenceId, appliedNextAction.toolOccurrenceId);

      current = await open();
      await tasks!.drain();
      assert.equal((await current.get<Task>('task', applied.task.id, principal.id))?.data.state, 'completed');
      const appliedEvents = await taskEvents(applied.task.id);
      const appliedReceipts = appliedEvents.filter((event) => event.data.type === 'tool_result'
        && (event.data.payload as { reconciled?: string }).reconciled === 'applied');
      assert.deepEqual(appliedReceipts.map((event) =>
        (event.data.payload as { toolOccurrenceId?: string }).toolOccurrenceId), [
        applied.action.toolOccurrenceId,
        appliedNextAction.toolOccurrenceId,
      ]);
      assert.equal(new Set(appliedReceipts.map((event) => event.id)).size, 2);
      assert.deepEqual(appliedEvents.filter((event) => event.data.type === 'reconcile').map((event) =>
        (event.data.payload as { toolOccurrenceId?: string }).toolOccurrenceId), [
        applied.action.toolOccurrenceId,
        appliedNextAction.toolOccurrenceId,
      ]);
      assert.equal(attempts.get('applied'), 1);
      assert.equal(attempts.get('applied-next'), 1);

      const faulted = await makeUnknown(conversation.id, 'faulted-finish');
      current = await open(true);
      const callsBeforeFault = modelCalls;
      const attemptsBeforeFault = attempts.get('faulted-finish');
      const faultDecision = {
        resolution: 'applied' as const,
        toolOccurrenceId: faulted.action.toolOccurrenceId,
        actionHash: faulted.action.hash,
        note: 'Effect independently verified',
      };
      await assert.rejects(tasks!.reconcileOutcome(principal, faulted.task.id, faultDecision), /Injected audit persistence failure/);
      let pending = (await current.get<Task>('task', faulted.task.id, principal.id))!;
      assert.equal(pending.data.state, 'unknown');
      assert.equal(pending.data.reconciliation?.phase, 'pending');
      assert.equal(pending.data.reconciliation?.resolution, 'applied');
      assert.equal(pending.data.reconciliation?.toolOccurrenceId, faulted.action.toolOccurrenceId);
      assert.equal(modelCalls, callsBeforeFault);
      assert.equal(attempts.get('faulted-finish'), attemptsBeforeFault);
      const faultLease = await leases!.get(principal.id, workspaceId);
      assert.equal(faultLease?.data.state, 'released');
      assert.equal(faultLease?.data.verification?.receiptId, pending.data.reconciliation?.receiptId);
      let faultEvents = await taskEvents(faulted.task.id);
      assert.equal(faultEvents.filter((event) => event.data.type === 'tool_result'
        && (event.data.payload as { reconciled?: string }).reconciled === 'applied').length, 1);
      assert.equal(faultEvents.filter((event) => event.data.type === 'reconcile').length, 0);
      await assert.rejects(tasks!.reconcileOutcome(principal, faulted.task.id, {
        ...faultDecision,
        resolution: 'not_applied',
      }), hasCode('reconciliation_conflict'));

      current = await open();
      await tasks!.drain();
      pending = (await current.get<Task>('task', faulted.task.id, principal.id))!;
      assert.equal(pending.data.state, 'completed', pending.data.error);
      assert.equal(pending.data.reconciliation?.phase, 'complete');
      assert.equal((await current.get<{ count: number }>('effect', 'faulted-finish', principal.id))?.data.count, 1);
      assert.equal(attempts.get('faulted-finish'), 1);
      faultEvents = await taskEvents(faulted.task.id);
      assert.equal(faultEvents.filter((event) => event.data.type === 'tool_result'
        && (event.data.payload as { receiptId?: string }).receiptId === pending.data.reconciliation?.receiptId).length, 1);
      assert.equal(faultEvents.filter((event) => event.data.type === 'reconcile').length, 1);
      const released = await leases!.get(principal.id, workspaceId);
      assert.equal(released?.data.state, 'released');
      assert.equal(released?.data.verification?.receiptId, pending.data.reconciliation?.receiptId);

      const retry = await makeUnknown(conversation.id, 'retry');
      const retryCalls = modelCalls;
      const retryAttempts = attempts.get('retry');
      await tasks!.reconcileOutcome(principal, retry.task.id, {
        resolution: 'not_applied',
        toolOccurrenceId: retry.action.toolOccurrenceId,
        actionHash: retry.action.hash,
        note: 'No controlled effect was observed',
      });
      assert.equal(modelCalls, retryCalls);
      assert.equal(attempts.get('retry'), retryAttempts);
      await tasks!.drain();
      let retried = (await current.get<Task>('task', retry.task.id, principal.id))!;
      assert.equal(retried.data.state, 'waiting_for_approval', retried.data.error);
      const fresh = retried.data.pendingActions[0];
      assert.ok(fresh?.toolOccurrenceId);
      assert.notEqual(fresh.toolOccurrenceId, retry.action.toolOccurrenceId);
      assert.notEqual(fresh.hash, retry.action.hash);
      assert.equal((await current.get<{ count: number }>('effect', 'retry', principal.id))?.data.count, 0);
      await tasks!.control(principal.id, retried.id, 'resume', [fresh.hash], principal);
      await tasks!.drain();
      retried = (await current.get<Task>('task', retried.id, principal.id))!;
      assert.equal(retried.data.state, 'completed', retried.data.error);
      assert.equal((await current.get<{ count: number }>('effect', 'retry', principal.id))?.data.count, 1);
      assert.equal(attempts.get('retry'), 2);
      assert.equal(responses.length, 0);
    } finally {
      try {
        await tasks?.close();
        await store?.close();
      } finally {
        try {
          if (admin && schemaCreated) await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
        } finally {
          await admin?.end();
          if (directory) await rm(directory, { recursive: true, force: true });
        }
      }
    }
  });
}
