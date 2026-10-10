import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { AccessService } from '../src/access.js';
import { AgentCoordinator } from '../src/agents/coordinator.js';
import { markAutomationAuthorizationFailed } from '../src/automation-authorization.js';
import { DomainError, type Principal } from '../src/contracts.js';
import type { Conversation, Notification, Task } from '../src/domain.js';
import {
  AutomationDispatcher,
  EventTriggerService,
  type AutomationTaskQueue,
  type EventInboxItem,
} from '../src/event-triggers.js';
import { createServer } from '../src/http/server.js';
import { NotificationService } from '../src/notifications.js';
import { SchedulerService, type AutomationSchedule, type ScheduleOccurrence } from '../src/scheduler.js';
import { SqliteStore } from '../src/storage/sqlite.js';
import type { Entity, Store } from '../src/storage/store.js';
import { TaskService } from '../src/tasks.js';

const issuer = 'https://identity.example.test';
const ownerSubject = `acct_${'a'.repeat(32)}`;
const ownerId = createHash('sha256').update(`${issuer}\0${ownerSubject}`).digest('hex');
const now = Date.parse('2026-09-27T04:00:00.000Z');
const conversation: Conversation = {
  title: 'Automation', scope: 'private', modelPolicy: 'cloud', strategy: 'single', mode: 'act', archived: false,
};
const actor = (expiresAt?: string): Principal => ({
  id: ownerId,
  issuer,
  subject: ownerSubject,
  level: 1,
  scopes: ['*'],
  applicationId: 'kiancode-plus',
  audience: 'kiancode',
  credentialVersion: 3,
  consentVersion: 1,
  ...(expiresAt ? { expiresAt } : {}),
});

function hasCode(code: string): (error: unknown) => boolean {
  return (error) => error instanceof DomainError && error.code === code;
}

class StampFaultStore implements Store {
  public failed = false;

  public constructor(private readonly delegate: Store) {}

  create<T>(kind: string, ownerId: string, data: T, id?: string): Promise<Entity<T>> {
    return this.delegate.create(kind, ownerId, data, id);
  }

  get<T>(kind: string, id: string, ownerId: string): Promise<Entity<T> | undefined> {
    return this.delegate.get(kind, id, ownerId);
  }

  scan<T>(kind: string, ownerId?: string): Promise<Array<Entity<T>>> {
    return this.delegate.scan(kind, ownerId);
  }

  put<T>(kind: string, id: string, ownerId: string, data: T, revision: number): Promise<Entity<T>> {
    if (!this.failed && kind === 'automation_schedule'
      && (data as { authorizationFailedAt?: string }).authorizationFailedAt) {
      this.failed = true;
      return Promise.reject(new Error('stamp storage failed'));
    }
    return this.delegate.put(kind, id, ownerId, data, revision);
  }

  remove(kind: string, id: string, ownerId: string, revision: number): Promise<boolean> {
    return this.delegate.remove(kind, id, ownerId, revision);
  }

  close(): Promise<void> {
    return this.delegate.close();
  }
}

