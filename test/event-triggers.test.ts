import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import Fastify from 'fastify';
import { DomainError, type Principal } from '../src/contracts.js';
import { developmentAuth } from '../src/auth.js';
import type { Conversation, Task } from '../src/domain.js';
import {
  AutomationDispatcher,
  EventTriggerService,
  type EventInboxItem,
} from '../src/event-triggers.js';
import { registerAutomationRoutes } from '../src/http/event-triggers-http.js';
import { createServer } from '../src/http/server.js';
import { DeviceConnectionRegistry } from '../src/http/device-socket.js';
import type { AgentProfile } from '../src/runtime/index.js';
import {
  cronScheduleNextAt,
  SchedulerService,
  type AutomationSchedule,
  type LegacyScheduleDraft,
  type ScheduleOccurrence,
} from '../src/scheduler.js';
import { SqliteStore } from '../src/storage/sqlite.js';
import type { Entity } from '../src/storage/store.js';
import { TaskService } from '../src/tasks.js';
import type { Plugin } from '../src/plugins.js';

const start = Date.parse('2026-09-27T04:00:00.000Z');
const owner = (expiresAt = '2026-09-27T06:00:00.000Z'): Principal => ({
  id: 'owner-1',
  level: 1,
  scopes: ['schedule:read', 'schedule:write', 'model:read', 'workspace:read'],
  expiresAt,
});

const baseConversation: Conversation = {
  title: 'Automation source',
  scope: 'private',
  modelPolicy: 'cloud',
  modelId: 'model-v1',
  strategy: 'single',
  mode: 'act',
  archived: false,
};

test('webhook secret, filter, event dedup and restart reconciliation enqueue one immutable task', async () => {
  const store = new SqliteStore();
  const tasks = new TaskService(store, async () => ({ text: 'unused' }));
  let now = start;
  try {
    const pluginV1 = 'a'.repeat(64);
    const pluginV2 = 'b'.repeat(64);
    const plugin = await store.create<Plugin>('plugin', owner().id, {
      name: 'Automation plugin', kind: 'skill', enabled: true, activeVersion: pluginV1, versions: [pluginV1, pluginV2],
    }, 'automation-plugin');
    const source = await store.create<Conversation>('conversation', owner().id, baseConversation);
    const dispatcher = new AutomationDispatcher(store, tasks, () => now);
    const firstService = new EventTriggerService(store, dispatcher, {
      enabled: true,
      now: () => now,
      reauthorize: async () => owner(),
    });
    const created = await firstService.create(owner(), {
      name: 'Build hook',
      prompt: 'Review the build event.',
      enabled: true,
      type: 'webhook',
      filter: { eventName: 'build.finished', equals: { 'result.status': 'ok' } },
      settings: {
        conversationId: source.id,
        permissions: ['model:read'],
        notification: { type: 'in_app' },
      },
    });
    assert.ok(created.secret?.startsWith('whsec_'));
    await store.put<Plugin>('plugin', plugin.id, plugin.ownerId, {
      ...plugin.data,
      activeVersion: pluginV2,
    }, plugin.revision);
    assert.equal(JSON.stringify(created.trigger).includes('secretHash'), false);
    const webhookId = created.trigger.data.webhook?.id;
    assert.ok(webhookId);

    const rotated = await firstService.rotateSecret(owner(), created.trigger.id, created.trigger.revision);
    await assert.rejects(
      firstService.ingestWebhook(webhookId, created.secret, {
        eventId: 'old-secret', eventName: 'build.finished', payload: { result: { status: 'ok' } },
      }),
      hasCode('invalid_webhook'),
    );

    await assert.rejects(
      firstService.ingestWebhook(webhookId, 'whsec_wrong', {
        eventId: 'event-1', eventName: 'build.finished', payload: { result: { status: 'ok' } },
      }),
      hasCode('invalid_webhook'),
    );
    await assert.rejects(
      firstService.ingestWebhook(webhookId, rotated.secret, {
        eventId: 'filtered', eventName: 'build.finished', payload: { result: { status: 'failed' } },
      }),
      hasCode('event_filtered'),
    );
    const event = await firstService.ingestWebhook(webhookId, rotated.secret, {
      eventId: 'event-1', eventName: 'build.finished', payload: { result: { status: 'ok' } },
    });
    const duplicate = await firstService.ingestWebhook(webhookId, rotated.secret, {
      eventId: 'event-1', eventName: 'build.finished', payload: { result: { status: 'ok' } },
    });
    assert.equal(event.id, duplicate.id);
    await assert.rejects(
      firstService.ingestWebhook(webhookId, rotated.secret, {
        eventId: 'event-1', eventName: 'build.finished', payload: { result: { status: 'ok', attempt: 2 } },
      }),
      hasCode('idempotency_conflict'),
    );

    const changed = await store.get<Conversation>('conversation', source.id, owner().id);
    assert.ok(changed);
    await store.put('conversation', source.id, owner().id, {
      ...changed.data,
      modelPolicy: 'local',
      modelId: 'model-v2',
    }, changed.revision);

    const restarted = new EventTriggerService(store, dispatcher, {
      enabled: true,
      now: () => now,
      reauthorize: async () => owner(),
    });
    await Promise.all([restarted.reconcile(), restarted.reconcile()]);
    assert.equal((await store.scan<Task>('task', owner().id)).length, 1);
    const inbox = await store.get<EventInboxItem>('event_inbox', event.id, owner().id);
    assert.equal(inbox?.data.status, 'enqueued');
    const task = (await store.scan<Task>('task', owner().id))[0];
    assert.deepEqual(task?.data.principal.scopes, ['model:read']);
    assert.equal(task?.data.pluginVersions?.['automation-plugin'], pluginV1);
    const executionConversation = await store.get<Conversation>('conversation', task!.data.conversationId, owner().id);
    assert.equal(executionConversation?.data.modelPolicy, 'cloud');
    assert.equal(executionConversation?.data.modelId, 'model-v1');
    assert.match(task!.data.prompt, /untrusted JSON/);
    assert.equal((await store.scan('automation_execution', owner().id)).length, 1);
  } finally {
    await tasks.close();
    await store.close();
  }
});

