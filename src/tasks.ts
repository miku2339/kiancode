import { createHash, randomUUID } from 'node:crypto';
import {
  accountTaskGrantIdentityMatches,
  accountTaskGrantMatches,
  bindAccountTaskGrant,
  isAccountIdentity,
  repairableAccountTaskGrant,
  type AccountTaskGrantAdmission,
} from './account-task-grant.js';
import type { Artifact } from './artifacts.js';
import { markAutomationAuthorizationFailed } from './automation-authorization.js';
import { DomainError, type Principal, type Workspace } from './contracts.js';
import type {
  Conversation,
  AccountTaskGrant,
  Message,
  NotificationDestination,
  PendingAction,
  Task,
  TaskEvent,
  TaskReconciliationRecord,
  TaskReconciliationResolution,
  TaskState,
} from './domain.js';
import type { NotificationInput, NotificationService } from './notifications.js';
import type { Entity, Store } from './storage/store.js';
import { snapshotEnabledPluginVersions } from './plugins.js';
import { reconcileToolCall, type ChatMessage } from './runtime/index.js';
import { WorkspaceWriteLeaseService } from './workspace-write-lease.js';

export interface ExecutionResult {
  text: string;
  status?: 'completed' | 'waiting_for_approval' | 'waiting_for_children';
  pendingActions?: PendingAction[];
  messages?: unknown[];
  usage?: unknown;
}

export interface TaskExecution {
  task: Entity<Task>;
  conversation: Entity<Conversation>;
  history: Array<Entity<Message>>;
  workspace?: Workspace;
  signal: AbortSignal;
  onEvent(event: { type: string; [key: string]: unknown }): Promise<void>;
}

export type TaskRunner = (input: TaskExecution) => Promise<ExecutionResult>;

export interface TaskReconciliation {
  resolution: TaskReconciliationResolution;
  dispatchSequence?: number;
  toolCallId?: string;
  toolOccurrenceId?: string;
  actionHash?: string;
  note?: string;
}

export interface TaskServiceOptions {
  now?: () => number;
  concurrency?: number;
  onError?: (error: unknown) => void;
  onTickError?: (failure: TaskTickFailure) => void;
  onTickRecovered?: (recovery: TaskTickRecovery) => void;
  reauthorize?: (principal: Principal) => Promise<Principal>;
  durableGrants?: boolean;
  isQuietTime?: (ownerId: string, at: Date) => boolean | Promise<boolean>;
  notifications?: Pick<NotificationService, 'publishTask' | 'reconcile'>;
  leaseMs?: number;
  heartbeatMs?: number;
}

export type TaskEnqueueAuthorization = Pick<Task, 'authorizationKind' | 'automationSource'> & {
  accountTaskGrant?: AccountTaskGrantAdmission;
};

export type TaskTickPhase = 'notifications' | 'reconciliations' | 'reconciler' | 'tasks';

export interface TaskTickStatus {
  consecutiveFailures: number;
  lastErrorAt?: string;
}

export interface TaskTickFailure {
  phase: TaskTickPhase;
  code: string;
  message: string;
  consecutiveFailures: number;
}

export interface TaskTickRecovery {
  failedTicks: number;
}

interface TickPhaseFailure {
  phase: TaskTickPhase;
  error: unknown;
}

interface ActiveRun {
  ownerId: string;
  controller: AbortController;
  promise: Promise<void>;
}

interface EventSequence {
  next: number;
  fixed?: Record<string, number>;
}

interface MessageSequence {
  next: number;
}

interface SideEffectDispatch {
  sequence: number;
  toolCallId?: string;
  toolOccurrenceId?: string;
  actionHash?: string;
  toolName?: string;
  toolArguments?: Record<string, unknown>;
  sideEffect: 'write' | 'external';
  resolved: boolean;
}

type RuntimeEvent = { type: string; [key: string]: unknown };

const tokenFlushDelayMs = 32;
const tokenBufferLimitBytes = 64 * 1024;
const failedEventRepairBatchSize = 16;

class DurableRuntimeEventStream {
  private intake = Promise.resolve();
  private persistence = Promise.resolve();
  private tokenContent = '';
  private tokenBytes = 0;
  private tokenTemplate?: RuntimeEvent;
  private flushTimer?: ReturnType<typeof setTimeout>;
  private tokenFlushInFlight?: Promise<void>;
  private failure?: unknown;
  private aborted = false;
  private closed = false;

  public constructor(
    private readonly signal: AbortSignal,
    private readonly persist: (event: RuntimeEvent) => Promise<void>,
  ) {
    signal.addEventListener('abort', () => this.abort(), { once: true });
  }

  public push(event: RuntimeEvent): Promise<void> {
    return this.serialize(async () => {
      this.assertWritable();
      if (event.type !== 'token' || typeof event.content !== 'string') {
        await this.flushTokens(true);
        await this.queuePersistence(event);
        return;
      }
      const bytes = Buffer.byteLength(event.content);
      if (bytes > tokenBufferLimitBytes) {
        await this.flushTokens(true);
        await this.queuePersistence(event);
        return;
      }
      if (this.tokenBytes + bytes > tokenBufferLimitBytes) {
        await this.flushTokens(true);
        this.assertWritable();
      }
      if (!this.tokenTemplate) this.tokenTemplate = { ...event };
      this.tokenContent += event.content;
      this.tokenBytes += bytes;
      this.scheduleFlush();
    });
  }

  public finish(): Promise<void> {
    return this.serialize(async () => {
      if (this.closed) {
        if (this.failure !== undefined) throw this.failure;
        return;
      }
      this.clearFlushTimer();
      this.signal.throwIfAborted();
      await this.flushTokens(true);
      await this.persistence;
      if (this.failure !== undefined) throw this.failure;
      this.closed = true;
    });
  }

  public dispose(): void {
    this.closed = true;
    this.clearFlushTimer();
  }

  private serialize(operation: () => Promise<void>): Promise<void> {
    const next = this.intake.then(operation);
    this.intake = next.catch((error) => {
      if (this.failure === undefined && !this.signal.aborted) this.failure = error;
    });
    return next;
  }

  private async flushTokens(waitForPersistence: boolean): Promise<void> {
    this.clearFlushTimer();
    if (this.tokenFlushInFlight) {
      if (!waitForPersistence) return;
      await this.tokenFlushInFlight;
    }
    if (!this.tokenTemplate) {
      if (waitForPersistence) await this.persistence;
      return;
    }
    const event = { ...this.tokenTemplate, content: this.tokenContent };
    this.tokenTemplate = undefined;
    this.tokenContent = '';
    this.tokenBytes = 0;
    const persisted = this.queuePersistence(event);
    let tracked: Promise<void>;
    tracked = persisted.finally(() => {
      if (this.tokenFlushInFlight === tracked) this.tokenFlushInFlight = undefined;
      if (this.tokenTemplate && !this.closed && !this.aborted && this.failure === undefined) {
        this.scheduleFlush();
      }
    });
    this.tokenFlushInFlight = tracked;
    void tracked.catch(() => undefined);
    if (waitForPersistence) await tracked;
  }

  private queuePersistence(event: RuntimeEvent): Promise<void> {
    const next = this.persistence.then(async () => {
      this.assertWritable();
      await this.persist(event);
    });
    this.persistence = next.catch((error) => {
      if (this.failure === undefined && !this.signal.aborted) this.failure = error;
      throw error;
    });
    void this.persistence.catch(() => undefined);
    return next;
  }

  private scheduleFlush(): void {
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = undefined;
      void this.serialize(async () => {
        this.assertWritable();
        await this.flushTokens(false);
      }).catch(() => undefined);
    }, tokenFlushDelayMs);
    this.flushTimer.unref();
  }

  private clearFlushTimer(): void {
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.flushTimer = undefined;
  }

  private abort(): void {
    this.aborted = true;
    this.clearFlushTimer();
    this.tokenTemplate = undefined;
    this.tokenContent = '';
    this.tokenBytes = 0;
  }

  private assertWritable(): void {
    if (this.failure !== undefined) throw this.failure;
    if (this.aborted || this.closed) {
      this.signal.throwIfAborted();
      throw new DomainError('event_stream_closed', 'Task event stream is closed', 409);
    }
    this.signal.throwIfAborted();
  }
}

const terminalStates: TaskState[] = ['completed', 'failed', 'cancelled', 'unknown'];
const dependencyFailureStates: TaskState[] = ['failed', 'cancelled', 'unknown'];

export class TaskService {
  private readonly workerId = randomUUID();
  private readonly active = new Map<string, ActiveRun>();
  private timer?: ReturnType<typeof setInterval>;
  private ticking?: Promise<void>;
  private stopped = false;
  private reconciler?: () => Promise<void>;
  private tickFailures = 0;
  private tickLastErrorAt?: string;
  private failedEventRepairOffset = 0;

