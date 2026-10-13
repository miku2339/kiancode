import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import test from 'node:test';
import { Pool } from 'pg';
import { AccessService } from '../src/access.js';
import { AgentCoordinator } from '../src/agents/coordinator.js';
import { markAutomationAuthorizationFailed } from '../src/automation-authorization.js';
import { DomainError, type Principal } from '../src/contracts.js';
import type { Conversation, Notification, Task } from '../src/domain.js';
import { AutomationDispatcher, EventTriggerService, type EventTrigger } from '../src/event-triggers.js';
import { NotificationService } from '../src/notifications.js';
import { SchedulerService, type AutomationSchedule } from '../src/scheduler.js';
import { PostgresStore } from '../src/storage/postgres.js';
import { TaskService } from '../src/tasks.js';

const databaseUrl = process.env.KIANCODE_TEST_DATABASE_URL ?? '';

test('PostgreSQL: Account authorization tuple persists across tasks, automations, children, and restart', {
  skip: databaseUrl ? false : 'KIANCODE_TEST_DATABASE_URL is not set',
}, async () => {
  const schema = `kiancode_test_${randomBytes(16).toString('hex')}`;
  const admin = new Pool({ connectionString: databaseUrl, max: 1, connectionTimeoutMillis: 5000 });
  const issuer = 'https://identity.example.test';
  const subject = `acct_${'c'.repeat(32)}`;
  const ownerId = createHash('sha256').update(`${issuer}\0${subject}`).digest('hex');
  const clock = Date.now();
  const grantVersion = 7;
  const authenticatedAt = Math.floor(clock / 1_000) - 60;
  let store: PostgresStore | undefined;
  let tasks: TaskService | undefined;
  let access: AccessService | undefined;
  let authorizationBody: Record<string, unknown> | undefined;
  const actor = (): Principal => ({
    id: ownerId,
    issuer,
    subject,
    level: 1,
    scopes: ['*'],
    applicationId: 'standalone',
    audience: 'kiancode',
    credentialVersion: 3,
    consentVersion: 2,
    grantVersion,
    authenticatedAt,
    expiresAt: new Date(clock + 900_000).toISOString(),
  });
  const assertTuple = (principal: { grantVersion?: number; authenticatedAt?: number }): void => {
    assert.equal(principal.grantVersion, grantVersion);
    assert.equal(principal.authenticatedAt, authenticatedAt);
  };
  const open = async (): Promise<void> => {
    await tasks?.close();
    await store?.close();
    store = await PostgresStore.connect(databaseUrl, { schema });
    access = new AccessService(
      store,
      subject,
      'synthetic-service-token',
      'account',
      undefined,
      (async (_input, init) => {
        authorizationBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return Response.json({
          success: true,
          data: { active: true, credentialVersion: 3, consentVersion: 2, grantVersion },
        });
      }) as typeof fetch,
      {},
      { expectedIssuer: issuer, expectedAudience: 'kiancode' },
    );
    const reauthorize = async (principal: Principal): Promise<Principal> => {
      if (!await access!.validateDelegation(principal)) throw new DomainError('grant_revoked', 'Revoked', 403);
      return access!.authorize(principal);
    };
    tasks = new TaskService(store, async () => ({ text: 'unused' }), {
      now: () => clock,
      durableGrants: true,
      reauthorize,
    });
  };
  try {
    await admin.query(`CREATE SCHEMA ${schema}`);
    await open();
    const conversation = await store!.create<Conversation>('conversation', ownerId, {
      title: 'Authorization tuple', scope: 'private', modelPolicy: 'cloud', strategy: 'single', mode: 'act', archived: false,
    });
    const authorization = { accountTaskGrant: access!.accountTaskGrant(actor())! };
    const parent = await tasks!.enqueue(
      actor(), conversation.id, 'Persist the admitted authorization', undefined, [], [], undefined, undefined, authorization,
    );
    const resumable = await tasks!.enqueue(
      actor(), conversation.id, 'Reject a replacement authorization', undefined, [], [], undefined, undefined, authorization,
    );
    await tasks!.control(ownerId, resumable.id, 'pause');

    const dispatcher = new AutomationDispatcher(store!, tasks!, () => clock);
    const reauthorize = async (principal: Principal): Promise<Principal> => {
      if (!await access!.validateDelegation(principal)) throw new DomainError('grant_revoked', 'Revoked', 403);
      return access!.authorize(principal);
    };
    const scheduler = new SchedulerService(store!, dispatcher, {
      enabled: true, unattended: 'durable', now: () => clock, reauthorize,
    });
    const schedule = await scheduler.create(actor(), {
      name: 'Tuple schedule', prompt: 'Run later', enabled: true,
      nextAt: new Date(clock + 60_000).toISOString(),
      settings: { conversationId: conversation.id, permissions: ['model:read'], notification: { type: 'none' } },
    });
    const triggers = new EventTriggerService(store!, dispatcher, {
      enabled: true, unattended: 'durable', now: () => clock, reauthorize,
    });
    const trigger = await triggers.create(actor(), {
      name: 'Tuple trigger', prompt: 'Run from an event', enabled: true, type: 'webhook', filter: {},
      settings: { conversationId: conversation.id, permissions: ['model:read'], notification: { type: 'none' } },
    });

    const coordinator = new AgentCoordinator(store!, undefined, () => clock);
    const plan = await coordinator.prepare(ownerId, parent.id, {
      key: 'tuple-child',
      children: [{ key: 'worker', prompt: 'Keep the admitted tuple', scopes: ['model:read'] }],
      budget: { maxCalls: 2, maxTokens: 1_000 },
    });
    const [child] = await coordinator.runChildren(ownerId, plan.id);
    assert.ok(child);

    await open();
    const persistedParent = (await store!.get<Task>('task', parent.id, ownerId))!;
    const persistedResumable = (await store!.get<Task>('task', resumable.id, ownerId))!;
    const persistedChild = (await store!.get<Task>('task', child.id, ownerId))!;
    const persistedSchedule = (await store!.get<AutomationSchedule>('automation_schedule', schedule.id, ownerId))!;
    const persistedTrigger = (await store!.get<EventTrigger>('event_trigger', trigger.trigger.id, ownerId))!;
    for (const principal of [
      persistedParent.data.principal,
      persistedResumable.data.principal,
      persistedChild.data.principal,
      persistedSchedule.data.actor,
      persistedTrigger.data.actor,
    ]) assertTuple(principal);
    assertTuple(persistedParent.data.accountTaskGrant!);
    assertTuple(persistedResumable.data.accountTaskGrant!);
    assertTuple(persistedChild.data.accountTaskGrant!);
    assert.equal(persistedChild.data.accountTaskGrant?.rootTaskId, parent.id);
    assert.deepEqual(persistedChild.data.principal.scopes, ['model:read']);
    assert.deepEqual(persistedChild.data.accountTaskGrant?.scopes, ['model:read']);
    assert.equal(persistedSchedule.data.actor.expiresAt, undefined);
    assert.equal(persistedTrigger.data.actor.expiresAt, undefined);

    assert.equal(await access!.validateDelegation(persistedParent.data.principal), true);
    assert.deepEqual(authorizationBody, {
      subject,
      applicationId: 'standalone',
      credentialVersion: 3,
      consentVersion: 2,
      grantVersion,
      authenticatedAt,
    });
    await assert.rejects(
      tasks!.control(ownerId, resumable.id, 'resume', [], {
        ...actor(), grantVersion: grantVersion + 1, authenticatedAt: authenticatedAt + 60,
      }),
      (error: unknown) => error instanceof DomainError && error.code === 'grant_revoked',
    );
    const rejectedResume = (await store!.get<Task>('task', resumable.id, ownerId))!;
    assert.equal(rejectedResume.data.state, 'paused');
    assertTuple(rejectedResume.data.principal);
    assertTuple(rejectedResume.data.accountTaskGrant!);
  } finally {
    try {
      await tasks?.close();
      await store?.close();
    } finally {
      try {
        await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      } finally {
        await admin.end();
      }
    }
  }
});

