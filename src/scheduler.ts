import { createHash, randomUUID } from 'node:crypto';
import { CronExpressionParser } from 'cron-parser';
import { DomainError, type Principal } from './contracts.js';
import {
  AutomationDispatcher,
  type AutomationExecutionSnapshot,
  type AutomationSettingsInput,
} from './event-triggers.js';
import type { Entity, Store } from './storage/store.js';

export interface AutomationScheduleInput {
  name: string;
  prompt: string;
  nextAt?: string;
  intervalSeconds?: number;
  cronExpression?: string;
  timezone?: string;
  enabled?: boolean;
  settings: AutomationSettingsInput;
}

export interface AutomationSchedule {
  name: string;
  prompt: string;
  nextAt: string;
  intervalSeconds?: number;
  cronExpression?: string;
  timezone?: string;
  enabled: boolean;
  actor: Principal;
  settings: AutomationExecutionSnapshot;
  version: number;
  lastOccurrenceAt?: string;
  lastTaskId?: string;
  authorizationFailedAt?: string;
}

export type LegacyScheduleDraftTiming =
  | { type: 'cron'; expression: string; timezone?: string }
  | { type: 'interval'; intervalSeconds: number; anchorAt?: string }
  | { type: 'once'; at: string };

export interface LegacyScheduleDraft {
  name: string;
  prompt: string;
  timing: LegacyScheduleDraftTiming;
  enabled: false;
  originalEnabled: boolean;
  requiresReview: Array<'execution_settings' | 'prompt' | 'timezone'>;
  importedAt: string;
  source: {
    system: 'hermes' | 'openclaw';
    idHash: string;
    fingerprint: string;
  };
}

export interface ScheduleOccurrence {
  scheduleId: string;
  scheduleVersion: number;
  dueAt: string;
  prompt: string;
  actor: Principal;
  settings: AutomationExecutionSnapshot;
  status: 'pending' | 'processing' | 'enqueued' | 'rejected';
  attempts: number;
  availableAt?: string;
  claim?: { workerId: string; expiresAt: string };
  taskId?: string;
  rejectionCode?: string;
  lastError?: string;
}

export interface SchedulerOptions {
  enabled?: boolean;
  now?: () => number;
  claimMs?: number;
  reauthorize?: (principal: Principal) => Promise<Principal>;
}

interface ScheduleTombstone {
  removedAt: string;
}

const permanentAuthorizationCodes = new Set([
  'access_revoked',
  'actor_expired',
  'authorization_revalidation_required',
  'forbidden',
  'grant_expired',
  'grant_revoked',
  'owner_required',
  'plugin_snapshot_missing',
  'unauthorized',
  'workspace_snapshot_changed',
]);

export class SchedulerService {
  private readonly enabled: boolean;
  private readonly now: () => number;
  private readonly claimMs: number;
  private readonly workerId = randomUUID();

  public constructor(
    private readonly store: Store,
    private readonly dispatcher: AutomationDispatcher,
    private readonly options: SchedulerOptions = {},
  ) {
    this.enabled = options.enabled === true;
    this.now = options.now ?? Date.now;
    this.claimMs = options.claimMs ?? 30_000;
  }

  public async create(actor: Principal, input: AutomationScheduleInput): Promise<Entity<AutomationSchedule>> {
    assertScheduleActor(actor, this.now());
    const timing = normalizeScheduleTiming(input, this.now());
    if (input.enabled && !this.enabled) {
      throw new DomainError('scheduler_disabled', 'Scheduled execution is not enabled on this server.', 503);
    }
    const settings = await this.dispatcher.snapshot(actor.id, input.settings);
    return this.store.create<AutomationSchedule>('automation_schedule', actor.id, {
      name: input.name.trim(),
      prompt: input.prompt.trim(),
      ...timing,
      enabled: input.enabled === true,
      actor,
      settings,
      version: 1,
    });
  }