  public constructor(
    private readonly store: Store,
    private readonly runner: TaskRunner,
    private readonly options: TaskServiceOptions = {},
  ) {}

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }

  public async enqueue(
    principal: Principal,
    conversationId: string,
    prompt: string,
    requestId?: string,
    attachmentIds: string[] = [],
    dependencyIds: string[] = [],
    notificationDestination?: NotificationDestination,
    pluginVersions?: Record<string, string>,
    authorization?: TaskEnqueueAuthorization,
  ): Promise<Entity<Task>> {
    const conversation = await this.store.get<Conversation>('conversation', conversationId, principal.id);
    if (!conversation || conversation.data.archived) {
      throw new DomainError('not_found', 'Conversation not found', 404);
    }
    if (!prompt.trim() || prompt.length > 64_000) {
      throw new DomainError('invalid_prompt', 'Prompt must contain 1 to 64000 characters');
    }
    if (attachmentIds.length > 10) {
      throw new DomainError('too_many_attachments', 'A task can include at most 10 attachments.');
    }
    const attachments = [...new Set(attachmentIds)].sort();
    for (const attachmentId of attachments) {
      if (!attachmentId || !await this.store.get('artifact', attachmentId, principal.id)) {
        throw new DomainError('not_found', 'Attachment not found', 404);
      }
    }
    const dependencies = [...new Set(dependencyIds)].sort();
    if (dependencies.length > 20) {
      throw new DomainError('too_many_dependencies', 'A task can depend on at most 20 tasks.');
    }
    for (const dependencyId of dependencies) {
      if (!await this.store.get<Task>('task', dependencyId, principal.id)) {
        throw new DomainError('not_found', 'Dependency task not found', 404);
      }
    }
    const id = requestId
      ? createHash('sha256').update(`${principal.id}\0${conversationId}\0${requestId}`).digest('hex')
      : randomUUID();
    if (dependencies.includes(id)) {
      throw new DomainError('invalid_dependency', 'A task cannot depend on itself.');
    }
    const previous = await this.store.get<Task>('task', id, principal.id);
    if (previous) {
      if (previous.data.prompt !== prompt
        || !sameStrings(previous.data.attachmentIds ?? [], attachments)
        || !sameStrings(previous.data.dependencyIds ?? [], dependencies)
        || !sameNotificationDestination(previous.data.notificationDestination, notificationDestination)
        || (pluginVersions !== undefined && !sameRecord(previous.data.pluginVersions ?? {}, normalizePluginVersions(pluginVersions)))
        || !sameTaskAuthorization(previous, authorization)) {
        throw new DomainError('idempotency_conflict', 'Request ID already belongs to another task input', 409);
      }
      return previous;
    }
    const capturedPluginVersions = pluginVersions === undefined
      ? await snapshotEnabledPluginVersions(this.store, principal.id)
      : normalizePluginVersions(pluginVersions);
    const accountAuthorization = authorization?.accountTaskGrant
      ? bindAccountTaskGrant(principal, authorization.accountTaskGrant, id)
      : undefined;
    const taskPrincipal = accountAuthorization?.principal ?? principal;
    let task: Entity<Task>;
    try {
      task = await this.store.create<Task>('task', principal.id, {
        conversationId,
        ...(conversation.data.workspaceId ? { workspaceId: conversation.data.workspaceId } : {}),
        prompt,
        principal: taskPrincipal,
        state: 'queued',
        grantExpiresAt: renewedGrantExpiry(taskPrincipal, this.now()),
        pendingActions: [],
        approvedActionHashes: [],
        pluginVersions: capturedPluginVersions,
        ...(attachments.length ? { attachmentIds: attachments } : {}),
        ...(dependencies.length ? { dependencyIds: dependencies } : {}),
        ...(notificationDestination ? { notificationDestination } : {}),
        ...(accountAuthorization ? { accountTaskGrant: accountAuthorization.grant } : {}),
        ...(authorization?.authorizationKind ? { authorizationKind: authorization.authorizationKind } : {}),
        ...(authorization?.automationSource ? { automationSource: authorization.automationSource } : {}),
      }, id);
    } catch (error) {
      if (error instanceof DomainError && error.code === 'conflict') {
        return this.enqueue(principal, conversationId, prompt, requestId, attachments, dependencies, notificationDestination, capturedPluginVersions, authorization);
      }
      throw error;
    }
    await this.ensureUserMessage(task);
    await this.event(task, { type: 'queued' });
    return task;
  }

  private async ensureUserMessage(task: Entity<Task>): Promise<void> {
    const id = `${task.id}:user`;
    if (await this.store.get('message', id, task.ownerId)) {
      return;
    }
    try {
      await this.store.create<Message>('message', task.ownerId, {
        conversationId: task.data.conversationId,
        role: 'user',
        content: task.data.prompt,
        taskId: task.id,
        sequence: await this.nextMessageSequence(task.ownerId, task.data.conversationId),
        ...(task.data.attachmentIds?.length ? { attachmentIds: task.data.attachmentIds } : {}),
      }, id);
    } catch (error) {
      if (!(error instanceof DomainError && error.code === 'conflict')) {
        throw error;
      }
    }
  }

  public setReconciler(reconciler: (() => Promise<void>) | undefined): void {
    this.reconciler = reconciler;
  }

  public tickStatus(): TaskTickStatus {
    return {
      consecutiveFailures: this.tickFailures,
      ...(this.tickLastErrorAt ? { lastErrorAt: this.tickLastErrorAt } : {}),
    };
  }

  public async events(ownerId: string, taskId: string, after = 0): Promise<Array<Entity<TaskEvent>>> {
    const task = await this.store.get<Task>('task', taskId, ownerId);
    if (!task) {
      throw new DomainError('not_found', 'Task not found', 404);
    }
    if (task.data.state === 'failed') await this.ensureFailedEvent(task);
    return (await this.store.scan<TaskEvent>('event', ownerId))
      .filter((row) => row.data.taskId === taskId && row.data.sequence > after)
      .sort((left, right) => left.data.sequence - right.data.sequence);
  }

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

  private async nextEventSequence(ownerId: string, taskId: string): Promise<number> {
    for (let attempt = 0; attempt < 16; attempt += 1) {
      const cursor = await this.store.get<EventSequence>('event_sequence', taskId, ownerId);
      if (!cursor) {
        try {
          const existing = (await this.store.scan<TaskEvent>('event', ownerId))
            .filter((row) => row.data.taskId === taskId);
          const sequence = Math.max(0, ...existing.map((row) => row.data.sequence)) + 1;
          await this.store.create<EventSequence>('event_sequence', ownerId, { next: sequence + 1 }, taskId);
          return sequence;
        } catch (error) {
          if (error instanceof DomainError && error.code === 'conflict') {
            continue;
          }
          throw error;
        }
      }
      try {
        const existing = (await this.store.scan<TaskEvent>('event', ownerId))
          .filter((row) => row.data.taskId === taskId);
        const sequence = Math.max(
          cursor.data.next,
          Math.max(0, ...existing.map((row) => row.data.sequence)) + 1,
        );
        await this.store.put<EventSequence>(
          'event_sequence',
          taskId,
          ownerId,
          { ...cursor.data, next: sequence + 1 },
          cursor.revision,
        );
        return sequence;
      } catch (error) {
        if (!(error instanceof DomainError && error.code === 'conflict')) {
          throw error;
        }
      }
    }
    throw new DomainError('busy', 'Task event stream is busy; retry', 409);
  }

  private async nextFixedEventSequence(ownerId: string, taskId: string, eventId: string): Promise<number> {
    for (let attempt = 0; attempt < 16; attempt += 1) {
      const cursor = await this.store.get<EventSequence>('event_sequence', taskId, ownerId);
      const reserved = cursor?.data.fixed?.[eventId];
      if (reserved !== undefined) return reserved;
      const existing = (await this.store.scan<TaskEvent>('event', ownerId))
        .filter((row) => row.data.taskId === taskId);
      const sequence = Math.max(
        cursor?.data.next ?? 1,
        Math.max(0, ...existing.map((row) => row.data.sequence)) + 1,
      );
      try {
        if (!cursor) {
          await this.store.create<EventSequence>('event_sequence', ownerId, {
            next: sequence + 1,
            fixed: { [eventId]: sequence },
          }, taskId);
        } else {
          await this.store.put<EventSequence>('event_sequence', taskId, ownerId, {
            ...cursor.data,
            next: sequence + 1,
            fixed: { ...cursor.data.fixed, [eventId]: sequence },
          }, cursor.revision);
        }
        return sequence;
      } catch (error) {
        if (!(error instanceof DomainError && error.code === 'conflict')) throw error;
      }
    }
    throw new DomainError('busy', 'Task event stream is busy; retry', 409);
  }

  private async change(ownerId: string, id: string, change: (task: Task) => Task): Promise<Entity<Task>> {
    for (let attempt = 0; attempt < 16; attempt += 1) {
      const row = await this.store.get<Task>('task', id, ownerId);
      if (!row) {
        throw new DomainError('not_found', 'Task not found', 404);
      }
      try {
        const updated = change(row.data);
        if (updated === row.data) return row;
        return await this.store.put('task', id, ownerId, updated, row.revision);
      } catch (error) {
        if (!(error instanceof DomainError && error.code === 'conflict')) {
          throw error;
        }
      }
    }
    throw new DomainError('busy', 'Task is busy; retry', 409);
  }

  public async control(
    ownerId: string,
    id: string,
    action: 'pause' | 'resume' | 'cancel',
    hashes: string[] = [],
    actor?: Principal,
  ): Promise<Entity<Task>> {
    const before = action === 'resume' ? false : await this.hasUnresolvedSideEffect(ownerId, id);
    let row = await this.change(ownerId, id, (task) => {
      if (terminalStates.includes(task.state)) {
        throw new DomainError('terminal_task', 'Task has already stopped', 409);
      }
      if (action === 'cancel') {
        return {
          ...task,
          cancelRequested: true,
          state: before ? 'unknown' : 'cancelled',
          ...(before ? { error: 'Cancellation was requested after a side effect was dispatched; verify its outcome.' } : {}),
        };
      }
      if (action === 'pause') {
        return {
          ...task,
          pauseRequested: true,
          state: before ? 'unknown' : 'paused',
          ...(before ? { error: 'Pause was requested after a side effect was dispatched; verify its outcome.' } : {}),
        };
      }
      if (task.state === 'running') {
        throw new DomainError('already_running', 'Task is already running', 409);
      }
      if (actor && actor.id !== ownerId) {
        throw new DomainError('forbidden', 'The current principal does not own this task', 403);
      }
      const expected = new Set(task.pendingActions.map((pending) => pending.hash));
      if (hashes.some((hash) => !expected.has(hash))) {
        throw new DomainError('invalid_approval', 'Approval does not match a pending action', 409);
      }
      const approved = new Set([...task.approvedActionHashes, ...hashes]);
      if (task.state === 'waiting_for_approval'
        && task.pendingActions.some((pending) => !approved.has(pending.hash))) {
        throw new DomainError('approval_required', 'Approve the exact pending actions first', 409);
      }
      const principal = actor
        ? resumedPrincipal(task, id, actor, this.now(), this.options.durableGrants === true)
        : task.principal;
      return {
        ...task,
        principal,
        state: task.orchestration?.role === 'parent' && task.orchestration.phase === 'children'
          ? 'waiting_for_children'
          : 'queued',
        pauseRequested: false,
        nextAttemptAt: undefined,
        grantExpiresAt: renewedGrantExpiry(
          principal,
          this.now(),
          task.accountTaskGrant?.delegationExpiresAt,
        ),
        approvedActionHashes: [...approved],
      };
    });
    if (action !== 'resume') {
      this.active.get(id)?.controller.abort(new DOMException(action, 'AbortError'));
      if (!before && await this.hasUnresolvedSideEffect(ownerId, id)) {
        row = await this.change(ownerId, id, (task) => ({
          ...task,
          state: 'unknown',
          error: `${action === 'cancel' ? 'Cancellation' : 'Pause'} was requested after a side effect was dispatched; verify its outcome.`,
        }));
      }
    }
    await this.event(row, { type: action, state: row.data.state });
    return row;
  }

  public async reconcileOutcome(
    actor: Principal,
    id: string,
    input: TaskReconciliation,
  ): Promise<Entity<Task>> {
    if (!scopeCovered(actor.scopes, 'approval:write')) {
      throw new DomainError('forbidden', 'Missing capability: approval:write', 403);
    }
    const ownerId = actor.id;
    let task = await this.store.get<Task>('task', id, ownerId);
    if (!task) throw new DomainError('not_found', 'Task not found', 404);
    resumedPrincipal(task.data, task.id, actor, this.now(), this.options.durableGrants === true);
    const previousDecision = task.data.reconciliation;
    if (previousDecision?.phase === 'pending') {
      assertSameReconciliation(previousDecision, input, actor);
      return this.finishReconciliation(task);
    }
    let dispatches: SideEffectDispatch[] | undefined;
    if (previousDecision?.phase === 'complete') {
      if (explicitlyTargetsReconciliation(previousDecision, input)
        || (!hasReconciliationSelector(input) && previousDecision.dispatchSequence === undefined)) {
        assertSameReconciliation(previousDecision, input, actor);
        return task;
      }
      if (task.data.state === 'unknown' && input.toolCallId !== undefined
        && reconciliationSelectorMatches(previousDecision, input)) {
        dispatches = await this.sideEffectDispatches(ownerId, id);
        if (!dispatches.some((dispatch) => !dispatch.resolved && dispatch.toolCallId === input.toolCallId)) {
          assertSameReconciliation(previousDecision, input, actor);
          return task;
        }
        throw new DomainError(
          'reconciliation_conflict',
          'The selector could name either the completed receipt or a new unresolved dispatch',
          409,
        );
      }
    }
    if (task.data.state !== 'unknown') throw notReconcilable();
    if (input.resolution !== 'abandon' && !hasReconciliationSelector(input)) {
      throw new DomainError('invalid_input', 'Name the exact dispatched action to reconcile', 400);
    }
    if (this.active.has(id) || (task.data.workerId && Date.parse(task.data.leaseExpiresAt ?? '') > this.now())) {
      throw new DomainError('task_busy', 'The task executor must stop before its outcome can be reconciled', 409);
    }
    const principal = resumedPrincipal(task.data, task.id, actor, this.now(), this.options.durableGrants === true);
    const dispatch = hasReconciliationSelector(input)
      ? reconciliationTarget(dispatches ?? await this.sideEffectDispatches(ownerId, id), input)
      : undefined;
    const conversation = await this.store.get<Conversation>('conversation', task.data.conversationId, ownerId);
    if (!conversation) throw new DomainError('not_found', 'Conversation not found', 404);
    const targetState = reconciliationTargetState(task.data, conversation.data, input.resolution);
    if (!task.data.cancelRequested && input.resolution !== 'abandon' && !conversation.data.internalOperation) {
      if (!dispatch) throw new DomainError('invalid_reconciliation', 'A resumable reconciliation requires a dispatch', 409);
      const checkpoint = checkpointForDispatch(task.data.runtimeMessages, dispatch);
      if (!checkpoint || !reconcileToolCall(checkpoint, {
        ...(dispatch.toolCallId ? { toolCallId: dispatch.toolCallId } : {}),
        ...(dispatch.toolOccurrenceId ? { toolOccurrenceId: dispatch.toolOccurrenceId } : {}),
        ...(dispatch.actionHash ? { actionHash: dispatch.actionHash } : {}),
        resolution: input.resolution,
        ...(input.note ? { note: input.note } : {}),
      })) {
        throw new DomainError('not_resumable', 'This task has no matching checkpoint to continue from; use abandon', 409);
      }
    }
    if (input.resolution !== 'abandon' && task.data.workspaceId) {
      await new WorkspaceWriteLeaseService(this.store, () => this.now())
        .verifyTaskRelease(ownerId, task.data.workspaceId, task.id);
    }
    const acceptedAt = new Date(this.now()).toISOString();
    const receiptId = dispatch
      ? `${task.id}:${String(dispatch.sequence).padStart(12, '0')}:reconciled`
      : `${task.id}:reconciled:abandon`;
    const reconciliation: TaskReconciliationRecord = {
      phase: 'pending',
      resolution: input.resolution,
      receiptId,
      ...(dispatch ? { dispatchSequence: dispatch.sequence, sideEffect: dispatch.sideEffect } : {}),
      ...(dispatch?.toolCallId ? { toolCallId: dispatch.toolCallId } : {}),
      ...(dispatch?.toolOccurrenceId ? { toolOccurrenceId: dispatch.toolOccurrenceId } : {}),
      ...(dispatch?.actionHash ? { actionHash: dispatch.actionHash } : {}),
      ...(dispatch?.toolName ? { toolName: dispatch.toolName } : {}),
      ...(input.note ? { note: input.note } : {}),
      actor: reconciliationActor(actor),
      acceptedAt,
      targetState,
      resumePrincipal: principal,
      grantExpiresAt: renewedGrantExpiry(
        principal,
        this.now(),
        task.data.accountTaskGrant?.delegationExpiresAt,
      ),
    };
    try {
      task = await this.store.put('task', task.id, ownerId, { ...task.data, reconciliation }, task.revision);
    } catch (error) {
      if (!(error instanceof DomainError && error.code === 'conflict')) throw error;
      task = await this.store.get<Task>('task', id, ownerId) ?? task;
      if (!task.data.reconciliation) throw new DomainError('busy', 'Task is busy; retry', 409);
      if (previousDecision && sameReconciliationDecision(task.data.reconciliation, previousDecision)) {
        throw new DomainError('busy', 'Task is busy; retry', 409);
      }
      assertSameReconciliation(task.data.reconciliation, input, actor);
    }
    return this.finishReconciliation(task);
  }

  private async finishReconciliation(start: Entity<Task>): Promise<Entity<Task>> {
    let task = await this.store.get<Task>('task', start.id, start.ownerId) ?? start;
    const decision = task.data.reconciliation;
    if (!decision) throw new DomainError('invalid_reconciliation', 'Task has no accepted reconciliation', 409);
    if (decision.phase === 'complete') return task;
    if (decision.dispatchSequence !== undefined && decision.sideEffect) {
      const receiptPayload = reconciliationReceipt(task.id, decision);
      await this.fixedEvent(task, decision.receiptId, receiptPayload, decision.acceptedAt);
    }
    const unresolved = decision.resolution !== 'abandon'
      && await this.hasUnresolvedSideEffect(task.ownerId, task.id);
    const targetState: TaskState = unresolved ? 'unknown' : decision.targetState;
    if (!unresolved && decision.resolution !== 'abandon' && task.data.workspaceId) {
      await new WorkspaceWriteLeaseService(this.store, () => this.now()).releaseForTask(
        task.ownerId,
        task.data.workspaceId,
        task.id,
        {
          receiptId: decision.receiptId,
          resolution: decision.resolution,
          note: decision.note ?? `Task outcome reconciled as ${decision.resolution}`,
        },
      );
    }
    if (!unresolved && decision.resolution !== 'abandon') await this.restoreReconciledParents(task, decision);
    await this.fixedEvent(task, `${decision.receiptId}:audit`, {
      type: 'reconcile',
      receiptId: decision.receiptId,
      state: targetState,
      resolution: decision.resolution,
      ...(decision.dispatchSequence !== undefined ? { dispatchSequence: decision.dispatchSequence } : {}),
      ...(decision.toolCallId ? { toolCallId: decision.toolCallId } : {}),
      ...(decision.toolOccurrenceId ? { toolOccurrenceId: decision.toolOccurrenceId } : {}),
      ...(decision.actionHash ? { actionHash: decision.actionHash } : {}),
      ...(decision.toolName ? { toolName: decision.toolName } : {}),
      ...(decision.note ? { note: decision.note } : {}),
      actor: decision.actor,
      acceptedAt: decision.acceptedAt,
    }, decision.acceptedAt);
    for (let attempt = 0; attempt < 16; attempt += 1) {
      task = await this.store.get<Task>('task', task.id, task.ownerId) ?? task;
      const current = task.data.reconciliation;
      if (!current || !sameReconciliationDecision(current, decision)) {
        throw new DomainError('reconciliation_conflict', 'Task reconciliation changed', 409);
      }
      if (current.phase === 'complete') return task;
      const final = await this.reconciledTaskData(task, decision, targetState);
      try {
        return await this.store.put('task', task.id, task.ownerId, {
          ...final,
          reconciliation: { ...decision, phase: 'complete' },
        }, task.revision);
      } catch (error) {
        if (!(error instanceof DomainError && error.code === 'conflict')) throw error;
      }
    }
    throw new DomainError('busy', 'Task reconciliation is busy; retry', 409);
  }

  private async reconciledTaskData(
    task: Entity<Task>,
    decision: TaskReconciliationRecord,
    targetState: TaskState,
  ): Promise<Task> {
    const conversation = await this.store.get<Conversation>('conversation', task.data.conversationId, task.ownerId);
    if (!conversation) throw new DomainError('not_found', 'Conversation not found', 404);
    const base: Task = {
      ...task.data,
      state: targetState,
      principal: decision.resumePrincipal,
      grantExpiresAt: decision.grantExpiresAt,
      pauseRequested: false,
      nextAttemptAt: undefined,
      workerId: undefined,
      leaseExpiresAt: undefined,
    };
    if (targetState === 'cancelled') return { ...base, cancelRequested: true };
    if (conversation.data.internalOperation) {
      if (targetState === 'unknown') {
        return {
          ...base,
          result: undefined,
          error: 'Another dispatched side effect still requires reconciliation.',
        };
      }
      if (decision.resolution === 'applied') {
        return {
          ...base,
          result: JSON.stringify({
            reconciled: 'applied',
            ...(decision.toolCallId ? { toolCallId: decision.toolCallId } : {}),
            ...(decision.toolOccurrenceId ? { toolOccurrenceId: decision.toolOccurrenceId } : {}),
            message: 'Operator confirmed that the operation was applied.',
            ...(decision.note ? { note: decision.note } : {}),
          }),
          error: undefined,
        };
      }
      return { ...base, result: undefined, error: 'Operator confirmed that the operation was not applied.' };
    }
    const dispatch = reconciliationDispatch(decision);
    const checkpoint = checkpointForDispatch(task.data.runtimeMessages, dispatch);
    const messages = checkpoint && reconcileToolCall(checkpoint, {
      ...(decision.toolCallId ? { toolCallId: decision.toolCallId } : {}),
      ...(decision.toolOccurrenceId ? { toolOccurrenceId: decision.toolOccurrenceId } : {}),
      ...(decision.actionHash ? { actionHash: decision.actionHash } : {}),
      resolution: decision.resolution === 'abandon' ? 'not_applied' : decision.resolution,
      ...(decision.note ? { note: decision.note } : {}),
    });
    if (!messages) throw new DomainError('not_resumable', 'The accepted checkpoint can no longer be reconciled', 409);
    return {
      ...base,
      runtimeMessages: messages,
      error: targetState === 'unknown'
        ? 'Another dispatched side effect still requires reconciliation.'
        : undefined,
      approvedActionHashes: decision.resolution === 'not_applied' && decision.actionHash
        ? task.data.approvedActionHashes.filter((hash) => hash !== decision.actionHash)
        : task.data.approvedActionHashes,
    };
  }

  private async fixedEvent(
    task: Pick<Entity<Task>, 'id' | 'ownerId'>,
    id: string,
    payload: { type: string; [key: string]: unknown },
    at: string,
  ): Promise<void> {
    const existing = await this.store.get<TaskEvent>('event', id, task.ownerId);
    if (existing) {
      assertFixedEvent(existing, task.id, payload, at);
      return;
    }
    const data: TaskEvent = {
      taskId: task.id,
      sequence: await this.nextFixedEventSequence(task.ownerId, task.id, id),
      type: payload.type,
      payload,
      at,
    };
    try {
      await this.store.create('event', task.ownerId, data, id);
    } catch (error) {
      if (!(error instanceof DomainError && error.code === 'conflict')) throw error;
      const raced = await this.store.get<TaskEvent>('event', id, task.ownerId);
      if (!raced) throw new DomainError('reconciliation_integrity', 'Reconciliation event conflict could not be verified', 409);
      assertFixedEvent(raced, task.id, payload, at);
    }
  }

  private async ensureFailedEvent(task: Entity<Task>): Promise<void> {
    if (task.data.state !== 'failed') return;
    await this.fixedEvent(task, `${task.id}:terminal:failed:${task.revision}`, {
      type: 'failed',
      taskRevision: task.revision,
      error: task.data.error ?? 'Task execution failed',
    }, task.updatedAt);
  }

  private async repairFailedEvents(tasks: Array<Entity<Task>>): Promise<void> {
    const failed = tasks.filter((task) => task.data.state === 'failed');
    if (failed.length === 0) {
      this.failedEventRepairOffset = 0;
      return;
    }
    const count = Math.min(failedEventRepairBatchSize, failed.length);
    const offset = this.failedEventRepairOffset % failed.length;
    for (let index = 0; index < count; index += 1) {
      await this.ensureFailedEvent(failed[(offset + index) % failed.length]!);
    }
    this.failedEventRepairOffset = (offset + count) % failed.length;
  }

  public start(intervalMs = 1_000): void {
    if (this.timer) {
      return;
    }
    this.stopped = false;
    const runTick = (): void => {
      void this.tick().catch(() => undefined);
    };
    runTick();
    this.timer = setInterval(runTick, intervalMs);
    this.timer.unref();
  }

  public async drain(): Promise<void> {
    if (this.stopped) {
      return;
    }
    while (true) {
      await this.tick();
      const running = [...this.active.values()].map((run) => run.promise);
      if (running.length === 0) {
        return;
      }
      await Promise.allSettled(running);
    }
  }

  private async tick(): Promise<void> {
    if (this.stopped) {
      return;
    }
    if (this.ticking) {
      return this.ticking;
    }
    this.ticking = this.tickInternal().finally(() => {
      this.ticking = undefined;
    });
    return this.ticking;
  }

  private async tickInternal(): Promise<void> {
    const failure = await this.runPhases();
    if (!failure) {
      if (!this.stopped && this.tickFailures > 0) {
        const failedTicks = this.tickFailures;
        this.tickFailures = 0;
        this.options.onTickRecovered?.({ failedTicks });
      }
      return;
    }
    if (!this.stopped) {
      this.tickFailures += 1;
      this.tickLastErrorAt = new Date(this.now()).toISOString();
      if (this.options.onTickError) {
        this.options.onTickError({
          phase: failure.phase,
          ...describeTickError(failure.error),
          consecutiveFailures: this.tickFailures,
        });
      } else {
        this.options.onError?.(failure.error);
      }
    }
    throw failure.error;
  }

  private async runPhases(): Promise<TickPhaseFailure | undefined> {
    let failure: TickPhaseFailure | undefined;
    const phase = async (name: TaskTickPhase, run: () => Promise<unknown>): Promise<void> => {
      try {
        await run();
      } catch (error) {
        failure ??= { phase: name, error };
      }
    };
    await phase('notifications', async () => this.options.notifications?.reconcile());
    await phase('reconciliations', () => this.finishPendingReconciliations());
    await phase('reconciler', async () => this.reconciler?.());
    await phase('tasks', () => this.claimTasks());
    return failure;
  }

  private async finishPendingReconciliations(): Promise<void> {
    const tasks = await this.store.scan<Task>('task');
    let failure: { error: unknown } | undefined;
    for (const task of tasks) {
      if (task.data.reconciliation?.phase !== 'pending') continue;
      try {
        await this.finishReconciliation(task);
      } catch (error) {
        failure ??= { error };
      }
    }
    if (failure) throw failure.error;
  }

  private async claimTasks(): Promise<void> {
    let tasks = await this.store.scan<Task>('task');
    await this.repairFailedEvents(tasks);
    for (const task of tasks) {
      if (task.data.state === 'running'
        && !this.active.has(task.id)
        && Date.parse(task.data.leaseExpiresAt ?? '') < this.now()) {
        const unresolved = await this.hasUnresolvedSideEffect(task.ownerId, task.id);
        try {
          const recovered = await this.store.put<Task>('task', task.id, task.ownerId, {
            ...task.data,
            state: unresolved ? 'unknown' : 'queued',
            workerId: undefined,
            leaseExpiresAt: undefined,
            ...(unresolved
              ? { error: 'Executor stopped after a side effect was dispatched; verify its outcome before continuing.' }
              : { error: undefined }),
          }, task.revision);
          if (recovered.data.state === 'unknown') {
            await this.notify(recovered, taskNotification(recovered, 'task_unknown'), new Date(recovered.updatedAt));
          }
        } catch (error) {
          if (!(error instanceof DomainError && error.code === 'conflict')) {
            throw error;
          }
        }
      }
    }
    tasks = await this.store.scan<Task>('task');
    for (const task of tasks) {
      if (this.stopped) {
        break;
      }
      if (!['queued', 'waiting_for_device'].includes(task.data.state) || this.active.has(task.id)) {
        continue;
      }
      if (task.data.nextAttemptAt && Date.parse(task.data.nextAttemptAt) > this.now()) {
        continue;
      }
      const dependency = await this.dependencyState(task);
      if (dependency === 'waiting') {
        continue;
      }
      if (dependency === 'failed') {
        const failed = await this.change(task.ownerId, task.id, (current) => ({
          ...current,
          state: 'failed',
          error: 'A dependency did not complete successfully.',
        }));
        await this.event(failed, { type: 'dependency_failed' });
        await this.ensureFailedEvent(failed);
        await this.notify(failed, taskNotification(failed, 'task_failed'), new Date(failed.updatedAt));
        continue;
      }
      const ownerActive = [...this.active.values()].filter((run) => run.ownerId === task.ownerId).length;
      if (ownerActive >= (this.options.concurrency ?? 3)) {
        continue;
      }
      let claimed: Entity<Task>;
      try {
        claimed = await this.store.put('task', task.id, task.ownerId, {
          ...task.data,
          state: 'running',
          workerId: this.workerId,
          leaseExpiresAt: new Date(this.now() + (this.options.leaseMs ?? 60_000)).toISOString(),
        }, task.revision);
      } catch (error) {
        if (error instanceof DomainError && error.code === 'conflict') {
          continue;
        }
        throw error;
      }
      const controller = new AbortController();
      const promise = this.execute(claimed, controller)
        .catch((error) => this.options.onError?.(error))
        .finally(() => {
          this.active.delete(task.id);
        });
      this.active.set(task.id, { ownerId: task.ownerId, controller, promise });
    }
  }

  private async dependencyState(task: Entity<Task>): Promise<'ready' | 'waiting' | 'failed'> {
    for (const dependencyId of task.data.dependencyIds ?? []) {
      const dependency = await this.store.get<Task>('task', dependencyId, task.ownerId);
      if (!dependency || dependencyFailureStates.includes(dependency.data.state)) {
        return 'failed';
      }
      if (dependency.data.state !== 'completed') {
        return 'waiting';
      }
    }
    return 'ready';
  }

  private async execute(task: Entity<Task>, controller: AbortController): Promise<void> {
    const runtimeEvents = new DurableRuntimeEventStream(controller.signal, async (runtimeEvent) => {
      controller.signal.throwIfAborted();
      let fresh = await this.store.get<Task>('task', task.id, task.ownerId);
      if (!fresh || fresh.data.state !== 'running' || fresh.data.workerId !== this.workerId) {
        throw new DomainError('lease_lost', 'Execution lease lost', 409);
      }
      if (runtimeEvent.type === 'model_call' || runtimeEvent.type === 'tool_dispatched') {
        if (!this.options.reauthorize) {
          if (runtimeEvent.type === 'tool_dispatched') {
            throw new DomainError(
              'authorization_revalidation_required',
              'Tool dispatch requires current account authorization.',
              403,
            );
          }
        } else {
          if (accountDelegationExpired(fresh.data, this.now())) {
            throw new DomainError('grant_expired', 'Delegated task authorization expired', 403);
          }
          const principal = revalidatedTaskPrincipal(
            fresh,
            await this.options.reauthorize(fresh.data.principal),
          );
          const durableAccount = isDurableAccountTask(fresh);
          const delegationExpiresAt = fresh.data.accountTaskGrant?.delegationExpiresAt;
          fresh = await this.change(task.ownerId, task.id, (current) => {
            if (current.state !== 'running' || current.workerId !== this.workerId) {
              throw new DomainError('lease_lost', 'Execution lease lost', 409);
            }
            return {
              ...current,
              principal,
              ...(durableAccount ? {
                grantExpiresAt: renewedGrantExpiry(
                  principal,
                  this.now(),
                  delegationExpiresAt,
                ),
              } : {}),
            };
          });
        }
      }
      if ((runtimeEvent.type === 'model_call' || runtimeEvent.type === 'usage') && runtimeEvent.usage) {
        await this.change(task.ownerId, task.id, (current) => ({
          ...current,
          usage: runtimeEvent.usage,
        }));
      }
      if (Array.isArray(runtimeEvent.checkpointMessages)) {
        await this.change(task.ownerId, task.id, (current) => ({
          ...current,
          runtimeMessages: runtimeEvent.checkpointMessages as unknown[],
        }));
      }
      const persisted = { ...runtimeEvent };
      delete persisted.checkpointMessages;
      await this.event(task, persisted);
    });
    const leaseTimer = setInterval(() => {
      void this.change(task.ownerId, task.id, (current) => {
        if (current.state !== 'running' || current.workerId !== this.workerId) {
          controller.abort(new DomainError('lease_lost', 'Execution lease lost', 409));
          return current;
        }
        return {
          ...current,
          leaseExpiresAt: new Date(this.now() + (this.options.leaseMs ?? 60_000)).toISOString(),
        };
      }).catch((error) => controller.abort(error));
    }, this.options.heartbeatMs ?? 15_000);
    leaseTimer.unref();
    try {
      if (hasMalformedAccountTaskGrant(task)) {
        throw new DomainError('invalid_account_task_grant', 'Account task authorization context is invalid', 403);
      }
      if (hasMalformedAutomationAuthorization(task.data)) {
        throw new DomainError('invalid_automation_identity', 'Automation authorization context is invalid', 403);
      }
      if (accountDelegationExpired(task.data, this.now())) {
        throw new DomainError('grant_expired', 'Delegated task authorization expired', 403);
      }
      const grantLapsed = Date.parse(task.data.grantExpiresAt) <= this.now();
      const durable = this.options.durableGrants === true
        && this.options.reauthorize !== undefined
        && (isDurableAutomationTask(task.data) || isDurableAccountTask(task));
      if (grantLapsed && !durable) {
        throw new DomainError('grant_expired', 'Task authorization expired; resume from a signed-in client', 403);
      }
      let executionTask = task;
      if (this.options.reauthorize) {
        const principal = revalidatedTaskPrincipal(
          task,
          await this.options.reauthorize(task.data.principal),
        );
        executionTask = await this.change(task.ownerId, task.id, (current) => {
          if (current.state !== 'running' || current.workerId !== this.workerId) {
            throw new DomainError('lease_lost', 'Execution lease lost', 409);
          }
          return {
            ...current,
            principal,
            ...(grantLapsed ? {
              grantExpiresAt: renewedGrantExpiry(
                principal,
                this.now(),
                task.data.accountTaskGrant?.delegationExpiresAt,
              ),
            } : {}),
          };
        });
      }
      const conversation = await this.store.get<Conversation>(
        'conversation', executionTask.data.conversationId, executionTask.ownerId,
      );
      if (!conversation) {
        throw new DomainError('not_found', 'Conversation not found', 404);
      }
      await this.ensureUserMessage(executionTask);
      const history = orderMessages((await this.store.scan<Message>('message', task.ownerId))
        .filter((message) => message.data.conversationId === conversation.id && message.data.taskId !== task.id));
      const workspaceEntity = conversation.data.workspaceId
        ? await this.store.get<Workspace>('workspace', conversation.data.workspaceId, task.ownerId)
        : undefined;
      if (conversation.data.workspaceId && !workspaceEntity) {
        throw new DomainError('not_found', 'Workspace not found', 404);
      }
      const result = await this.runner({
        task: executionTask,
        conversation,
        history,
        ...(workspaceEntity ? {
          workspace: {
            ...workspaceEntity.data,
            id: workspaceEntity.id,
            ownerId: workspaceEntity.ownerId,
          },
        } : {}),
        signal: controller.signal,
        onEvent: (runtimeEvent) => runtimeEvents.push(runtimeEvent),
      });
      await runtimeEvents.finish();
      const current = await this.store.get<Task>('task', task.id, task.ownerId);
      if (!current || current.data.state !== 'running' || current.data.workerId !== this.workerId) {
        return;
      }
      const state: TaskState = result.status === 'waiting_for_approval'
        ? 'waiting_for_approval'
        : result.status === 'waiting_for_children'
          ? 'waiting_for_children'
          : 'completed';
      const resultArtifactIds = state === 'completed'
        ? await this.confirmedResultArtifactIds(task.ownerId, task.id)
        : [];
      if (state === 'completed' && !await this.store.get('message', `${task.id}:assistant`, task.ownerId)) {
        await this.store.create<Message>('message', task.ownerId, {
          conversationId: conversation.id,
          role: 'assistant',
          content: result.text,
          taskId: task.id,
          sequence: await this.nextMessageSequence(task.ownerId, conversation.id),
        }, `${task.id}:assistant`);
      }
      const updated = await this.change(task.ownerId, task.id, (data) => data.state !== 'running'
        || data.workerId !== this.workerId
        ? data
        : {
            ...data,
            state,
            result: result.text,
            pendingActions: result.pendingActions ?? [],
            runtimeMessages: result.messages ?? data.runtimeMessages,
            usage: result.usage ?? data.usage,
            resultArtifactIds: resultArtifactIds.length ? resultArtifactIds : undefined,
            error: undefined,
            nextAttemptAt: undefined,
            workerId: undefined,
            leaseExpiresAt: undefined,
          });
      await this.event(updated, { type: state, text: result.text });
      if (state !== 'waiting_for_children') {
        const type = state === 'completed' ? 'task_completed' : 'approval_required';
        await this.notify(updated, taskNotification(updated, type), new Date(updated.updatedAt))
          .catch((notificationError) => this.options.onError?.(notificationError));
      }
    } catch (caught) {
      let error = caught;
      try {
        await runtimeEvents.finish();
      } catch (flushError) {
        if (!controller.signal.aborted) error = flushError;
      }
      const code = (error as { code?: string }).code;
      const unresolved = code === 'outcome_unknown'
        || await this.hasUnresolvedSideEffect(task.ownerId, task.id);
      if (automationPermanentCodes.has(code ?? '') && isDurableAutomationTask(task.data)) {
        try {
          await markAutomationAuthorizationFailed(
            this.store,
            task.ownerId,
            task.data.automationSource!,
            new Date(this.now()).toISOString(),
          );
        } catch (stampError) {
          throw stampError;
        }
      }
      const updated = await this.change(task.ownerId, task.id, (current) => {
        if (current.state !== 'running' || current.workerId !== this.workerId) {
          return current;
        }
        if (code === 'waiting_for_device') {
          return {
            ...current,
            state: 'waiting_for_device',
            error: error instanceof Error ? error.message : 'Device is unavailable',
            nextAttemptAt: new Date(this.now() + 10_000).toISOString(),
            workerId: undefined,
            leaseExpiresAt: undefined,
          };
        }
        if (unresolved) {
          return {
            ...current,
            state: 'unknown',
            error: 'A side effect was dispatched but its result was not confirmed. Verify the outcome before retrying.',
            workerId: undefined,
            leaseExpiresAt: undefined,
          };
        }
        if (authorizationPauseCodes.has(code ?? '')) {
          return {
            ...current,
            state: 'paused',
            pauseRequested: true,
            error: error instanceof Error ? error.message : 'Task authorization must be renewed',
            workerId: undefined,
            leaseExpiresAt: undefined,
          };
        }
        if (code === 'identity_unavailable') {
          return {
            ...current,
            state: 'queued',
            error: error instanceof Error ? error.message : 'Identity service is unavailable',
            nextAttemptAt: new Date(this.now() + 30_000).toISOString(),
            workerId: undefined,
            leaseExpiresAt: undefined,
          };
        }
        if (controller.signal.aborted) {
          return {
            ...current,
            state: 'queued',
            error: undefined,
            workerId: undefined,
            leaseExpiresAt: undefined,
          };
        }
        return {
          ...current,
          state: 'failed',
          error: error instanceof Error ? error.message : 'Task execution failed',
          workerId: undefined,
          leaseExpiresAt: undefined,
        };
      }).catch((storageError) => {
        this.options.onError?.(storageError);
        return undefined;
      });
      if (code === 'identity_unavailable' && updated?.data.state === 'queued') {
        this.options.onError?.(error);
      }
      if (updated?.data.state === 'failed' || updated?.data.state === 'unknown') {
        const type = updated.data.state === 'failed' ? 'task_failed' : 'task_unknown';
        await this.notify(updated, taskNotification(updated, type), new Date(updated.updatedAt))
          .catch((notificationError) => this.options.onError?.(notificationError));
      }
      if (updated?.data.state === 'failed') await this.ensureFailedEvent(updated);
    } finally {
      runtimeEvents.dispose();
      clearInterval(leaseTimer);
    }
  }

  private async nextMessageSequence(ownerId: string, conversationId: string): Promise<number> {
    const cursorId = createHash('sha256').update(`${ownerId}\0${conversationId}`).digest('hex');
    while (true) {
      const cursor = await this.store.get<MessageSequence>('message_sequence', cursorId, ownerId);
      if (!cursor) {
        try {
          await this.store.create<MessageSequence>('message_sequence', ownerId, { next: 2 }, cursorId);
          return 1;
        } catch (error) {
          if (error instanceof DomainError && error.code === 'conflict') continue;
          throw error;
        }
      }
      try {
        await this.store.put('message_sequence', cursor.id, ownerId, { next: cursor.data.next + 1 }, cursor.revision);
        return cursor.data.next;
      } catch (error) {
        if (error instanceof DomainError && error.code === 'conflict') continue;
        throw error;
      }
    }
  }

  private async hasUnresolvedSideEffect(ownerId: string, taskId: string): Promise<boolean> {
    return (await this.sideEffectDispatches(ownerId, taskId)).some((dispatch) => !dispatch.resolved);
  }

  private async sideEffectDispatches(ownerId: string, taskId: string): Promise<SideEffectDispatch[]> {
    const dispatches: SideEffectDispatch[] = [];
    for (const row of await this.events(ownerId, taskId)) {
      const payload = row.data.payload as {
        toolCallId?: string;
        toolOccurrenceId?: string;
        actionHash?: string;
        sideEffect?: string;
        outcome?: string;
        toolCall?: { id?: string; occurrenceId?: string; name?: string; arguments?: Record<string, unknown> };
      };
      if (row.data.type === 'tool_dispatched'
        && (payload.sideEffect === 'write' || payload.sideEffect === 'external')) {
        const toolCallId = payload.toolCallId ?? payload.toolCall?.id;
        const toolOccurrenceId = payload.toolOccurrenceId ?? payload.toolCall?.occurrenceId;
        dispatches.push({
          sequence: row.data.sequence,
          ...(toolCallId ? { toolCallId } : {}),
          ...(toolOccurrenceId ? { toolOccurrenceId } : {}),
          ...(payload.actionHash ? { actionHash: payload.actionHash } : {}),
          ...(payload.toolCall?.name ? { toolName: payload.toolCall.name } : {}),
          ...(payload.toolCall?.arguments ? { toolArguments: payload.toolCall.arguments } : {}),
          sideEffect: payload.sideEffect,
          resolved: false,
        });
      }
      if (row.data.type === 'tool_result'
        && ['confirmed', 'failed', 'not_replayed'].includes(payload.outcome ?? '')) {
        const occurrence = payload.toolOccurrenceId ?? payload.toolCall?.occurrenceId;
        let dispatch: SideEffectDispatch | undefined;
        if (occurrence) {
          dispatch = [...dispatches].reverse().find((candidate) => !candidate.resolved
            && candidate.toolOccurrenceId === occurrence);
        } else {
          const rawId = payload.toolCallId ?? payload.toolCall?.id;
          if (rawId) {
            dispatch = [...dispatches].reverse().find((candidate) => !candidate.resolved
              && !candidate.toolOccurrenceId && candidate.toolCallId === rawId
              && (payload.actionHash === undefined || candidate.actionHash === payload.actionHash));
          } else if (payload.actionHash) {
            dispatch = [...dispatches].reverse().find((candidate) => !candidate.resolved
              && candidate.actionHash === payload.actionHash);
          }
        }
        if (dispatch) dispatch.resolved = true;
      }
    }
    return dispatches;
  }

  private async restoreReconciledParents(child: Entity<Task>, decision: TaskReconciliationRecord): Promise<void> {
    let childId = child.id;
    let parentId = child.data.orchestration?.parentTaskId;
    while (parentId) {
      let parent: Entity<Task> | undefined;
      const marker = { receiptId: decision.receiptId, childTaskId: childId, resolution: decision.resolution };
      for (let attempt = 0; attempt < 16; attempt += 1) {
        parent = await this.store.get<Task>('task', parentId, child.ownerId);
        if (!parent) return;
        const plan = parent.data.orchestration
          ? await this.store.get<{ childIds: string[] }>('agent_plan', parent.data.orchestration.planId, child.ownerId)
          : undefined;
        if (!plan?.data.childIds.includes(childId)
          || parent.data.cancelRequested
          || parent.data.orchestration?.role !== 'parent'
          || parent.data.orchestration.phase !== 'children'
          || !['unknown', 'waiting_for_children'].includes(parent.data.state)
          || (parent.data.state === 'unknown'
            && !parent.data.error?.startsWith('Delegated work requires attention:'))
          || await this.hasUnresolvedSideEffect(parent.ownerId, parent.id)
          || !await this.planChildrenHaveAcceptedReceipts(parent.ownerId, plan.data.childIds)) return;
        if (parent.data.state === 'waiting_for_children'
          && sameValue(parent.data.reconciliationRestoration, marker)) break;
        try {
          parent = await this.store.put('task', parent.id, parent.ownerId, {
            ...parent.data,
            state: 'waiting_for_children',
            error: undefined,
            reconciliationRestoration: marker,
          }, parent.revision);
          break;
        } catch (error) {
          if (!(error instanceof DomainError && error.code === 'conflict')) throw error;
        }
        parent = undefined;
      }
      if (!parent) throw new DomainError('busy', 'Parent reconciliation restoration is busy; retry', 409);
      await this.fixedEvent(parent, `${decision.receiptId}:parent:${parent.id}`, {
        type: 'child_reconciled',
        receiptId: decision.receiptId,
        childTaskId: childId,
        resolution: decision.resolution,
        state: 'waiting_for_children',
      }, decision.acceptedAt);
      childId = parent.id;
      parentId = parent.data.orchestration?.parentTaskId;
    }
  }

  private async planChildrenHaveAcceptedReceipts(ownerId: string, childIds: string[]): Promise<boolean> {
    for (const childId of childIds) {
      const child = await this.store.get<Task>('task', childId, ownerId);
      if (!child || child.data.reconciliation?.resolution === 'abandon') return false;
      if (child.data.state !== 'unknown') continue;
      const receiptId = child.data.reconciliation?.receiptId;
      if (!receiptId || !await this.store.get<TaskEvent>('event', receiptId, ownerId)
        || await this.hasUnresolvedSideEffect(ownerId, child.id)) return false;
    }
    return true;
  }

  private async confirmedResultArtifactIds(ownerId: string, taskId: string): Promise<string[]> {
    const ids: string[] = [];
    const seen = new Set<string>();
    for (const row of await this.events(ownerId, taskId)) {
      if (row.data.type !== 'tool_result') continue;
      const payload = row.data.payload as {
        outcome?: string;
        isError?: boolean;
        result?: { artifactIds?: unknown };
      };
      if (payload.outcome !== 'confirmed' || payload.isError !== false || payload.result?.artifactIds === undefined) continue;
      if (!Array.isArray(payload.result.artifactIds)) {
        throw new DomainError('invalid_result_artifact', 'Tool result artifact identifiers are invalid', 409);
      }
      for (const artifactId of payload.result.artifactIds) {
        if (typeof artifactId !== 'string' || !artifactId || artifactId.length > 200) {
          throw new DomainError('invalid_result_artifact', 'Tool result artifact identifier is invalid', 409);
        }
        if (seen.has(artifactId)) continue;
        if (ids.length >= 20) throw new DomainError('too_many_result_artifacts', 'A task produced too many result artifacts', 409);
        const artifact = await this.store.get<Artifact>('artifact', artifactId, ownerId);
        if (!artifact || artifact.data.source !== 'tool' || artifact.data.producerTaskId !== taskId) {
          throw new DomainError('invalid_result_artifact', 'Tool result artifact does not belong to this task', 409);
        }
        seen.add(artifactId);
        ids.push(artifactId);
      }
    }
    return ids;
  }

  private async notify(task: Entity<Task>, input: NotificationInput, occurredAt: Date): Promise<void> {
    if (this.options.notifications) {
      await this.options.notifications.publishTask(task.ownerId, input, occurredAt, task.data.notificationDestination);
      return;
    }
    if (task.data.notificationDestination?.type === 'none') return;
    const quiet = await this.options.isQuietTime?.(task.ownerId, occurredAt) ?? false;
    await this.store.create('notification', task.ownerId, {
      ...input,
      occurredAt: occurredAt.toISOString(),
      deliverAfter: occurredAt.toISOString(),
      silent: quiet,
      read: false,
      pushEligible: task.data.notificationDestination === undefined
        || task.data.notificationDestination.type === 'push',
      ...(task.data.notificationDestination?.type === 'push'
        ? { targetSubscriptionId: task.data.notificationDestination.subscriptionId }
        : {}),
      ...(task.data.notificationDestination?.type === 'channel'
        ? { targetChannelDestinationId: task.data.notificationDestination.destinationId }
        : {}),
    });
  }

  public async close(): Promise<void> {
    this.stopped = true;
    if (this.timer) {
      clearInterval(this.timer);
    }
    this.timer = undefined;
    for (const run of this.active.values()) {
      run.controller.abort(new DOMException('Service shutting down', 'AbortError'));
    }
    await Promise.allSettled([...this.active.values()].map((run) => run.promise));
  }
}

