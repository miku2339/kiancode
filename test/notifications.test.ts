import assert from 'node:assert/strict';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { accountDeviceVerifier, NotificationService, notificationDeliveryAt } from '../src/notifications.js';
import { SqliteStore } from '../src/storage/sqlite.js';
import { createServer } from '../src/http/server.js';
import { DomainError, type Principal } from '../src/contracts.js';
import type { Conversation, Notification, NotificationPreferences, Task } from '../src/domain.js';
import { TaskService } from '../src/tasks.js';
import { AutomationDispatcher } from '../src/event-triggers.js';

const conversation: Conversation = {
  title: 'Private task',
  scope: 'private',
  modelPolicy: 'cloud',
  strategy: 'single',
  mode: 'ask',
  archived: false,
};

test('different owners can concurrently create and update independent notification preferences', async () => {
  const store = new SqliteStore();
  const notifications = new NotificationService(store);
  try {
    const [alice, bob, concurrentAlice] = await Promise.all([
      notifications.preferences('alice'), notifications.preferences('bob'), notifications.preferences('alice'),
    ]);
    assert.notEqual(alice.id, bob.id);
    assert.equal(alice.id, concurrentAlice.id);
    await notifications.setPreferences('alice', { timezone: 'Asia/Hong_Kong', quietHours: null }, alice.revision);
    assert.equal((await notifications.preferences('alice')).data.timezone, 'Asia/Hong_Kong');
    assert.equal((await notifications.preferences('bob')).data.timezone, 'UTC');
    await Promise.all(['alice', 'bob'].map((ownerId) => notifications.publish(ownerId, {
      type: 'task_completed', dedupeKey: 'completed', taskId: 'task',
    })));
    assert.equal((await store.scan('notification')).length, 2);
  } finally {
    await store.close();
  }
});

test('legacy notification preferences remain editable without blocking a second owner', async () => {
  const store = new SqliteStore();
  const notifications = new NotificationService(store);
  try {
    const legacy = await store.create<NotificationPreferences>('notification_preferences', 'alice', {
      timezone: 'Asia/Hong_Kong', quietHours: { start: '22:00', end: '07:00' },
    }, 'preferences');
    const bob = await notifications.preferences('bob');
    assert.notEqual(bob.id, legacy.id);
    assert.equal((await notifications.preferences('alice')).id, legacy.id);
    const updated = await notifications.setPreferences('alice', { timezone: 'Asia/Tokyo', quietHours: null }, legacy.revision);
    assert.equal(updated.id, legacy.id);
    assert.equal(updated.revision, legacy.revision + 1);
    assert.equal((await notifications.preferences('bob')).data.timezone, 'UTC');
  } finally {
    await store.close();
  }
});

test('quiet hours defer delivery across midnight and a DST gap', () => {
  assert.deepEqual(notificationDeliveryAt({
    timezone: 'Asia/Hong_Kong',
    quietHours: { start: '22:00', end: '07:00' },
  }, new Date('2026-09-27T15:30:00.000Z')), {
    quiet: true,
    deliverAfter: '2026-09-27T23:00:00.000Z',
  });

  assert.deepEqual(notificationDeliveryAt({
    timezone: 'America/New_York',
    quietHours: { start: '01:30', end: '03:30' },
  }, new Date('2026-03-08T06:45:00.000Z')), {
    quiet: true,
    deliverAfter: '2026-03-08T07:30:00.000Z',
  });

  assert.deepEqual(notificationDeliveryAt({ timezone: 'UTC', quietHours: null }, new Date('2026-01-01T00:00:00.000Z')), {
    quiet: false,
    deliverAfter: '2026-01-01T00:00:00.000Z',
  });
});