  public list(ownerId: string): Promise<Array<Entity<AutomationSchedule>>> {
    return this.store.scan<AutomationSchedule>('automation_schedule', ownerId);
  }

  public listDrafts(ownerId: string): Promise<Array<Entity<LegacyScheduleDraft>>> {
    return this.store.scan<LegacyScheduleDraft>('automation_schedule_draft', ownerId);
  }

  public async removeDraft(actor: Principal, id: string, expectedRevision: number): Promise<void> {
    assertScheduleActor(actor, this.now());
    const current = await this.store.get<LegacyScheduleDraft>('automation_schedule_draft', id, actor.id);
    if (!current) throw new DomainError('not_found', 'Schedule draft not found', 404);
    if (current.revision !== expectedRevision) {
      throw new DomainError('conflict', 'Schedule draft changed; reload and retry.', 409);
    }
    await this.store.remove('automation_schedule_draft', id, actor.id, expectedRevision);
  }

  public async update(
    actor: Principal,
    id: string,
    expectedRevision: number,
    input: AutomationScheduleInput,
  ): Promise<Entity<AutomationSchedule>> {
    assertScheduleActor(actor, this.now());
    const timing = normalizeScheduleTiming(input, this.now());
    if (input.enabled && !this.enabled) {
      throw new DomainError('scheduler_disabled', 'Scheduled execution is not enabled on this server.', 503);
    }
    const current = await this.requireSchedule(actor.id, id);
    if (current.revision !== expectedRevision) throw new DomainError('conflict', 'Schedule changed; reload and retry.', 409);
    const settings = await this.dispatcher.snapshot(actor.id, input.settings);
    return this.store.put('automation_schedule', id, actor.id, {
      ...current.data,
      name: input.name.trim(),
      prompt: input.prompt.trim(),
      ...timing,
      intervalSeconds: timing.intervalSeconds,
      cronExpression: timing.cronExpression,
      timezone: timing.timezone,
      enabled: input.enabled === true,
      actor,
      settings,
      version: current.data.version + 1,
      authorizationFailedAt: undefined,
    }, expectedRevision);
  }

  public async setEnabled(
    actor: Principal,
    id: string,
    expectedRevision: number,
    enabled: boolean,
  ): Promise<Entity<AutomationSchedule>> {
    assertScheduleActor(actor, this.now());
    if (enabled && !this.enabled) {
      throw new DomainError('scheduler_disabled', 'Scheduled execution is not enabled on this server.', 503);
    }
    const current = await this.requireSchedule(actor.id, id);
    if (current.revision !== expectedRevision) throw new DomainError('conflict', 'Schedule changed; reload and retry.', 409);
    return this.store.put('automation_schedule', id, actor.id, {
      ...current.data,
      enabled,
      authorizationFailedAt: enabled ? undefined : current.data.authorizationFailedAt,
    }, expectedRevision);
  }

  public async remove(actor: Principal, id: string, expectedRevision: number): Promise<void> {
    assertScheduleActor(actor, this.now());
    const current = await this.requireSchedule(actor.id, id);
    if (current.revision !== expectedRevision) throw new DomainError('conflict', 'Schedule changed; reload and retry.', 409);
    const disabled = await this.store.put<AutomationSchedule>('automation_schedule', id, actor.id, {
      ...current.data,
      enabled: false,
    }, expectedRevision);
    await createOrVerify<ScheduleTombstone>(this.store, 'automation_schedule_tombstone', id, actor.id, {
      removedAt: new Date(this.now()).toISOString(),
    });
    await this.rejectPending(actor.id, id, 'schedule_removed');
    await this.store.remove('automation_schedule', id, actor.id, disabled.revision);
  }

