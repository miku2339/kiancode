import { createHash } from 'node:crypto';
import { bearer, secureAccountApiOrigin } from './auth.js';
import { DomainError } from './contracts.js';
import type {
  Notification,
  NotificationChannelDestination,
  NotificationDestination,
  NotificationPreferences,
  NotificationType,
  PushSubscription,
  QuietHours,
  Task,
} from './domain.js';
import type { Entity, Store } from './storage/store.js';

export interface NotificationInput {
  type: NotificationType;
  dedupeKey: string;
  taskId?: string;
  conversationId?: string;
  scheduleId?: string;
  title?: string;
  body?: string;
}

export interface PushSubscriptionInput {
  deviceId: string;
  environment: 'development' | 'production';
  topic: string;
  token: string;
}

export interface NotificationChannelDestinationInput {
  channel: string;
  chatId: string;
}

export interface PublicPushSubscription {
  id: string;
  ownerId: string;
  revision: number;
  createdAt: string;
  updatedAt: string;
  data: Omit<PushSubscription, 'token'>;
}

export interface NotificationServiceOptions {
  now?: () => Date;
  verifyDevice?: (authorization: string | undefined, deviceId: string) => Promise<void>;
}

interface AutomationScheduleNotification {
  authorizationFailedAt?: string;
  settings: { notification: NotificationDestination };
}

interface NotificationDelivery {
  pushEligible: boolean;
  reuseOccurredAt?: boolean;
  targetSubscriptionId?: string;
  targetChannelDestinationId?: string;
}

const legacyPreferencesId = 'preferences';
const timePattern = /^(?:[01]\d|2[0-3]):[0-5]\d$/;
const topicPattern = /^[A-Za-z0-9][A-Za-z0-9.-]{0,254}$/;
const tokenPattern = /^(?:[0-9a-fA-F]{2}){16,128}$/;

export class NotificationService {
  private readonly now: () => Date;

  public constructor(
    private readonly store: Store,
    private readonly options: NotificationServiceOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
  }

  public async preferences(ownerId: string): Promise<Entity<NotificationPreferences>> {
    const preferencesId = digest(ownerId, 'notification_preferences');
    const current = await this.storedPreferences(ownerId);
    if (current) return current;
    try {
      return await this.store.create('notification_preferences', ownerId, {
        timezone: 'UTC',
        quietHours: null,
      }, preferencesId);
    } catch (error) {
      if (!(error instanceof DomainError && error.code === 'conflict')) throw error;
      const concurrent = await this.store.get<NotificationPreferences>('notification_preferences', preferencesId, ownerId);
      if (!concurrent) throw new DomainError('storage_unavailable', 'Notification preferences were not confirmed.', 503);
      return concurrent;
    }
  }

  public async setPreferences(
    ownerId: string,
    data: NotificationPreferences,
    expectedRevision?: number,
  ): Promise<Entity<NotificationPreferences>> {
    validatePreferences(data);
    const preferencesId = digest(ownerId, 'notification_preferences');
    const current = await this.storedPreferences(ownerId);
    if (!current) {
      if (expectedRevision !== undefined) throw new DomainError('conflict', 'Notification preferences changed; reload and retry.', 409);
      try {
        return await this.store.create('notification_preferences', ownerId, data, preferencesId);
      } catch (error) {
        if (error instanceof DomainError && error.code === 'conflict') {
          throw new DomainError('conflict', 'Notification preferences changed; reload and retry.', 409);
        }
        throw error;
      }
    }
    if (expectedRevision === undefined || current.revision !== expectedRevision) {
      throw new DomainError('conflict', 'Notification preferences changed; reload and retry.', 409);
    }
    return this.store.put('notification_preferences', current.id, ownerId, data, current.revision);
  }

  private async storedPreferences(ownerId: string): Promise<Entity<NotificationPreferences> | undefined> {
    return await this.store.get<NotificationPreferences>('notification_preferences', digest(ownerId, 'notification_preferences'), ownerId)
      ?? await this.store.get<NotificationPreferences>('notification_preferences', legacyPreferencesId, ownerId);
  }

  public async deliveryAt(ownerId: string, at: Date): Promise<{ quiet: boolean; deliverAfter: string }> {
    const preferences = (await this.preferences(ownerId)).data;
    return notificationDeliveryAt(preferences, at);
  }