const authorizationPauseCodes = new Set([
  'access_required',
  'access_revoked',
  'authorization_revalidation_required',
  'grant_expired',
  'grant_revoked',
  'invalid_account_task_grant',
  'invalid_automation_identity',
  'unauthorized',
]);

const automationPermanentCodes = new Set([
  'access_required',
  'access_revoked',
  'grant_revoked',
  'invalid_automation_identity',
]);

function notReconcilable(): DomainError {
  return new DomainError('not_reconcilable', 'Only a task whose outcome is unknown can be reconciled', 409);
}

function hasReconciliationSelector(input: TaskReconciliation): boolean {
  return input.dispatchSequence !== undefined || input.toolCallId !== undefined
    || input.toolOccurrenceId !== undefined || input.actionHash !== undefined;
}

function reconciliationSelectorMatches(
  decision: TaskReconciliationRecord,
  input: TaskReconciliation,
): boolean {
  return hasReconciliationSelector(input)
    && (input.dispatchSequence === undefined || decision.dispatchSequence === input.dispatchSequence)
    && (input.toolCallId === undefined || decision.toolCallId === input.toolCallId)
    && (input.toolOccurrenceId === undefined || decision.toolOccurrenceId === input.toolOccurrenceId)
    && (input.actionHash === undefined || decision.actionHash === input.actionHash);
}

