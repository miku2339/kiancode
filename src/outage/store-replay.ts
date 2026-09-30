import { createHash } from 'node:crypto';
import { DomainError } from '../contracts.js';
import type { Conversation, Message, Task } from '../domain.js';
import type { Store } from '../storage/store.js';
import type { OutageReplayRecord, OutageReplaySink } from './types.js';

export function createStoreReplaySink(store: Store): OutageReplaySink {
  return {
    async replay(record) {
      await ensureConversation(store, record);
      await ensureTask(store, record);
      for (const message of record.messages) await ensureMessage(store, record, message);
      await advanceMessageSequence(store, record);
      await verifyReplay(store, record);
      return { recordId: record.recordId, durable: true, deduplicated: true };
    },
  };
}

async function advanceMessageSequence(store: Store, record: OutageReplayRecord): Promise<void> {
  const maximum = Math.max(0, ...record.messages.map((message) => message.sequence ?? 0));
  if (maximum === 0) return;
  const id = createHash('sha256').update(`${record.ownerId}\0${record.conversation.id}`).digest('hex');
  while (true) {
    const cursor = await store.get<{ next: number }>('message_sequence', id, record.ownerId);
    if (!cursor) {
      try {
        await store.create('message_sequence', record.ownerId, { next: maximum + 1 }, id);
        return;
      } catch (error) {
        if (error instanceof DomainError && error.code === 'conflict') continue;
        throw error;
      }
    }
    if (cursor.data.next > maximum) return;
    try {
      await store.put('message_sequence', id, record.ownerId, { next: maximum + 1 }, cursor.revision);
      return;
    } catch (error) {
      if (error instanceof DomainError && error.code === 'conflict') continue;
      throw error;
    }
  }
}

async function ensureConversation(store: Store, record: OutageReplayRecord): Promise<void> {
  const existing = await store.get<Conversation>('conversation', record.conversation.id, record.ownerId);
  if (existing) {
    if (existing.data.scope !== 'private' || existing.data.internalOperation) replayConflict();
    return;
  }
  const conversation: Conversation = {
    title: record.conversation.title,
    scope: 'private',
    modelPolicy: record.conversation.modelPolicy,
    strategy: record.conversation.strategy,
    mode: record.conversation.mode,
    ...(record.conversation.modelId ? { modelId: record.conversation.modelId } : {}),
    ...(record.conversation.workspaceId ? { workspaceId: record.conversation.workspaceId } : {}),
    ...(record.conversation.agentId ? { agentId: record.conversation.agentId } : {}),
    archived: false,
  };
  await createOrRead(store, 'conversation', record.conversation.id, record.ownerId, conversation);
}

async function ensureTask(store: Store, record: OutageReplayRecord): Promise<void> {
  const existing = await store.get<Task>('task', record.task.id, record.ownerId);
  if (existing) {
    if (!sameTask(existing.data, record)) replayConflict();
    return;
  }
  const task: Task = {
    conversationId: record.task.conversationId,
    ...(record.conversation.workspaceId ? { workspaceId: record.conversation.workspaceId } : {}),
    prompt: record.task.prompt,
    principal: record.principal,
    state: record.task.state,
    grantExpiresAt: record.principal.expiresAt ?? record.task.updatedAt,
    pendingActions: [],
    approvedActionHashes: [],
    ...(record.task.result !== undefined ? { result: record.task.result } : {}),
    ...(record.task.error !== undefined ? { error: record.task.error } : {}),
  };
  await createOrRead(store, 'task', record.task.id, record.ownerId, task);
}

async function ensureMessage(
  store: Store,
  record: OutageReplayRecord,
  message: OutageReplayRecord['messages'][number],
): Promise<void> {
  const data: Message = {
    conversationId: record.conversation.id,
    role: message.role,
    content: message.content,
    taskId: record.task.id,
    ...(message.sequence !== undefined ? { sequence: message.sequence } : {}),
  };
  const existing = await store.get<Message>('message', message.id, record.ownerId);
  if (existing) {
    if (!sameMessage(existing.data, data)) replayConflict();
    return;
  }
  await createOrRead(store, 'message', message.id, record.ownerId, data);
}

async function verifyReplay(store: Store, record: OutageReplayRecord): Promise<void> {
  const conversation = await store.get<Conversation>('conversation', record.conversation.id, record.ownerId);
  const task = await store.get<Task>('task', record.task.id, record.ownerId);
  if (!conversation || conversation.data.scope !== 'private' || !task || !sameTask(task.data, record)) {
    throw new DomainError('outage_replay_unconfirmed', 'NAS did not confirm the replayed conversation and task.', 503);
  }
  for (const message of record.messages) {
    const stored = await store.get<Message>('message', message.id, record.ownerId);
    if (!stored || !sameMessage(stored.data, {
      conversationId: record.conversation.id,
      role: message.role,
      content: message.content,
      taskId: record.task.id,
      ...(message.sequence !== undefined ? { sequence: message.sequence } : {}),
    })) {
      throw new DomainError('outage_replay_unconfirmed', 'NAS did not confirm every replayed message.', 503);
    }
  }
}

async function createOrRead<T>(store: Store, kind: string, id: string, ownerId: string, data: T): Promise<void> {
  try {
    await store.create(kind, ownerId, data, id);
  } catch (error) {
    if (!(error instanceof DomainError && error.code === 'conflict')) throw error;
    if (!await store.get(kind, id, ownerId)) throw error;
  }
}

function sameTask(task: Task, record: OutageReplayRecord): boolean {
  return task.conversationId === record.task.conversationId
    && (task.workspaceId === undefined || task.workspaceId === record.conversation.workspaceId)
    && task.prompt === record.task.prompt
    && task.state === record.task.state
    && task.result === record.task.result
    && task.error === record.task.error;
}

function sameMessage(left: Message, right: Message): boolean {
  return left.conversationId === right.conversationId
    && left.taskId === right.taskId
    && left.role === right.role
    && left.content === right.content
    && left.sequence === right.sequence;
}

function replayConflict(): never {
  throw new DomainError('outage_replay_conflict', 'NAS contains a different record with the same outage ID.', 409);
}