  public async publish(
    ownerId: string,
    input: NotificationInput,
    occurredAt = this.now(),
    policy: NotificationDelivery = { pushEligible: true },
  ): Promise<Entity<Notification>> {
    if (!input.dedupeKey || input.dedupeKey.length > 500) {
      throw new DomainError('invalid_notification', 'Notification deduplication key is invalid.');
    }
    const copy = notificationCopy(input.type);
    const title = boundedText(input.title ?? copy.title, 120);
    const body = boundedText(input.body ?? copy.body, 500);
    const id = digest(ownerId, input.dedupeKey);
    const existing = await this.store.get<Notification>('notification', id, ownerId);
    if (existing) {
      if (!sameNotificationEvent(existing.data, input, occurredAt, title, body, policy)) {
        throw new DomainError('idempotency_conflict', 'Notification key belongs to another event.', 409);
      }
      return existing;
    }
    const delivery = await this.deliveryAt(ownerId, occurredAt);
    const data: Notification = {
      type: input.type,
      title,
      body,
      dedupeKey: input.dedupeKey,
      occurredAt: occurredAt.toISOString(),
      deliverAfter: delivery.deliverAfter,
      silent: delivery.quiet,
      read: false,
      pushEligible: policy.pushEligible,
      ...(policy.targetSubscriptionId ? { targetSubscriptionId: policy.targetSubscriptionId } : {}),
      ...(policy.targetChannelDestinationId ? { targetChannelDestinationId: policy.targetChannelDestinationId } : {}),
      ...(input.taskId ? { taskId: input.taskId } : {}),
      ...(input.conversationId ? { conversationId: input.conversationId } : {}),
      ...(input.scheduleId ? { scheduleId: input.scheduleId } : {}),
    };
    try {
      return await this.store.create('notification', ownerId, data, id);
    } catch (error) {
      if (!(error instanceof DomainError && error.code === 'conflict')) throw error;
      const concurrent = await this.store.get<Notification>('notification', id, ownerId);
      if (!concurrent || !sameNotificationEvent(concurrent.data, input, occurredAt, title, body, policy)) {
        throw new DomainError('idempotency_conflict', 'Notification key belongs to another event.', 409);
      }
      return concurrent;
    }
  }

  public async publishTask(
    ownerId: string,
    input: NotificationInput,
    occurredAt: Date,
    destination?: NotificationDestination,
  ): Promise<Entity<Notification> | undefined> {
    if (destination?.type === 'none') return undefined;
    return this.publish(ownerId, input, occurredAt, {
      pushEligible: destination === undefined || destination.type === 'push',
      reuseOccurredAt: true,
      ...(destination?.type === 'push' ? { targetSubscriptionId: destination.subscriptionId } : {}),
      ...(destination?.type === 'channel' ? { targetChannelDestinationId: destination.destinationId } : {}),
    });
  }

