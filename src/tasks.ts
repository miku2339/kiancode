import { createHash, randomUUID } from 'node:crypto';
import type { Artifact } from './artifacts.js';
import { DomainError, type Principal, type Workspace } from './contracts.js';
import type { Conversation, Message, NotificationDestination, PendingAction, Task, TaskEvent, TaskState } from './domain.js';
import type { NotificationInput, NotificationService } from './notifications.js';
import type { Entity, Store } from './storage/store.js';
import { snapshotEnabledPluginVersions } from './plugins.js';

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

export interface TaskServiceOptions {
  now?: () => number;
  concurrency?: number;
  onError?: (error: unknown) => void;
  reauthorize?: (principal: Principal) => Promise<Principal>;
  isQuietTime?: (ownerId: string, at: Date) => boolean | Promise<boolean>;
  notifications?: Pick<NotificationService, 'publishTask' | 'reconcile'>;
  leaseMs?: number;
  heartbeatMs?: number;
}

interface ActiveRun {
  ownerId: string;
  controller: AbortController;
  promise: Promise<void>;
}

interface EventSequence {
  next: number;
}

interface MessageSequence {
  next: number;
}

type RuntimeEvent = { type: string; [key: string]: unknown };

const tokenFlushDelayMs = 32;
const tokenBufferLimitBytes = 64 * 1024;

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
        || (pluginVersions !== undefined && !sameRecord(previous.data.pluginVersions ?? {}, normalizePluginVersions(pluginVersions)))) {
        throw new DomainError('idempotency_conflict', 'Request ID already belongs to another task input', 409);
      }
      return previous;
    }
    const capturedPluginVersions = pluginVersions === undefined
      ? await snapshotEnabledPluginVersions(this.store, principal.id)
      : normalizePluginVersions(pluginVersions);
    let task: Entity<Task>;
    try {
      task = await this.store.create<Task>('task', principal.id, {
        conversationId,
        ...(conversation.data.workspaceId ? { workspaceId: conversation.data.workspaceId } : {}),
        prompt,
        principal,
        state: 'queued',
        grantExpiresAt: renewedGrantExpiry(principal, this.now()),
        pendingActions: [],
        approvedActionHashes: [],
        pluginVersions: capturedPluginVersions,
        ...(attachments.length ? { attachmentIds: attachments } : {}),
        ...(dependencies.length ? { dependencyIds: dependencies } : {}),
        ...(notificationDestination ? { notificationDestination } : {}),
      }, id);
    } catch (error) {
      if (error instanceof DomainError && error.code === 'conflict') {
        return this.enqueue(principal, conversationId, prompt, requestId, attachments, dependencies, notificationDestination, capturedPluginVersions);
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

  public async events(ownerId: string, taskId: string, after = 0): Promise<Array<Entity<TaskEvent>>> {
    if (!await this.store.get('task', taskId, ownerId)) {
      throw new DomainError('not_found', 'Task not found', 404);
    }
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
          { next: sequence + 1 },
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

  private async change(ownerId: string, id: string, change: (task: Task) => Task): Promise<Entity<Task>> {
    for (let attempt = 0; attempt < 16; attempt += 1) {
      const row = await this.store.get<Task>('task', id, ownerId);
      if (!row) {
        throw new DomainError('not_found', 'Task not found', 404);
      }
      try {
        return await this.store.put('task', id, ownerId, change(row.data), row.revision);
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
      const principal = actor ? resumedPrincipal(task, actor, this.now()) : task.principal;
      return {
        ...task,
        principal,
        state: task.orchestration?.role === 'parent' && task.orchestration.phase === 'children'
          ? 'waiting_for_children'
          : 'queued',
        pauseRequested: false,
        nextAttemptAt: undefined,
        grantExpiresAt: renewedGrantExpiry(principal, this.now()),
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

  public start(intervalMs = 1_000): void {
    if (this.timer) {
      return;
    }
    this.stopped = false;
    const runTick = (): void => {
      void this.tick().catch((error) => this.options.onError?.(error));
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
    await this.options.notifications?.reconcile();
    await this.reconciler?.();
    let tasks = await this.store.scan<Task>('task');
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
      const promise = this.execute(claimed, controller).finally(() => {
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
          const principal = revalidatedPrincipal(
            fresh.data.principal,
            await this.options.reauthorize(fresh.data.principal),
            task.ownerId,
          );
          fresh = await this.change(task.ownerId, task.id, (current) => {
            if (current.state !== 'running' || current.workerId !== this.workerId) {
              throw new DomainError('lease_lost', 'Execution lease lost', 409);
            }
            return { ...current, principal };
          });
        }
      }
      if (runtimeEvent.type === 'usage' && runtimeEvent.usage) {
        await this.change(task.ownerId, task.id, (current) => ({
          ...current,
          usage: runtimeEvent.usage,
        }));
      }
      if (runtimeEvent.type === 'tool_result' && Array.isArray(runtimeEvent.checkpointMessages)) {
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
      if (Date.parse(task.data.grantExpiresAt) <= this.now()) {
        throw new DomainError('grant_expired', 'Task authorization expired; resume from a signed-in client', 403);
      }
      let executionTask = task;
      if (this.options.reauthorize) {
        const principal = revalidatedPrincipal(
          task.data.principal,
          await this.options.reauthorize(task.data.principal),
          task.ownerId,
        );
        executionTask = await this.change(task.ownerId, task.id, (current) => {
          if (current.state !== 'running' || current.workerId !== this.workerId) {
            throw new DomainError('lease_lost', 'Execution lease lost', 409);
          }
          return { ...current, principal };
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
        if (unresolved) {
          return {
            ...current,
            state: 'unknown',
            error: 'A side effect was dispatched but its result was not confirmed. Verify the outcome before retrying.',
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
      if (updated?.data.state === 'failed' || updated?.data.state === 'unknown') {
        const type = updated.data.state === 'failed' ? 'task_failed' : 'task_unknown';
        await this.notify(updated, taskNotification(updated, type), new Date(updated.updatedAt))
          .catch((notificationError) => this.options.onError?.(notificationError));
      }
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
    const unresolved = new Set<string>();
    for (const row of await this.events(ownerId, taskId)) {
      const payload = row.data.payload as {
        type?: string;
        toolCallId?: string;
        actionHash?: string;
        sideEffect?: string;
        outcome?: string;
        toolCall?: { id?: string };
      };
      const key = payload.actionHash ?? payload.toolCallId ?? payload.toolCall?.id;
      if (!key) {
        continue;
      }
      if (row.data.type === 'tool_dispatched'
        && (payload.sideEffect === 'write' || payload.sideEffect === 'external')) {
        unresolved.add(key);
      }
      if (row.data.type === 'tool_result'
        && ['confirmed', 'failed', 'not_replayed'].includes(payload.outcome ?? '')) {
        unresolved.delete(key);
      }
    }
    return unresolved.size > 0;
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
  'access_revoked',
  'authorization_revalidation_required',
  'grant_expired',
  'grant_revoked',
  'unauthorized',
]);

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

function resumedPrincipal(task: Task, actor: Principal, now: number): Principal {
  if (actor.expiresAt && (!Number.isFinite(Date.parse(actor.expiresAt)) || Date.parse(actor.expiresAt) <= now)) {
    throw new DomainError('unauthorized', 'The signed-in session has expired', 401);
  }
  if (!task.orchestration) return { ...actor, scopes: [...actor.scopes] };
  return revalidatedPrincipal(task.principal, actor, task.principal.id);
}

function renewedGrantExpiry(principal: Principal, now: number): string {
  const sessionExpiry = principal.expiresAt ? Date.parse(principal.expiresAt) : Number.POSITIVE_INFINITY;
  return new Date(Math.min(now + 3_600_000, sessionExpiry)).toISOString();
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