test('pending webhook inbox survives a SQLite close and is reconciled after reopen', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'kiancode-event-trigger-'));
  const database = path.join(directory, 'core.sqlite');
  let firstStore: SqliteStore | undefined;
  let firstTasks: TaskService | undefined;
  let secondStore: SqliteStore | undefined;
  let secondTasks: TaskService | undefined;
  try {
    firstStore = new SqliteStore(database);
    firstTasks = new TaskService(firstStore, async () => ({ text: 'unused' }));
    const source = await firstStore.create<Conversation>('conversation', owner().id, baseConversation);
    const first = new EventTriggerService(
      firstStore,
      new AutomationDispatcher(firstStore, firstTasks, () => start),
      { enabled: true, now: () => start, reauthorize: async () => owner() },
    );
    const created = await first.create(owner(), {
      name: 'Durable hook', prompt: 'Resume after restart', enabled: true, type: 'webhook', filter: {},
      settings: { conversationId: source.id, permissions: ['model:read'], notification: { type: 'none' } },
    });
    await first.ingestWebhook(created.trigger.data.webhook!.id, created.secret, {
      eventId: 'durable-event', eventName: 'test', payload: { sequence: 1 },
    });
    await firstTasks.close();
    firstTasks = undefined;
    await firstStore.close();
    firstStore = undefined;

    secondStore = new SqliteStore(database);
    secondTasks = new TaskService(secondStore, async () => ({ text: 'unused' }));
    const restarted = new EventTriggerService(
      secondStore,
      new AutomationDispatcher(secondStore, secondTasks, () => start),
      { enabled: true, now: () => start, reauthorize: async () => owner() },
    );
    await restarted.reconcile();
    assert.equal((await secondStore.scan<Task>('task', owner().id)).length, 1);
    assert.equal((await secondStore.scan<EventInboxItem>('event_inbox', owner().id))[0]?.data.status, 'enqueued');
  } finally {
    await firstTasks?.close();
    await firstStore?.close();
    await secondTasks?.close();
    await secondStore?.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('expired or low-privilege actors cannot create or execute event triggers', async () => {
  const store = new SqliteStore();
  const tasks = new TaskService(store, async () => ({ text: 'unused' }));
  let now = start;
  try {
    const source = await store.create<Conversation>('conversation', owner().id, baseConversation);
    const dispatcher = new AutomationDispatcher(store, tasks, () => now);
    const service = new EventTriggerService(store, dispatcher, {
      enabled: true,
      now: () => now,
      reauthorize: async () => owner('2026-09-27T06:00:00.000Z'),
    });
    await assert.rejects(service.create({ ...owner(), level: 5 }, {
      name: 'Denied', prompt: 'Never run', enabled: false, type: 'webhook', filter: {},
      settings: { conversationId: source.id, permissions: ['model:read'], notification: { type: 'none' } },
    }), hasCode('owner_required'));

    const shortActor = owner('2026-09-27T04:00:01.000Z');
    const created = await service.create(shortActor, {
      name: 'Expires', prompt: 'Never run after expiry', enabled: true, type: 'webhook', filter: {},
      settings: { conversationId: source.id, permissions: ['model:read'], notification: { type: 'none' } },
    });
    await service.ingestWebhook(created.trigger.data.webhook!.id, created.secret, {
      eventId: 'expires-1', eventName: 'test', payload: {},
    });
    now += 2_000;
    await service.reconcile();
    assert.equal((await store.scan<Task>('task', owner().id)).length, 0);
    const inbox = (await store.scan<EventInboxItem>('event_inbox', owner().id))[0];
    assert.equal(inbox?.data.status, 'rejected');
    assert.equal(inbox?.data.rejectionCode, 'actor_expired');
    const trigger = (await service.list(owner().id))[0];
    assert.equal(trigger?.data.enabled, false);
  } finally {
    await tasks.close();
    await store.close();
  }
});

test('device-online accepts only a broker-validated connection edge and deduplicates the edge', async () => {
  const store = new SqliteStore();
  const tasks = new TaskService(store, async () => ({ text: 'unused' }));
  try {
    const source = await store.create<Conversation>('conversation', owner().id, baseConversation);
    const dispatcher = new AutomationDispatcher(store, tasks, () => start);
    const unconfigured = new EventTriggerService(store, dispatcher, { enabled: true, now: () => start });
    await assert.rejects(unconfigured.ingestDeviceOnline({
      deviceId: 'device-1', connectionId: 'connection-1', connectedAt: new Date(start).toISOString(),
    }), hasCode('device_events_unavailable'));

    let validations = 0;
    const service = new EventTriggerService(store, dispatcher, {
      enabled: true,
      now: () => start,
      reauthorize: async () => owner(),
      validateDeviceConnection: async (edge) => {
        validations += 1;
        return { ownerId: owner().id, deviceId: edge.deviceId };
      },
    });
    await service.create(owner(), {
      name: 'Mac online', prompt: 'Check the device.', enabled: true, type: 'device_online',
      filter: { deviceIds: ['device-1'] },
      settings: { conversationId: source.id, permissions: ['model:read'], notification: { type: 'none' } },
    });
    const ignored = await service.ingestDeviceOnline({
      deviceId: 'device-2', connectionId: 'connection-1', connectedAt: new Date(start).toISOString(),
    });
    assert.deepEqual(ignored, []);
    const first = await service.ingestDeviceOnline({
      deviceId: 'device-1', connectionId: 'connection-1', connectedAt: new Date(start).toISOString(),
    });
    const duplicate = await service.ingestDeviceOnline({
      deviceId: 'device-1', connectionId: 'connection-1', connectedAt: new Date(start).toISOString(),
    });
    assert.equal(validations, 3);
    assert.equal(first[0]?.id, duplicate[0]?.id);
    assert.equal((await store.scan<EventInboxItem>('event_inbox', owner().id)).length, 1);
  } finally {
    await tasks.close();
    await store.close();
  }
});

test('automation execution remains disabled until the server explicitly enables it', async () => {
  const store = new SqliteStore();
  const tasks = new TaskService(store, async () => ({ text: 'unused' }));
  try {
    const source = await store.create<Conversation>('conversation', owner().id, baseConversation);
    const dispatcher = new AutomationDispatcher(store, tasks, () => start);
    const input = {
      name: 'Disabled hook', prompt: 'Do not run', enabled: true as const, type: 'webhook' as const, filter: {},
      settings: { conversationId: source.id, permissions: ['model:read'], notification: { type: 'none' as const } },
    };
    await assert.rejects(new EventTriggerService(store, dispatcher, { now: () => start }).create(owner(), input), hasCode('event_triggers_disabled'));
    await assert.rejects(new SchedulerService(store, dispatcher, { now: () => start }).create(owner(), {
      name: 'Disabled schedule', prompt: 'Do not run', enabled: true, nextAt: new Date(start).toISOString(),
      settings: input.settings,
    }), hasCode('scheduler_disabled'));
  } finally {
    await tasks.close();
    await store.close();
  }
});

test('deleting a trigger tombstones accepted inbox work and stale revisions have no side effects', async () => {
  const store = new SqliteStore();
  const tasks = new TaskService(store, async () => ({ text: 'unused' }));
  try {
    const source = await store.create<Conversation>('conversation', owner().id, baseConversation);
    const dispatcher = new AutomationDispatcher(store, tasks, () => start);
    const service = new EventTriggerService(store, dispatcher, {
      enabled: true, now: () => start, reauthorize: async () => owner(),
    });
    const created = await service.create(owner(), {
      name: 'Delete safely', prompt: 'Should not run', enabled: true, type: 'webhook', filter: {},
      settings: { conversationId: source.id, permissions: ['model:read'], notification: { type: 'none' } },
    });
    const inbox = await service.ingestWebhook(created.trigger.data.webhook!.id, created.secret, {
      eventId: 'delete-event', eventName: 'test', payload: {},
    });
    await assert.rejects(service.remove(owner(), created.trigger.id, created.trigger.revision + 1), hasCode('conflict'));
    assert.equal((await store.get<EventInboxItem>('event_inbox', inbox.id, owner().id))?.data.status, 'pending');
    await service.remove(owner(), created.trigger.id, created.trigger.revision);
    await service.reconcile();
    assert.equal((await store.get<EventInboxItem>('event_inbox', inbox.id, owner().id))?.data.status, 'rejected');
    assert.equal((await store.scan<Task>('task', owner().id)).length, 0);
  } finally {
    await tasks.close();
    await store.close();
  }
});

test('schedule freezes agent and model settings, coalesces missed intervals and edits future settings', async () => {
  const store = new SqliteStore();
  const tasks = new TaskService(store, async () => ({ text: 'unused' }));
  let now = start;
  try {
    const agent = await store.create<AgentProfile>('agent', owner().id, {
      systemPrompt: 'Original policy',
      strategy: 'single',
      modelPolicy: 'cloud',
      experts: [],
      candidateCount: 1,
    });
    const source = await store.create<Conversation>('conversation', owner().id, {
      ...baseConversation,
      agentId: agent.id,
    });
    const dispatcher = new AutomationDispatcher(store, tasks, () => now);
    const scheduler = new SchedulerService(store, dispatcher, {
      enabled: true,
      now: () => now,
      reauthorize: async () => owner(),
    });
    const schedule = await scheduler.create(owner(), {
      name: 'Hourly review',
      prompt: 'Review now',
      nextAt: new Date(now - 5 * 60_000).toISOString(),
      intervalSeconds: 60,
      enabled: true,
      settings: { conversationId: source.id, permissions: ['model:read'], notification: { type: 'in_app' } },
    });
    const mutableConversation = await store.get<Conversation>('conversation', source.id, owner().id);
    await store.put('conversation', source.id, owner().id, {
      ...mutableConversation!.data,
      modelPolicy: 'local',
      modelId: 'model-v2',
    }, mutableConversation!.revision);
    const mutableAgent = await store.get<AgentProfile>('agent', agent.id, owner().id);
    await store.put('agent', agent.id, owner().id, { ...mutableAgent!.data, systemPrompt: 'Changed later' }, mutableAgent!.revision);

    await Promise.all([scheduler.reconcile(), scheduler.reconcile()]);
    assert.equal((await store.scan<Task>('task', owner().id)).length, 1);
    assert.equal((await store.scan<ScheduleOccurrence>('schedule_occurrence', owner().id)).length, 1);
    const task = (await store.scan<Task>('task', owner().id))[0]!;
    const frozenConversation = await store.get<Conversation>('conversation', task.data.conversationId, owner().id);
    assert.equal(frozenConversation?.data.modelPolicy, 'cloud');
    assert.equal(frozenConversation?.data.modelId, 'model-v1');
    const frozenAgent = await store.get<AgentProfile>('agent', frozenConversation!.data.agentId!, owner().id);
    assert.equal(frozenAgent?.data.systemPrompt, 'Original policy');
    const advanced = await store.get<AutomationSchedule>('automation_schedule', schedule.id, owner().id);
    assert.ok(Date.parse(advanced!.data.nextAt) > now);
    assert.equal(Date.parse(advanced!.data.nextAt), start + 60_000);

    const edited = await scheduler.update(owner(), schedule.id, advanced!.revision, {
      name: 'Hourly review', prompt: 'Use new settings', nextAt: new Date(now + 120_000).toISOString(),
      intervalSeconds: 60, enabled: true,
      settings: { conversationId: source.id, permissions: ['model:read'], notification: { type: 'none' } },
    });
    assert.equal(edited.data.version, 2);
    assert.equal(edited.data.settings.conversation.modelPolicy, 'local');
    assert.equal(edited.data.settings.agent?.data.systemPrompt, 'Changed later');
  } finally {
    await tasks.close();
    await store.close();
  }
});

test('cron schedules use their IANA timezone across DST and coalesce missed occurrences', async () => {
  const store = new SqliteStore();
  const tasks = new TaskService(store, async () => ({ text: 'unused' }));
  let now = Date.parse('2026-03-07T08:00:00.000Z');
  try {
    const source = await store.create<Conversation>('conversation', owner().id, baseConversation);
    const scheduler = new SchedulerService(store, new AutomationDispatcher(store, tasks, () => now), {
      enabled: true,
      now: () => now,
      reauthorize: async () => owner('2027-01-01T00:00:00.000Z'),
    });
    const spring = await scheduler.create(owner('2027-01-01T00:00:00.000Z'), {
      name: 'New York morning',
      prompt: 'Run at local 02:30',
      cronExpression: '30 2 * * *',
      timezone: 'America/New_York',
      enabled: true,
      settings: { conversationId: source.id, permissions: ['model:read'], notification: { type: 'none' } },
    });
    assert.equal(spring.data.nextAt, '2026-03-08T07:30:00.000Z');

    now = Date.parse('2026-03-10T08:00:00.000Z');
    await Promise.all([scheduler.reconcile(), scheduler.reconcile()]);
    assert.equal((await store.scan<Task>('task', owner().id)).length, 1);
    assert.equal((await store.scan<ScheduleOccurrence>('schedule_occurrence', owner().id)).length, 1);
    const advanced = await store.get<AutomationSchedule>('automation_schedule', spring.id, owner().id);
    assert.equal(advanced?.data.nextAt, '2026-03-11T06:30:00.000Z');

    now = Date.parse('2026-10-31T07:00:00.000Z');
    const fall = await scheduler.create(owner('2027-01-01T00:00:00.000Z'), {
      name: 'Fall transition',
      prompt: 'Run at local 01:30',
      cronExpression: '30 1 * * *',
      timezone: 'America/New_York',
      settings: { conversationId: source.id, permissions: ['model:read'], notification: { type: 'none' } },
    });
    assert.equal(fall.data.nextAt, '2026-11-01T05:30:00.000Z');
    assert.equal(
      cronScheduleNextAt('30 1 * * *', 'America/New_York', Date.parse(fall.data.nextAt)),
      '2026-11-02T06:30:00.000Z',
    );
  } finally {
    await tasks.close();
    await store.close();
  }
});

test('stale schedule claim reuses the same task instead of replaying a missed external run', async () => {
  const store = new SqliteStore();
  const tasks = new TaskService(store, async () => ({ text: 'unused' }));
  let now = start;
  class CrashAfterEnqueue extends AutomationDispatcher {
    private crashed = false;

    public override async dispatch(input: Parameters<AutomationDispatcher['dispatch']>[0]): Promise<Entity<Task>> {
      const task = await super.dispatch(input);
      if (!this.crashed) {
        this.crashed = true;
        throw new Error('simulated process loss after durable enqueue');
      }
      return task;
    }
  }
  try {
    const source = await store.create<Conversation>('conversation', owner().id, baseConversation);
    const crashing = new CrashAfterEnqueue(store, tasks, () => now);
    const first = new SchedulerService(store, crashing, {
      enabled: true,
      now: () => now,
      claimMs: 1_000,
      reauthorize: async () => owner(),
    });
    await first.create(owner(), {
      name: 'One shot', prompt: 'Perform once', nextAt: new Date(now).toISOString(), enabled: true,
      settings: { conversationId: source.id, permissions: ['model:read'], notification: { type: 'none' } },
    });
    await first.reconcile();
    assert.equal((await store.scan<Task>('task', owner().id)).length, 1);
    assert.equal((await store.scan<ScheduleOccurrence>('schedule_occurrence', owner().id))[0]?.data.status, 'pending');

    now += 3_000;
    const restarted = new SchedulerService(store, new AutomationDispatcher(store, tasks, () => now), {
      enabled: true,
      now: () => now,
      reauthorize: async () => owner(),
    });
    await restarted.reconcile();
    await restarted.reconcile();
    assert.equal((await store.scan<Task>('task', owner().id)).length, 1);
    assert.equal((await store.scan<ScheduleOccurrence>('schedule_occurrence', owner().id))[0]?.data.status, 'enqueued');
  } finally {
    await tasks.close();
    await store.close();
  }
});

test('automation HTTP routes default disabled, expose a secret once and support full schedule edits', async () => {
  const store = new SqliteStore();
  const tasks = new TaskService(store, async () => ({ text: 'unused' }));
  const app = Fastify({ bodyLimit: 1024 * 1024 });
  try {
    const source = await store.create<Conversation>('conversation', owner().id, baseConversation);
    const dispatcher = new AutomationDispatcher(store, tasks, () => start);
    const eventTriggers = new EventTriggerService(store, dispatcher, {
      enabled: true,
      now: () => start,
      reauthorize: async () => owner(),
    });
    const scheduler = new SchedulerService(store, dispatcher, {
      enabled: true,
      now: () => start,
      reauthorize: async () => owner(),
    });
    registerAutomationRoutes(app, { eventTriggers, scheduler }, () => owner());

    const trigger = await app.inject({
      method: 'POST', url: '/v1/event-triggers',
      payload: {
        type: 'webhook', name: 'Hook', prompt: 'Handle', settings: {
          conversationId: source.id, permissions: ['model:read'], notification: { type: 'none' },
        }, filter: {},
      },
    });
    assert.equal(trigger.statusCode, 201, trigger.body);
    assert.equal(trigger.json().data.data.enabled, false);
    assert.ok(trigger.json().webhook.secret.startsWith('whsec_'));
    assert.equal(trigger.body.includes('secretHash'), false);
    const list = await app.inject({ method: 'GET', url: '/v1/event-triggers' });
    assert.equal(list.body.includes(trigger.json().webhook.secret), false);

    const schedule = await app.inject({
      method: 'POST', url: '/v1/schedules', payload: {
        name: 'Later', prompt: 'Run later', nextAt: new Date(start + 60_000).toISOString(), settings: {
          conversationId: source.id, permissions: ['model:read'], notification: { type: 'none' },
        },
      },
    });
    assert.equal(schedule.statusCode, 201, schedule.body);
    assert.equal(schedule.json().data.data.enabled, false);
    const edited = await app.inject({
      method: 'PUT', url: `/v1/schedules/${schedule.json().data.id}`, payload: {
        revision: schedule.json().data.revision,
        data: {
          name: 'Later edited', prompt: 'Run after review', nextAt: new Date(start + 120_000).toISOString(), enabled: true,
          settings: { conversationId: source.id, permissions: ['model:read'], notification: { type: 'in_app' } },
        },
      },
    });
    assert.equal(edited.statusCode, 200, edited.body);
    assert.equal(edited.json().data.data.version, 2);
    assert.equal(edited.json().data.data.settings.notification.type, 'in_app');
    const disabled = await app.inject({
      method: 'PATCH', url: `/v1/schedules/${schedule.json().data.id}`,
      payload: { revision: edited.json().data.revision, enabled: false },
    });
    assert.equal(disabled.statusCode, 200, disabled.body);
    assert.equal(disabled.json().data.data.enabled, false);
    assert.equal(disabled.json().data.data.version, 2);
    assert.equal(disabled.json().data.data.settings.fingerprint, edited.json().data.data.settings.fingerprint);

    const cron = await app.inject({
      method: 'POST', url: '/v1/schedules', payload: {
        name: 'Weekday morning', prompt: 'Run on weekdays', cronExpression: '0 9 * * 1-5',
        timezone: 'Asia/Hong_Kong', settings: {
          conversationId: source.id, permissions: ['model:read'], notification: { type: 'none' },
        },
      },
    });
    assert.equal(cron.statusCode, 201, cron.body);
    assert.equal(cron.json().data.data.cronExpression, '0 9 * * 1-5');
    assert.equal(cron.json().data.data.timezone, 'Asia/Hong_Kong');
    assert.equal(cron.json().data.data.nextAt, '2026-09-28T01:00:00.000Z');

    for (const timing of [
      { cronExpression: 'H 9 * * *', timezone: 'Asia/Hong_Kong' },
      { cronExpression: '0 9 * * *', timezone: 'Not/A_Timezone' },
    ]) {
      const invalid = await app.inject({
        method: 'POST', url: '/v1/schedules', payload: {
          name: 'Invalid cron', prompt: 'Must not be stored', ...timing, settings: {
            conversationId: source.id, permissions: ['model:read'], notification: { type: 'none' },
          },
        },
      });
      assert.equal(invalid.statusCode, 400, invalid.body);
    }
    await assert.rejects(scheduler.create(owner(), {
      name: 'Mixed timing', prompt: 'Must not be stored', nextAt: '2026-09-28T01:00:00.000Z',
      cronExpression: '0 9 * * *', timezone: 'Asia/Hong_Kong', settings: {
        conversationId: source.id, permissions: ['model:read'], notification: { type: 'none' },
      },
    }), (error: unknown) => error instanceof DomainError && error.code === 'invalid_schedule');

    const draftData: LegacyScheduleDraft = {
      name: 'Imported draft', prompt: 'Review before adopting.',
      timing: { type: 'cron', expression: '0 8 * * *', timezone: 'Asia/Hong_Kong' },
      enabled: false, originalEnabled: true, requiresReview: ['execution_settings'],
      importedAt: new Date(start).toISOString(),
      source: { system: 'hermes', idHash: 'a'.repeat(64), fingerprint: 'b'.repeat(64) },
    };
    const draft = await store.create('automation_schedule_draft', owner().id, draftData, 'draft-1');
    await store.create('automation_schedule_draft', 'another-owner', draftData, 'draft-2');
    const drafts = await app.inject({ method: 'GET', url: '/v1/schedule-drafts' });
    assert.equal(drafts.statusCode, 200, drafts.body);
    assert.deepEqual(drafts.json().data.map((row: { id: string }) => row.id), ['draft-1']);
    const removedDraft = await app.inject({
      method: 'DELETE', url: `/v1/schedule-drafts/${draft.id}?revision=${draft.revision}`,
    });
    assert.equal(removedDraft.statusCode, 204, removedDraft.body);
    assert.equal((await scheduler.listDrafts(owner().id)).length, 0);

    const oversized = await app.inject({
      method: 'POST', url: `/v1/event-hooks/${trigger.json().webhook.id}`,
      headers: { 'x-kian-webhook-secret': trigger.json().webhook.secret },
      payload: { eventId: 'large', eventName: 'test', payload: { value: 'x'.repeat(70 * 1024) } },
    });
    assert.equal(oversized.statusCode, 413);
  } finally {
    await app.close();
    await tasks.close();
    await store.close();
  }
});

test('server automation routes hide frozen execution snapshots from management lists', async () => {
  const store = new SqliteStore();
  const token = 'automation-owner-token-with-at-least-thirty-two-characters';
  const server = await createServer({
    store,
    authenticate: developmentAuth(token),
    reauthorize: async (actor) => actor,
    runner: async () => ({ text: 'unused' }),
    automations: { eventTriggersEnabled: true, schedulerEnabled: true },
  });
  const headers = { authorization: `Bearer ${token}` };
  try {
    const agent = await server.app.inject({
      method: 'POST', url: '/v1/agents', headers,
      payload: { name: 'Automation agent', systemPrompt: 'Act carefully.' },
    });
    const conversation = await server.app.inject({
      method: 'POST', url: '/v1/conversations', headers,
      payload: { title: 'Automation source', agentId: agent.json().data.id },
    });
    const schedule = await server.app.inject({
      method: 'POST', url: '/v1/schedules', headers,
      payload: {
        name: 'Due now', prompt: 'Run once', nextAt: new Date(Date.now() - 1_000).toISOString(), enabled: true,
        settings: {
          conversationId: conversation.json().data.id,
          permissions: ['model:read'],
          notification: { type: 'none' },
        },
      },
    });
    assert.equal(schedule.statusCode, 201, schedule.body);
    await server.scheduler.reconcile();

    const agents = await server.app.inject({ method: 'GET', url: '/v1/agents', headers });
    const conversations = await server.app.inject({ method: 'GET', url: '/v1/conversations', headers });
    assert.equal(agents.json().data.length, 1);
    assert.equal(conversations.json().data.length, 1);
    assert.equal((await store.scan('agent', 'local-owner')).length, 2);
    assert.equal((await store.scan('conversation', 'local-owner')).length, 2);
  } finally {
    await server.close();
  }
});

test('device connection registry validates one fresh authenticated edge only once', async () => {
  let now = start;
  const registry = new DeviceConnectionRegistry(() => now, 1_000);
  const edge = registry.open({ id: 'device-1', ownerId: owner().id });
  assert.deepEqual(await registry.validate(edge), { ownerId: owner().id, deviceId: 'device-1' });
  await assert.rejects(registry.validate(edge), hasCode('invalid_device_edge'));

  const expired = registry.open({ id: 'device-1', ownerId: owner().id });
  now += 1_001;
  await assert.rejects(registry.validate(expired), hasCode('invalid_device_edge'));
});

function hasCode(expected: string): (error: unknown) => boolean {
  return (error) => error instanceof DomainError && error.code === expected;
}
