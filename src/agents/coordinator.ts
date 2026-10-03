import { createHash } from 'node:crypto';
import path from 'node:path';
import { DomainError, type ExecutionStrategy, type Principal } from '../contracts.js';
import type { Conversation, Message, Task, TaskEvent, TaskOrchestration, TaskState } from '../domain.js';
import type { AgentProfile, RunUsage } from '../runtime/index.js';
import type { Entity, Store } from '../storage/store.js';
import { BudgetLedger, type BudgetLimits } from './budget-ledger.js';

export type ChildStrategy = Extract<ExecutionStrategy, 'single' | 'experts' | 'moa'>;
export type ChildControl = (
  ownerId: string,
  taskId: string,
  action: 'pause' | 'resume' | 'cancel',
  actor?: Principal,
) => Promise<unknown>;

export interface ChildSpec {
  key: string;
  prompt: string;
  profileId?: string;
  scopes?: string[];
  level?: Principal['level'];
  grantExpiresAt?: string;
}

export interface PrepareChildrenRequest {
  key: string;
  strategy?: ChildStrategy;
  children: ChildSpec[];
  budget?: BudgetLimits;
}

export interface OrchestrationPlan {
  parentTaskId: string;
  rootTaskId: string;
  strategy: ChildStrategy;
  childIds: string[];
  budgetId: string;
  state: 'preparing' | 'waiting' | 'integrating' | 'completed' | 'cancelled' | 'paused';
  fingerprint: string;
  aggregationClaimed: boolean;
  parentTransition?: 'coordinator' | 'runner';
  integrationBoundary?: { parentEventSequence: number };
  verification?: { at: string; evidence: string };
}

export interface PrepareChildrenOptions {
  parentTransition?: 'coordinator' | 'runner';
  parentRuntimeUsage?: RunUsage | { calls: number; totalTokens: number; accountedTokens?: number };
}

export interface ChildResult {
  id: string;
  key: string;
  state: TaskState;
  result?: string;
  error?: string;
  attachmentIds: string[];
}

export interface OrchestrationResults {
  plan: Entity<OrchestrationPlan>;
  children: ChildResult[];
  ready: boolean;
  successful: boolean;
  aggregateRequired: boolean;
  verificationRequired: boolean;
}

export interface ChildWorkspaceChange {
  path?: string;
  tool: string;
  actionHash: string;
  at: string;
}

export interface ChildExternalAction {
  taskId: string;
  tool: string;
  actionHash: string;
  arguments: Record<string, unknown>;
  confirmation?: 'owner_reconciled';
  confirmationActor?: Record<string, unknown>;
  approval?: 'missing';
}

export interface ChildSideEffects {
  changes: ChildWorkspaceChange[];
  externalActions: ChildExternalAction[];
}

interface ChildSlots {
  children: Record<string, { planId: string; reservedAt: string }>;
}

interface ParentPlanClaim {
  parentTaskId: string;
  planId: string;
  fingerprint: string;
  generation: number;
  claimedAt: string;
}

interface EventSequence {
  next: number;
}

interface PreparedChildren {
  parentConversation: Entity<Conversation>;
  depth: number;
  children: Array<{
    spec: ChildSpec;
    principal: Principal;
    grantExpiresAt: string;
    authorizationKind?: Task['authorizationKind'];
    automationSource?: Task['automationSource'];
  }>;
}

interface ConfirmedAction {
  taskId: string;
  actionHash: string;
  tool: string;
  arguments: Record<string, unknown>;
  sideEffect?: string;
  result?: unknown;
  at: string;
  dispatchSequence: number;
  resultSequence: number;
  reconciled: boolean;
  reconciliationActor?: Record<string, unknown>;
}

const terminalStates = new Set<TaskState>(['completed', 'failed', 'cancelled', 'unknown']);
const terminalPlanStates = new Set<OrchestrationPlan['state']>(['completed', 'cancelled']);
const planKeyPattern = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/;
const workspaceMutationTools = new Set(['workspace.write', 'workspace.patch', 'workspace.restore']);

function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left.localeCompare(right));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function scopeCovered(parent: string[], requested: string): boolean {
  return parent.some((scope) => scope === '*'
    || scope === 'kiancode:*'
    || scope === requested
    || scope === `${requested.split(':')[0]}:*`);
}

function confirmedActions(
  events: Array<Entity<TaskEvent>>,
  include: (event: Entity<TaskEvent>) => boolean,
): ConfirmedAction[] {
  const dispatched = new Map<string, ConfirmedAction>();
  const confirmed: ConfirmedAction[] = [];
  for (const event of events.filter(include).sort((left, right) => left.data.taskId.localeCompare(right.data.taskId)
    || left.data.sequence - right.data.sequence)) {
    const payload = event.data.payload as {
      actionHash?: string;
      toolCallId?: string;
      toolCall?: { id?: string; name?: string; arguments?: Record<string, unknown> };
      sideEffect?: string;
      outcome?: string;
      isError?: boolean;
      result?: unknown;
      reconciled?: string;
      actor?: unknown;
    };
    const actionKey = payload.actionHash ?? payload.toolCallId ?? payload.toolCall?.id;
    if (!actionKey) continue;
    const key = `${event.data.taskId}\0${actionKey}`;
    if (event.data.type === 'tool_dispatched' && payload.toolCall?.name) {
      dispatched.set(key, {
        taskId: event.data.taskId,
        actionHash: actionKey,
        tool: payload.toolCall.name,
        arguments: payload.toolCall.arguments ?? {},
        sideEffect: payload.sideEffect,
        at: event.data.at,
        dispatchSequence: event.data.sequence,
        resultSequence: event.data.sequence,
        reconciled: false,
      });
    } else if (event.data.type === 'tool_result' && payload.outcome === 'confirmed' && !payload.isError) {
      const action = dispatched.get(key);
      if (action) confirmed.push({
        ...action,
        result: payload.result,
        at: event.data.at,
        resultSequence: event.data.sequence,
        reconciled: payload.reconciled === 'applied',
        ...(payload.reconciled === 'applied' && payload.actor && typeof payload.actor === 'object'
          ? { reconciliationActor: payload.actor as Record<string, unknown> }
          : {}),
      });
    }
  }
  return confirmed;
}

function normalizedWorkspacePath(value: unknown): string | undefined {
  if (typeof value !== 'string' || !value.trim()) return undefined;
  const normalized = path.posix.normalize(value.trim().replaceAll('\\', '/'));
  if (normalized === '.' || normalized === '..' || normalized.startsWith('../') || path.posix.isAbsolute(normalized)) return undefined;
  return normalized;
}

function resultPath(result: unknown): string | undefined {
  if (!result || typeof result !== 'object') return undefined;
  const content = (result as { content?: unknown }).content;
  if (typeof content !== 'string') return undefined;
  try {
    const parsed = JSON.parse(content) as { path?: unknown; restored?: unknown };
    return normalizedWorkspacePath(parsed.path) ?? normalizedWorkspacePath(parsed.restored);
  } catch {
    return undefined;
  }
}

function changedWorkspacePath(action: ConfirmedAction): string | undefined {
  if (action.tool === 'workspace.write') return normalizedWorkspacePath(action.arguments.path) ?? resultPath(action.result);
  if (action.tool === 'workspace.patch' || action.tool === 'workspace.restore') return resultPath(action.result);
  return undefined;
}