test('dispatcher creates a durable marker only after current account authorization succeeds', async () => {
  const store = new SqliteStore();
  let active = false;
  const authenticatedAt = 1_700_000_000;
  const issued = { ...actor(), grantVersion: 5, authenticatedAt };
  let authorizationBody: Record<string, unknown> | undefined;
  const access = new AccessService(store, ownerSubject, 'service-token', 'account', undefined, (async (_input, init) => {
    authorizationBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return Response.json({
      success: true, data: { active, credentialVersion: 3, consentVersion: 1, grantVersion: 5 },
    });
  }) as typeof fetch, {}, { expectedIssuer: issuer, expectedAudience: 'kiancode' });
  const reauthorize = async (principal: Principal): Promise<Principal> => {
    if (!await access.validateDelegation(principal)) throw new DomainError('grant_revoked', 'revoked', 403);
    return access.authorize(principal);
  };
  const tasks = new TaskService(store, async () => ({ text: 'done' }), { reauthorize, durableGrants: true });
  try {
    const source = await store.create<Conversation>('conversation', ownerId, conversation);
    const dispatcher = new AutomationDispatcher(store, tasks, () => now);
    const settings = await dispatcher.snapshot(ownerId, {
      conversationId: source.id, permissions: ['model:read'], notification: { type: 'none' },
    });
    const input = {
      ownerId,
      source: 'schedule' as const,
      sourceId: 'schedule-1',
      sourceVersion: 4,
      occurrenceId: 'occurrence-1',
      prompt: 'Run',
      actor: issued,
      settings,
      reauthorize,
      durable: true,
    };
    await assert.rejects(dispatcher.dispatch(input), hasCode('grant_revoked'));
    assert.equal((await store.scan<Task>('task', ownerId)).length, 0);

    active = true;
    const task = await dispatcher.dispatch(input);
    assert.deepEqual(authorizationBody, {
      subject: ownerSubject,
      applicationId: 'kiancode-plus',
      credentialVersion: 3,
      consentVersion: 1,
      grantVersion: 5,
      authenticatedAt,
    });
    assert.equal(task.data.authorizationKind, 'account_automation');
    assert.deepEqual(task.data.automationSource, { type: 'schedule', id: 'schedule-1', version: 4 });
    assert.equal('expiresAt' in task.data.principal, false);
    assert.equal(task.data.principal.grantVersion, 5);
    assert.equal(task.data.principal.authenticatedAt, authenticatedAt);
    await assert.rejects(dispatcher.dispatch({ ...input, sourceVersion: 5 }), hasCode('idempotency_conflict'));
  } finally {
    await tasks.close();
    await store.close();
  }
});

test('durable dispatcher recovers legacy unmarked schedule and trigger tasks without upgrading their grant', async () => {
  const store = new SqliteStore();
  const tasks = new TaskService(store, async () => ({ text: 'done' }));
  try {
    const source = await store.create<Conversation>('conversation', ownerId, conversation);
    const dispatcher = new AutomationDispatcher(store, tasks, () => now);
    const settings = await dispatcher.snapshot(ownerId, {
      conversationId: source.id, permissions: ['model:read'], notification: { type: 'none' },
    });
    for (const sourceType of ['schedule', 'event_trigger'] as const) {
      const input = {
        ownerId,
        source: sourceType,
        sourceId: `${sourceType}-legacy`,
        sourceVersion: 3,
        occurrenceId: 'legacy-occurrence',
        prompt: `Legacy ${sourceType}`,
        actor: actor(),
        settings,
        reauthorize: async (principal: Principal) => principal,
      };
      const legacy = await dispatcher.dispatch(input);
      const originalGrant = legacy.data.grantExpiresAt;
      const recovered = await dispatcher.dispatch({ ...input, durable: true });
      assert.equal(recovered.id, legacy.id);
      assert.equal(recovered.data.authorizationKind, undefined);
      assert.equal(recovered.data.automationSource, undefined);
      assert.equal(recovered.data.grantExpiresAt, originalGrant);
    }

    const partialInput = {
      ownerId,
      source: 'schedule' as const,
      sourceId: 'partial',
      sourceVersion: 1,
      occurrenceId: 'partial-occurrence',
      prompt: 'Partial',
      actor: actor(),
      settings,
      reauthorize: async (principal: Principal) => principal,
    };
    const partial = await dispatcher.dispatch(partialInput);
    await store.put<Task>('task', partial.id, ownerId, {
      ...partial.data, authorizationKind: 'account_automation',
    }, partial.revision);
    await assert.rejects(dispatcher.dispatch({ ...partialInput, durable: true }), hasCode('idempotency_conflict'));

    const emptySourceInput = {
      ...partialInput,
      sourceId: 'empty-source',
      occurrenceId: 'empty-source-occurrence',
      prompt: 'Empty source',
    };
    const emptySource = await dispatcher.dispatch(emptySourceInput);
    await store.put<Task>('task', emptySource.id, ownerId, {
      ...emptySource.data,
      automationSource: {} as Task['automationSource'],
    }, emptySource.revision);
    await assert.rejects(
      dispatcher.dispatch({ ...emptySourceInput, durable: true }),
      hasCode('idempotency_conflict'),
    );
  } finally {
    await tasks.close();
    await store.close();
  }
});