  public async registerChannelDestination(
    ownerId: string,
    input: NotificationChannelDestinationInput,
  ): Promise<Entity<NotificationChannelDestination>> {
    validateChannelDestination(input);
    const now = this.now().toISOString();
    const id = digest(ownerId, input.channel, input.chatId);
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const current = await this.store.get<NotificationChannelDestination>('notification_channel', id, ownerId);
      if (!current) {
        try {
          return await this.store.create('notification_channel', ownerId, {
            channel: input.channel,
            chatId: input.chatId,
            status: 'active',
            activatedAt: now,
            updatedAt: now,
          }, id);
        } catch (error) {
          if (!(error instanceof DomainError && error.code === 'conflict')) throw error;
          continue;
        }
      }
      if (current.data.channel !== input.channel || current.data.chatId !== input.chatId) {
        throw new DomainError('idempotency_conflict', 'Notification destination ID belongs to another channel.', 409);
      }
      if (current.data.status === 'active') return current;
      try {
        return await this.store.put('notification_channel', id, ownerId, {
          ...current.data,
          status: 'active',
          activatedAt: now,
          updatedAt: now,
          revokedAt: undefined,
          revokeReason: undefined,
        }, current.revision);
      } catch (error) {
        if (!(error instanceof DomainError && error.code === 'conflict')) throw error;
      }
    }
    throw new DomainError('busy', 'Notification destination is busy; retry.', 409);
  }

  public async listChannelDestinations(ownerId: string): Promise<Array<Entity<NotificationChannelDestination>>> {
    return (await this.store.scan<NotificationChannelDestination>('notification_channel', ownerId))
      .filter((destination) => destination.data.status === 'active');
  }

  public channelDestination(
    ownerId: string,
    id: string,
  ): Promise<Entity<NotificationChannelDestination> | undefined> {
    return this.store.get<NotificationChannelDestination>('notification_channel', id, ownerId);
  }

  public async revokeChannelDestination(
    ownerId: string,
    id: string,
    reason: string,
    expectedRevision?: number,
  ): Promise<Entity<NotificationChannelDestination>> {
    const revokeReason = boundedText(reason, 120);
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const current = await this.store.get<NotificationChannelDestination>('notification_channel', id, ownerId);
      if (!current) throw new DomainError('not_found', 'Notification destination not found', 404);
      if (expectedRevision !== undefined && current.revision !== expectedRevision) {
        throw new DomainError('conflict', 'Notification destination changed; reload and retry.', 409);
      }
      if (current.data.status === 'revoked') return current;
      const now = this.now().toISOString();
      try {
        return await this.store.put('notification_channel', id, ownerId, {
          ...current.data,
          status: 'revoked',
          updatedAt: now,
          revokedAt: now,
          revokeReason,
        }, current.revision);
      } catch (error) {
        if (!(error instanceof DomainError && error.code === 'conflict')) throw error;
      }
    }
    throw new DomainError('busy', 'Notification destination is busy; retry.', 409);
  }

  public list(ownerId: string): Promise<Array<Entity<Notification>>> {
    return this.store.scan<Notification>('notification', ownerId);
  }

  public async markRead(ownerId: string, id: string): Promise<Entity<Notification>> {
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const current = await this.store.get<Notification>('notification', id, ownerId);
      if (!current) throw new DomainError('not_found', 'Notification not found', 404);
      if (current.data.read) return current;
      try {
        return await this.store.put('notification', id, ownerId, { ...current.data, read: true }, current.revision);
      } catch (error) {
        if (!(error instanceof DomainError && error.code === 'conflict')) throw error;
      }
    }
    throw new DomainError('busy', 'Notification is busy; retry.', 409);
  }

  public async registerPushSubscription(
    ownerId: string,
    authorization: string | undefined,
    input: PushSubscriptionInput,
  ): Promise<PublicPushSubscription> {
    validatePushSubscription(input);
    if (!this.options.verifyDevice) {
      throw new DomainError('push_registration_unavailable', 'Account device verification is unavailable.', 503);
    }
    await this.options.verifyDevice(authorization, input.deviceId);
    const now = this.now().toISOString();
    const token = input.token.toLowerCase();
    const tokenHash = digest(token);
    const id = digest(ownerId, input.deviceId, input.topic, input.environment);
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const current = await this.store.get<PushSubscription>('push_subscription', id, ownerId);
      if (!current) {
        try {
          const created = await this.store.create<PushSubscription>('push_subscription', ownerId, {
            deviceId: input.deviceId,
            platform: 'apns',
            environment: input.environment,
            topic: input.topic,
            token,
            tokenHash,
            status: 'active',
            activatedAt: now,
            updatedAt: now,
          }, id);
          return publicSubscription(created);
        } catch (error) {
          if (!(error instanceof DomainError && error.code === 'conflict')) throw error;
          continue;
        }
      }
      const reactivated = current.data.status !== 'active' || current.data.tokenHash !== tokenHash;
      try {
        const updated = await this.store.put<PushSubscription>('push_subscription', id, ownerId, {
          ...current.data,
          token,
          tokenHash,
          status: 'active',
          activatedAt: reactivated ? now : current.data.activatedAt,
          updatedAt: now,
          revokedAt: undefined,
          revokeReason: undefined,
        }, current.revision);
        return publicSubscription(updated);
      } catch (error) {
        if (!(error instanceof DomainError && error.code === 'conflict')) throw error;
      }
    }
    throw new DomainError('busy', 'Push subscription is busy; retry.', 409);
  }

  public async listPushSubscriptions(ownerId: string): Promise<PublicPushSubscription[]> {
    return (await this.store.scan<PushSubscription>('push_subscription', ownerId)).map(publicSubscription);
  }

  public async activePushSubscriptions(ownerId: string): Promise<Array<Entity<PushSubscription>>> {
    return (await this.store.scan<PushSubscription>('push_subscription', ownerId))
      .filter((subscription) => subscription.data.status === 'active');
  }

  public pushSubscription(ownerId: string, id: string): Promise<Entity<PushSubscription> | undefined> {
    return this.store.get<PushSubscription>('push_subscription', id, ownerId);
  }

  public async revokePushSubscription(
    ownerId: string,
    id: string,
    reason: string,
    expectedRevision?: number,
  ): Promise<Entity<PushSubscription>> {
    const revokeReason = boundedText(reason, 120);
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const current = await this.store.get<PushSubscription>('push_subscription', id, ownerId);
      if (!current) throw new DomainError('not_found', 'Push subscription not found', 404);
      if (expectedRevision !== undefined && current.revision !== expectedRevision) {
        throw new DomainError('conflict', 'Push subscription changed; reload and retry.', 409);
      }
      if (current.data.status === 'revoked') return current;
      const now = this.now().toISOString();
      try {
        return await this.store.put('push_subscription', id, ownerId, {
          ...current.data,
          status: 'revoked',
          updatedAt: now,
          revokedAt: now,
          revokeReason,
        }, current.revision);
      } catch (error) {
        if (!(error instanceof DomainError && error.code === 'conflict')) throw error;
      }
    }
    throw new DomainError('busy', 'Push subscription is busy; retry.', 409);
  }

  public async deliverableNotifications(): Promise<Array<Entity<Notification>>> {
    return (await this.store.scan<Notification>('notification')).filter((row) => row.data.pushEligible);
  }

  public async deliverableChannelNotifications(): Promise<Array<Entity<Notification>>> {
    return (await this.store.scan<Notification>('notification'))
      .filter((row) => row.data.targetChannelDestinationId !== undefined);
  }

  public async reconcile(): Promise<void> {
    const tasks = await this.store.scan<Task>('task');
    for (const task of tasks) {
      const input = taskNotification(task);
      if (input) await this.publishTask(task.ownerId, input, new Date(task.updatedAt), task.data.notificationDestination);
    }
    for (const schedule of await this.store.scan<AutomationScheduleNotification>('automation_schedule')) {
      if (!schedule.data.authorizationFailedAt) continue;
      await this.publishTask(schedule.ownerId, {
        type: 'schedule_authorization_failed',
        dedupeKey: `schedule:${schedule.id}:authorization:${schedule.data.authorizationFailedAt}`,
        scheduleId: schedule.id,
      }, new Date(schedule.data.authorizationFailedAt), schedule.data.settings.notification);
    }
  }
}

