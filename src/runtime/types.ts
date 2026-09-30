import type {
  ExecutionStrategy,
  ModelPolicy,
  Principal,
  RunMode,
  ToolDefinition,
  ToolContext,
  ToolResult,
  Workspace,
} from '../contracts.js';

export type ModelLocality = 'cloud' | 'local';
export type PrivacyLevel = 'standard' | 'private';
export type ChatRole = 'system' | 'user' | 'assistant' | 'tool';

export interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
  actionHash?: string;
}

export interface ChatAttachment {
  mimeType: string;
  data: string;
  artifactId?: string;
  ephemeral?: true;
}

export interface ChatMessage {
  role: ChatRole;
  content: string;
  attachments?: ChatAttachment[];
  name?: string;
  toolCallId?: string;
  toolCalls?: ToolCall[];
  actionHash?: string;
  toolOutcome?: 'confirmed' | 'failed' | 'unknown' | 'not_replayed';
}

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
}

export interface ChatRequest {
  model: ModelConfig;
  messages: ChatMessage[];
  tools: ToolDefinition[];
  signal: AbortSignal;
  maxOutputTokens?: number;
  context?: Pick<ToolContext, 'principal' | 'workspace' | 'taskId'>;
  onToken?: (token: string) => void | Promise<void>;
}

export interface ChatResponse {
  message: ChatMessage;
  usage: TokenUsage;
}

export interface ModelProvider {
  readonly id: string;
  readonly locality: ModelLocality;
  isAvailable?(model: ModelConfig, workspace: Workspace | undefined, signal: AbortSignal): Promise<boolean>;
  probeCapabilities?(model: ModelConfig, signal: AbortSignal): Promise<string[]>;
  chat(request: ChatRequest): Promise<ChatResponse>;
}

export interface ModelConfig {
  id: string;
  providerId: string;
  locality: ModelLocality;
  model?: string;
  deviceId?: string;
  capabilities: string[];
  capabilitiesVerified?: boolean;
  enabled?: boolean;
  priority?: number;
}

export interface AgentProfile {
  id?: string;
  systemPrompt?: string;
  strategy?: ExecutionStrategy;
  modelPolicy?: ModelPolicy;
  modelId?: string;
  experts?: Array<{ name: string; instruction: string }>;
  candidateCount?: number;
}

export interface RunBudgets {
  maxCalls?: number;
  maxTokens?: number;
}

export type RuntimeEvent =
  | { type: 'start'; taskId: string; strategy: ExecutionStrategy }
  | { type: 'model_call'; taskId: string; modelId: string; call: number; reservedTokens?: number }
  | { type: 'token'; taskId: string; content: string }
  | { type: 'tool_call'; taskId: string; toolCall: ToolCall }
  | { type: 'approval_required'; taskId: string; toolCall: ToolCall; actionHash?: string }
  | { type: 'tool_dispatched'; taskId: string; toolCall: ToolCall; actionHash: string; sideEffect: ToolDefinition['sideEffect'] }
  | { type: 'tool_result'; taskId: string; toolCallId: string; isError: boolean; outcome: 'confirmed' | 'failed' | 'unknown' | 'not_replayed'; actionHash?: string; sideEffect?: ToolDefinition['sideEffect']; result?: ToolResult; checkpointMessages?: ChatMessage[] }
  | { type: 'usage'; taskId: string; usage: RunUsage }
  | { type: 'candidate'; taskId: string; index: number; ok: boolean }
  | { type: 'final'; taskId: string; result: RunResult };

export interface RunInput {
  principal: Principal;
  workspace?: Workspace;
  taskId: string;
  prompt?: string;
  messages?: ChatMessage[];
  mode: RunMode;
  strategy?: ExecutionStrategy;
  modelPolicy?: ModelPolicy;
  modelId?: string;
  privacy?: PrivacyLevel;
  profile?: AgentProfile;
  budgets?: RunBudgets;
  maxOutputTokens?: number;
  priorUsage?: RunUsage;
  signal?: AbortSignal;
  onEvent?: (event: RuntimeEvent) => void | Promise<void>;
  requiredModelCapabilities?: string[];
  approvedActionHashes?: Set<string>;
  pluginVersions?: Record<string, string>;
  workspaceWriteLease?: ToolContext['workspaceWriteLease'];
  depth?: number;
  additionalTools?: ToolDefinition[];
}

export interface RunUsage extends TokenUsage {
  calls: number;
  totalTokens: number;
}

export interface RunResult {
  status: 'completed' | 'waiting_for_approval' | 'waiting_for_children';
  content: string;
  modelId: string;
  usage: RunUsage;
  strategy: ExecutionStrategy;
  messages: ChatMessage[];
  pendingActions?: PendingAction[];
  degraded?: boolean;
  candidates?: Array<{ content: string; modelId: string }>;
}

export interface PendingAction {
  toolCallId: string;
  toolName: string;
  input: Record<string, unknown>;
  actionHash?: string;
}

export interface RuntimeOptions {
  providers: ModelProvider[];
  models: ModelConfig[];
  tools?: ToolDefinition[];
  maxActiveRunsPerOwner?: number;
  maxDepth?: number;
}