  public async reconcile(): Promise<void> {
    if (!this.enabled) return;
    const now = this.now();
    for (const schedule of await this.store.scan<AutomationSchedule>('automation_schedule')) {
      if (!schedule.data.enabled || Date.parse(schedule.data.nextAt) > now) continue;
      await this.materializeOccurrence(schedule);
    }
    const occurrences = (await this.store.scan<ScheduleOccurrence>('schedule_occurrence'))
      .filter((row) => row.data.status === 'pending'
        ? !row.data.availableAt || Date.parse(row.data.availableAt) <= now
        : row.data.status === 'processing' && Date.parse(row.data.claim?.expiresAt ?? '') <= now)
      .slice(0, 100);
    for (const occurrence of occurrences) await this.reconcileOccurrence(occurrence);
  }

  private async materializeOccurrence(schedule: Entity<AutomationSchedule>): Promise<void> {
    if (await this.store.get<ScheduleTombstone>('automation_schedule_tombstone', schedule.id, schedule.ownerId)) return;
    const occurrenceId = digest(`${schedule.ownerId}\0${schedule.id}\0${schedule.data.nextAt}`);
    const occurrence: ScheduleOccurrence = {
      scheduleId: schedule.id,
      scheduleVersion: schedule.data.version,
      dueAt: schedule.data.nextAt,
      prompt: schedule.data.prompt,
      actor: schedule.data.actor,
      settings: schedule.data.settings,
      status: 'pending',
      attempts: 0,
    };
    await createOrVerify(this.store, 'schedule_occurrence', occurrenceId, schedule.ownerId, occurrence);
    const nextAt = schedule.data.cronExpression && schedule.data.timezone
      ? cronScheduleNextAt(schedule.data.cronExpression, schedule.data.timezone, this.now())
      : schedule.data.intervalSeconds
        ? nextFutureOccurrence(schedule.data.nextAt, schedule.data.intervalSeconds, this.now())
        : schedule.data.nextAt;
    try {
      await this.store.put<AutomationSchedule>('automation_schedule', schedule.id, schedule.ownerId, {
        ...schedule.data,
        enabled: Boolean(schedule.data.intervalSeconds || schedule.data.cronExpression),
        nextAt,
        lastOccurrenceAt: schedule.data.nextAt,
      }, schedule.revision);
    } catch (error) {
      if (!isConflict(error)) throw error;
    }
  }

  private async reconcileOccurrence(candidate: Entity<ScheduleOccurrence>): Promise<void> {
    let claimed: Entity<ScheduleOccurrence>;
    try {
      claimed = await this.store.put('schedule_occurrence', candidate.id, candidate.ownerId, {
        ...candidate.data,
        status: 'processing',
        attempts: candidate.data.attempts + 1,
        claim: {
          workerId: this.workerId,
          expiresAt: new Date(this.now() + this.claimMs).toISOString(),
        },
      }, candidate.revision);
    } catch (error) {
      if (isConflict(error)) return;
      throw error;
    }
    try {
      if (await this.store.get<ScheduleTombstone>('automation_schedule_tombstone', claimed.data.scheduleId, claimed.ownerId)) {
        await this.finishClaim(claimed, {
          ...claimed.data,
          status: 'rejected',
          claim: undefined,
          rejectionCode: 'schedule_removed',
        });
        return;
      }
      const task = await this.dispatcher.dispatch({
        ownerId: claimed.ownerId,
        source: 'schedule',
        sourceId: claimed.data.scheduleId,
        occurrenceId: claimed.data.dueAt,
        prompt: claimed.data.prompt,
        actor: claimed.data.actor,
        settings: claimed.data.settings,
        reauthorize: this.options.reauthorize,
      });
      await this.finishClaim(claimed, {
        ...claimed.data,
        status: 'enqueued',
        claim: undefined,
        taskId: task.id,
        lastError: undefined,
      });
      await this.recordTask(claimed.ownerId, claimed.data.scheduleId, claimed.data.dueAt, task.id);
    } catch (error) {
      const code = error instanceof DomainError ? error.code : 'service_unavailable';
      const permanent = permanentAuthorizationCodes.has(code);
      await this.finishClaim(claimed, permanent ? {
        ...claimed.data,
        status: 'rejected',
        claim: undefined,
        rejectionCode: code,
        lastError: error instanceof Error ? error.message : 'Schedule authorization failed',
      } : {
        ...claimed.data,
        status: 'pending',
        claim: undefined,
        availableAt: new Date(this.now() + retryDelay(claimed.data.attempts)).toISOString(),
        lastError: error instanceof Error ? error.message : 'Schedule enqueue failed',
      });
      if (permanent) await this.disableSchedule(claimed.ownerId, claimed.data.scheduleId);
    }
  }

