import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { Pool } from 'pg';
import { DomainError, notDispatched, type Principal, type ToolDefinition, type Workspace } from '../src/contracts.js';
import type { Conversation, Task } from '../src/domain.js';
import { createTaskRunner } from '../src/runtime-adapter.js';
import { AgentRuntime, type ChatMessage, type ModelProvider } from '../src/runtime/index.js';
import { PostgresStore } from '../src/storage/postgres.js';
import { SqliteStore } from '../src/storage/sqlite.js';
import type { Store } from '../src/storage/store.js';
import { TaskService } from '../src/tasks.js';
import { WorkspaceWriteLeaseService } from '../src/workspace-write-lease.js';

const databaseUrl = process.env.KIANCODE_TEST_DATABASE_URL ?? '';

for (const backend of ['SQLite', 'PostgreSQL'] as const) {
  test(`${backend}: dispatch occurrences survive restart and unknown writes cannot replay`, {
    skip: backend === 'PostgreSQL' && !databaseUrl ? 'KIANCODE_TEST_DATABASE_URL is not set' : false,
  }, async () => {
    const schema = `kiancode_test_${randomBytes(16).toString('hex')}`;
    const admin = backend === 'PostgreSQL'
      ? new Pool({ connectionString: databaseUrl, max: 1, connectionTimeoutMillis: 5000 })
      : undefined;
    let directory: string | undefined;
    const principal: Principal = {
      id: 'dispatch-owner', level: 3, scopes: ['*'],
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    };
    let store: Store | undefined;
    let tasks: TaskService | undefined;
    let leases: WorkspaceWriteLeaseService;
    let attempts = 0;
    let modelCalls = 0;
    let loseReceipt = false;
    const effectId = 'persisted-effect';
    const messages: ChatMessage[] = [
      { role: 'assistant', content: '', toolCalls: [{ id: 'call-1', name: 'write', arguments: {} }] },
      { role: 'assistant', content: '', toolCalls: [{ id: 'call-1', name: 'write', arguments: {} }] },
      { role: 'assistant', content: '', toolCalls: [{ id: 'call-1', name: 'read', arguments: {} }] },
      { role: 'assistant', content: 'Verified' },
      { role: 'assistant', content: '', toolCalls: [{ id: 'call-1', name: 'write', arguments: {} }] },
    ];
    const provider: ModelProvider = {
      id: 'persistent-dispatch', locality: 'local',
      async chat() {
        modelCalls += 1;
        const message = messages.shift();
        assert.ok(message, 'Unexpected provider call after an unknown effect');
        return { message, usage: { inputTokens: 1, outputTokens: 1 } };
      },
    };
    const open = async (): Promise<Store> => {
      await tasks?.close();
      await store?.close();
      store = backend === 'PostgreSQL'
        ? await PostgresStore.connect(databaseUrl, { schema })
        : new SqliteStore(join(directory!, 'state.sqlite'));
      leases = new WorkspaceWriteLeaseService(store);
      const write: ToolDefinition = leases.wrap({
        name: 'write', description: 'Write one test record', inputSchema: { type: 'object' },
        requiredCapabilities: [], requiresWorkspace: true, sideEffect: 'write',
        async execute() {
          attempts += 1;
          if (attempts === 1) throw notDispatched('offline', 'Write was refused before dispatch', 503);
          const previous = await store!.get<{ count: number }>('effect', effectId, principal.id);
          await store!.put('effect', effectId, principal.id, { count: previous!.data.count + 1 }, previous!.revision);
          if (loseReceipt) throw new Error('Receipt was lost after the record changed');
          return { content: 'Written' };
        },
      });
      const read: ToolDefinition = {
        name: 'read', description: 'Verify the test record', inputSchema: { type: 'object' },
        requiredCapabilities: [], requiresWorkspace: true, sideEffect: 'read',
        async execute() {
          return { content: JSON.stringify((await store!.get('effect', effectId, principal.id))!.data) };
        },
      };
      const runtime = new AgentRuntime({
        providers: [provider],
        models: [{ id: 'local-model', providerId: provider.id, locality: 'local', capabilities: ['tools'] }],
        tools: [write, read],
      });
      tasks = new TaskService(store, createTaskRunner(store, runtime, [write, read]), {
        reauthorize: async (current) => current,
      });
      return store;
    };
    try {
      if (admin) await admin.query(`CREATE SCHEMA ${schema}`);
      else directory = await mkdtemp(join(tmpdir(), 'kiancode-dispatch-'));
      let current = await open();
      await current.create('effect', principal.id, { count: 0 }, effectId);
      const workspace = await current.create<Workspace>('workspace', principal.id, {
        id: 'dispatch-workspace', ownerId: principal.id, name: 'Dispatch', root: '/project', deviceId: 'server',
        capabilities: [], allowCloud: false,
      }, 'dispatch-workspace');
      const conversation = await current.create<Conversation>('conversation', principal.id, {
        title: 'Dispatch', scope: 'private', modelPolicy: 'local', strategy: 'single', mode: 'act',
        archived: false, workspaceId: workspace.id,
      });
      const first = await tasks!.enqueue(principal, conversation.id, 'Write and verify');
      await tasks!.drain();
      let task = (await current.get<Task>('task', first.id, principal.id))!;
      const initialAction = task.data.pendingActions[0]!;
      assert.equal(task.data.state, 'waiting_for_approval');
      await tasks!.control(principal.id, first.id, 'resume', [initialAction.hash], principal);
      await tasks!.drain();
      task = (await current.get<Task>('task', first.id, principal.id))!;
      const retryAction = task.data.pendingActions[0]!;
      assert.equal(task.data.state, 'waiting_for_approval', task.data.error);
      assert.notEqual(retryAction.hash, initialAction.hash);
      assert.notEqual(retryAction.toolOccurrenceId, initialAction.toolOccurrenceId);
      assert.equal((await leases!.get(principal.id, workspace.id))?.data.state, 'released');
      assert.equal((await current.get<{ count: number }>('effect', effectId, principal.id))!.data.count, 0);

      current = await open();
      task = (await current.get<Task>('task', first.id, principal.id))!;
      assert.deepEqual(task.data.pendingActions[0], retryAction);
      await tasks!.control(principal.id, first.id, 'resume', [retryAction.hash], principal);
      await tasks!.drain();
      task = (await current.get<Task>('task', first.id, principal.id))!;
      assert.equal(task.data.state, 'completed', task.data.error);
      assert.equal((await current.get<{ count: number }>('effect', effectId, principal.id))!.data.count, 1);
      const results = (await tasks!.events(principal.id, first.id))
        .filter((event) => event.data.type === 'tool_result')
        .map((event) => event.data.payload as { toolOccurrenceId?: string; outcome?: string; notDispatched?: boolean });
      assert.deepEqual(results.slice(0, 2).map((result) => [result.toolOccurrenceId, result.outcome]), [
        [initialAction.toolOccurrenceId, 'failed'], [retryAction.toolOccurrenceId, 'confirmed'],
      ]);
      assert.equal(results[0]?.notDispatched, true);

      loseReceipt = true;
      const second = await tasks!.enqueue(principal, conversation.id, 'Write with a lost receipt');
      await tasks!.drain();
      task = (await current.get<Task>('task', second.id, principal.id))!;
      await tasks!.control(principal.id, second.id, 'resume', [task.data.pendingActions[0]!.hash], principal);
      await tasks!.drain();
      assert.equal((await current.get<Task>('task', second.id, principal.id))!.data.state, 'unknown');
      assert.equal((await leases!.get(principal.id, workspace.id))?.data.state, 'unknown');
      const callsBeforeRestart = modelCalls;
      current = await open();
      await tasks!.drain();
      assert.equal((await current.get<Task>('task', second.id, principal.id))!.data.state, 'unknown');
      assert.equal((await leases!.get(principal.id, workspace.id))?.data.state, 'unknown');
      assert.equal((await current.get<{ count: number }>('effect', effectId, principal.id))!.data.count, 2);
      assert.equal(modelCalls, callsBeforeRestart);
      assert.equal(attempts, 3);
      await assert.rejects(tasks!.control(principal.id, second.id, 'resume', [], principal),
        (error: unknown) => error instanceof DomainError && error.code === 'terminal_task');
    } finally {
      try {
        await tasks?.close();
        await store?.close();
      } finally {
        try {
          await admin?.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
        } finally {
          await admin?.end();
          if (directory) await rm(directory, { recursive: true, force: true });
        }
      }
    }
  });
}
