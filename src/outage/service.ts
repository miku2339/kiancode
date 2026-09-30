import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { DomainError } from '../contracts.js';
import { EncryptedBuffer, type EncryptedBufferOptions } from './encrypted-buffer.js';
import type {
  OutageContext,
  OutageConversationResult,
  OutageMessage,
  OutageReplayRecord,
  OutageReplaySink,
  OutageRunInput,
  OutageRunResult,
  OutageStats,
  OutageTask,
  SimpleChat,
} from './types.js';

const HARD_MAX_BYTES = 1024 * 1024 * 1024;
const HARD_MAX_AGE_MS = 24 * 60 * 60 * 1_000;

export interface OutageServiceOptions extends EncryptedBufferOptions {
  simpleChat: SimpleChat;
  replaySink?: OutageReplaySink;
  maxBytes?: number;
  maxAgeMs?: number;
  maxResponseBytes?: number;
  now?: () => number;
}

export class OutageService {
  private readonly buffer: EncryptedBuffer;
  private readonly simpleChat: SimpleChat;
  private readonly replaySink?: OutageReplaySink;
  private readonly maxBytes: number;
  private readonly maxAgeMs: number;
  private readonly maxResponseBytes: number;
  private readonly now: () => number;
  private readonly mutex = new Mutex();
  private readonly activeTasks = new Map<string, Promise<OutageRunResult>>();
  private reconciling?: Promise<{ acknowledged: number; remaining: number }>;

  public constructor(options: OutageServiceOptions) {
    this.maxBytes = bounded(options.maxBytes, HARD_MAX_BYTES, 1, HARD_MAX_BYTES, 'maxBytes');
    this.maxAgeMs = bounded(options.maxAgeMs, HARD_MAX_AGE_MS, 1, HARD_MAX_AGE_MS, 'maxAgeMs');
    this.maxResponseBytes = bounded(
      options.maxResponseBytes,
      1024 * 1024,
      1,
      Math.min(64 * 1024 * 1024, this.maxBytes),
      'maxResponseBytes',
    );
    this.buffer = new EncryptedBuffer(options.directory, {
      ...(options.key ? { key: options.key } : {}),
      ...(options.keyEnv ? { keyEnv: options.keyEnv } : {}),
      ...(options.env ? { env: options.env } : {}),
    });
    this.simpleChat = options.simpleChat;
    this.replaySink = options.replaySink;
    this.now = options.now ?? Date.now;
  }

  public async cacheContext(context: OutageContext): Promise<void> {
    validateContext(context, this.now());
    const cached: OutageContext = {
      ...context,
      history: context.history.slice(-60).map(validateMessage),
      cachedAt: new Date(this.now()).toISOString(),
    };
    await this.mutex.use(async () => {
      const relativePath = contextPath(context.principal.id, context.conversation.id);
      const stats = await this.statsUnlocked();
      this.assertAccepting(stats);
      const previous = await this.buffer.size(relativePath);
      const estimate = encryptedSizeEstimate(cached);
      if (stats.bytesUsed + estimate > this.maxBytes) {
        throw new DomainError('outage_buffer_full', 'Outage buffer capacity is exhausted.', 507);
      }
      const written = await this.buffer.write(relativePath, cached);
      if (stats.bytesUsed - previous + written > this.maxBytes) {
        throw new DomainError('outage_buffer_full', 'Outage buffer capacity is exhausted.', 507);
      }
    });
  }

