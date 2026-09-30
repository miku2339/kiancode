import { createHash } from 'node:crypto';
import path from 'node:path';
import { DomainError, type ExecutionStrategy, type Principal } from '../contracts.js';
import type { Conversation, Message, Task, TaskEvent, TaskOrchestration, TaskState } from '../domain.js';
import type { AgentProfile } from '../runtime/index.js';
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
  verification?: { at: string; evidence: string };
}

export interface PrepareChildrenOptions {
  parentTransition?: 'coordinator' | 'runner';
  parentRuntimeUsage?: { calls: number; totalTokens: number };
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

interface PreparedChildren {
  parentConversation: Entity<Conversation>;
  depth: number;
  children: Array<{ spec: ChildSpec; principal: Principal; grantExpiresAt: string }>;
}

interface ConfirmedAction {
  actionHash: string;
  tool: string;
  arguments: Record<string, unknown>;
  sideEffect?: string;
  result?: unknown;
}

const terminalStates = new Set<TaskState>(['completed', 'failed', 'cancelled', 'unknown']);
const terminalPlanStates = new Set<OrchestrationPlan['state']>(['completed', 'cancelled']);
const planKeyPattern = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/;

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
  for (const event of events.filter(include).sort((left, right) => left.data.sequence - right.data.sequence)) {
    const payload = event.data.payload as {
      actionHash?: string;
      toolCallId?: string;
      toolCall?: { id?: string; name?: string; arguments?: Record<string, unknown> };
      sideEffect?: string;
      outcome?: string;
      isError?: boolean;
      result?: unknown;
    };
    const key = payload.actionHash ?? payload.toolCallId ?? payload.toolCall?.id;
    if (!key) continue;
    if (event.data.type === 'tool_dispatched' && payload.toolCall?.name) {
      dispatched.set(key, {
        actionHash: key,
        tool: payload.toolCall.name,
        arguments: payload.toolCall.arguments ?? {},
        sideEffect: payload.sideEffect,
      });
    } else if (event.data.type === 'tool_result' && payload.outcome === 'confirmed' && !payload.isError) {
      const action = dispatched.get(key);
      if (action) confirmed.push({ ...action, result: payload.result });
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
    return normalizedWorkspacePath((JSON.parse(content) as { path?: unknown }).path);
  } catch {
    return undefined;
  }
}

function changedWorkspacePath(action: ConfirmedAction): string | undefined {
  if (action.tool === 'workspace.write') return normalizedWorkspacePath(action.arguments.path) ?? resultPath(action.result);
  if (action.tool === 'workspace.patch' || action.tool === 'workspace.restore') return resultPath(action.result);
  return undefined;
}

function verifiesWorkspacePath(action: ConfirmedAction, resource: string): boolean {
  if (action.tool === 'workspace.read') return normalizedWorkspacePath(action.arguments.path) === resource;
  if (action.tool !== 'terminal.run' || typeof action.arguments.command !== 'string') return false;
  const command = action.arguments.command;
  const escaped = resource.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|[\\s'\"]|\\./)${escaped}([\\s'\"]|$)`).test(command)
    && /(^|[;&|]\s*|\b)(cat|test|git\s+(diff|status)|npm\s+(test|run\s+test)|swift\s+test|pytest|cargo\s+test)\b/.test(command);
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
    await this.cleanSlots(ownerId);
    const children = tasks.map((task): ChildResult => ({
      id: task.id,
      key: task.data.orchestration?.childKey ?? task.id,
      state: task.data.state,
      result: task.data.result,
      error: task.data.error,
      attachmentIds: task.data.attachmentIds ?? [],
    }));
    const ready = children.every((child) => terminalStates.has(child.state));
    return {
      plan,
      children,
      ready,
      successful: ready && children.every((child) => child.state === 'completed'),
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
    if (plan.data.strategy === 'moa') {
      plan = await this.changePlan(ownerId, plan.id, (current) => {
        if (current.aggregationClaimed) return current;
        return { ...current, aggregationClaimed: true, state: 'integrating' };
      });
    } else if (plan.data.state !== 'integrating') {
      plan = await this.changePlan(ownerId, plan.id, (current) => ({ ...current, state: 'integrating' }));
    }
    return this.changeTask(ownerId, plan.data.parentTaskId, (task) => {
      if (['queued', 'running', 'completed'].includes(task.state)) return task;
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

  public async verifyIntegration(ownerId: string, planId: string, _claimedEvidence?: string): Promise<Entity<OrchestrationPlan>> {
    const plan = await this.requirePlan(ownerId, planId);
    const parent = await this.requireTask(ownerId, plan.data.parentTaskId);
    if (!['integrating', 'completed'].includes(plan.data.state) || parent.data.state !== 'completed') {
      throw new DomainError('integration_incomplete', 'Parent integration must complete before verification', 409);
    }
    if (plan.data.state === 'completed' && plan.data.verification) {
      await this.markParentVerified(ownerId, parent.id);
      return plan;
    }
    const evidence = await this.integrationEvidence(ownerId, plan);
    const verified = await this.changePlan(ownerId, plan.id, (current) => current.state === 'completed'
      ? current
      : { ...current, state: 'completed', verification: { at: new Date(this.now()).toISOString(), evidence } });
    await this.markParentVerified(ownerId, parent.id);
    return verified;
  }

  private async integrationEvidence(ownerId: string, plan: Entity<OrchestrationPlan>): Promise<string> {
    const events = await this.store.scan<TaskEvent>('event', ownerId);
    const childIds = new Set(plan.data.childIds);
    const mutations = confirmedActions(events, (event) => childIds.has(event.data.taskId))
      .filter((action) => action.sideEffect === 'write' || action.sideEffect === 'external');
    if (mutations.length === 0) return 'No confirmed child side effects required resource verification.';
    const resources = new Map<string, string>();
    for (const mutation of mutations) {
      const resource = changedWorkspacePath(mutation);
      if (!resource) {
        throw new DomainError('verification_required', 'A confirmed child side effect has no resource evidence for parent verification', 409);
      }
      resources.set(resource, mutation.actionHash);
    }
    const checks = confirmedActions(events, (event) => event.data.taskId === plan.data.parentTaskId
      && event.data.at >= plan.updatedAt);
    const verified = [...resources.entries()].filter(([resource]) => checks.some((check) => verifiesWorkspacePath(check, resource)));
    if (verified.length !== resources.size) {
      throw new DomainError('verification_required', 'Parent verification must inspect or test every confirmed child resource', 409);
    }
    return `Parent verified child resources: ${verified.map(([resource, actionHash]) => `${resource} (${actionHash})`).join(', ').slice(0, 3_900)}`;
  }

  private async markParentVerified(ownerId: string, parentId: string): Promise<void> {
    await this.changeTask(ownerId, parentId, (task) => task.orchestration
      ? { ...task, orchestration: { ...task.orchestration, verification: 'passed' } }
      : task);
  }

  private async adoptParentUsage(
    ownerId: string,
    budgetId: string,
    parentTaskId: string,
    usage: PrepareChildrenOptions['parentRuntimeUsage'],
  ): Promise<void> {
    if (!usage) return;
    await this.budgets.adoptRuntimeUsage(ownerId, budgetId, parentTaskId, usage);
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
      await this.changePlan(ownerId, plan.id, (current) => ({
        ...current,
        state: action === 'cancel' ? 'cancelled' : action === 'resume' ? 'waiting' : 'paused',
      }));
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
      children.push({ spec, principal, grantExpiresAt: new Date(requestedExpiry).toISOString() });
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
      const { spec, principal, grantExpiresAt } = prepared.children[index]!;
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
        orchestration: data.orchestration,
      };
      const actual = {
        conversationId: existing.data.conversationId,
        prompt: existing.data.prompt,
        principal: existing.data.principal,
        grantExpiresAt: existing.data.grantExpiresAt,
        pluginVersions: existing.data.pluginVersions,
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