test('notification API keeps preferences and APNs tokens owner-private and device-bound', async () => {
  const store = new SqliteStore();
  const verified: Array<{ authorization: string | undefined; deviceId: string }> = [];
  const notifications = new NotificationService(store, {
    async verifyDevice(authorization, deviceId) { verified.push({ authorization, deviceId }); },
  });
  const authenticate = async (authorization: string | undefined): Promise<Principal> => {
    if (authorization === 'Bearer alice-token') return { id: 'alice', level: 1, scopes: ['notification:*'] };
    if (authorization === 'Bearer bob-token') return { id: 'bob', level: 1, scopes: ['notification:*'] };
    throw new DomainError('unauthorized', 'Sign in', 401);
  };
  const server = await createServer({
    store,
    notifications,
    authenticate,
    runner: async () => ({ text: 'unused' }),
  });
  try {
    const aliceHeaders = { authorization: 'Bearer alice-token' };
    const defaults = await server.app.inject({ method: 'GET', url: '/v1/notifications/preferences', headers: aliceHeaders });
    assert.equal(defaults.statusCode, 200, defaults.body);
    assert.deepEqual(defaults.json().data.data, { timezone: 'UTC', quietHours: null });

    const updated = await server.app.inject({
      method: 'PUT',
      url: '/v1/notifications/preferences',
      headers: aliceHeaders,
      payload: {
        revision: defaults.json().data.revision,
        timezone: 'Asia/Hong_Kong',
        quietHours: { start: '22:30', end: '07:15' },
      },
    });
    assert.equal(updated.statusCode, 200, updated.body);
    const invalid = await server.app.inject({
      method: 'PUT',
      url: '/v1/notifications/preferences',
      headers: aliceHeaders,
      payload: { revision: updated.json().data.revision, timezone: 'Not/A_Timezone', quietHours: null },
    });
    assert.equal(invalid.statusCode, 400, invalid.body);

    const token = 'a1'.repeat(32);
    const registered = await server.app.inject({
      method: 'POST',
      url: '/v1/notifications/push-subscriptions',
      headers: aliceHeaders,
      payload: {
        deviceId: 'account-device-1',
        platform: 'apns',
        environment: 'production',
        topic: 'com.example.KianCode',
        token,
      },
    });
    assert.equal(registered.statusCode, 201, registered.body);
    assert.equal(registered.body.includes(token), false);
    assert.deepEqual(verified, [{ authorization: 'Bearer alice-token', deviceId: 'account-device-1' }]);

    const bob = await server.app.inject({
      method: 'GET',
      url: '/v1/notifications/push-subscriptions',
      headers: { authorization: 'Bearer bob-token' },
    });
    assert.deepEqual(bob.json().data, []);

    const removed = await server.app.inject({
      method: 'DELETE',
      url: `/v1/notifications/push-subscriptions/${registered.json().data.id}?revision=${registered.json().data.revision}`,
      headers: aliceHeaders,
    });
    assert.equal(removed.statusCode, 204, removed.body);
    assert.equal((await notifications.activePushSubscriptions('alice')).length, 0);
  } finally {
    await server.close();
  }
});

test('channel notification destinations are owner-scoped, durable, and excluded from APNs delivery', async () => {
  const store = new SqliteStore();
  const now = new Date('2026-09-30T04:00:00.000Z');
  const notifications = new NotificationService(store, { now: () => now });
  try {
    const destination = await notifications.registerChannelDestination('alice', {
      channel: 'whatsapp',
      chatId: 'alice@s.whatsapp.net',
    });
    const same = await notifications.registerChannelDestination('alice', {
      channel: 'whatsapp',
      chatId: 'alice@s.whatsapp.net',
    });
    assert.equal(same.id, destination.id);
    assert.equal(await notifications.channelDestination('bob', destination.id), undefined);

    const notification = await notifications.publishTask('alice', {
      type: 'task_completed',
      dedupeKey: 'task:channel:completed',
      taskId: 'channel-task',
    }, now, { type: 'channel', destinationId: destination.id });
    assert.ok(notification);
    assert.equal(notification.data.pushEligible, false);
    assert.equal(notification.data.targetChannelDestinationId, destination.id);
    assert.equal((await notifications.deliverableNotifications()).length, 0);
    assert.deepEqual((await notifications.deliverableChannelNotifications()).map((row) => row.id), [notification.id]);

    const sourceConversation = await store.create<Conversation>('conversation', 'alice', {
      ...conversation,
      title: 'Scheduled channel notification',
    });
    const dispatcher = new AutomationDispatcher(store, {} as never, () => now.getTime());
    await dispatcher.snapshot('alice', {
      conversationId: sourceConversation.id,
      permissions: ['model:read'],
      notification: { type: 'channel', destinationId: destination.id },
    });

    await notifications.revokeChannelDestination('alice', destination.id, 'binding_revoked', destination.revision);
    assert.equal((await notifications.listChannelDestinations('alice')).length, 0);
    await assert.rejects(
      dispatcher.snapshot('alice', {
        conversationId: sourceConversation.id,
        permissions: ['model:read'],
        notification: { type: 'channel', destinationId: destination.id },
      }),
      (error: unknown) => error instanceof DomainError && error.code === 'not_found',
    );
  } finally {
    await store.close();
  }
});