function explicitlyTargetsReconciliation(
  decision: TaskReconciliationRecord,
  input: TaskReconciliation,
): boolean {
  return reconciliationSelectorMatches(decision, input)
    && (input.dispatchSequence !== undefined
      || input.toolOccurrenceId !== undefined
      || input.actionHash !== undefined);
}

function reconciliationTarget(dispatches: SideEffectDispatch[], input: TaskReconciliation): SideEffectDispatch {
  let candidates = dispatches.filter((dispatch) => !dispatch.resolved);
  if (input.dispatchSequence !== undefined) {
    candidates = candidates.filter((dispatch) => dispatch.sequence === input.dispatchSequence);
  }
  if (input.toolOccurrenceId !== undefined) {
    candidates = candidates.filter((dispatch) => dispatch.toolOccurrenceId === input.toolOccurrenceId);
  }
  if (input.actionHash !== undefined) {
    candidates = candidates.filter((dispatch) => dispatch.actionHash === input.actionHash);
  }
  if (input.toolCallId !== undefined) {
    candidates = candidates.filter((dispatch) => dispatch.toolCallId === input.toolCallId);
  }
  if (candidates.length !== 1) {
    throw new DomainError(
      candidates.length > 1 ? 'ambiguous_reconciliation' : 'invalid_reconciliation',
      candidates.length > 1
        ? 'The selector matches more than one unresolved dispatch; use its occurrence or sequence'
        : 'The selector does not name an unresolved dispatch of this task',
      409,
    );
  }
  return candidates[0]!;
}