  public async run(input: OutageRunInput): Promise<OutageRunResult> {
    const signal = input.signal ?? new AbortController().signal;
    signal.throwIfAborted();
    const context = await this.authenticate(input.token, input.conversationId);
    if (!input.prompt.trim() || Buffer.byteLength(input.prompt) > 64_000) {
      throw new DomainError('invalid_prompt', 'Prompt must contain 1 to 64000 bytes.');
    }
    if (input.requestId !== undefined
      && (!input.requestId.trim() || Buffer.byteLength(input.requestId) > 256)) {
      throw new DomainError('invalid_request_id', 'Request ID must contain 1 to 256 bytes.');
    }
    const history = await this.history(context);
    const now = new Date(this.now()).toISOString();
    const id = input.requestId
      ? createHash('sha256').update(`${context.principal.id}\0${input.conversationId}\0${input.requestId}`).digest('hex')
      : randomUUID();
    const userMessage: OutageMessage = {
      id: `${id}:user`,
      role: 'user',
      content: input.prompt,
      createdAt: now,
      sequence: nextOutageSequence(history),
    };
    const task: OutageTask = {
      id,
      ownerId: context.principal.id,
      conversation: context.conversation,
      principal: context.principal,
      history,
      prompt: input.prompt,
      ...(input.requestId !== undefined ? { requestId: input.requestId } : {}),
      state: 'queued',
      degraded: true,
      createdAt: now,
      updatedAt: now,
      userMessage,
      reservedBytes: 0,
    };
    task.reservedBytes = encryptedSizeEstimate(task) * 2
      + Math.ceil(this.maxResponseBytes * 8 / 3)
      + 4_096;
    const accepted = await this.mutex.use(async (): Promise<{ task: OutageTask; created: boolean }> => {
      if (task.requestId) {
        const existing = (await this.tasks()).find((candidate) => candidate.ownerId === task.ownerId
          && candidate.conversation.id === task.conversation.id
          && candidate.requestId === task.requestId);
        if (existing) {
          if (existing.prompt !== task.prompt) {
            throw new DomainError('idempotency_conflict', 'Request ID was already used for different input.', 409);
          }
          return { task: existing, created: false };
        }
      }
      const stats = await this.statsUnlocked();
      this.assertAccepting(stats);
      if (stats.bytesUsed + task.reservedBytes > this.maxBytes) {
        throw new DomainError('outage_buffer_full', 'Outage buffer capacity is exhausted.', 507);
      }
      await this.buffer.write(taskPath(task.id), task);
      return { task, created: true };
    });
    if (!accepted.created) return publicTask(accepted.task);
    return this.complete(accepted.task, history, signal);
  }

  public async resumeQueued(signal = new AbortController().signal): Promise<OutageRunResult[]> {
    const results: OutageRunResult[] = [];
    for (const task of await this.tasks()) {
      if (!['queued', 'waiting_for_device'].includes(task.state)) continue;
      const context = await this.context(task.ownerId, task.conversation.id);
      if (!context) {
        const failed = await this.saveFailure(task, 'Cached session expired before local generation resumed.');
        results.push(publicTask(failed));
        continue;
      }
      try {
        validateContext(context, this.now());
      } catch (error) {
        if (!(error instanceof DomainError) || error.code !== 'session_expired') throw error;
        const failed = await this.saveFailure(task, 'Cached session expired before generation resumed.');
        results.push(publicTask(failed));
        continue;
      }
      results.push(await this.complete(task, task.history, signal));
    }
    return results;
  }

  public async list(token: string, conversationId: string): Promise<OutageRunResult[]> {
    const context = await this.authenticate(token, conversationId);
    return (await this.tasks())
      .filter((task) => task.ownerId === context.principal.id && task.conversation.id === conversationId)
      .map(publicTask);
  }

  public async conversation(token: string, conversationId: string): Promise<OutageConversationResult> {
    const context = await this.authenticate(token, conversationId);
    return { conversation: context.conversation, degraded: true };
  }

  public async messages(token: string, conversationId: string): Promise<OutageMessage[]> {
    const context = await this.authenticate(token, conversationId);
    return this.history(context);
  }

  public async get(token: string, taskId: string): Promise<OutageRunResult> {
    const task = await this.buffer.read<OutageTask>(taskPath(taskId));
    if (!task) throw new DomainError('not_found', 'Task not found.', 404);
    const context = await this.authenticate(token, task.conversation.id);
    if (context.principal.id !== task.ownerId) throw new DomainError('not_found', 'Task not found.', 404);
    return publicTask(task);
  }

  public async listAll(token: string): Promise<OutageRunResult[]> {
    const principal = await this.authenticateAny(token);
    const results: OutageRunResult[] = [];
    for (const task of await this.tasks()) {
      if (principal.id === task.ownerId) results.push(publicTask(task));
    }
    return results;
  }

  public async stats(): Promise<OutageStats> {
    return this.mutex.use(() => this.statsUnlocked());
  }

  public async reconcile(): Promise<{ acknowledged: number; remaining: number }> {
    if (!this.replaySink) {
      throw new DomainError('outage_replay_unavailable', 'NAS replay sink is not configured.', 503);
    }
    if (this.reconciling) return this.reconciling;
    this.reconciling = this.reconcileInternal().finally(() => {
      this.reconciling = undefined;
    });
    return this.reconciling;
  }