test('upgraded schedule and trigger reconciliation recover a crash after legacy enqueue', async () => {
  const store = new SqliteStore();
  const tasks = new TaskService(store, async () => ({ text: 'done' }));
  let clock = now;
  const crashingQueue: AutomationTaskQueue = {
    async enqueue(...args: Parameters<TaskService['enqueue']>) {
      await tasks.enqueue(...args);
      throw new Error('crash after enqueue');
    },
  };
  const reauthorize = async (principal: Principal): Promise<Principal> => principal;
  try {
    const source = await store.create<Conversation>('conversation', ownerId, conversation);
    const settings = { conversationId: source.id, permissions: ['model:read'], notification: { type: 'none' as const } };
    const legacyDispatcher = new AutomationDispatcher(store, crashingQueue, () => clock);
    const legacySchedule = new SchedulerService(store, legacyDispatcher, {
      enabled: true, now: () => clock, reauthorize,
    });
    const schedule = await legacySchedule.create(actor(new Date(clock + 60_000).toISOString()), {
      name: 'Legacy schedule', prompt: 'Run schedule', nextAt: new Date(clock).toISOString(), enabled: true, settings,
    });
    await legacySchedule.reconcile();

    const legacyTriggers = new EventTriggerService(store, legacyDispatcher, {
      enabled: true, now: () => clock, reauthorize,
    });
    const created = await legacyTriggers.create(actor(new Date(clock + 60_000).toISOString()), {
      name: 'Legacy trigger', prompt: 'Run trigger', enabled: true, type: 'webhook', filter: {}, settings,
    });
    await legacyTriggers.ingestWebhook(created.trigger.data.webhook!.id, created.secret, {
      eventId: 'legacy-event', eventName: 'test', payload: {},
    });
    await legacyTriggers.reconcile();
    const legacyTasks = await store.scan<Task>('task', ownerId);
    assert.equal(legacyTasks.length, 2);
    assert.ok(legacyTasks.every((task) => task.data.authorizationKind === undefined
      && task.data.automationSource === undefined));

    clock += 2_001;
    const upgradedDispatcher = new AutomationDispatcher(store, tasks, () => clock);
    const upgradedSchedule = new SchedulerService(store, upgradedDispatcher, {
      enabled: true, now: () => clock, reauthorize, unattended: 'durable',
    });
    const upgradedTriggers = new EventTriggerService(store, upgradedDispatcher, {
      enabled: true, now: () => clock, reauthorize, unattended: 'durable',
    });
    await upgradedSchedule.reconcile();
    await upgradedTriggers.reconcile();

    const occurrences = await store.scan<ScheduleOccurrence>('schedule_occurrence', ownerId);
    const inbox = await store.scan<EventInboxItem>('event_inbox', ownerId);
    assert.equal(occurrences.find((row) => row.data.scheduleId === schedule.id)?.data.status, 'enqueued');
    assert.equal(inbox.find((row) => row.data.triggerId === created.trigger.id)?.data.status, 'enqueued');
    const recovered = await store.scan<Task>('task', ownerId);
    assert.equal(recovered.length, 2);
    assert.ok(recovered.every((task) => task.data.authorizationKind === undefined
      && task.data.automationSource === undefined));
  } finally {
    await tasks.close();
    await store.close();
  }
});