function reconciliationTargetState(
  task: Task,
  conversation: Conversation,
  resolution: TaskReconciliationResolution,
): TaskState {
  if (task.cancelRequested || resolution === 'abandon') return 'cancelled';
  if (conversation.internalOperation) return resolution === 'applied' ? 'completed' : 'failed';
  return task.orchestration?.role === 'parent' && task.orchestration.phase === 'children'
    ? 'waiting_for_children'
    : 'queued';
}

function reconciliationActor(actor: Principal): TaskReconciliationRecord['actor'] {
  return {
    id: actor.id,
    level: actor.level,
    ...(actor.applicationId ? { applicationId: actor.applicationId } : {}),
    ...(actor.issuer ? { issuer: actor.issuer } : {}),
    ...(actor.subject ? { subject: actor.subject } : {}),
  };
}

function assertSameReconciliation(
  decision: TaskReconciliationRecord,
  input: TaskReconciliation,
  actor: Principal,
): void {
  const matches = decision.resolution === input.resolution
    && decision.note === input.note
    && (decision.dispatchSequence === undefined || hasReconciliationSelector(input))
    && (input.dispatchSequence === undefined || decision.dispatchSequence === input.dispatchSequence)
    && (input.toolCallId === undefined || decision.toolCallId === input.toolCallId)
    && (input.toolOccurrenceId === undefined || decision.toolOccurrenceId === input.toolOccurrenceId)
    && (input.actionHash === undefined || decision.actionHash === input.actionHash)
    && sameValue(decision.actor, reconciliationActor(actor));
  if (!matches) throw new DomainError('reconciliation_conflict', 'A different reconciliation decision was already accepted', 409);
}