test('Account device verification uses the service endpoint and rejects another device', async () => {
  const requests: Array<{ url: string; authorization: string | null }> = [];
  const verify = accountDeviceVerifier('http://127.0.0.1:8787', async (input, init) => {
    requests.push({ url: String(input), authorization: new Headers(init?.headers).get('authorization') });
    return new Response(JSON.stringify({ success: true, data: { devices: [{ id: 'active-device' }] } }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  });
  await verify('Bearer session-token', 'active-device');
  assert.deepEqual(requests, [{
    url: 'http://127.0.0.1:8787/api/account/devices/',
    authorization: 'Bearer session-token',
  }]);
  await assert.rejects(
    verify('Bearer session-token', 'revoked-device'),
    (error: unknown) => error instanceof DomainError && error.code === 'device_not_authorized',
  );
});

test('task state notifications are durable, deduplicated, and omit task content', async () => {
  const store = new SqliteStore();
  const now = new Date('2026-09-27T08:00:00.000Z');
  const notifications = new NotificationService(store, { now: () => now });
  const service = new TaskService(store, async ({ task }) => {
    if (task.data.prompt === 'secret failure prompt') throw new Error('private failure detail');
    if (task.data.prompt === 'approval') {
      return {
        text: '',
        status: 'waiting_for_approval',
        pendingActions: [{ hash: 'write-hash', tool: 'workspace.write', input: { content: 'private' } }],
      };
    }
    return { text: 'private result' };
  }, { now: () => now.getTime(), notifications });
  try {
    const principal: Principal = { id: 'alice', level: 1, scopes: ['*'] };
    const thread = await store.create('conversation', principal.id, conversation);
    const completed = await service.enqueue(principal, thread.id, 'complete');
    const failed = await service.enqueue(principal, thread.id, 'secret failure prompt');
    const approval = await service.enqueue(principal, thread.id, 'approval');
    await service.drain();
    await service.drain();

    assert.equal((await store.get<Task>('task', completed.id, principal.id))?.data.state, 'completed');
    assert.equal((await store.get<Task>('task', failed.id, principal.id))?.data.state, 'failed');
    assert.equal((await store.get<Task>('task', approval.id, principal.id))?.data.state, 'waiting_for_approval');
    const rows = await store.scan<Notification>('notification', principal.id);
    assert.deepEqual(new Set(rows.map((row) => row.data.type)), new Set([
      'task_completed',
      'task_failed',
      'approval_required',
    ]));
    assert.equal(rows.length, 3);
    const serialized = JSON.stringify(rows);
    assert.equal(serialized.includes('private result'), false);
    assert.equal(serialized.includes('private failure detail'), false);
    assert.equal(serialized.includes('private'), false);
    const preferences = await notifications.preferences(principal.id);
    await notifications.setPreferences(principal.id, {
      timezone: 'Asia/Hong_Kong',
      quietHours: { start: '22:00', end: '07:00' },
    }, preferences.revision);
    await notifications.reconcile();
    assert.equal((await store.scan<Notification>('notification', principal.id)).length, 3);
  } finally {
    await service.close();
    await store.close();
  }
});

test('task notification destinations suppress, retain in-app, or target one push subscription durably', async () => {
  const store = new SqliteStore();
  const now = new Date('2026-09-27T08:00:00.000Z');
  const notifications = new NotificationService(store, { now: () => now });
  const service = new TaskService(store, async () => ({ text: 'done' }), {
    now: () => now.getTime(),
    notifications,
  });
  try {
    const principal: Principal = { id: 'alice', level: 1, scopes: ['*'] };
    const thread = await store.create('conversation', principal.id, conversation);
    await service.enqueue(principal, thread.id, 'none', 'none', [], [], { type: 'none' });
    await service.enqueue(principal, thread.id, 'in app', 'in-app', [], [], { type: 'in_app' });
    await service.enqueue(principal, thread.id, 'one device', 'push', [], [], {
      type: 'push',
      subscriptionId: 'subscription-1',
    });
    await assert.rejects(
      service.enqueue(principal, thread.id, 'one device', 'push', [], [], { type: 'in_app' }),
      (error: unknown) => error instanceof DomainError && error.code === 'idempotency_conflict',
    );
    await service.drain();
    await notifications.reconcile();

    const rows = await store.scan<Notification>('notification', principal.id);
    assert.equal(rows.length, 2);
    const inApp = rows.find((row) => row.data.taskId
      && row.data.targetSubscriptionId === undefined
      && row.data.pushEligible === false);
    const targeted = rows.find((row) => row.data.targetSubscriptionId === 'subscription-1');
    assert.ok(inApp);
    assert.equal(targeted?.data.pushEligible, true);
  } finally {
    await service.close();
    await store.close();
  }
});

test('task metadata changes preserve the original completion notification and delivery time', async () => {
  const store = new SqliteStore();
  const notifications = new NotificationService(store);
  const service = new TaskService(store, async () => ({ text: 'done' }), { notifications });
  const principal: Principal = { id: 'alice', level: 1, scopes: ['*'] };
  try {
    const thread = await store.create('conversation', principal.id, conversation);
    const queued = await service.enqueue(principal, thread.id, 'complete', 'completion');
    await service.drain();
    const task = (await store.get<Task>('task', queued.id, principal.id))!;
    const original = (await store.scan<Notification>('notification', principal.id))
      .find((row) => row.data.type === 'task_completed')!;
    await delay(5);
    const changed = await store.put('task', task.id, principal.id, { ...task.data, leaseExpiresAt: undefined }, task.revision);
    assert.notEqual(changed.updatedAt, task.updatedAt);
    await notifications.reconcile();
    const after = await store.scan<Notification>('notification', principal.id);
    assert.deepEqual(after, [original]);
    await assert.rejects(notifications.publish(principal.id, {
      type: original.data.type, dedupeKey: original.data.dedupeKey, taskId: task.id, conversationId: thread.id,
    }, new Date(changed.updatedAt)), (error: unknown) => error instanceof DomainError && error.code === 'idempotency_conflict');
  } finally {
    await service.close();
    await store.close();
  }
});

test('concurrent task reconciliation retains one occurrence despite different metadata timestamps', async () => {
  const store = new SqliteStore();
  const notifications = new NotificationService(store);
  try {
    const input = { type: 'task_completed' as const, dedupeKey: 'task:concurrent:completed', taskId: 'concurrent' };
    const rows = await Promise.all([
      notifications.publishTask('alice', input, new Date('2026-09-30T00:00:00Z')),
      notifications.publishTask('alice', input, new Date('2026-09-30T00:00:01Z')),
    ]);
    assert.deepEqual(rows[0], rows[1]);
    assert.equal((await store.scan('notification', 'alice')).length, 1);
  } finally {
    await store.close();
  }
});