  private async reconcileInternal(): Promise<{ acknowledged: number; remaining: number }> {
    let acknowledged = 0;
    for (const task of await this.tasks()) {
      if (task.state === 'queued' || task.state === 'waiting_for_device') continue;
      const record = replayRecord(task);
      let ack;
      try {
        ack = await this.replaySink!.replay(record);
      } catch {
        continue;
      }
      if (ack.durable !== true || ack.deduplicated !== true || ack.recordId !== task.id) {
        continue;
      }
      await this.mutex.use(() => this.buffer.remove(taskPath(task.id)));
      acknowledged += 1;
    }
    const remaining = (await this.tasks()).length;
    return { acknowledged, remaining };
  }

  private async complete(
    task: OutageTask,
    history: OutageMessage[],
    signal: AbortSignal,
  ): Promise<OutageRunResult> {
    const active = this.activeTasks.get(task.id);
    if (active) return active;
    const completion = this.completeOnce(task, history, signal).finally(() => {
      this.activeTasks.delete(task.id);
    });
    this.activeTasks.set(task.id, completion);
    return completion;
  }

  private async completeOnce(
    task: OutageTask,
    history: OutageMessage[],
    signal: AbortSignal,
  ): Promise<OutageRunResult> {
    let response: { content: string };
    try {
      const modelPolicy = task.conversation.privacy === 'private'
        || task.conversation.workspaceAllowCloud === false
        ? 'local'
        : task.conversation.modelPolicy;
      response = await this.simpleChat({
        taskId: task.id,
        principal: task.principal,
        conversation: task.conversation,
        history,
        prompt: task.prompt,
        signal,
        mode: 'ask',
        strategy: 'single',
        modelPolicy,
        ...(task.conversation.modelId ? { modelId: task.conversation.modelId } : {}),
        privacy: task.conversation.privacy,
        ...(task.conversation.workspaceAllowCloud !== undefined
          ? { workspaceAllowCloud: task.conversation.workspaceAllowCloud }
          : {}),
        tools: [],
        maxOutputBytes: this.maxResponseBytes,
      });
    } catch (error) {
      if (error instanceof DomainError && error.code === 'waiting_for_device') {
        return publicTask(await this.saveWaiting(task, error.message));
      }
      return publicTask(await this.saveFailure(
        task,
        signal.aborted ? 'Generation was cancelled after the prompt was durably queued.'
          : error instanceof DomainError ? error.message : 'Generation failed.',
      ));
    }
    if (typeof response.content !== 'string'
      || Buffer.byteLength(response.content) > this.maxResponseBytes) {
      return publicTask(await this.saveFailure(task, 'Model response exceeded its durable output limit.'));
    }
    const finishedAt = new Date(this.now()).toISOString();
    const { error: _previousError, ...taskWithoutError } = task;
    const completed: OutageTask = {
      ...taskWithoutError,
      state: 'completed',
      result: response.content,
        assistantMessage: {
        id: `${task.id}:assistant`,
        role: 'assistant',
        content: response.content,
          createdAt: finishedAt,
          sequence: (task.userMessage.sequence ?? nextOutageSequence(history)) + 1,
      },
      updatedAt: finishedAt,
    };
    const currentSize = await this.buffer.size(taskPath(task.id));
    if (encryptedSizeEstimate(completed) + currentSize > task.reservedBytes) {
      return publicTask(await this.saveFailure(task, 'Model response exceeded its durable output limit.'));
    }
    await this.mutex.use(() => this.buffer.write(taskPath(task.id), completed));
    return publicTask(completed);
  }

  private async saveWaiting(task: OutageTask, error: string): Promise<OutageTask> {
    const waiting: OutageTask = {
      ...task,
      state: 'waiting_for_device',
      error: error.slice(0, 2_000),
      updatedAt: new Date(this.now()).toISOString(),
    };
    await this.mutex.use(() => this.buffer.write(taskPath(task.id), waiting));
    return waiting;
  }

  private async saveFailure(task: OutageTask, error: string): Promise<OutageTask> {
    const failed: OutageTask = {
      ...task,
      state: 'failed',
      error: error.slice(0, 2_000),
      updatedAt: new Date(this.now()).toISOString(),
    };
    await this.mutex.use(() => this.buffer.write(taskPath(task.id), failed));
    return failed;
  }

