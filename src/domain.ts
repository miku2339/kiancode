import type { ExecutionStrategy, ModelPolicy, Principal, RunMode } from './contracts.js';

export interface Conversation {
  title: string;
  scope: 'private' | 'group';
  modelPolicy: ModelPolicy;
  strategy: ExecutionStrategy;
  mode: RunMode;
  modelId?: string;
  workspaceId?: string;
  agentId?: string;
  archived: boolean;
  internalOperation?: { tool: string; input: Record<string, unknown> };
}

export interface Message {
  conversationId: string;
  role: 'user' | 'assistant';
  content: string;
  taskId: string;
  sequence?: number;
  attachmentIds?: string[];
}

export type TaskState = 'queued' | 'running' | 'waiting_for_device' | 'waiting_for_approval' | 'waiting_for_children' | 'paused' | 'completed' | 'failed' | 'cancelled' | 'unknown';

export type NotificationDestination =
  | { type: 'none' }
  | { type: 'in_app' }
  | { type: 'push'; subscriptionId: string }
  | { type: 'channel'; destinationId: string };

export interface TaskOrchestration {
  rootTaskId: string;
  parentTaskId?: string;
  planId: string;
  depth: number;
  role: 'parent' | 'child';
  strategy: 'single' | 'experts' | 'moa';
  childKey?: string;
  profileId?: string;
  budgetId: string;
  phase: 'children' | 'integration';
  verification: 'pending' | 'passed' | 'failed';
}

export interface PendingAction { hash: string; tool: string; input: Record<string, unknown>; toolOccurrenceId?: string }

export type TaskReconciliationResolution = 'applied' | 'not_applied' | 'abandon';

export interface TaskReconciliationRecord {
  phase: 'pending' | 'complete';
  resolution: TaskReconciliationResolution;
  dispatchSequence?: number;
  receiptId: string;
  toolCallId?: string;
  toolOccurrenceId?: string;
  actionHash?: string;
  toolName?: string;
  sideEffect?: 'write' | 'external';
  note?: string;
  actor: Pick<Principal, 'id' | 'level' | 'applicationId' | 'issuer' | 'subject'>;
  acceptedAt: string;
  targetState: TaskState;
  resumePrincipal: Principal;
  grantExpiresAt: string;
}

export interface TaskReconciliationRestoration {
  receiptId: string;
  childTaskId: string;
  resolution: TaskReconciliationResolution;
}

export interface AccountTaskGrant {
  issuer: string;
  subject: string;
  applicationId: string;
  audience: string;
  credentialVersion: number;
  consentVersion: number;
  scopes: string[];
  rootTaskId: string;
  delegationExpiresAt?: string;
}

export interface Task {
  conversationId: string;
  workspaceId?: string;
  prompt: string;
  principal: Principal;
  state: TaskState;
  grantExpiresAt: string;
  workerId?: string;
  leaseExpiresAt?: string;
  nextAttemptAt?: string;
  cancelRequested?: boolean;
  pauseRequested?: boolean;
  result?: string;
  error?: string;
  pendingActions: PendingAction[];
  approvedActionHashes: string[];
  runtimeMessages?: unknown[];
  usage?: unknown;
  attachmentIds?: string[];
  resultArtifactIds?: string[];
  pluginVersions?: Record<string, string>;
  dependencyIds?: string[];
  notificationDestination?: NotificationDestination;
  orchestration?: TaskOrchestration;
  accountTaskGrant?: AccountTaskGrant;
  authorizationKind?: 'account_automation';
  automationSource?: { type: 'schedule' | 'event_trigger'; id: string; version: number };
  reconciliation?: TaskReconciliationRecord;
  reconciliationRestoration?: TaskReconciliationRestoration;
}

export interface TaskEvent {
  taskId: string;
  sequence: number;
  type: string;
  payload: unknown;
  at: string;
}

export interface Memory {
  type: 'persona' | 'preference' | 'episode' | 'project' | 'agent' | 'document';
  text: string;
  scope: 'private' | 'group' | 'workspace' | 'agent';
  scopeId?: string;
  source: string;
  provenance?: Record<string, unknown>;
  validFrom: string;
  validTo?: string;
  replacesId?: string;
  reviewStatus?: 'approved' | 'held' | 'rejected';
  reviewReason?: string;
  reviewedAt?: string;
  reviewedBy?: string;
}

export interface Schedule {
  conversationId: string;
  prompt: string;
  intervalSeconds?: number;
  nextAt: string;
  enabled: boolean;
  principal: Principal;
  lastTaskId?: string;
  pendingOccurrence?: { at: string; taskId: string };
  authorizationFailedAt?: string;
}

export interface QuietHours {
  start: string;
  end: string;
}

export interface NotificationPreferences {
  timezone: string;
  quietHours: QuietHours | null;
}

export type NotificationType =
  | 'task_completed'
  | 'task_failed'
  | 'task_unknown'
  | 'approval_required'
  | 'schedule_authorization_failed'
  | 'important_change';

export interface Notification {
  type: NotificationType;
  title: string;
  body: string;
  dedupeKey: string;
  occurredAt: string;
  deliverAfter: string;
  silent: boolean;
  read: boolean;
  pushEligible: boolean;
  targetSubscriptionId?: string;
  targetChannelDestinationId?: string;
  taskId?: string;
  conversationId?: string;
  scheduleId?: string;
  eventTriggerId?: string;
}

export interface NotificationChannelDestination {
  channel: string;
  chatId: string;
  status: 'active' | 'revoked';
  activatedAt: string;
  updatedAt: string;
  revokedAt?: string;
  revokeReason?: string;
}

export interface PushSubscription {
  deviceId: string;
  platform: 'apns';
  environment: 'development' | 'production';
  topic: string;
  token: string;
  tokenHash: string;
  status: 'active' | 'revoked';
  activatedAt: string;
  updatedAt: string;
  revokedAt?: string;
  revokeReason?: string;
}