function parsedResult(action: ConfirmedAction): Record<string, unknown> | undefined {
  if (!action.result || typeof action.result !== 'object') return undefined;
  const content = (action.result as { content?: unknown }).content;
  if (typeof content !== 'string') return undefined;
  try {
    const parsed = JSON.parse(content) as unknown;
    return parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : undefined;
  } catch {
    return undefined;
  }
}

function safeCommandSegments(command: string): string[] | undefined {
  const trimmed = command.trim();
  if (!trimmed || trimmed.includes('\n') || trimmed.includes('\r')) return undefined;
  const withoutRedirections = trimmed.replace(/\b\d*>&\d+\b/g, '');
  if (/[;|`$<>]/.test(withoutRedirections)) return undefined;
  const segments = withoutRedirections.split('&&').map((segment) => segment.trim());
  if (segments.some((segment) => !segment || segment.includes('&'))) return undefined;
  return segments;
}

function successfulTerminalAction(action: ConfirmedAction): boolean {
  if (action.tool !== 'terminal.run' || action.reconciled || typeof action.arguments.command !== 'string') return false;
  const cwd = action.arguments.cwd;
  if (cwd !== undefined && (typeof cwd !== 'string'
    || path.posix.normalize(cwd.trim().replaceAll('\\', '/')) !== '.')) return false;
  const result = parsedResult(action);
  return result?.exitCode === 0
    && (result.signal === undefined || result.signal === null)
    && result.timedOut !== true
    && result.aborted !== true;
}

const environmentPrefix = '(?:[A-Za-z_][A-Za-z0-9_]*=[^\\s;&|`$()]+\\s+)*';
const testRunnerCommand = new RegExp(`^${environmentPrefix}(?:npm\\s+(?:test|run\\s+test(?::[A-Za-z0-9._-]+)?)|swift\\s+test|pytest|cargo\\s+test)$`);

function runsWorkspaceTests(action: ConfirmedAction): boolean {
  if (!successfulTerminalAction(action)) return false;
  const segments = safeCommandSegments(action.arguments.command as string);
  return segments !== undefined && segments.every((segment) => testRunnerCommand.test(segment));
}

function verifiesWorkspacePath(action: ConfirmedAction, resource: string): boolean {
  if (action.tool === 'workspace.read') {
    const result = parsedResult(action);
    return normalizedWorkspacePath(action.arguments.path) === resource
      && normalizedWorkspacePath(result?.path) === resource
      && typeof result?.sha256 === 'string'
      && /^[a-f0-9]{64}$/.test(result.sha256);
  }
  return false;
}

function verifiesChange(check: ConfirmedAction, change: ChildWorkspaceChange): boolean {
  return runsWorkspaceTests(check) || (change.path !== undefined && verifiesWorkspacePath(check, change.path));
}

function verificationFailureMessage(missing: ChildWorkspaceChange[]): string {
  const labels = missing.map(childChangeLabel);
  const more = labels.length > 20 ? ` and ${labels.length - 20} more` : '';
  return `Delegated work is unverified. Before its final answer the parent must read each child-changed workspace path with workspace.read or run a passing test command in the workspace. Not verified: ${labels.slice(0, 20).join(', ')}${more}`.slice(0, 2_000);
}

function collectChildSideEffects(
  events: Array<Entity<TaskEvent>>,
  childIds: string[],
  approvedActionHashes: Map<string, Set<string>>,
): ChildSideEffects {
  const children = new Set(childIds);
  const changes = new Map<string, { change: ChildWorkspaceChange; taskId: string; sequence: number }>();
  const externalActions: ChildExternalAction[] = [];
  for (const action of confirmedActions(events, (event) => children.has(event.data.taskId))) {
    if (action.sideEffect !== 'write' && action.sideEffect !== 'external') continue;
    if (!workspaceMutationTools.has(action.tool)) {
      externalActions.push({
        taskId: action.taskId,
        tool: action.tool,
        actionHash: action.actionHash,
        arguments: action.arguments,
        ...(action.reconciled ? { confirmation: 'owner_reconciled' as const } : {}),
        ...(action.reconciliationActor ? { confirmationActor: action.reconciliationActor } : {}),
        ...(!approvedActionHashes.get(action.taskId)?.has(action.actionHash) ? { approval: 'missing' as const } : {}),
      });
      continue;
    }
    const resource = changedWorkspacePath(action);
    const key = resource ?? `\0${action.actionHash}`;
    const previous = changes.get(key);
    if (previous && (previous.taskId !== action.taskId || previous.sequence > action.resultSequence)) continue;
    changes.set(key, {
      change: {
        ...(resource ? { path: resource } : {}),
        tool: action.tool,
        actionHash: action.actionHash,
        at: action.at,
      },
      taskId: action.taskId,
      sequence: action.resultSequence,
    });
  }
  return {
    changes: [...changes.values()].map(({ change }) => change)
      .sort((left, right) => childChangeLabel(left).localeCompare(childChangeLabel(right))),
    externalActions,
  };
}

export function childChangeLabel(change: ChildWorkspaceChange): string {
  return change.path ?? `${change.tool} (path not reported)`;
}

function tasksWithUnresolvedSideEffects(events: Array<Entity<TaskEvent>>, taskIds: string[]): Set<string> {
  const tasks = new Set(taskIds);
  const unresolved = new Map<string, Array<{
    toolCallId?: string;
    toolOccurrenceId?: string;
    actionHash?: string;
  }>>();
  for (const event of events
    .filter((candidate) => tasks.has(candidate.data.taskId))
    .sort((left, right) => left.data.taskId.localeCompare(right.data.taskId)
      || left.data.sequence - right.data.sequence)) {
    const payload = event.data.payload as {
      toolCallId?: string;
      toolOccurrenceId?: string;
      actionHash?: string;
      sideEffect?: string;
      outcome?: string;
      toolCall?: { id?: string; occurrenceId?: string };
    };
    const pending = unresolved.get(event.data.taskId) ?? [];
    if (event.data.type === 'tool_dispatched'
      && (payload.sideEffect === 'write' || payload.sideEffect === 'external')) {
      pending.push({
        ...(payload.toolCallId ?? payload.toolCall?.id ? { toolCallId: payload.toolCallId ?? payload.toolCall?.id } : {}),
        ...(payload.toolOccurrenceId ?? payload.toolCall?.occurrenceId
          ? { toolOccurrenceId: payload.toolOccurrenceId ?? payload.toolCall?.occurrenceId }
          : {}),
        ...(payload.actionHash ? { actionHash: payload.actionHash } : {}),
      });
      unresolved.set(event.data.taskId, pending);
      continue;
    }
    if (event.data.type !== 'tool_result'
      || !['confirmed', 'failed', 'not_replayed'].includes(payload.outcome ?? '')) continue;
    const occurrence = payload.toolOccurrenceId ?? payload.toolCall?.occurrenceId;
    const rawId = payload.toolCallId ?? payload.toolCall?.id;
    const index = [...pending].reverse().findIndex((dispatch) => occurrence
      ? dispatch.toolOccurrenceId === occurrence
      : rawId
        ? !dispatch.toolOccurrenceId && dispatch.toolCallId === rawId
          && (payload.actionHash === undefined || dispatch.actionHash === payload.actionHash)
        : payload.actionHash !== undefined && dispatch.actionHash === payload.actionHash);
    if (index >= 0) pending.splice(pending.length - index - 1, 1);
  }
  return new Set([...unresolved.entries()].filter(([, pending]) => pending.length > 0).map(([taskId]) => taskId));
}

function validateRequest(request: PrepareChildrenRequest): ChildStrategy {
  if (!planKeyPattern.test(request.key)) {
    throw new DomainError('invalid_orchestration_key', 'Orchestration key must be stable and contain at most 128 safe characters');
  }
  const strategy = request.strategy ?? 'single';
  const maximum = strategy === 'single' ? 1 : strategy === 'experts' ? 2 : 3;
  if (request.children.length < 1 || request.children.length > maximum) {
    throw new DomainError('invalid_child_count', `${strategy} requires 1 to ${maximum} child tasks`);
  }
  const keys = new Set<string>();
  for (const child of request.children) {
    if (!planKeyPattern.test(child.key) || keys.has(child.key)) {
      throw new DomainError('invalid_child_key', 'Child keys must be unique, stable, and contain at most 128 safe characters');
    }
    if (!child.prompt.trim() || child.prompt.length > 64_000) {
      throw new DomainError('invalid_prompt', 'Child prompt must contain 1 to 64000 characters');
    }
    if (child.profileId !== undefined
      && (typeof child.profileId !== 'string' || !child.profileId || child.profileId.length > 128)) {
      throw new DomainError('invalid_profile', 'Agent profile ID must contain 1 to 128 characters');
    }
    keys.add(child.key);
  }
  return strategy;
}

export class AgentCoordinator {
  public readonly budgets: BudgetLedger;

  public constructor(
    private readonly store: Store,
    private readonly controlTask?: ChildControl,
    private readonly now: () => number = Date.now,
  ) {
    this.budgets = new BudgetLedger(store);
  }

  public async prepare(
    ownerId: string,
    parentTaskId: string,
    request: PrepareChildrenRequest,
    options: PrepareChildrenOptions = {},
  ): Promise<Entity<OrchestrationPlan>> {
    const strategy = validateRequest(request);
    const parent = await this.requireTask(ownerId, parentTaskId);
    const parentDepth = parent.data.orchestration?.depth ?? 0;
    if (parentDepth >= 2) throw new DomainError('max_agent_depth', 'Agent child depth cannot exceed 2', 409);
    const rootTaskId = parent.data.orchestration?.rootTaskId ?? parent.id;
    const planId = digest(`${ownerId}\0${parent.id}\0${request.key}`);
    const childIds = request.children.map((child) => digest(`${ownerId}\0${planId}\0${child.key}`));
    const fingerprint = digest(canonical({
      strategy,
      children: request.children.map((child) => ({ ...child, scopes: child.scopes ? [...new Set(child.scopes)].sort() : undefined })),
      budget: request.budget,
      ...(options.parentTransition === 'runner' ? { parentTransition: 'runner' } : {}),
    }));
    const inheritedBudgetId = parent.data.orchestration?.budgetId;
    const budgetId = inheritedBudgetId ?? digest(`${ownerId}\0${rootTaskId}\0budget`);
    let plan = await this.store.get<OrchestrationPlan>('agent_plan', planId, ownerId);
    if (plan) {
      if (plan.data.fingerprint !== fingerprint) {
        throw new DomainError('idempotency_conflict', 'Orchestration key belongs to another child plan', 409);
      }
      if (terminalPlanStates.has(plan.data.state)) return plan;
      if (terminalStates.has(parent.data.state)) {
        throw new DomainError('terminal_task', 'A stopped task cannot create children', 409);
      }
      let prepared: PreparedChildren | undefined;
      if (plan.data.state === 'preparing') {
        prepared = await this.prepareChildren(parent, request);
      }
      await this.claimParentPlan(ownerId, parent.id, planId, fingerprint);
      await this.adoptParentUsage(ownerId, plan.data.budgetId, parent.id, options.parentRuntimeUsage);
      if (prepared) {
        plan = await this.finishPreparation(plan, parent, strategy, prepared);
      }
      return plan;
    }
    if (terminalStates.has(parent.data.state)) {
      throw new DomainError('terminal_task', 'A stopped task cannot create children', 409);
    }
    const prepared = await this.prepareChildren(parent, request);
    if (await this.hasOtherUnfinishedPlan(ownerId, parent.id, planId)
      || await this.hasConflictingParentClaim(ownerId, parent.id, planId)) {
      throw new DomainError('active_child_plan', 'Parent task already has an unfinished child plan', 409);
    }
    const newBudget = inheritedBudgetId ? undefined : request.budget;
    if (inheritedBudgetId) {
      if (request.budget) throw new DomainError('budget_expansion', 'Nested agents must use the parent shared budget', 409);
      await this.budgets.get(ownerId, inheritedBudgetId);
    } else {
      if (!newBudget) throw new DomainError('budget_required', 'Root orchestration requires explicit shared budget limits');
    }
    if (newBudget) {
      await this.budgets.create(ownerId, budgetId, rootTaskId, newBudget);
    }
    await this.adoptParentUsage(ownerId, budgetId, parent.id, options.parentRuntimeUsage);
    await this.claimParentPlan(ownerId, parent.id, planId, fingerprint);
    const data: OrchestrationPlan = {
      parentTaskId: parent.id,
      rootTaskId,
      strategy,
      childIds,
      budgetId,
      state: 'preparing',
      fingerprint,
      aggregationClaimed: false,
      ...(options.parentTransition === 'runner' ? { parentTransition: 'runner' } : {}),
    };
    try {
      plan = await this.store.create('agent_plan', ownerId, data, planId);
    } catch (error) {
      if (error instanceof DomainError && error.code === 'conflict') {
        return this.prepare(ownerId, parentTaskId, request, options);
      }
      throw error;
    }
    return this.finishPreparation(plan, parent, strategy, prepared);
  }

  public async runChildren(ownerId: string, planId: string): Promise<Array<Entity<Task>>> {
    const plan = await this.requirePlan(ownerId, planId);
    if (!['waiting', 'integrating'].includes(plan.data.state)) {
      throw new DomainError('plan_not_runnable', 'Child plan is not ready', 409);
    }
    return Promise.all(plan.data.childIds.map((id) => this.requireTask(ownerId, id)));
  }

  public async results(ownerId: string, planId: string): Promise<OrchestrationResults> {
    const plan = await this.requirePlan(ownerId, planId);
    const tasks = await Promise.all(plan.data.childIds.map((id) => this.requireTask(ownerId, id)));
    const events = await this.store.scan<TaskEvent>('event', ownerId);
    const unresolved = tasksWithUnresolvedSideEffects(events, plan.data.childIds);
    await this.cleanSlots(ownerId);
    const children = tasks.map((task): ChildResult => ({
      id: task.id,
      key: task.data.orchestration?.childKey ?? task.id,
      state: task.data.state,
      result: task.data.result,
      error: task.data.error,
      attachmentIds: task.data.attachmentIds ?? [],
    }));
    const ready = tasks.every((task) => task.data.reconciliation?.phase !== 'pending'
      && !(task.data.reconciliation?.phase === 'complete' && unresolved.has(task.id)))
      && children.every((child) => terminalStates.has(child.state));
    const successful = ready
      && children.every((child) => child.state === 'completed')
      && tasks.every((task) => !unresolved.has(task.id));
    return {
      plan,
      children,
      ready,
      successful,
      aggregateRequired: ready && plan.data.strategy === 'moa',
      verificationRequired: plan.data.state !== 'completed',
    };
  }

  public async wait(
    ownerId: string,
    planId: string,
    options: { signal?: AbortSignal; pollMs?: number } = {},
  ): Promise<OrchestrationResults> {
    const pollMs = options.pollMs ?? 100;
    if (!Number.isSafeInteger(pollMs) || pollMs < 10 || pollMs > 10_000) {
      throw new DomainError('invalid_poll_interval', 'pollMs must be from 10 to 10000');
    }
    while (true) {
      options.signal?.throwIfAborted();
      const result = await this.results(ownerId, planId);
      if (result.ready) return result;
      await new Promise<void>((resolve, reject) => {
        const finish = (): void => {
          options.signal?.removeEventListener('abort', onAbort);
          resolve();
        };
        const timer = setTimeout(finish, pollMs);
        const onAbort = (): void => {
          clearTimeout(timer);
          reject(options.signal?.reason);
        };
        options.signal?.addEventListener('abort', onAbort, { once: true });
      });
    }
  }

  public async queueIntegration(ownerId: string, planId: string): Promise<Entity<Task>> {
    let plan = await this.requirePlan(ownerId, planId);
    const outcome = await this.results(ownerId, planId);
    if (!outcome.ready) throw new DomainError('children_running', 'Child tasks have not finished', 409);
    if (!outcome.successful) throw new DomainError('child_failed', 'All children must complete before parent integration', 409);
    const parent = await this.requireTask(ownerId, plan.data.parentTaskId);
    if (['completed', 'cancelled'].includes(plan.data.state)) {
      throw new DomainError('plan_not_runnable', 'Child plan has already stopped', 409);
    }
    if (!['waiting', 'integrating'].includes(plan.data.state)) {
      throw new DomainError('plan_not_runnable', 'Child plan is not ready for integration', 409);
    }
    const sameChildrenPhase = parent.data.orchestration?.planId === plan.id
      && parent.data.orchestration.phase === 'children';
    const canCreateBoundary = sameChildrenPhase && (parent.data.state === 'waiting_for_children'
      || (plan.data.parentTransition === 'runner' && parent.data.state === 'running'));
    if (!plan.data.integrationBoundary && !canCreateBoundary) {
      throw new DomainError('integration_incomplete', 'Legacy integration has no safe event boundary and must be checked again', 409);
    }
    const parentEvents = (await this.store.scan<TaskEvent>('event', ownerId))
      .filter((event) => event.data.taskId === plan.data.parentTaskId);
    const cursor = await this.store.get<EventSequence>('event_sequence', plan.data.parentTaskId, ownerId);
    const parentEventSequence = Math.max(
      0,
      cursor ? cursor.data.next - 1 : 0,
      ...parentEvents.map((event) => event.data.sequence),
    );
    plan = await this.changePlan(ownerId, plan.id, (current) => {
      if (current.state === 'completed' || current.state === 'cancelled') {
        throw new DomainError('plan_not_runnable', 'Child plan has already stopped', 409);
      }
      if (!current.integrationBoundary && !canCreateBoundary) {
        throw new DomainError('integration_incomplete', 'Legacy integration has no safe event boundary and must be checked again', 409);
      }
      if (current.state !== 'waiting' && current.state !== 'integrating') {
        throw new DomainError('plan_not_runnable', 'Child plan is not ready for integration', 409);
      }
      return {
        ...current,
        state: 'integrating',
        aggregationClaimed: current.aggregationClaimed || current.strategy === 'moa',
        integrationBoundary: current.integrationBoundary ?? { parentEventSequence },
      };
    });
    return this.changeTask(ownerId, plan.data.parentTaskId, (task) => {
      if (task.state === 'running') {
        if (parent.data.state === 'running' && task.workerId !== parent.data.workerId) {
          throw new DomainError('integration_incomplete', 'Parent execution changed before integration could be queued', 409);
        }
        if (task.orchestration?.planId !== plan.id) {
          throw new DomainError('integration_incomplete', 'Parent orchestration no longer matches the child plan', 409);
        }
        return task.orchestration.phase === 'integration'
          ? task
          : { ...task, orchestration: { ...task.orchestration, phase: 'integration', verification: 'pending' } };
      }
      if (task.state === 'queued') {
        if (task.orchestration?.planId !== plan.id) {
          throw new DomainError('integration_incomplete', 'Parent orchestration no longer matches the child plan', 409);
        }
        return task.orchestration.phase === 'integration'
          ? task
          : { ...task, orchestration: { ...task.orchestration, phase: 'integration', verification: 'pending' } };
      }
      if (task.state === 'completed') throw new DomainError('terminal_task', 'Parent task already stopped', 409);
      if (terminalStates.has(task.state)) throw new DomainError('terminal_task', 'Parent task already stopped', 409);
      if (task.state !== 'waiting_for_children') {
        throw new DomainError('parent_not_waiting', 'Parent task is not waiting for child results', 409);
      }
      return {
        ...task,
        state: 'queued',
        workerId: undefined,
        leaseExpiresAt: undefined,
        orchestration: task.orchestration ? {
          ...task.orchestration,
          phase: 'integration',
          verification: 'pending',
        } : task.orchestration,
      };
    });
  }

  public async childSideEffects(ownerId: string, planId: string): Promise<ChildSideEffects> {
    const plan = await this.requirePlan(ownerId, planId);
    const tasks = await Promise.all(plan.data.childIds.map((childId) => this.requireTask(ownerId, childId)));
    const approved = new Map(tasks.map((task) => [task.id, new Set(task.data.approvedActionHashes)]));
    return collectChildSideEffects(await this.store.scan<TaskEvent>('event', ownerId), plan.data.childIds, approved);
  }

  public async verifyIntegration(ownerId: string, planId: string, _claimedEvidence?: string): Promise<Entity<OrchestrationPlan>> {
    const plan = await this.requirePlan(ownerId, planId);
    let parent = await this.requireTask(ownerId, plan.data.parentTaskId);
    if (!['integrating', 'completed'].includes(plan.data.state) || !['running', 'completed'].includes(parent.data.state)) {
      throw new DomainError('integration_incomplete', 'Parent integration must be running or complete before verification', 409);
    }
    if (plan.data.state === 'integrating' && plan.data.integrationBoundary
      && parent.data.state === 'running' && parent.data.orchestration?.planId === plan.id
      && parent.data.orchestration.phase === 'children') {
      const expectedWorker = parent.data.workerId;
      parent = await this.changeTask(ownerId, parent.id, (task) => {
        if (task.state !== 'running' || task.workerId !== expectedWorker
          || task.orchestration?.planId !== plan.id || task.orchestration.phase !== 'children') {
          throw new DomainError('integration_incomplete', 'Recovered parent execution changed before verification', 409);
        }
        return { ...task, orchestration: { ...task.orchestration, phase: 'integration', verification: 'pending' } };
      });
    }
    const outcome = await this.results(ownerId, plan.id);
    if (!outcome.ready || !outcome.successful) {
      const error = new DomainError('verification_failed', 'Delegated work changed after integration started or still has an unresolved outcome', 409);
      if (parent.data.state === 'running') await this.markParentVerification(ownerId, plan.id, parent, 'failed');
      throw error;
    }
    if (plan.data.state === 'completed' && plan.data.verification) {
      await this.markParentVerification(ownerId, plan.id, parent, 'passed');
      return plan;
    }
    if (plan.data.state === 'completed') {
      throw new DomainError('verification_failed', 'Completed integration has no persisted verification proof', 409);
    }
    let evidence: string;
    try {
      evidence = await this.integrationEvidence(ownerId, plan);
    } catch (error) {
      if (error instanceof DomainError && error.code === 'verification_failed' && parent.data.state === 'running') {
        await this.markParentVerification(ownerId, plan.id, parent, 'failed');
      }
      throw error;
    }
    const verified = await this.changePlan(ownerId, plan.id, (current) => {
      if (current.state === 'completed' && current.verification) return current;
      if (current.state !== 'integrating'
        || current.integrationBoundary?.parentEventSequence !== plan.data.integrationBoundary?.parentEventSequence) {
        throw new DomainError('integration_incomplete', 'Integration plan changed before verification could be saved', 409);
      }
      return { ...current, state: 'completed', verification: { at: new Date(this.now()).toISOString(), evidence } };
    });
    await this.markParentVerification(ownerId, plan.id, parent, 'passed');
    return verified;
  }

  private async integrationEvidence(ownerId: string, plan: Entity<OrchestrationPlan>): Promise<string> {
    const boundary = plan.data.integrationBoundary?.parentEventSequence;
    if (boundary === undefined) {
      throw new DomainError('verification_failed', 'Delegated work is unverified because its integration event boundary is missing; re-run integration checks', 409);
    }
    const events = await this.store.scan<TaskEvent>('event', ownerId);
    const tasks = await Promise.all(plan.data.childIds.map((childId) => this.requireTask(ownerId, childId)));
    const approved = new Map(tasks.map((task) => [task.id, new Set(task.data.approvedActionHashes)]));
    const effects = collectChildSideEffects(events, plan.data.childIds, approved);
    const missingApprovals = effects.externalActions.filter((action) => action.approval === 'missing');
    if (missingApprovals.length) {
      throw new DomainError(
        'verification_failed',
        `Delegated work has confirmed external receipts without the child's exact approval record: ${missingApprovals.map((action) => `${action.tool} (${action.actionHash})`).join(', ')}`.slice(0, 2_000),
        409,
      );
    }
    const actualExternal = effects.externalActions
      .filter((action) => action.confirmation !== 'owner_reconciled')
      .map((action) => `${action.tool} (${action.actionHash})`);
    const reconciledExternal = effects.externalActions
      .filter((action) => action.confirmation === 'owner_reconciled')
      .map((action) => `${action.tool} (${action.actionHash})`);
    const recorded = [
      ...(actualExternal.length ? [
        `Confirmed external child actions, individually approved and not re-verified: ${actualExternal.join(', ')}`,
      ] : []),
      ...(reconciledExternal.length ? [
        `Owner-confirmed reconciled child actions, not treated as runtime receipts: ${reconciledExternal.join(', ')}`,
      ] : []),
    ].join('. ').slice(0, 1_000);
    if (effects.changes.length === 0) {
      return recorded
        ? `No child workspace changes required verification. ${recorded}`
        : 'No confirmed child side effects required resource verification.';
    }
    const checks = confirmedActions(events, (event) => event.data.taskId === plan.data.parentTaskId
      && event.data.sequence > boundary);
    const missing = effects.changes.filter((change) => !checks.some((check) => verifiesChange(check, change)));
    if (missing.length > 0) throw new DomainError('verification_failed', verificationFailureMessage(missing), 409);
    const resources = effects.changes.map((change) => `${childChangeLabel(change)} (${change.actionHash})`).join(', ');
    return `${`Parent verified child resources: ${resources}`.slice(0, 2_900)}${recorded ? `. ${recorded}` : ''}`;
  }

  private async markParentVerification(
    ownerId: string,
    planId: string,
    expected: Entity<Task>,
    verification: 'passed' | 'failed',
  ): Promise<void> {
    await this.changeTask(ownerId, expected.id, (task) => {
      if (!task.orchestration || task.orchestration.planId !== planId || task.orchestration.phase !== 'integration') {
        throw new DomainError('integration_incomplete', 'Parent orchestration metadata no longer matches integration', 409);
      }
      const sameRun = expected.data.state === 'running'
        ? task.state === 'running' && task.workerId === expected.data.workerId
        : task.state === 'completed';
      if (!sameRun) throw new DomainError('integration_incomplete', 'Parent execution stopped before verification could be saved', 409);
      if (task.orchestration.verification === verification) return task;
      return { ...task, orchestration: { ...task.orchestration, verification } };
    });
  }

  private async adoptParentUsage(
    ownerId: string,
    budgetId: string,
    parentTaskId: string,
    usage: PrepareChildrenOptions['parentRuntimeUsage'],
  ): Promise<void> {
    if (!usage) return;
    await this.reconcileTaskBudget(ownerId, budgetId, parentTaskId, usage);
  }

  public async reconcileTaskBudget(
    ownerId: string,
    budgetId: string,
    taskId: string,
    finalUsage: { calls: number; totalTokens: number; accountedTokens?: number },
  ): Promise<void> {
    const validateUsage = (usage: { calls: number; totalTokens: number; accountedTokens?: number }): number => {
      const accounted = usage.accountedTokens ?? usage.totalTokens;
      if (!Number.isSafeInteger(usage.calls) || usage.calls < 1
        || !Number.isSafeInteger(usage.totalTokens) || usage.totalTokens < 0
        || !Number.isSafeInteger(accounted) || accounted < usage.totalTokens) {
        throw new DomainError('invalid_usage_sequence', 'Runtime usage snapshot is invalid', 409);
      }
      return accounted;
    };
    const events = (await this.store.scan<TaskEvent>('event', ownerId))
      .filter((event) => event.data.taskId === taskId)
      .sort((left, right) => left.data.sequence - right.data.sequence);
    const modelEvents = events.filter((event) => event.data.type === 'model_call');
    if (modelEvents.length === 0) {
      validateUsage(finalUsage);
      if ((finalUsage.accountedTokens ?? finalUsage.totalTokens) === finalUsage.totalTokens) {
        await this.budgets.adoptRuntimeUsage(ownerId, budgetId, taskId, finalUsage);
      } else {
        await this.budgets.reconcileModelUsage(ownerId, budgetId, taskId, finalUsage);
      }
      return;
    }

    let replayed: { calls: number; totalTokens: number; accountedTokens?: number } = {
      calls: 0,
      totalTokens: 0,
    };
    let lastReservedTokens = 0;
    for (const event of events) {
      const payload = event.data.payload as {
        call?: number;
        reservedTokens?: number;
        usage?: RunUsage;
      };
      if (event.data.type === 'model_call') {
        if (payload.usage) {
          const currentAccounted = validateUsage(payload.usage);
          if (payload.call !== payload.usage.calls
            || !Number.isSafeInteger(payload.reservedTokens) || payload.reservedTokens! < 1) {
            throw new DomainError('invalid_usage_sequence', 'Model call usage snapshot is inconsistent', 409);
          }
          if (payload.usage.calls === replayed.calls + 2) {
            const priorAccounted = currentAccounted - payload.reservedTokens!;
            if (!Number.isSafeInteger(priorAccounted) || priorAccounted < payload.usage.totalTokens
              || payload.usage.totalTokens < replayed.totalTokens) {
              throw new DomainError('invalid_usage_sequence', 'Lost model reservation cannot be reconstructed', 409);
            }
            replayed = {
              calls: payload.usage.calls - 1,
              totalTokens: payload.usage.totalTokens,
              ...(priorAccounted === payload.usage.totalTokens ? {} : { accountedTokens: priorAccounted }),
            };
            if (replayed.calls > 0) {
              await this.budgets.reconcileModelUsage(ownerId, budgetId, taskId, replayed);
            }
          } else if (payload.usage.calls !== replayed.calls + 1) {
            throw new DomainError('invalid_usage_sequence', 'Runtime event gap cannot be uniquely reconstructed', 409);
          }
          const priorAccounted = currentAccounted - payload.reservedTokens!;
          if (payload.usage.totalTokens < replayed.totalTokens
            || priorAccounted < payload.usage.totalTokens) {
            throw new DomainError('invalid_usage_sequence', 'Model call usage snapshot is not monotonic', 409);
          }
          if (payload.usage.totalTokens > replayed.totalTokens) {
            if (replayed.calls < 1) {
              throw new DomainError('invalid_usage_sequence', 'Provider usage cannot precede the first model call', 409);
            }
            replayed = {
              calls: replayed.calls,
              totalTokens: payload.usage.totalTokens,
              ...(priorAccounted === payload.usage.totalTokens ? {} : { accountedTokens: priorAccounted }),
            };
            await this.budgets.reconcileModelUsage(ownerId, budgetId, taskId, replayed);
          } else if (priorAccounted !== (replayed.accountedTokens ?? replayed.totalTokens)) {
            throw new DomainError('invalid_usage_sequence', 'Model call accounting snapshot is inconsistent', 409);
          }
          replayed = payload.usage;
          lastReservedTokens = payload.reservedTokens!;
        } else {
          if (!Number.isSafeInteger(payload.call) || payload.call !== replayed.calls + 1
            || !Number.isSafeInteger(payload.reservedTokens) || payload.reservedTokens! < 1) {
            throw new DomainError('invalid_usage_sequence', 'Legacy model call event cannot be uniquely reconstructed', 409);
          }
          replayed = {
            calls: payload.call!,
            totalTokens: replayed.totalTokens,
            accountedTokens: (replayed.accountedTokens ?? replayed.totalTokens) + payload.reservedTokens!,
          };
          lastReservedTokens = payload.reservedTokens!;
        }
        await this.budgets.reconcileModelUsage(ownerId, budgetId, taskId, replayed);
      } else if (event.data.type === 'usage' && payload.usage) {
        const totalDelta = payload.usage.totalTokens - replayed.totalTokens;
        const accounted = payload.usage.accountedTokens ?? (totalDelta === 0
          ? replayed.accountedTokens ?? replayed.totalTokens
          : (replayed.accountedTokens ?? replayed.totalTokens) - lastReservedTokens + totalDelta);
        const normalized = {
          ...payload.usage,
          ...(accounted === payload.usage.totalTokens ? { accountedTokens: undefined } : { accountedTokens: accounted }),
        };
        validateUsage(normalized);
        if (normalized.calls !== replayed.calls
          || normalized.totalTokens < replayed.totalTokens) {
          throw new DomainError('invalid_usage_sequence', 'Runtime usage event is not monotonic', 409);
        }
        replayed = normalized;
        await this.budgets.reconcileModelUsage(ownerId, budgetId, taskId, replayed);
      }
    }
    if (finalUsage.calls > 0) {
      const totalDelta = finalUsage.totalTokens - replayed.totalTokens;
      const accounted = finalUsage.accountedTokens ?? (finalUsage.calls === replayed.calls
        ? totalDelta === 0
          ? replayed.accountedTokens ?? replayed.totalTokens
          : (replayed.accountedTokens ?? replayed.totalTokens) - lastReservedTokens + totalDelta
        : finalUsage.totalTokens);
      const normalized = {
        ...finalUsage,
        ...(accounted === finalUsage.totalTokens ? { accountedTokens: undefined } : { accountedTokens: accounted }),
      };
      validateUsage(normalized);
      if (normalized.calls < replayed.calls || normalized.calls > replayed.calls + 1
        || (normalized.calls === replayed.calls && normalized.totalTokens < replayed.totalTokens)) {
        throw new DomainError('invalid_usage_sequence', 'Final runtime usage is not monotonic', 409);
      }
      await this.budgets.reconcileModelUsage(ownerId, budgetId, taskId, normalized);
    }
  }

  private async claimParentPlan(
    ownerId: string,
    parentTaskId: string,
    planId: string,
    fingerprint: string,
  ): Promise<void> {
    const claimId = digest(`${ownerId}\0${parentTaskId}\0agent-plan-claim`);
    for (let attempt = 0; attempt < 16; attempt += 1) {
      const row = await this.store.get<ParentPlanClaim>('agent_plan_claim', claimId, ownerId);
      if (row) {
        if (row.data.parentTaskId !== parentTaskId) {
          throw new DomainError('idempotency_conflict', 'Parent plan claim belongs to another task', 409);
        }
        if (row.data.planId === planId) {
          if (row.data.fingerprint !== fingerprint) {
            throw new DomainError('idempotency_conflict', 'Orchestration key belongs to another child plan', 409);
          }
          return;
        }
        const active = await this.store.get<OrchestrationPlan>('agent_plan', row.data.planId, ownerId);
        if (!active || !terminalPlanStates.has(active.data.state)) {
          throw new DomainError('active_child_plan', 'Parent task already has an unfinished child plan', 409);
        }
        if (await this.hasOtherUnfinishedPlan(ownerId, parentTaskId, planId)) {
          throw new DomainError('active_child_plan', 'Parent task already has an unfinished child plan', 409);
        }
        try {
          await this.store.put<ParentPlanClaim>('agent_plan_claim', claimId, ownerId, {
            parentTaskId,
            planId,
            fingerprint,
            generation: row.data.generation + 1,
            claimedAt: new Date(this.now()).toISOString(),
          }, row.revision);
          return;
        } catch (error) {
          if (!(error instanceof DomainError && error.code === 'conflict')) throw error;
          continue;
        }
      }
      if (await this.hasOtherUnfinishedPlan(ownerId, parentTaskId, planId)) {
        throw new DomainError('active_child_plan', 'Parent task already has an unfinished child plan', 409);
      }
      try {
        await this.store.create<ParentPlanClaim>('agent_plan_claim', ownerId, {
          parentTaskId,
          planId,
          fingerprint,
          generation: 1,
          claimedAt: new Date(this.now()).toISOString(),
        }, claimId);
        return;
      } catch (error) {
        if (!(error instanceof DomainError && error.code === 'conflict')) throw error;
      }
    }
    throw new DomainError('busy', 'Parent plan claim is busy; retry', 409);
  }

  private async hasOtherUnfinishedPlan(ownerId: string, parentTaskId: string, planId: string): Promise<boolean> {
    return (await this.store.scan<OrchestrationPlan>('agent_plan', ownerId)).some((candidate) => candidate.id !== planId
      && candidate.data.parentTaskId === parentTaskId
      && !terminalPlanStates.has(candidate.data.state));
  }

  private async hasConflictingParentClaim(ownerId: string, parentTaskId: string, planId: string): Promise<boolean> {
    const claimId = digest(`${ownerId}\0${parentTaskId}\0agent-plan-claim`);
    const claim = await this.store.get<ParentPlanClaim>('agent_plan_claim', claimId, ownerId);
    if (!claim || claim.data.planId === planId) return false;
    const claimedPlan = await this.store.get<OrchestrationPlan>('agent_plan', claim.data.planId, ownerId);
    return !claimedPlan || !terminalPlanStates.has(claimedPlan.data.state);
  }

  public async propagateControl(
    ownerId: string,
    parentTaskId: string,
    action: 'pause' | 'resume' | 'cancel',
    actor?: Principal,
  ): Promise<void> {
    const plans = (await this.store.scan<OrchestrationPlan>('agent_plan', ownerId))
      .filter((plan) => plan.data.parentTaskId === parentTaskId && !['completed', 'cancelled'].includes(plan.data.state));
    const parent = plans.length ? await this.store.get<Task>('task', parentTaskId, ownerId) : undefined;
    for (const plan of plans) {
      for (const childId of plan.data.childIds) {
        const child = await this.requireTask(ownerId, childId);
        if (terminalStates.has(child.data.state)) continue;
        if (action === 'resume' && child.data.state !== 'paused') continue;
        if (action === 'pause' && child.data.state === 'paused') continue;
        if (child.data.state === 'running' || action === 'resume') {
          if (!this.controlTask) {
            throw new DomainError('control_adapter_required', 'Running children require TaskService control propagation', 503);
          }
          await this.controlTask(ownerId, child.id, action, actor);
        } else {
          await this.changeTask(ownerId, child.id, (task) => ({
            ...task,
            state: action === 'cancel' ? 'cancelled' : 'paused',
            cancelRequested: action === 'cancel' || task.cancelRequested,
            pauseRequested: action === 'pause' || task.pauseRequested,
          }));
        }
        await this.propagateControl(ownerId, child.id, action, actor);
      }
      const integrating = parent?.data.orchestration?.planId === plan.id
        && parent.data.orchestration.phase === 'integration';
      const state = action === 'cancel'
        ? 'cancelled'
        : integrating ? 'integrating' : action === 'resume' ? 'waiting' : 'paused';
      await this.changePlan(ownerId, plan.id, (current) => current.state === state
        ? current
        : { ...current, state });
    }
    await this.cleanSlots(ownerId);
  }

  private async prepareChildren(
    parent: Entity<Task>,
    request: PrepareChildrenRequest,
  ): Promise<PreparedChildren> {
    const parentConversation = await this.store.get<Conversation>('conversation', parent.data.conversationId, parent.ownerId);
    if (!parentConversation) throw new DomainError('not_found', 'Parent conversation not found', 404);
    const depth = (parent.data.orchestration?.depth ?? 0) + 1;
    const children = [] as PreparedChildren['children'];
    for (const spec of request.children) {
      if (spec.profileId && !await this.store.get<AgentProfile>('agent', spec.profileId, parent.ownerId)) {
        throw new DomainError('not_found', 'Agent profile not found', 404);
      }
      const principal = this.narrowPrincipal(parent.data.principal, spec);
      const parentExpiry = Math.min(
        Date.parse(parent.data.grantExpiresAt),
        parent.data.principal.expiresAt ? Date.parse(parent.data.principal.expiresAt) : Number.POSITIVE_INFINITY,
      );
      const requestedExpiry = spec.grantExpiresAt ? Date.parse(spec.grantExpiresAt) : parentExpiry;
      if (!Number.isFinite(requestedExpiry) || requestedExpiry > parentExpiry) {
        throw new DomainError('grant_expansion', 'Child grant cannot outlive its parent', 403);
      }
      children.push({
        spec,
        principal,
        grantExpiresAt: new Date(requestedExpiry).toISOString(),
        authorizationKind: parent.data.authorizationKind,
        automationSource: parent.data.automationSource,
      });
    }
    return { parentConversation, depth, children };
  }

  private async finishPreparation(
    plan: Entity<OrchestrationPlan>,
    parent: Entity<Task>,
    strategy: ChildStrategy,
    prepared: PreparedChildren,
  ): Promise<Entity<OrchestrationPlan>> {
    await this.reserveSlots(parent.ownerId, plan.id, plan.data.childIds);
    for (let index = 0; index < prepared.children.length; index += 1) {
      const { spec, principal, grantExpiresAt, authorizationKind, automationSource } = prepared.children[index]!;
      const childId = plan.data.childIds[index]!;
      const conversationId = `${childId}:conversation`;
      await this.createOnce<Conversation>('conversation', conversationId, parent.ownerId, {
        ...prepared.parentConversation.data,
        title: `Agent: ${spec.key}`,
        strategy: 'single',
        agentId: spec.profileId,
        archived: true,
      });
      const orchestration: TaskOrchestration = {
        rootTaskId: plan.data.rootTaskId,
        parentTaskId: parent.id,
        planId: plan.id,
        depth: prepared.depth,
        role: 'child',
        strategy,
        childKey: spec.key,
        profileId: spec.profileId,
        budgetId: plan.data.budgetId,
        phase: 'children',
        verification: 'pending',
      };
      await this.createOnce<Message>('message', `${childId}:user`, parent.ownerId, {
        conversationId,
        role: 'user',
        content: spec.prompt,
        taskId: childId,
        sequence: 1,
        attachmentIds: parent.data.attachmentIds,
      });
      await this.createOnce<TaskEvent>('event', `${childId}:000000000001`, parent.ownerId, {
        taskId: childId,
        sequence: 1,
        type: 'queued',
        payload: { type: 'queued', parentTaskId: parent.id, planId: plan.id },
        at: plan.createdAt,
      });
      await this.createChildTask(childId, parent.ownerId, {
        conversationId,
        ...(parent.data.workspaceId ? { workspaceId: parent.data.workspaceId } : {}),
        prompt: spec.prompt,
        principal,
        state: 'queued',
        grantExpiresAt,
        pendingActions: [],
        approvedActionHashes: [],
        attachmentIds: parent.data.attachmentIds,
        pluginVersions: parent.data.pluginVersions,
        ...(authorizationKind ? { authorizationKind } : {}),
        ...(automationSource ? { automationSource } : {}),
        orchestration,
      });
    }
    await this.changeTask(parent.ownerId, parent.id, (task) => ({
      ...task,
      ...(plan.data.parentTransition === 'runner' ? {} : {
        state: 'waiting_for_children' as const,
        workerId: undefined,
        leaseExpiresAt: undefined,
      }),
      orchestration: {
        ...task.orchestration,
        rootTaskId: plan.data.rootTaskId,
        parentTaskId: task.orchestration?.parentTaskId,
        planId: plan.id,
        depth: task.orchestration?.depth ?? 0,
        role: 'parent',
        strategy,
        budgetId: plan.data.budgetId,
        phase: 'children',
        verification: 'pending',
      },
    }));
    return this.changePlan(parent.ownerId, plan.id, (current) => current.state === 'preparing'
      ? { ...current, state: 'waiting' }
      : current);
  }

  private narrowPrincipal(parent: Principal, spec: ChildSpec): Principal {
    const scopes = [...new Set(spec.scopes ?? parent.scopes)].sort();
    if (scopes.some((scope) => !scopeCovered(parent.scopes, scope))) {
      throw new DomainError('scope_expansion', 'Child scopes must be covered by the parent grant', 403);
    }
    const level = spec.level ?? parent.level;
    if (level < parent.level) throw new DomainError('level_expansion', 'Child level cannot exceed parent authority', 403);
    return { ...parent, level, scopes };
  }

  private async reserveSlots(ownerId: string, planId: string, childIds: string[]): Promise<void> {
    const slotsId = digest(`${ownerId}\0agent-child-slots`);
    for (let attempt = 0; attempt < 16; attempt += 1) {
      const row = await this.store.get<ChildSlots>('agent_child_slots', slotsId, ownerId);
      const slots: ChildSlots = row ? { children: { ...row.data.children } } : { children: {} };
      for (const id of Object.keys(slots.children)) {
        const task = await this.store.get<Task>('task', id, ownerId);
        if (task && terminalStates.has(task.data.state)) delete slots.children[id];
      }
      const newIds = childIds.filter((id) => !slots.children[id]);
      if (Object.keys(slots.children).length + newIds.length > 3) {
        throw new DomainError('too_many_active_children', 'An account can run at most 3 temporary child agents', 409);
      }
      const reservedAt = new Date(this.now()).toISOString();
      for (const id of newIds) slots.children[id] = { planId, reservedAt };
      try {
        if (row) await this.store.put('agent_child_slots', slotsId, ownerId, slots, row.revision);
        else await this.store.create('agent_child_slots', ownerId, slots, slotsId);
        return;
      } catch (error) {
        if (!(error instanceof DomainError && error.code === 'conflict')) throw error;
      }
    }
    throw new DomainError('busy', 'Child slots are busy; retry', 409);
  }

  private async cleanSlots(ownerId: string): Promise<void> {
    const slotsId = digest(`${ownerId}\0agent-child-slots`);
    for (let attempt = 0; attempt < 16; attempt += 1) {
      const row = await this.store.get<ChildSlots>('agent_child_slots', slotsId, ownerId);
      if (!row) return;
      const children = { ...row.data.children };
      for (const id of Object.keys(children)) {
        const task = await this.store.get<Task>('task', id, ownerId);
        if (task && terminalStates.has(task.data.state)) delete children[id];
      }
      if (Object.keys(children).length === Object.keys(row.data.children).length) return;
      try {
        await this.store.put('agent_child_slots', slotsId, ownerId, { children }, row.revision);
        return;
      } catch (error) {
        if (!(error instanceof DomainError && error.code === 'conflict')) throw error;
      }
    }
    throw new DomainError('busy', 'Child slots are busy; retry', 409);
  }

  private async createOnce<T>(kind: string, id: string, ownerId: string, data: T): Promise<Entity<T>> {
    const existing = await this.store.get<T>(kind, id, ownerId);
    if (existing) {
      if (canonical(existing.data) !== canonical(data)) {
        throw new DomainError('idempotency_conflict', `${kind} ID belongs to different data`, 409);
      }
      return existing;
    }
    try {
      return await this.store.create(kind, ownerId, data, id);
    } catch (error) {
      if (error instanceof DomainError && error.code === 'conflict') return this.createOnce(kind, id, ownerId, data);
      throw error;
    }
  }

  private async createChildTask(id: string, ownerId: string, data: Task): Promise<Entity<Task>> {
    const existing = await this.store.get<Task>('task', id, ownerId);
    if (existing) {
      const expected = {
        conversationId: data.conversationId,
        prompt: data.prompt,
        principal: data.principal,
        grantExpiresAt: data.grantExpiresAt,
        pluginVersions: data.pluginVersions,
        authorizationKind: data.authorizationKind,
        automationSource: data.automationSource,
        orchestration: data.orchestration,
      };
      const actual = {
        conversationId: existing.data.conversationId,
        prompt: existing.data.prompt,
        principal: existing.data.principal,
        grantExpiresAt: existing.data.grantExpiresAt,
        pluginVersions: existing.data.pluginVersions,
        authorizationKind: existing.data.authorizationKind,
        automationSource: existing.data.automationSource,
        orchestration: existing.data.orchestration,
      };
      if (canonical(actual) !== canonical(expected)) {
        throw new DomainError('idempotency_conflict', 'Child task ID belongs to different input', 409);
      }
      return existing;
    }
    try {
      return await this.store.create('task', ownerId, data, id);
    } catch (error) {
      if (error instanceof DomainError && error.code === 'conflict') return this.createChildTask(id, ownerId, data);
      throw error;
    }
  }

  private async requireTask(ownerId: string, id: string): Promise<Entity<Task>> {
    const task = await this.store.get<Task>('task', id, ownerId);
    if (!task) throw new DomainError('not_found', 'Task not found', 404);
    return task;
  }

  private async requirePlan(ownerId: string, id: string): Promise<Entity<OrchestrationPlan>> {
    const plan = await this.store.get<OrchestrationPlan>('agent_plan', id, ownerId);
    if (!plan) throw new DomainError('not_found', 'Orchestration plan not found', 404);
    return plan;
  }

  private async changeTask(ownerId: string, id: string, change: (task: Task) => Task): Promise<Entity<Task>> {
    for (let attempt = 0; attempt < 16; attempt += 1) {
      const row = await this.requireTask(ownerId, id);
      const data = change(row.data);
      if (data === row.data) return row;
      try {
        return await this.store.put('task', id, ownerId, data, row.revision);
      } catch (error) {
        if (!(error instanceof DomainError && error.code === 'conflict')) throw error;
      }
    }
    throw new DomainError('busy', 'Task is busy; retry', 409);
  }

  private async changePlan(
    ownerId: string,
    id: string,
    change: (plan: OrchestrationPlan) => OrchestrationPlan,
  ): Promise<Entity<OrchestrationPlan>> {
    for (let attempt = 0; attempt < 16; attempt += 1) {
      const row = await this.requirePlan(ownerId, id);
      const data = change(row.data);
      if (data === row.data) return row;
      try {
        return await this.store.put('agent_plan', id, ownerId, data, row.revision);
      } catch (error) {
        if (!(error instanceof DomainError && error.code === 'conflict')) throw error;
      }
    }
    throw new DomainError('busy', 'Orchestration plan is busy; retry', 409);
  }
}