  private async authenticate(token: string, conversationId: string): Promise<OutageContext> {
    if (!token || token.length > 16_384) {
      throw new DomainError('unauthorized', 'Cached session is unavailable.', 401);
    }
    const expected = tokenHash(token);
    for (const relativePath of await this.buffer.list('contexts')) {
      const context = await this.buffer.read<OutageContext>(relativePath);
      if (!context || context.conversation.id !== conversationId
        || !equalHash(context.tokenHash, expected)) continue;
      validateContext(context, this.now());
      return context;
    }
    throw new DomainError('unauthorized', 'Cached session is unavailable.', 401);
  }

  private async authenticateAny(token: string): Promise<OutageContext['principal']> {
    if (!token || token.length > 16_384) {
      throw new DomainError('unauthorized', 'Cached session is unavailable.', 401);
    }
    const expected = tokenHash(token);
    let expired = false;
    for (const relativePath of await this.buffer.list('contexts')) {
      const context = await this.buffer.read<OutageContext>(relativePath);
      if (!context || !equalHash(context.tokenHash, expected)) continue;
      try {
        validateContext(context, this.now());
        return context.principal;
      } catch (error) {
        if (error instanceof DomainError && error.code === 'session_expired') expired = true;
        else throw error;
      }
    }
    throw new DomainError(expired ? 'session_expired' : 'unauthorized', 'Cached session is unavailable.', 401);
  }

  private async context(ownerId: string, conversationId: string): Promise<OutageContext | undefined> {
    return this.buffer.read(contextPath(ownerId, conversationId));
  }

  private async history(context: OutageContext): Promise<OutageMessage[]> {
    const combined = [...context.history];
    for (const task of await this.tasks()) {
      if (task.ownerId !== context.principal.id || task.conversation.id !== context.conversation.id) continue;
      combined.push(task.userMessage);
      if (task.assistantMessage) combined.push(task.assistantMessage);
    }
    const unique = new Map(combined.map((message) => [message.id, message]));
    return [...unique.values()]
      .sort((left, right) => {
        if (left.sequence !== undefined && right.sequence !== undefined && left.sequence !== right.sequence) {
          return left.sequence - right.sequence;
        }
        return left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id);
      })
      .slice(-60);
  }

  private async tasks(): Promise<OutageTask[]> {
    const tasks: OutageTask[] = [];
    for (const relativePath of await this.buffer.list('records')) {
      const task = await this.buffer.read<OutageTask>(relativePath);
      if (task) tasks.push(task);
    }
    return tasks.sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id));
  }

  private async statsUnlocked(): Promise<OutageStats> {
    let bytesUsed = await this.buffer.usage();
    const tasks = await this.tasks();
    for (const task of tasks) {
      const actual = await this.buffer.size(taskPath(task.id));
      bytesUsed += Math.max(0, task.reservedBytes - actual);
    }
    const firstUnsyncedAt = tasks[0]?.createdAt;
    return {
      bytesUsed,
      maxBytes: this.maxBytes,
      unsyncedRecords: tasks.length,
      ...(firstUnsyncedAt ? { firstUnsyncedAt } : {}),
      accepting: bytesUsed < this.maxBytes
        && (!firstUnsyncedAt || this.now() - Date.parse(firstUnsyncedAt) < this.maxAgeMs),
    };
  }

  private assertAccepting(stats: OutageStats): void {
    if (stats.bytesUsed >= this.maxBytes) {
      throw new DomainError('outage_buffer_full', 'Outage buffer capacity is exhausted.', 507);
    }
    if (stats.firstUnsyncedAt && this.now() - Date.parse(stats.firstUnsyncedAt) >= this.maxAgeMs) {
      throw new DomainError('outage_window_expired', 'The 24-hour outage acceptance window is exhausted.', 503);
    }
  }
}

function contextPath(ownerId: string, conversationId: string): string {
  const id = createHash('sha256').update(`${ownerId}\0${conversationId}`).digest('hex');
  return `contexts/${id}.enc`;
}

function taskPath(taskId: string): string {
  return `records/${taskId}.enc`;
}