test('PostgreSQL: durable automation survives session expiry and restart, retries outages, and preserves revoked outcomes', {
  skip: databaseUrl ? false : 'KIANCODE_TEST_DATABASE_URL is not set',
}, async () => {
  const schema = `kiancode_test_${randomBytes(16).toString('hex')}`;
  const admin = new Pool({ connectionString: databaseUrl, max: 1, connectionTimeoutMillis: 5000 });
  let store: PostgresStore | undefined;
  let tasks: TaskService | undefined;
  const issuer = 'https://identity.example.test';
  const subject = `acct_${'b'.repeat(32)}`;
  const ownerId = createHash('sha256').update(`${issuer}\0${subject}`).digest('hex');
  let clock = Date.now();
  let unavailable = false;
  let active = true;
  let revokeDuringRun = false;
  let credentialVersion = 3;
  let consentVersion = 1;
  let runs = 0;
  const actor = (): Principal => ({
    id: ownerId, issuer, subject, level: 1, scopes: ['*'],
    applicationId: 'standalone', audience: 'kiancode', credentialVersion, consentVersion,
    expiresAt: new Date(clock + 2_000).toISOString(),
  });
  const open = async (): Promise<PostgresStore> => {
    await tasks?.close();
    await store?.close();
    store = await PostgresStore.connect(databaseUrl, { schema });
    const access = new AccessService(store, subject, 'synthetic-service-token', 'account', undefined,
      (async () => unavailable ? new Response('', { status: 503 }) : Response.json({
        success: true, data: { active, credentialVersion, consentVersion, grantVersion: 0 },
      })) as typeof fetch, {}, { expectedIssuer: issuer, expectedAudience: 'kiancode' });
    const reauthorize = async (principal: Principal): Promise<Principal> => {
      if (!await access.validateDelegation(principal)) throw new DomainError('grant_revoked', 'Revoked', 403);
      return access.authorize(principal);
    };
    tasks = new TaskService(store, async ({ onEvent }) => {
      runs += 1;
      await onEvent({ type: 'model_call' });
      if (revokeDuringRun) {
        await onEvent({ type: 'tool_dispatched', toolCallId: 'write-1', sideEffect: 'write' });
        active = false;
        await onEvent({ type: 'model_call' });
      }
      return { text: 'Completed' };
    }, { now: () => clock, durableGrants: true, reauthorize });
    return store;
  };
  try {
    await admin.query(`CREATE SCHEMA ${schema}`);
    let currentStore = await open();
    const conversation = await currentStore.create<Conversation>('conversation', ownerId, {
      title: 'Automation', scope: 'private', modelPolicy: 'cloud', strategy: 'single', mode: 'act', archived: false,
    });
    const scheduler = (): SchedulerService => {
      const access = new AccessService(currentStore, subject, 'synthetic-service-token', 'account', undefined,
        (async () => Response.json({ success: true, data: { active, credentialVersion, consentVersion, grantVersion: 0 } })) as typeof fetch,
        {}, { expectedIssuer: issuer, expectedAudience: 'kiancode' });
      return new SchedulerService(currentStore, new AutomationDispatcher(currentStore, tasks!, () => clock), {
        enabled: true, unattended: 'durable', now: () => clock,
        reauthorize: async (principal) => {
          if (!await access.validateDelegation(principal)) throw new DomainError('grant_revoked', 'Revoked', 403);
          return access.authorize(principal);
        },
      });
    };
    const input = (name: string) => ({
      name, prompt: 'Run', enabled: true, nextAt: new Date(clock + 1_000).toISOString(),
      settings: {
        conversationId: conversation.id, permissions: ['model:read', 'workspace:write'],
        notification: { type: 'in_app' as const },
      },
    });
    const first = await scheduler().create(actor(), input('After session expiry'));
    clock += 2_001;
    await scheduler().reconcile();
    const queued = (await currentStore.scan<Task>('task', ownerId))[0]!;
    assert.equal(queued.data.authorizationKind, 'account_automation');
    assert.deepEqual(queued.data.automationSource, { type: 'schedule', id: first.id, version: 1 });
    assert.equal(queued.data.principal.expiresAt, undefined);
    assert.equal(queued.data.principal.consentVersion, 1);

    currentStore = await open();
    assert.equal((await currentStore.get<Task>('task', queued.id, ownerId))?.data.principal.consentVersion, 1);
    clock += 3_600_001;
    unavailable = true;
    await tasks!.drain();
    assert.equal((await currentStore.get<Task>('task', queued.id, ownerId))?.data.state, 'queued');
    assert.equal((await currentStore.get<AutomationSchedule>('automation_schedule', first.id, ownerId))?.data.authorizationFailedAt, undefined);
    assert.equal(runs, 0);
    unavailable = false;
    clock += 30_001;
    await tasks!.drain();
    assert.equal((await currentStore.get<Task>('task', queued.id, ownerId))?.data.state, 'completed');
    await scheduler().reconcile();
    await tasks!.drain();
    assert.equal(runs, 1);

    const second = await scheduler().create(actor(), input('Revoke after dispatch'));
    clock += 2_001;
    await scheduler().reconcile();
    revokeDuringRun = true;
    await tasks!.drain();
    const unknown = (await currentStore.scan<Task>('task', ownerId)).find((row) => row.id !== queued.id)!;
    assert.equal(unknown.data.state, 'unknown');
    const failed = await currentStore.get<AutomationSchedule>('automation_schedule', second.id, ownerId);
    assert.equal(failed?.data.authorizationFailedVersion, 1);
    assert.equal(failed?.data.enabled, false);

    currentStore = await open();
    const notifications = new NotificationService(currentStore, { now: () => new Date(clock) });
    await notifications.reconcile();
    await notifications.reconcile();
    const failures = (await currentStore.scan<Notification>('notification', ownerId))
      .filter((row) => row.data.type === 'schedule_authorization_failed');
    assert.equal(failures.length, 1);
    assert.equal(failures[0]?.data.scheduleId, second.id);
    await tasks!.drain();
    assert.equal(runs, 2);
    assert.equal((await currentStore.get<Task>('task', unknown.id, ownerId))?.data.state, 'unknown');

    active = true;
    credentialVersion += 1;
    const refreshed = await scheduler().setEnabled(actor(), second.id, failed!.revision, true);
    assert.equal(await markAutomationAuthorizationFailed(currentStore, ownerId, {
      type: 'schedule', id: second.id, version: 1,
    }, new Date(clock).toISOString()), 'stale');
    assert.equal((await currentStore.get<AutomationSchedule>('automation_schedule', second.id, ownerId))?.data.enabled, true);
    assert.equal(refreshed.data.version, 2);
    await scheduler().reconcile();
    await tasks!.drain();
    assert.equal(runs, 2);
  } finally {
    try {
      await tasks?.close();
      await store?.close();
    } finally {
      try {
        await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      } finally {
        await admin.end();
      }
    }
  }
});