export function notificationDeliveryAt(
  preferences: NotificationPreferences,
  at: Date,
): { quiet: boolean; deliverAfter: string } {
  validatePreferences(preferences);
  if (!preferences.quietHours || !isQuietAt(preferences.timezone, preferences.quietHours, at)) {
    return { quiet: false, deliverAfter: at.toISOString() };
  }
  let candidate = Math.floor(at.getTime() / 60_000) * 60_000 + 60_000;
  for (let minute = 0; minute < 72 * 60; minute += 1, candidate += 60_000) {
    const date = new Date(candidate);
    if (!isQuietAt(preferences.timezone, preferences.quietHours, date)) {
      return { quiet: true, deliverAfter: date.toISOString() };
    }
  }
  throw new DomainError('invalid_quiet_hours', 'Quiet hours do not have a delivery window.');
}

export function accountDeviceVerifier(
  accountApiUrl: string,
  fetcher: typeof fetch = fetch,
): (authorization: string | undefined, deviceId: string) => Promise<void> {
  const origin = secureAccountApiOrigin(accountApiUrl);
  return async (authorization, deviceId) => {
    const token = bearer(authorization);
    let response: Response;
    try {
      response = await fetcher(new URL('/api/account/devices/', origin), {
        headers: { authorization: `Bearer ${token}` },
        redirect: 'error',
        signal: AbortSignal.timeout(5_000),
      });
    } catch {
      throw new DomainError('identity_unavailable', 'Account device verification is unavailable.', 503);
    }
    if (!response.ok) {
      if (response.status === 401) throw new DomainError('unauthorized', 'Account session expired or was revoked.', 401);
      throw new DomainError('identity_unavailable', 'Account device verification is unavailable.', 503);
    }
    const envelope = await response.json() as { success?: boolean; data?: { devices?: unknown } };
    const devices = envelope.data?.devices;
    if (!envelope.success || !Array.isArray(devices)
      || devices.some((device) => typeof device !== 'object' || device === null || typeof (device as { id?: unknown }).id !== 'string')) {
      throw new DomainError('invalid_identity', 'Account returned an invalid device list.', 503);
    }
    if (!devices.some((device) => (device as { id: string }).id === deviceId)) {
      throw new DomainError('device_not_authorized', 'Push subscription must use an active signed-in device.', 403);
    }
  };
}

function taskNotification(task: Entity<Task>): NotificationInput | undefined {
  if (task.data.state === 'completed') {
    return {
      type: 'task_completed',
      dedupeKey: `task:${task.id}:completed`,
      taskId: task.id,
      conversationId: task.data.conversationId,
    };
  }
  if (task.data.state === 'failed') {
    return {
      type: 'task_failed',
      dedupeKey: `task:${task.id}:failed`,
      taskId: task.id,
      conversationId: task.data.conversationId,
    };
  }
  if (task.data.state === 'unknown') {
    return {
      type: 'task_unknown',
      dedupeKey: `task:${task.id}:unknown`,
      taskId: task.id,
      conversationId: task.data.conversationId,
    };
  }
  if (task.data.state === 'waiting_for_approval') {
    const actions = task.data.pendingActions.map((action) => action.hash).sort().join(',');
    return {
      type: 'approval_required',
      dedupeKey: `task:${task.id}:approval:${digest(actions)}`,
      taskId: task.id,
      conversationId: task.data.conversationId,
    };
  }
  return undefined;
}