function sameReconciliationDecision(left: TaskReconciliationRecord, right: TaskReconciliationRecord): boolean {
  return sameValue({ ...left, phase: 'pending' }, { ...right, phase: 'pending' });
}

function reconciliationDispatch(decision: TaskReconciliationRecord): SideEffectDispatch {
  if (decision.dispatchSequence === undefined || !decision.sideEffect) {
    throw new DomainError('reconciliation_integrity', 'Reconciliation dispatch metadata is incomplete', 409);
  }
  return {
    sequence: decision.dispatchSequence,
    ...(decision.toolCallId ? { toolCallId: decision.toolCallId } : {}),
    ...(decision.toolOccurrenceId ? { toolOccurrenceId: decision.toolOccurrenceId } : {}),
    ...(decision.actionHash ? { actionHash: decision.actionHash } : {}),
    ...(decision.toolName ? { toolName: decision.toolName } : {}),
    sideEffect: decision.sideEffect,
    resolved: false,
  };
}

function checkpointForDispatch(messages: unknown[] | undefined, dispatch: SideEffectDispatch): ChatMessage[] | undefined {
  if (!messages) return undefined;
  const checkpoint = structuredClone(messages) as ChatMessage[];
  const calls: Array<{ id: string; occurrenceId?: string; name: string; arguments: Record<string, unknown>; actionHash?: string }> = [];
  for (const message of checkpoint) {
    if (message.role !== 'assistant') continue;
    for (const call of message.toolCalls ?? []) {
      if (dispatch.toolOccurrenceId ? call.occurrenceId === dispatch.toolOccurrenceId : call.id === dispatch.toolCallId) {
        calls.push(call);
      }
    }
  }
  const call = dispatch.toolOccurrenceId ? calls[0] : calls.at(-1);
  if (!call || (dispatch.toolOccurrenceId && calls.length !== 1)
    || (dispatch.toolName && call.name !== dispatch.toolName)
    || (dispatch.toolArguments && !sameValue(call.arguments, dispatch.toolArguments))
    || (call.actionHash !== undefined && call.actionHash !== dispatch.actionHash)) return undefined;
  if (dispatch.actionHash) call.actionHash = dispatch.actionHash;
  return checkpoint;
}