export function tokenHash(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

function validateContext(context: OutageContext, now: number): void {
  if (context.conversation.scope !== 'private') {
    throw new DomainError('outage_private_only', 'Outage mode supports private conversations only.', 403);
  }
  if (!['cloud', 'local', 'auto'].includes(context.conversation.modelPolicy)
    || !['auto', 'single', 'experts', 'moa'].includes(context.conversation.strategy)
    || !['ask', 'plan', 'act'].includes(context.conversation.mode)
    || !['standard', 'private'].includes(context.conversation.privacy)
    || (context.conversation.workspaceAllowCloud !== undefined
      && typeof context.conversation.workspaceAllowCloud !== 'boolean')) {
    throw new DomainError('invalid_cached_context', 'Cached model policy is invalid.', 400);
  }
  if (context.conversation.ownerId !== context.principal.id) {
    throw new DomainError('forbidden', 'Conversation does not belong to the cached principal.', 403);
  }
  if (context.conversation.archived !== false || !context.conversation.id
    || !context.principal.id || !Array.isArray(context.principal.scopes)) {
    throw new DomainError('invalid_cached_session', 'Cached principal or conversation is invalid.', 400);
  }
  if (!/^[a-f0-9]{64}$/.test(context.tokenHash)) {
    throw new DomainError('invalid_cached_session', 'Cached session token hash is invalid.', 400);
  }
  const sessionExpiresAt = Date.parse(context.sessionExpiresAt);
  const principalExpiresAt = context.principal.expiresAt
    ? Date.parse(context.principal.expiresAt)
    : undefined;
  if (!Number.isFinite(sessionExpiresAt)
    || (principalExpiresAt !== undefined && !Number.isFinite(principalExpiresAt))) {
    throw new DomainError('invalid_cached_session', 'Cached session expiry is invalid.', 400);
  }
  if (sessionExpiresAt <= now || (principalExpiresAt !== undefined && principalExpiresAt <= now)) {
    throw new DomainError('session_expired', 'Cached session has expired.', 401);
  }
}

function equalHash(left: string, right: string): boolean {
  if (!/^[a-f0-9]{64}$/.test(left) || !/^[a-f0-9]{64}$/.test(right)) return false;
  return timingSafeEqual(Buffer.from(left, 'hex'), Buffer.from(right, 'hex'));
}

function validateMessage(message: OutageMessage): OutageMessage {
  if (!message.id || !['user', 'assistant'].includes(message.role)
    || typeof message.content !== 'string' || Buffer.byteLength(message.content) > 64_000
    || !Number.isFinite(Date.parse(message.createdAt))) {
    throw new DomainError('invalid_history', 'Cached conversation history is invalid.', 400);
  }
  return { ...message };
}

function replayRecord(task: OutageTask): OutageReplayRecord {
  if (task.state === 'queued' || task.state === 'waiting_for_device') {
    throw new DomainError('outage_record_pending', 'Pending records cannot be replayed.', 409);
  }
  return {
    recordId: task.id,
    ownerId: task.ownerId,
    principal: task.principal,
    task: {
      id: task.id,
      conversationId: task.conversation.id,
      state: task.state,
      prompt: task.prompt,
      ...(task.requestId !== undefined ? { requestId: task.requestId } : {}),
      ...(task.result !== undefined ? { result: task.result } : {}),
      ...(task.error !== undefined ? { error: task.error } : {}),
      degraded: true,
      createdAt: task.createdAt,
      updatedAt: task.updatedAt,
    },
    conversation: task.conversation,
    messages: [task.userMessage, ...(task.assistantMessage ? [task.assistantMessage] : [])],
  };
}

function publicTask(task: OutageTask): OutageRunResult {
  return {
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
    id: task.id,
    conversationId: task.conversation.id,
    ...(task.conversation.workspaceId ? { workspaceId: task.conversation.workspaceId } : {}),
    state: task.state,
    degraded: true,
    ...(task.result !== undefined ? { result: task.result } : {}),
    ...(task.error !== undefined ? { error: task.error } : {}),
  };
}

function encryptedSizeEstimate(value: unknown): number {
  return Math.ceil(Buffer.byteLength(JSON.stringify(value)) * 4 / 3) + 256;
}

function nextOutageSequence(history: OutageMessage[]): number {
  return Math.max(0, ...history.map((message) => message.sequence ?? 0)) + 1;
}

function bounded(value: number | undefined, fallback: number, minimum: number, maximum: number, name: string): number {
  const selected = value ?? fallback;
  if (!Number.isInteger(selected) || selected < minimum || selected > maximum) {
    throw new Error(`${name} must be an integer from ${minimum} to ${maximum}.`);
  }
  return selected;
}

class Mutex {
  private tail = Promise.resolve();

  public async use<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.tail;
    let release: (() => void) | undefined;
    this.tail = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try {
      return await operation();
    } finally {
      release?.();
    }
  }
}