test('source authorization failure marking is owner- and version-bound and preserves the first stamp', async () => {
  const store = new SqliteStore();
  const failedAt = '2026-09-27T04:01:00.000Z';
  try {
    const schedule = await store.create('automation_schedule', ownerId, {
      enabled: true, version: 2, settings: { notification: { type: 'in_app' } },
    }, 'shared-id');
    await store.create('automation_schedule', 'other-owner', {
      enabled: true, version: 1, settings: { notification: { type: 'in_app' } },
    }, 'other-id');
    assert.equal(await markAutomationAuthorizationFailed(store, 'missing-owner', {
      type: 'schedule', id: schedule.id, version: 2,
    }, failedAt), 'missing');
    assert.equal(await markAutomationAuthorizationFailed(store, ownerId, {
      type: 'schedule', id: schedule.id, version: 1,
    }, failedAt), 'stale');
    assert.equal(await markAutomationAuthorizationFailed(store, ownerId, {
      type: 'schedule', id: schedule.id, version: 2,
    }, failedAt), 'marked');
    assert.equal(await markAutomationAuthorizationFailed(store, ownerId, {
      type: 'schedule', id: schedule.id, version: 2,
    }, '2026-09-27T04:02:00.000Z'), 'existing');
    const marked = await store.get<AutomationSchedule>('automation_schedule', schedule.id, ownerId);
    assert.equal(marked?.data.enabled, false);
    assert.equal(marked?.data.authorizationFailedAt, failedAt);
    assert.equal(marked?.data.authorizationFailedVersion, 2);
    assert.equal((await store.get<{ enabled: boolean }>('automation_schedule', 'other-id', 'other-owner'))?.data.enabled, true);
  } finally {
    await store.close();
  }
});

test('durable renewal requires a complete automation marker and transient identity errors retry', async () => {
  const store = new SqliteStore();
  let clock = now;
  let unavailable = false;
  let runs = 0;
  const tasks = new TaskService(store, async () => { runs += 1; return { text: 'done' }; }, {
    now: () => clock,
    durableGrants: true,
    reauthorize: async (principal) => {
      if (unavailable) throw new DomainError('identity_unavailable', 'offline', 503);
      return principal;
    },
  });
  try {
    const source = await store.create<Conversation>('conversation', ownerId, conversation);
    const ordinary = await tasks.enqueue(actor(), source.id, 'ordinary');
    const durable = await tasks.enqueue(actor(), source.id, 'durable', undefined, [], [], undefined, undefined, {
      authorizationKind: 'account_automation',
      automationSource: { type: 'schedule', id: 'schedule-1', version: 1 },
    });
    clock += 3_600_001;
    unavailable = true;
    await tasks.drain();
    assert.equal((await store.get<Task>('task', ordinary.id, ownerId))?.data.state, 'paused');
    assert.equal((await store.get<Task>('task', durable.id, ownerId))?.data.state, 'queued');
    unavailable = false;
    clock += 30_001;
    await tasks.drain();
    const completed = await store.get<Task>('task', durable.id, ownerId);
    assert.equal(completed?.data.state, 'completed');
    assert.equal(completed?.data.grantExpiresAt, new Date(clock + 3_600_000).toISOString());
    assert.equal(runs, 1);
  } finally {
    await tasks.close();
    await store.close();
  }
});

test('automation execution rejects a reauthorized principal from a newer consent epoch', async () => {
  const store = new SqliteStore();
  let runs = 0;
  const tasks = new TaskService(store, async () => { runs += 1; return { text: 'must not run' }; }, {
    now: () => now,
    durableGrants: true,
    reauthorize: async (principal) => ({ ...principal, consentVersion: 2 }),
  });
  try {
    const source = await store.create<Conversation>('conversation', ownerId, conversation);
    const task = await tasks.enqueue(actor(), source.id, 'Old consent epoch', undefined, [], [], undefined, undefined, {
      authorizationKind: 'account_automation',
      automationSource: { type: 'schedule', id: 'schedule-old-consent', version: 1 },
    });
    await tasks.drain();
    const paused = (await store.get<Task>('task', task.id, ownerId))!;
    assert.equal(paused.data.state, 'paused');
    assert.equal(paused.data.principal.consentVersion, 1);
    assert.equal(runs, 0);
  } finally {
    await tasks.close();
    await store.close();
  }
});

