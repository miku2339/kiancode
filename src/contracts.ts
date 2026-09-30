export interface Principal {
  id: string;
  issuer?: string;
  subject?: string;
  level: 1 | 2 | 3 | 4 | 5;
  scopes: string[];
  applicationId?: string;
  audience?: string;
  credentialVersion?: number;
  expiresAt?: string;
}

export interface Workspace {
  id: string;
  ownerId: string;
  name: string;
  root: string;
  deviceId: string;
  capabilities: string[];
  allowCloud: boolean;
}

export type ModelPolicy = 'cloud' | 'local' | 'auto';
export type ExecutionStrategy = 'auto' | 'single' | 'experts' | 'moa';
export type RunMode = 'ask' | 'plan' | 'act';

export interface ToolContext {
  principal: Principal;
  workspace?: Workspace;
  taskId: string;
  signal: AbortSignal;
  approvedActionHashes?: Set<string>;
  pluginVersions?: Record<string, string>;
  workspaceWriteLease?: { id: string; epoch: number; holderId: string; expiresAt: string };
}

export interface ToolResult {
  content: string;
  isError?: boolean;
  artifacts?: Array<{ name: string; path: string; mimeType?: string; transient?: boolean; sha256?: string }>;
  artifactIds?: string[];
}

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  requiredCapabilities: string[];
  requiresWorkspace?: boolean;
  sideEffect: 'read' | 'write' | 'external';
  execute(input: Record<string, unknown>, context: ToolContext): Promise<ToolResult>;
}

export type ToolSpecification = Omit<ToolDefinition, 'execute'>;

export class DomainError extends Error {
  constructor(public code: string, message: string, public statusCode = 400) {
    super(message);
    this.name = 'DomainError';
  }
}
