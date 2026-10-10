import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import test from 'node:test';
import { Pool } from 'pg';
import { AccessService } from '../src/access.js';
import { markAutomationAuthorizationFailed } from '../src/automation-authorization.js';
import { DomainError, type Principal } from '../src/contracts.js';
import type { Conversation, Notification, Task } from '../src/domain.js';
import { AutomationDispatcher } from '../src/event-triggers.js';
import { NotificationService } from '../src/notifications.js';
import { SchedulerService, type AutomationSchedule } from '../src/scheduler.js';
import { PostgresStore } from '../src/storage/postgres.js';
import { TaskService } from '../src/tasks.js';

const databaseUrl = process.env.KIANCODE_TEST_DATABASE_URL ?? '';

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
        success: true, data: { active, credentialVersion, consentVersion },
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
        (async () => Response.json({ success: true, data: { active, credentialVersion, consentVersion } })) as typeof fetch,
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