test('a permanent task denial stamps its exact source before preserving an unknown outcome', async () => {
  const store = new SqliteStore();
  const failedAt = new Date(now).toISOString();
  const tasks = new TaskService(store, async ({ onEvent }) => {
    await onEvent({ type: 'tool_dispatched', toolCallId: 'write-1', sideEffect: 'write' });
    throw new DomainError('access_required', 'revoked', 403);
  }, { now: () => now, durableGrants: true, reauthorize: async (principal) => principal });
  try {
    const source = await store.create<Conversation>('conversation', ownerId, conversation);
    await store.create('automation_schedule', ownerId, {
      enabled: true, version: 7, settings: { notification: { type: 'in_app' } },
    }, 'schedule-7');
    const task = await tasks.enqueue(actor(), source.id, 'write', undefined, [], [], undefined, undefined, {
      authorizationKind: 'account_automation',
      automationSource: { type: 'schedule', id: 'schedule-7', version: 7 },
    });
    await tasks.drain();
    assert.equal((await store.get<Task>('task', task.id, ownerId))?.data.state, 'unknown');
    const schedule = await store.get<AutomationSchedule>('automation_schedule', 'schedule-7', ownerId);
    assert.equal(schedule?.data.enabled, false);
    assert.equal(schedule?.data.authorizationFailedAt, failedAt);
  } finally {
    await tasks.close();
    await store.close();
  }
});

test('failure version deduplication emits a second notification even in the same millisecond', async () => {
  const store = new SqliteStore();
  const notifications = new NotificationService(store, { now: () => new Date(now) });
  const occurredAt = new Date(now).toISOString();
  try {
    let schedule = await store.create('automation_schedule', ownerId, {
      enabled: false,
      version: 1,
      authorizationFailedAt: occurredAt,
      authorizationFailedVersion: 1,
      settings: { notification: { type: 'in_app' } },
    }, 'notify-schedule');
    await notifications.reconcile();
    schedule = await store.put('automation_schedule', schedule.id, ownerId, {
      ...schedule.data,
      version: 2,
      authorizationFailedVersion: 2,
    }, schedule.revision);
    await notifications.reconcile();
    const rows = await store.scan<Notification>('notification', ownerId);
    assert.equal(rows.length, 2);
    assert.deepEqual(rows.map((row) => row.data.dedupeKey).sort(), [
      'schedule:notify-schedule:authorization:1',
      'schedule:notify-schedule:authorization:2',
    ]);
  } finally {
    await store.close();
  }
});

test('HTTP callers cannot inject automation authorization context into ordinary tasks', async () => {
  const store = new SqliteStore();
  const principal: Principal = { id: 'local-owner', level: 1, scopes: ['*'] };
  const server = await createServer({
    store,
    authenticate: async () => principal,
    runner: async () => ({ text: 'done' }),
  });
  try {
    const source = await server.app.inject({ method: 'POST', url: '/v1/conversations', payload: { title: 'HTTP' } });
    const fake = await server.app.inject({
      method: 'POST',
      url: `/v1/conversations/${source.json().data.id}/messages`,
      payload: {
        content: 'Run',
        authorizationKind: 'account_automation',
        automationSource: { type: 'schedule', id: 'fake', version: 1 },
      },
    });
    assert.equal(fake.statusCode, 400, fake.body);
    const accepted = await server.app.inject({
      method: 'POST', url: `/v1/conversations/${source.json().data.id}/messages`, payload: { content: 'Run' },
    });
    assert.equal(accepted.statusCode, 202, accepted.body);
    assert.equal(accepted.json().data.data.authorizationKind, undefined);
    assert.equal(accepted.json().data.data.automationSource, undefined);
  } finally {
    await server.close();
  }
});

test('OIDC mode preserves disabled drafts but refuses enabled schedules and triggers', async () => {
  const store = new SqliteStore();
  const tasks = new TaskService(store, async () => ({ text: 'unused' }));
  try {
    const source = await store.create<Conversation>('conversation', ownerId, conversation);
    const dispatcher = new AutomationDispatcher(store, tasks, () => now);
    const scheduler = new SchedulerService(store, dispatcher, { enabled: true, now: () => now, unattended: 'unsupported' });
    const triggers = new EventTriggerService(store, dispatcher, { enabled: true, now: () => now, unattended: 'unsupported' });
    const settings = { conversationId: source.id, permissions: ['model:read'], notification: { type: 'none' as const } };
    const draft = await scheduler.create(actor(new Date(now + 60_000).toISOString()), {
      name: 'Draft', prompt: 'Later', nextAt: new Date(now + 60_000).toISOString(), enabled: false, settings,
    });
    assert.equal(draft.data.enabled, false);
    await assert.rejects(scheduler.setEnabled(actor(new Date(now + 60_000).toISOString()), draft.id, draft.revision, true), hasCode('unattended_automation_unsupported'));
    await assert.rejects(triggers.create(actor(new Date(now + 60_000).toISOString()), {
      name: 'Hook', prompt: 'Run', enabled: true, type: 'webhook', filter: {}, settings,
    }), hasCode('unattended_automation_unsupported'));
  } finally {
    await tasks.close();
    await store.close();
  }
});