function reconciliationReceipt(taskId: string, decision: TaskReconciliationRecord): { type: string; [key: string]: unknown } {
  if (decision.dispatchSequence === undefined || !decision.sideEffect) {
    throw new DomainError('reconciliation_integrity', 'Reconciliation receipt metadata is incomplete', 409);
  }
  return {
    type: 'tool_result',
    taskId,
    receiptId: decision.receiptId,
    resolution: decision.resolution,
    dispatchSequence: decision.dispatchSequence,
    ...(decision.toolCallId ? { toolCallId: decision.toolCallId } : {}),
    ...(decision.toolOccurrenceId ? { toolOccurrenceId: decision.toolOccurrenceId } : {}),
    ...(decision.actionHash ? { actionHash: decision.actionHash } : {}),
    sideEffect: decision.sideEffect,
    isError: decision.resolution !== 'applied',
    outcome: decision.resolution === 'applied' ? 'confirmed'
      : decision.resolution === 'not_applied' ? 'failed' : 'unknown',
    reconciled: decision.resolution,
    ...(decision.note ? { note: decision.note } : {}),
    actor: decision.actor,
    acceptedAt: decision.acceptedAt,
  };
}

function assertFixedEvent(
  event: Entity<TaskEvent>,
  taskId: string,
  payload: { type: string; [key: string]: unknown },
  at: string,
): void {
  if (event.data.taskId !== taskId || event.data.type !== payload.type
    || event.data.at !== at || !sameValue(event.data.payload, payload)) {
    throw new DomainError('reconciliation_integrity', 'A deterministic reconciliation event has different content', 409);
  }
}

