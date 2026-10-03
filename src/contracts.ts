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

export interface DomainErrorOptions {
  notDispatched?: boolean;
}

export class DomainError extends Error {
  public readonly notDispatched: boolean;

  constructor(public code: string, message: string, public statusCode = 400, options: DomainErrorOptions = {}) {
    super(message);
    this.name = 'DomainError';
    this.notDispatched = options.notDispatched === true;
  }
}

export function notDispatched(code: string, message: string, statusCode = 400): DomainError {
  return new DomainError(code, message, statusCode, { notDispatched: true });
}

export function asNotDispatched(error: unknown, code: string, statusCode = 400): DomainError {
  if (error instanceof DomainError) {
    return error.notDispatched
      ? error
      : new DomainError(error.code, error.message, error.statusCode, { notDispatched: true });
  }
  return new DomainError(code, error instanceof Error ? error.message : String(error), statusCode, {
    notDispatched: true,
  });
}

export function isNotDispatched(error: unknown): error is DomainError {
  return error instanceof DomainError && error.notDispatched;
}