test('a materialized one-shot task stamps its original source once when later access is denied', async () => {
  const store = new SqliteStore();
  let allowed = true;
  const notifications = new NotificationService(store, { now: () => new Date(now) });
  const reauthorize = async (principal: Principal): Promise<Principal> => {
    if (!allowed) throw new DomainError('access_required', 'revoked', 403);
    return principal;
  };
  const tasks = new TaskService(store, async () => ({ text: 'done' }), {
    now: () => now,
    reauthorize,
    durableGrants: true,
    notifications,
  });
  try {
    const source = await store.create<Conversation>('conversation', ownerId, conversation);
    const dispatcher = new AutomationDispatcher(store, tasks, () => now);
    const scheduler = new SchedulerService(store, dispatcher, {
      enabled: true, now: () => now, reauthorize, unattended: 'durable',
    });
    const schedule = await scheduler.create(actor(new Date(now + 60_000).toISOString()), {
      name: 'Once', prompt: 'Run once', nextAt: new Date(now).toISOString(), enabled: true,
      settings: { conversationId: source.id, permissions: ['model:read'], notification: { type: 'in_app' } },
    });
    await scheduler.reconcile();
    assert.equal((await store.scan<Task>('task', ownerId)).length, 1);
    allowed = false;
    await tasks.drain();
    await notifications.reconcile();
    await notifications.reconcile();

    const stopped = await store.get<AutomationSchedule>('automation_schedule', schedule.id, ownerId);
    assert.equal(stopped?.data.enabled, false);
    assert.equal(stopped?.data.authorizationFailedVersion, 1);
    assert.ok(stopped?.data.authorizationFailedAt);
    assert.equal((await store.scan<Notification>('notification', ownerId)).length, 1);
    await scheduler.reconcile();
    assert.equal((await store.scan<Task>('task', ownerId)).length, 1);
    assert.equal((await store.scan('schedule_occurrence', ownerId)).length, 1);
  } finally {
    await tasks.close();
    await store.close();
  }
});

test('Account 401 dispatch outage retries without stamping or disabling its schedule', async () => {
  const store = new SqliteStore();
  let clock = now;
  let available = false;
  const access = new AccessService(store, ownerSubject, 'service-token', 'account', undefined, (async () => available
    ? Response.json({ success: true, data: { active: true, credentialVersion: 3, consentVersion: 1, grantVersion: 0 } })
    : new Response(null, { status: 401 })) as typeof fetch, {}, {
    expectedIssuer: issuer, expectedAudience: 'kiancode',
  });
  const reauthorize = async (principal: Principal): Promise<Principal> => {
    if (!await access.validateDelegation(principal)) throw new DomainError('grant_revoked', 'revoked', 403);
    return access.authorize(principal);
  };
  const reported: unknown[] = [];
  const tasks = new TaskService(store, async () => ({ text: 'done' }), { now: () => clock, reauthorize, durableGrants: true });
  try {
    const source = await store.create<Conversation>('conversation', ownerId, conversation);
    const scheduler = new SchedulerService(store, new AutomationDispatcher(store, tasks, () => clock), {
      enabled: true,
      now: () => clock,
      reauthorize,
      unattended: 'durable',
      onError: (error) => reported.push(error),
    });
    const schedule = await scheduler.create(actor(new Date(clock + 60_000).toISOString()), {
      name: 'Retry', prompt: 'Run', nextAt: new Date(clock).toISOString(), intervalSeconds: 3_600, enabled: true,
      settings: { conversationId: source.id, permissions: ['model:read'], notification: { type: 'none' } },
    });
    await scheduler.reconcile();
    let stored = await store.get<AutomationSchedule>('automation_schedule', schedule.id, ownerId);
    assert.equal(stored?.data.enabled, true);
    assert.equal(stored?.data.authorizationFailedAt, undefined);
    assert.equal((await store.scan<Task>('task', ownerId)).length, 0);
    assert.equal((reported[0] as DomainError).code, 'identity_unavailable');

    available = true;
    clock += 2_001;
    await scheduler.reconcile();
    stored = await store.get<AutomationSchedule>('automation_schedule', schedule.id, ownerId);
    assert.equal(stored?.data.authorizationFailedAt, undefined);
    assert.equal((await store.scan<Task>('task', ownerId)).length, 1);
  } finally {
    await tasks.close();
    await store.close();
  }
});