function notificationCopy(type: NotificationType): { title: string; body: string } {
  switch (type) {
    case 'task_completed': return { title: '任務已完成', body: '你的 Kian 任務已完成。' };
    case 'task_failed': return { title: '任務未完成', body: '你的 Kian 任務執行失敗，請打開 App 查看詳情。' };
    case 'task_unknown': return { title: '任務結果待確認', body: '任務可能已產生外部變更，請打開 App 核實結果。' };
    case 'approval_required': return { title: '需要你的批准', body: 'Kian 正等待你批准一項操作。' };
    case 'schedule_authorization_failed': return { title: '排程已暫停', body: '排程授權已失效，請重新登入後啟用。' };
    case 'important_change': return { title: 'Kian 重要更新', body: '請打開 App 查看詳情。' };
  }
}

function validatePreferences(preferences: NotificationPreferences): void {
  if (!validTimeZone(preferences.timezone)) {
    throw new DomainError('invalid_timezone', 'Timezone must be a valid IANA timezone.');
  }
  const quiet = preferences.quietHours;
  if (quiet && (!timePattern.test(quiet.start) || !timePattern.test(quiet.end) || quiet.start === quiet.end)) {
    throw new DomainError('invalid_quiet_hours', 'Quiet hours require different HH:mm start and end times.');
  }
}

function validatePushSubscription(input: PushSubscriptionInput): void {
  if (!input.deviceId || input.deviceId.length > 200) throw new DomainError('invalid_device', 'Device ID is invalid.');
  if (!topicPattern.test(input.topic)) throw new DomainError('invalid_topic', 'APNs topic is invalid.');
  if (!tokenPattern.test(input.token)) throw new DomainError('invalid_device_token', 'APNs device token is invalid.');
}

function validTimeZone(timezone: string): boolean {
  if (!timezone || timezone.length > 100) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: timezone }).format(0);
    return true;
  } catch {
    return false;
  }
}

function isQuietAt(timezone: string, quiet: QuietHours, at: Date): boolean {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: timezone,
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(at);
  const hour = Number(parts.find((part) => part.type === 'hour')?.value);
  const minute = Number(parts.find((part) => part.type === 'minute')?.value);
  const current = hour * 60 + minute;
  const start = minutes(quiet.start);
  const end = minutes(quiet.end);
  return start < end ? current >= start && current < end : current >= start || current < end;
}

function minutes(value: string): number {
  const [hour = '0', minute = '0'] = value.split(':');
  return Number(hour) * 60 + Number(minute);
}

function publicSubscription(entity: Entity<PushSubscription>): PublicPushSubscription {
  const { token: _token, ...data } = entity.data;
  return { ...entity, data };
}

function sameNotificationEvent(
  existing: Notification,
  input: NotificationInput,
  occurredAt: Date,
  title: string,
  body: string,
  delivery: NotificationDelivery,
): boolean {
  return existing.type === input.type
    && existing.dedupeKey === input.dedupeKey
    && (delivery.reuseOccurredAt === true || existing.occurredAt === occurredAt.toISOString())
    && existing.title === title
    && existing.body === body
    && existing.taskId === input.taskId
    && existing.conversationId === input.conversationId
    && existing.scheduleId === input.scheduleId
    && existing.pushEligible === delivery.pushEligible
    && existing.targetSubscriptionId === delivery.targetSubscriptionId
    && existing.targetChannelDestinationId === delivery.targetChannelDestinationId;
}

function validateChannelDestination(input: NotificationChannelDestinationInput): void {
  if (!/^[a-z][a-z0-9_-]{0,63}$/.test(input.channel)
    || !input.chatId || input.chatId.length > 256 || /[\u0000-\u001f\u007f]/.test(input.chatId)) {
    throw new DomainError('invalid_notification_destination', 'Notification channel destination is invalid.');
  }
}

function boundedText(value: string, maximum: number): string {
  const text = value.trim();
  if (!text || text.length > maximum) throw new DomainError('invalid_notification', 'Notification text is invalid.');
  return text;
}

function digest(...parts: string[]): string {
  return createHash('sha256').update(parts.join('\u0000')).digest('hex');
}