  private async finishClaim(claimed: Entity<ScheduleOccurrence>, data: ScheduleOccurrence): Promise<void> {
    const current = await this.store.get<ScheduleOccurrence>('schedule_occurrence', claimed.id, claimed.ownerId);
    if (!current || current.data.status !== 'processing' || current.data.claim?.workerId !== this.workerId) return;
    await this.store.put('schedule_occurrence', current.id, current.ownerId, data, current.revision);
  }

  private async recordTask(ownerId: string, scheduleId: string, dueAt: string, taskId: string): Promise<void> {
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const schedule = await this.store.get<AutomationSchedule>('automation_schedule', scheduleId, ownerId);
      if (!schedule) return;
      if (schedule.data.lastOccurrenceAt !== dueAt || schedule.data.lastTaskId === taskId) return;
      try {
        await this.store.put('automation_schedule', scheduleId, ownerId, {
          ...schedule.data,
          lastTaskId: taskId,
        }, schedule.revision);
        return;
      } catch (error) {
        if (!isConflict(error)) throw error;
      }
    }
  }

  private async disableSchedule(ownerId: string, scheduleId: string): Promise<void> {
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const schedule = await this.store.get<AutomationSchedule>('automation_schedule', scheduleId, ownerId);
      if (!schedule || schedule.data.authorizationFailedAt) return;
      const authorizationFailedAt = new Date(this.now()).toISOString();
      try {
        await this.store.put('automation_schedule', scheduleId, ownerId, {
          ...schedule.data,
          enabled: false,
          authorizationFailedAt,
        }, schedule.revision);
        return;
      } catch (error) {
        if (!isConflict(error)) throw error;
      }
    }
  }

  private async rejectPending(ownerId: string, scheduleId: string, code: string): Promise<void> {
    for (const row of await this.store.scan<ScheduleOccurrence>('schedule_occurrence', ownerId)) {
      if (row.data.scheduleId !== scheduleId || !['pending', 'processing'].includes(row.data.status)) continue;
      try {
        await this.store.put('schedule_occurrence', row.id, ownerId, {
          ...row.data,
          status: 'rejected',
          claim: undefined,
          rejectionCode: code,
        }, row.revision);
      } catch (error) {
        if (!isConflict(error)) throw error;
      }
    }
  }

  private async requireSchedule(ownerId: string, id: string): Promise<Entity<AutomationSchedule>> {
    const row = await this.store.get<AutomationSchedule>('automation_schedule', id, ownerId);
    if (!row) throw new DomainError('not_found', 'Schedule not found', 404);
    return row;
  }
}