test('resuming a marked automation task preserves its durability and scope ceiling', async () => {
  const store = new SqliteStore();
  const durable = { ...actor(), scopes: ['model:read'] };
  const tasks = new TaskService(store, async () => ({ text: 'done' }), {
    now: () => now,
    durableGrants: true,
    reauthorize: async (principal) => principal,
  });
  try {
    const source = await store.create<Conversation>('conversation', ownerId, conversation);
    const task = await tasks.enqueue(durable, source.id, 'Resume', undefined, [], [], undefined, undefined, {
      authorizationKind: 'account_automation',
      automationSource: { type: 'event_trigger', id: 'trigger-1', version: 1 },
    });
    await tasks.control(ownerId, task.id, 'pause');
    const currentActor = actor(new Date(now + 60_000).toISOString());
    for (const changed of [
      { ...currentActor, credentialVersion: 4 },
      { ...currentActor, consentVersion: 2 },
      { ...currentActor, applicationId: 'different-client' },
      { ...currentActor, audience: 'different-audience' },
      { ...currentActor, issuer: 'https://different-identity.example.test' },
      { ...currentActor, subject: `acct_${'b'.repeat(32)}` },
    ]) {
      await assert.rejects(tasks.control(ownerId, task.id, 'resume', [], changed), hasCode('grant_revoked'));
      assert.equal((await store.get<Task>('task', task.id, ownerId))?.data.principal.consentVersion, 1);
    }
    const resumed = await tasks.control(ownerId, task.id, 'resume', [], currentActor);
    assert.equal('expiresAt' in resumed.data.principal, false);
    assert.deepEqual(resumed.data.principal.scopes, ['model:read']);
    assert.equal(resumed.data.principal.credentialVersion, 3);
    assert.equal(resumed.data.principal.consentVersion, 1);
    assert.equal(resumed.data.authorizationKind, 'account_automation');
    assert.deepEqual(resumed.data.automationSource, { type: 'event_trigger', id: 'trigger-1', version: 1 });

    const coordinator = new AgentCoordinator(
      store,
      (id, childId, action, principal) => tasks.control(id, childId, action, [], principal),
    );
    const plan = await coordinator.prepare(ownerId, task.id, {
      key: 'automation-child-version',
      children: [{ key: 'child', prompt: 'Continue' }],
      budget: { maxCalls: 3, maxTokens: 1_000 },
    });
    const [child] = await coordinator.runChildren(ownerId, plan.id);
    const nestedPlan = await coordinator.prepare(ownerId, child!.id, {
      key: 'automation-nested-version',
      children: [{ key: 'nested', prompt: 'Continue nested' }],
    });
    const [nested] = await coordinator.runChildren(ownerId, nestedPlan.id);
    await coordinator.propagateControl(ownerId, task.id, 'pause');
    await assert.rejects(
      coordinator.propagateControl(ownerId, task.id, 'resume', { ...currentActor, consentVersion: 2 }),
      hasCode('grant_revoked'),
    );
    await assert.rejects(
      tasks.control(ownerId, nested!.id, 'resume', [], { ...currentActor, consentVersion: 2 }),
      hasCode('grant_revoked'),
    );
    assert.equal((await store.get<Task>('task', child!.id, ownerId))?.data.principal.consentVersion, 1);
    assert.equal((await store.get<Task>('task', nested!.id, ownerId))?.data.principal.consentVersion, 1);
  } finally {
    await tasks.close();
    await store.close();
  }
});