function sameValue(left: unknown, right: unknown): boolean {
  return canonicalValue(left) === canonicalValue(right);
}

function canonicalValue(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalValue).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalValue(entry)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function scopeCovered(grants: string[], requested: string): boolean {
  const namespace = requested.split(':')[0];
  return grants.some((grant) => grant === '*'
    || grant === 'kiancode:*'
    || grant === requested
    || grant === `kiancode:${requested}`
    || grant === `${namespace}:*`);
}

function revalidatedPrincipal(granted: Principal, current: Principal, ownerId: string): Principal {
  if (current.id !== ownerId || current.id !== granted.id
    || (granted.issuer && current.issuer !== granted.issuer)
    || (granted.subject && current.subject !== granted.subject)) {
    throw new DomainError('unauthorized', 'Task identity changed during authorization revalidation', 401);
  }
  if (granted.scopes.some((scope) => !scopeCovered(current.scopes, scope))) {
    throw new DomainError('grant_revoked', 'Task capabilities have been reduced or revoked', 403);
  }
  return {
    ...current,
    level: Math.max(granted.level, current.level) as Principal['level'],
    scopes: [...granted.scopes],
  };
}

function resumedPrincipal(
  task: Task,
  taskId: string,
  actor: Principal,
  now: number,
  durableGrants: boolean,
): Principal {
  if (actor.expiresAt && (!Number.isFinite(Date.parse(actor.expiresAt)) || Date.parse(actor.expiresAt) <= now)) {
    throw new DomainError('unauthorized', 'The signed-in session has expired', 401);
  }
  if (durableGrants && task.accountTaskGrant) {
    if (accountDelegationExpired(task, now)) {
      throw new DomainError('grant_expired', 'Delegated task authorization expired', 403);
    }
    if (!repairableAccountTaskGrant(task.accountTaskGrant, task.principal, taskRootId(task, taskId))
      || !accountTaskGrantIdentityMatches(task.accountTaskGrant, actor)) {
      throw new DomainError('grant_revoked', 'Account task authorization has changed', 403);
    }
    const current = revalidatedPrincipal(task.principal, actor, task.principal.id);
    const { expiresAt: _expiresAt, ...durable } = current;
    if (!accountTaskGrantMatches(task.accountTaskGrant, durable, taskRootId(task, taskId))) {
      throw new DomainError('grant_revoked', 'Account task authorization has changed', 403);
    }
    return durable;
  }
  if (durableGrants && isDurableAutomationTask(task)) {
    if (!accountAutomationIdentityMatches(task.principal, actor)) {
      throw new DomainError('grant_revoked', 'Account automation authorization has changed', 403);
    }
    const { expiresAt: _expiresAt, ...durable } = revalidatedPrincipal(task.principal, actor, task.principal.id);
    return durable;
  }
  if (!task.orchestration) return { ...actor, scopes: [...actor.scopes] };
  return revalidatedPrincipal(task.principal, actor, task.principal.id);
}

function revalidatedTaskPrincipal(task: Entity<Task>, current: Principal): Principal {
  if (isDurableAutomationTask(task.data)
    && !accountAutomationIdentityMatches(task.data.principal, current)) {
    throw new DomainError('grant_revoked', 'Account automation authorization has changed', 403);
  }
  const principal = revalidatedPrincipal(task.data.principal, current, task.ownerId);
  if (task.data.accountTaskGrant
    && !accountTaskGrantMatches(task.data.accountTaskGrant, principal, taskRootId(task.data, task.id))) {
    throw new DomainError('invalid_account_task_grant', 'Account task authorization context is invalid', 403);
  }
  return principal;
}

function accountAutomationIdentityMatches(granted: Principal, current: Principal): boolean {
  return isAccountIdentity(granted)
    && isAccountIdentity(current)
    && granted.id === current.id
    && granted.issuer === current.issuer
    && granted.subject === current.subject
    && granted.applicationId === current.applicationId
    && granted.audience === current.audience
    && granted.credentialVersion === current.credentialVersion
    && granted.consentVersion === current.consentVersion
    && granted.grantVersion === current.grantVersion
    && granted.authenticatedAt === current.authenticatedAt;
}

function isDurableAccountTask(task: Pick<Entity<Task>, 'id' | 'data'>): boolean {
  return task.data.accountTaskGrant !== undefined
    && accountTaskGrantMatches(task.data.accountTaskGrant, task.data.principal, taskRootId(task.data, task.id));
}

function hasMalformedAccountTaskGrant(task: Pick<Entity<Task>, 'id' | 'data'>): boolean {
  return task.data.accountTaskGrant !== undefined && !isDurableAccountTask(task);
}

function taskRootId(task: Task, taskId: string): string {
  return task.orchestration?.rootTaskId ?? taskId;
}

function accountDelegationExpired(task: Task, now: number): boolean {
  const expiresAt = task.accountTaskGrant?.delegationExpiresAt;
  return expiresAt !== undefined && Date.parse(expiresAt) <= now;
}

function isDurableAutomationTask(task: Task): boolean {
  return task.principal.expiresAt === undefined
    && task.authorizationKind === 'account_automation'
    && (task.automationSource?.type === 'schedule' || task.automationSource?.type === 'event_trigger')
    && Boolean(task.automationSource.id)
    && Number.isInteger(task.automationSource.version)
    && task.automationSource.version >= 1;
}

function hasMalformedAutomationAuthorization(task: Task): boolean {
  return (task.authorizationKind !== undefined || task.automationSource !== undefined)
    && !isDurableAutomationTask(task);
}

function renewedGrantExpiry(principal: Principal, now: number, delegationExpiresAt?: string): string {
  const sessionExpiry = principal.expiresAt ? Date.parse(principal.expiresAt) : Number.POSITIVE_INFINITY;
  const delegationExpiry = delegationExpiresAt ? Date.parse(delegationExpiresAt) : Number.POSITIVE_INFINITY;
  return new Date(Math.min(now + 3_600_000, sessionExpiry, delegationExpiry)).toISOString();
}

function sameStrings(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function sameNotificationDestination(
  left: NotificationDestination | undefined,
  right: NotificationDestination | undefined,
): boolean {
  return left?.type === right?.type
    && (left?.type !== 'push' || right?.type !== 'push' || left.subscriptionId === right.subscriptionId)
    && (left?.type !== 'channel' || right?.type !== 'channel' || left.destinationId === right.destinationId);
}

function sameTaskAuthorization(
  task: Entity<Task>,
  authorization: TaskEnqueueAuthorization | undefined,
): boolean {
  if (task.data.authorizationKind !== authorization?.authorizationKind
    || (task.data.automationSource !== undefined) !== (authorization?.automationSource !== undefined)
    || task.data.automationSource?.type !== authorization?.automationSource?.type
    || task.data.automationSource?.id !== authorization?.automationSource?.id
    || task.data.automationSource?.version !== authorization?.automationSource?.version) return false;
  if (!task.data.accountTaskGrant) return true;
  if (!authorization?.accountTaskGrant) return false;
  const expected: AccountTaskGrant = {
    ...authorization.accountTaskGrant,
    scopes: [...new Set(authorization.accountTaskGrant.scopes)].sort(),
    rootTaskId: task.id,
  };
  return sameValue(task.data.accountTaskGrant, expected);
}

function normalizePluginVersions(value: Record<string, string>): Record<string, string> {
  const entries = Object.entries(value).sort(([left], [right]) => left.localeCompare(right));
  if (entries.length > 100) throw new DomainError('invalid_plugin_snapshot', 'A task can pin at most 100 plugins');
  for (const [pluginId, version] of entries) {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(pluginId) || !/^[a-f0-9]{64}$/.test(version)) {
      throw new DomainError('invalid_plugin_snapshot', 'Task plugin snapshot is invalid');
    }
  }
  return Object.fromEntries(entries);
}

function describeTickError(error: unknown): { code: string; message: string } {
  return {
    code: error instanceof DomainError ? 'domain_error' : 'internal_error',
    message: 'Task tick failed.',
  };
}

function sameRecord(left: Record<string, string>, right: Record<string, string>): boolean {
  const leftEntries = Object.entries(left).sort(([a], [b]) => a.localeCompare(b));
  const rightEntries = Object.entries(right).sort(([a], [b]) => a.localeCompare(b));
  return leftEntries.length === rightEntries.length
    && leftEntries.every(([key, value], index) => rightEntries[index]?.[0] === key && rightEntries[index]?.[1] === value);
}

function taskNotification(
  task: Entity<Task>,
  type: 'task_completed' | 'task_failed' | 'task_unknown' | 'approval_required',
): NotificationInput {
  const state = type === 'task_completed' ? 'completed'
    : type === 'task_failed' ? 'failed'
      : type === 'task_unknown' ? 'unknown'
        : `approval:${createHash('sha256').update(task.data.pendingActions.map((action) => action.hash).sort().join(',')).digest('hex')}`;
  return {
    type,
    dedupeKey: `task:${task.id}:${state}`,
    taskId: task.id,
    conversationId: task.data.conversationId,
  };
}

export function orderMessages<T extends Entity<Message>>(messages: T[]): T[] {
  return [...messages].sort((left, right) => {
    if (left.data.sequence !== undefined && right.data.sequence !== undefined
      && left.data.sequence !== right.data.sequence) {
      return left.data.sequence - right.data.sequence;
    }
    const created = left.createdAt.localeCompare(right.createdAt);
    if (created !== 0) return created;
    if (left.data.taskId === right.data.taskId && left.data.role !== right.data.role) {
      return left.data.role === 'user' ? -1 : 1;
    }
    return left.id.localeCompare(right.id);
  });
}
