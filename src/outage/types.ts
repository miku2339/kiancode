import type { ExecutionStrategy, ModelPolicy, Principal, RunMode } from '../contracts.js';

export interface OutageMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  createdAt: string;
  sequence?: number;
}

export interface OutageConversation {
  id: string;
  ownerId: string;
  title: string;
  scope: 'private';
  modelPolicy: ModelPolicy;
  strategy: ExecutionStrategy;
  mode: RunMode;
  modelId?: string;
  workspaceId?: string;
  agentId?: string;
  privacy: 'standard' | 'private';
  workspaceAllowCloud?: boolean;
  archived: false;
}

export interface OutageContext {
  principal: Principal;
  tokenHash: string;
  sessionExpiresAt: string;
  conversation: OutageConversation;
  history: OutageMessage[];
  cachedAt?: string;
}

export interface SimpleChatInput {
  taskId: string;
  principal: Principal;
  conversation: OutageConversation;
  history: OutageMessage[];
  prompt: string;
  signal: AbortSignal;
  mode: 'ask';
  strategy: 'single';
  modelPolicy: ModelPolicy;
  modelId?: string;
  privacy: 'standard' | 'private';
  workspaceAllowCloud?: boolean;
  tools: [];
  maxOutputBytes: number;
}

export type SimpleChat = (input: SimpleChatInput) => Promise<{ content: string }>;

export type OutageTaskState = 'queued' | 'waiting_for_device' | 'completed' | 'failed';

export interface OutageTask {
  id: string;
  ownerId: string;
  conversation: OutageConversation;
  principal: Principal;
  history: OutageMessage[];
  prompt: string;
  requestId?: string;
  state: OutageTaskState;
  degraded: true;
  result?: string;
  error?: string;
  createdAt: string;
  updatedAt: string;
  userMessage: OutageMessage;
  assistantMessage?: OutageMessage;
  reservedBytes: number;
}

export interface OutageRunInput {
  token: string;
  conversationId: string;
  prompt: string;
  requestId?: string;
  signal?: AbortSignal;
}

export interface OutageRunResult {
  id: string;
  createdAt: string;
  updatedAt: string;
  conversationId: string;
  workspaceId?: string;
  state: OutageTaskState;
  degraded: true;
  result?: string;
  error?: string;
}

export interface OutageConversationResult {
  conversation: OutageConversation;
  degraded: true;
}

export interface OutageReplayRecord {
  recordId: string;
  ownerId: string;
  principal: Principal;
  task: {
    id: string;
    conversationId: string;
    state: 'completed' | 'failed';
    prompt: string;
    requestId?: string;
    result?: string;
    error?: string;
    degraded: true;
    createdAt: string;
    updatedAt: string;
  };
  conversation: OutageConversation;
  messages: OutageMessage[];
}

export interface OutageReplayAck {
  recordId: string;
  durable: true;
  deduplicated: true;
}

export interface OutageReplaySink {
  replay(record: OutageReplayRecord): Promise<OutageReplayAck>;
}

export interface OutageStats {
  bytesUsed: number;
  maxBytes: number;
  unsyncedRecords: number;
  firstUnsyncedAt?: string;
  accepting: boolean;
}