test('marked automation reconciliation and legacy resume cannot replace the stored authorization epoch', async () => {
  const store = new SqliteStore();
  const durable = { ...actor(), scopes: ['approval:write'] };
  const tasks = new TaskService(store, async () => ({ text: 'unused' }), {
    now: () => now,
    durableGrants: true,
    reauthorize: async (principal) => principal,
  });
  try {
    const source = await store.create<Conversation>('conversation', ownerId, conversation);
    const authorization = {
      authorizationKind: 'account_automation' as const,
      automationSource: { type: 'schedule' as const, id: 'schedule-version', version: 1 },
    };
    const unknown = await tasks.enqueue(durable, source.id, 'Reconcile', undefined, [], [], undefined, undefined, authorization);
    await store.put<Task>('task', unknown.id, ownerId, {
      ...unknown.data,
      state: 'unknown',
      error: 'Outcome unknown',
    }, unknown.revision);
    await assert.rejects(
      tasks.reconcileOutcome({ ...actor(), consentVersion: 2 }, unknown.id, { resolution: 'abandon' }),
      hasCode('grant_revoked'),
    );
    const unchanged = (await store.get<Task>('task', unknown.id, ownerId))!;
    assert.equal(unchanged.data.state, 'unknown');
    assert.equal(unchanged.data.reconciliation, undefined);
    assert.equal(unchanged.data.principal.consentVersion, 1);

    const { consentVersion: _consentVersion, ...legacyPrincipal } = durable;
    const legacy = await tasks.enqueue(legacyPrincipal, source.id, 'Legacy', undefined, [], [], undefined, undefined, {
      ...authorization,
      automationSource: { ...authorization.automationSource, id: 'legacy-version' },
    });
    await tasks.control(ownerId, legacy.id, 'pause');
    await assert.rejects(
      tasks.control(ownerId, legacy.id, 'resume', [], actor(new Date(now + 60_000).toISOString())),
      hasCode('grant_revoked'),
    );
    assert.equal((await store.get<Task>('task', legacy.id, ownerId))?.data.principal.consentVersion, undefined);
  } finally {
    await tasks.close();
    await store.close();
  }
});

test('background execution observes a stamp storage failure and recovers it after the lease expires', async () => {
  const database = new SqliteStore();
  const store = new StampFaultStore(database);
  const reported: unknown[] = [];
  const tasks = new TaskService(store, async () => {
    throw new DomainError('access_required', 'revoked', 403);
  }, {
    leaseMs: 20,
    heartbeatMs: 1_000,
    durableGrants: true,
    reauthorize: async (principal) => principal,
    onError: (error) => reported.push(error),
  });
  try {
    const source = await store.create<Conversation>('conversation', ownerId, conversation);
    await store.create('automation_schedule', ownerId, {
      enabled: true, version: 1, settings: { notification: { type: 'none' } },
    }, 'faulted-schedule');
    const task = await tasks.enqueue(actor(), source.id, 'Recover stamp', undefined, [], [], undefined, undefined, {
      authorizationKind: 'account_automation',
      automationSource: { type: 'schedule', id: 'faulted-schedule', version: 1 },
    });
    tasks.start(5);
    const deadline = Date.now() + 2_000;
    while (Date.now() < deadline) {
      const current = await store.get<Task>('task', task.id, ownerId);
      const schedule = await store.get<AutomationSchedule>('automation_schedule', 'faulted-schedule', ownerId);
      if (current?.data.state === 'paused' && schedule?.data.authorizationFailedAt) break;
      await delay(10);
    }

    const recovered = await store.get<Task>('task', task.id, ownerId);
    const schedule = await store.get<AutomationSchedule>('automation_schedule', 'faulted-schedule', ownerId);
    assert.equal(store.failed, true);
    assert.equal(recovered?.data.state, 'paused');
    assert.equal(schedule?.data.enabled, false);
    assert.equal(schedule?.data.authorizationFailedVersion, 1);
    assert.equal(reported.filter((error) => error instanceof Error && error.message === 'stamp storage failed').length, 1);
  } finally {
    await tasks.close();
    await store.close();
  }
});