function normalizeScheduleTiming(
  input: AutomationScheduleInput,
  now: number,
): Pick<AutomationSchedule, 'nextAt' | 'intervalSeconds' | 'cronExpression' | 'timezone'> {
  if (!input.name.trim() || input.name.length > 120) throw new DomainError('invalid_schedule', 'Schedule name is invalid.');
  if (!input.prompt.trim() || input.prompt.length > 64_000) throw new DomainError('invalid_schedule', 'Schedule prompt is invalid.');
  const hasCron = input.cronExpression !== undefined || input.timezone !== undefined;
  if (hasCron) {
    if (input.nextAt !== undefined || input.intervalSeconds !== undefined
      || typeof input.cronExpression !== 'string' || typeof input.timezone !== 'string') {
      throw new DomainError('invalid_schedule', 'Cron schedules require an expression and timezone only.');
    }
    const cronExpression = input.cronExpression.trim();
    const timezone = input.timezone.trim();
    if (!cronExpression || cronExpression.length > 200 || cronExpression.split(/\s+/).length !== 5
      || hasRandomizedField(cronExpression)) {
      throw new DomainError('invalid_schedule', 'Cron expression must use five deterministic fields.');
    }
    if (!validTimeZone(timezone)) throw new DomainError('invalid_schedule', 'Schedule timezone must be a valid IANA timezone.');
    return { cronExpression, timezone, nextAt: cronScheduleNextAt(cronExpression, timezone, now) };
  }
  if (!input.nextAt || !Number.isFinite(Date.parse(input.nextAt))) {
    throw new DomainError('invalid_schedule', 'Schedule nextAt is invalid.');
  }
  if (input.intervalSeconds !== undefined
    && (!Number.isInteger(input.intervalSeconds) || input.intervalSeconds < 60 || input.intervalSeconds > 31_536_000)) {
    throw new DomainError('invalid_schedule', 'Schedule interval must be 60 to 31536000 seconds.');
  }
  return { nextAt: input.nextAt, intervalSeconds: input.intervalSeconds };
}

function assertScheduleActor(actor: Principal, now: number): void {
  if (actor.level !== 1) throw new DomainError('owner_required', 'Schedules require the account owner.', 403);
  if (!scopeCovered(actor.scopes, 'schedule:write')) throw new DomainError('forbidden', 'Missing capability: schedule:write', 403);
  if (actor.expiresAt !== undefined && (!Number.isFinite(Date.parse(actor.expiresAt)) || Date.parse(actor.expiresAt) <= now)) {
    throw new DomainError('actor_expired', 'Schedule authorization has expired.', 403);
  }
}

function nextFutureOccurrence(previous: string, intervalSeconds: number, now: number): string {
  const start = Date.parse(previous);
  const interval = intervalSeconds * 1_000;
  const steps = Math.max(1, Math.floor((now - start) / interval) + 1);
  return new Date(start + steps * interval).toISOString();
}

export function cronScheduleNextAt(expression: string, timezone: string, now: number): string {
  if (!expression || expression.length > 200 || expression.trim().split(/\s+/).length !== 5
    || hasRandomizedField(expression)) {
    throw new DomainError('invalid_schedule', 'Cron expression must use five deterministic fields.');
  }
  if (!validTimeZone(timezone)) throw new DomainError('invalid_schedule', 'Schedule timezone must be a valid IANA timezone.');
  try {
    return CronExpressionParser.parse(expression.trim(), {
      currentDate: new Date(now),
      tz: timezone,
    }).next().toDate().toISOString();
  } catch {
    throw new DomainError('invalid_schedule', 'Cron expression has no valid future occurrence.');
  }
}

function hasRandomizedField(expression: string): boolean {
  return /H(?=$|[\s,(\-\/#])/i.test(expression);
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

function scopeCovered(grants: string[], requested: string): boolean {
  const namespace = requested.split(':')[0];
  return grants.some((grant) => grant === '*' || grant === 'kiancode:*' || grant === requested
    || grant === `kiancode:${requested}` || grant === `${namespace}:*`);
}

function retryDelay(attempts: number): number {
  return Math.min(5 * 60_000, 1_000 * 2 ** Math.min(attempts, 8));
}

function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

async function createOrVerify<T>(store: Store, kind: string, id: string, ownerId: string, data: T): Promise<Entity<T>> {
  const current = await store.get<T>(kind, id, ownerId);
  if (current) {
    if (canonical(current.data) !== canonical(data)) {
      throw new DomainError('idempotency_conflict', `${kind} identifier belongs to different data.`, 409);
    }
    return current;
  }
  try {
    return await store.create(kind, ownerId, data, id);
  } catch (error) {
    if (!isConflict(error)) throw error;
    return createOrVerify(store, kind, id, ownerId, data);
  }
}

function isConflict(error: unknown): boolean {
  return error instanceof DomainError && error.code === 'conflict';
}
