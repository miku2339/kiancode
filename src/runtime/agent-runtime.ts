import { createHash } from 'node:crypto';
import { DomainError, type ToolDefinition, type ToolResult } from '../contracts.js';
import type {
  ChatMessage,
  ChatRequest,
  ChatResponse,
  ModelConfig,
  ModelProvider,
  PendingAction,
  RunInput,
  RunResult,
  RunUsage,
  RunBudgets,
  RuntimeOptions,
  ToolCall,
} from './types.js';

const DEFAULT_MAX_CALLS = 20;
const DEFAULT_MAX_TOKENS = 100_000;

interface ToolBatchResult {
  pendingActions?: PendingAction[];
  waitingForChildren?: boolean;
}

interface SingleRunOptions {
  strategy: RunResult['strategy'];
  emitLifecycle: boolean;
  toolsEnabled: boolean;
  budget: BudgetLedger;
}

interface ActionFailure {
  tool: string;
}

export class AgentRuntime {
  private readonly providers = new Map<string, ModelProvider>();
  private readonly models: ModelConfig[];
  private readonly tools = new Map<string, ToolDefinition>();
  private readonly ownerLimiter: Limiter;
  private readonly localProviderLimiter: Limiter;
  private readonly workspaceWriteLimiter: Limiter;
  private readonly maxDepth: number;

  public constructor(options: RuntimeOptions, shared?: AgentRuntime) {
    this.localProviderLimiter = shared?.localProviderLimiter ?? new Limiter(1);
    this.workspaceWriteLimiter = shared?.workspaceWriteLimiter ?? new Limiter(1, true);
    for (const provider of options.providers) {
      this.providers.set(provider.id, provider);
    }
    this.models = [...options.models];
    for (const tool of options.tools ?? []) {
      this.tools.set(tool.name, tool);
    }
    this.ownerLimiter = shared?.ownerLimiter ?? new Limiter(options.maxActiveRunsPerOwner ?? 3, true);
    this.maxDepth = options.maxDepth ?? 2;
  }

  public withConfiguration(options: RuntimeOptions): AgentRuntime {
    return new AgentRuntime(options, this);
  }

  public chat(provider: ModelProvider, request: ChatRequest): Promise<ChatResponse> {
    return provider.locality === 'local'
      ? this.localProviderLimiter.use(provider.id, request.signal, () => provider.chat(request))
      : provider.chat(request);
  }

  public async run(input: RunInput): Promise<RunResult> {
    const signal = input.signal ?? new AbortController().signal;
    const depth = input.depth ?? 0;
    if (depth > this.maxDepth) {
      throw new DomainError('max_agent_depth_exceeded', `Agent depth cannot exceed ${this.maxDepth}.`);
    }
    const release = await this.ownerLimiter.acquire(input.principal.id, signal);
    try {
      const requested = input.strategy ?? input.profile?.strategy ?? 'auto';
      const strategy = requested === 'auto'
        ? (input.profile?.experts?.length ? 'experts' : 'single')
        : requested;
      await input.onEvent?.({ type: 'start', taskId: input.taskId, strategy });
      const budget = new BudgetLedger(input.budgets, input.priorUsage);
      if (strategy === 'single') {
        return await this.runSingle(input, { strategy, emitLifecycle: true, toolsEnabled: true, budget });
      }
      return await this.runEnsemble(input, strategy, budget);
    } finally {
      release();
    }
  }

  private async runEnsemble(
    input: RunInput,
    strategy: 'experts' | 'moa',
    budget: BudgetLedger,
  ): Promise<RunResult> {
    const configuredExperts = input.profile?.experts ?? [];
    const candidateLimit = strategy === 'experts'
      ? Math.min(2, Math.max(1, configuredExperts.length))
      : Math.min(3, Math.max(2, input.profile?.candidateCount ?? 3));
    const candidates: Array<{ content: string; modelId: string; messages: ChatMessage[]; usage: RunUsage }> = [];
    let failed = 0;
    for (let index = 0; index < candidateLimit; index += 1) {
      const expert = configuredExperts[index];
      const instruction = expert?.instruction
        ?? `Produce an independent candidate answer ${index + 1}. Return only the answer and do not delegate.`;
      try {
        const result = await this.runSingle({
          ...input,
          strategy: 'single',
          depth: (input.depth ?? 0) + 1,
          profile: {
            ...input.profile,
            strategy: 'single',
            systemPrompt: [input.profile?.systemPrompt, instruction].filter(Boolean).join('\n\n'),
          },
          onEvent: input.onEvent,
        }, { strategy: 'single', emitLifecycle: false, toolsEnabled: false, budget });
        if (result.status === 'completed') {
          candidates.push({
            content: result.content,
            modelId: result.modelId,
            messages: result.messages,
            usage: result.usage,
          });
          await input.onEvent?.({ type: 'candidate', taskId: input.taskId, index, ok: true });
        } else {
          failed += 1;
          await input.onEvent?.({ type: 'candidate', taskId: input.taskId, index, ok: false });
        }
      } catch (error) {
        if (isAbortError(error)) {
          throw error;
        }
        failed += 1;
        await input.onEvent?.({ type: 'candidate', taskId: input.taskId, index, ok: false });
      }
    }
    if (candidates.length === 0) {
      throw new DomainError('all_candidates_failed', 'No candidate agent completed successfully.', 502);
    }
    if (candidates.length === 1) {
      const only = candidates[0];
      if (!only) {
        throw new DomainError('all_candidates_failed', 'No candidate agent completed successfully.', 502);
      }
      const result: RunResult = {
        status: 'completed',
        content: only.content,
        modelId: only.modelId,
        usage: budget.snapshot(),
        strategy,
        messages: only.messages,
        degraded: true,
        candidates: candidates.map(({ content, modelId }) => ({ content, modelId })),
      };
      await input.onEvent?.({ type: 'final', taskId: input.taskId, result });
      return result;
    }
    const aggregatePrompt = [
      'Synthesize the best final answer from these independent candidates.',
      ...candidates.map((candidate, index) => `Candidate ${index + 1}:\n${candidate.content}`),
    ].join('\n\n');
    const aggregate = await this.runSingle({
      ...input,
      prompt: aggregatePrompt,
      messages: [],
      strategy: 'single',
      depth: (input.depth ?? 0) + 1,
      profile: {
        ...input.profile,
        strategy: 'single',
        experts: [],
        systemPrompt: 'Act as the parent aggregator. Return one final answer without mentioning the candidates.',
      },
    }, { strategy: 'single', emitLifecycle: false, toolsEnabled: false, budget });
    const result: RunResult = {
      ...aggregate,
      usage: budget.snapshot(),
      strategy,
      degraded: failed > 0,
      candidates: candidates.map(({ content, modelId }) => ({ content, modelId })),
    };
    await input.onEvent?.({ type: 'final', taskId: input.taskId, result });
    return result;
  }

  private async runSingle(input: RunInput, options: SingleRunOptions): Promise<RunResult> {
    const signal = input.signal ?? new AbortController().signal;
    const availableTools = new Map(this.tools);
    for (const tool of input.additionalTools ?? []) availableTools.set(tool.name, tool);
    const allowedTools = options.toolsEnabled
      ? [...availableTools.values()]
          .filter((tool) => !tool.requiresWorkspace || Boolean(input.workspace))
          .filter((tool) => input.mode === 'act' || tool.sideEffect === 'read')
          .filter((tool) => this.hasToolCapabilities(tool, input))
      : [];
    const requiredCapabilities = new Set(input.requiredModelCapabilities ?? []);
    if (input.mode === 'act' && allowedTools.length > 0) {
      requiredCapabilities.add('tools');
    }
    const model = this.selectModel(input, requiredCapabilities);
    const provider = this.providers.get(model.providerId);
    if (!provider) {
      throw new DomainError('provider_not_found', `Provider ${model.providerId} is not registered.`, 500);
    }
    if (provider.isAvailable && !(await provider.isAvailable(model, input.workspace, signal))) {
      throw new DomainError(
        model.locality === 'local' ? 'waiting_for_device' : 'model_unavailable',
        model.locality === 'local'
          ? `Local model device ${model.deviceId ?? input.workspace?.deviceId ?? 'unknown'} is unavailable.`
          : `Model ${model.id} is unavailable.`,
        503,
      );
    }
    if (provider.probeCapabilities) {
      const probed = new Set(await provider.probeCapabilities(model, signal));
      const unsupported = [...requiredCapabilities].filter((capability) => !probed.has(capability));
      if (unsupported.length > 0) {
        throw new DomainError(
          'model_capability_unavailable',
          `Model ${model.id} did not verify required capabilities: ${unsupported.join(', ')}.`,
          503,
        );
      }
    }
    const modelTools = model.capabilities.includes('tools') ? allowedTools : [];
    const messages: ChatMessage[] = [
      ...(input.profile?.systemPrompt ? [{ role: 'system' as const, content: input.profile.systemPrompt }] : []),
      ...(input.messages ?? []),
      ...(input.prompt ? [{ role: 'user' as const, content: input.prompt }] : []),
    ];
    if (messages.length === 0) {
      throw new DomainError('prompt_required', 'A prompt or messages are required.');
    }
    let usage = options.budget.snapshot();
    const consumedActionHashes = new Set(messages
      .filter((message) => message.role === 'tool' && message.actionHash)
      .map((message) => message.actionHash as string));
    const unresolvedFailures = input.mode === 'act'
      ? unresolvedActionFailures(messages, availableTools)
      : new Map<string, ActionFailure>();

    const resumedCalls = pendingToolCalls(messages);
    if (resumedCalls.length > 0) {
      const batch = await this.executeToolCalls(
        resumedCalls, messages, input, signal, modelTools, consumedActionHashes, unresolvedFailures,
      );
      if (batch.pendingActions) {
        return this.waitingResult(model, usage, options.strategy, messages, batch.pendingActions);
      }
      if (batch.waitingForChildren) {
        return this.waitingForChildrenResult(model, usage, options.strategy, messages);
      }
    }

    while (true) {
      this.assertNotAborted(signal);
      const inputReservation = messages.reduce((sum, message) => sum + Buffer.byteLength(message.content, 'utf8') + (message.attachments?.length ?? 0) * 16_384, 0)
        + Buffer.byteLength(JSON.stringify(modelTools.map((tool) => ({ name: tool.name, description: tool.description, inputSchema: tool.inputSchema }))));
      const maxOutputTokens = Math.min(
        Math.max(1, Math.min(input.maxOutputTokens ?? 4096, 16_384)),
        options.budget.availableTokens() - inputReservation,
      );
      if (maxOutputTokens < 1) {
        throw new DomainError('token_budget_exceeded', 'No token budget remains for this model request.', 429);
      }
      const reservedTokens = inputReservation + maxOutputTokens;
      options.budget.reserveCall(reservedTokens);
      usage = options.budget.snapshot();
      await input.onEvent?.({ type: 'model_call', taskId: input.taskId, modelId: model.id, call: usage.calls, reservedTokens });
      const request = {
        model,
        messages: [...messages],
        tools: modelTools,
        signal,
        maxOutputTokens,
        context: {
          principal: input.principal,
          ...(input.workspace ? { workspace: input.workspace } : {}),
          taskId: input.taskId,
        },
        onToken: async (content: string) => input.onEvent?.({ type: 'token' as const, taskId: input.taskId, content }),
      };
      const response = model.locality === 'local'
        ? await this.localProviderLimiter.use(provider.id, signal, () => provider.chat(request))
        : await provider.chat(request);
      const budgetViolation = options.budget.addTokens(response.usage, reservedTokens);
      usage = options.budget.snapshot();
      await input.onEvent?.({ type: 'usage', taskId: input.taskId, usage: { ...usage } });
      if (budgetViolation) {
        throw new DomainError('budget_violation', 'Provider reported usage beyond the reserved token budget.', 409);
      }
      messages.push(response.message);
      if (!response.message.toolCalls?.length) {
        if (input.mode === 'act' && unresolvedFailures.size > 0) {
          const tools = [...new Set([...unresolvedFailures.values()].map((failure) => failure.tool))];
          throw new DomainError(
            'verification_failed',
            `Act task still has failed ${tools.join(', ')} action${tools.length === 1 ? '' : 's'}; repair and successfully retry or verify the corresponding operation before completing.`,
            409,
          );
        }
        const result: RunResult = {
          status: 'completed',
          content: response.message.content,
          modelId: model.id,
          usage,
          strategy: options.strategy,
          messages,
        };
        if (options.emitLifecycle) {
          await input.onEvent?.({ type: 'final', taskId: input.taskId, result });
        }
        return result;
      }
      const batch = await this.executeToolCalls(
        response.message.toolCalls, messages, input, signal, modelTools, consumedActionHashes, unresolvedFailures,
      );
      if (batch.pendingActions) {
        return this.waitingResult(model, usage, options.strategy, messages, batch.pendingActions);
      }
      if (batch.waitingForChildren) {
        return this.waitingForChildrenResult(model, usage, options.strategy, messages);
      }
    }
  }

  private async executeToolCalls(
    toolCalls: ToolCall[],
    messages: ChatMessage[],
    input: RunInput,
    signal: AbortSignal,
    allowedTools: ToolDefinition[],
    consumedActionHashes: Set<string>,
    unresolvedFailures: Map<string, ActionFailure>,
  ): Promise<ToolBatchResult> {
    for (const originalToolCall of toolCalls) {
      const toolCall: ToolCall = {
        ...originalToolCall,
        actionHash: actionHash(input.principal.id, input.taskId, originalToolCall),
      };
      this.assertNotAborted(signal);
      await input.onEvent?.({ type: 'tool_call', taskId: input.taskId, toolCall });
      const tool = allowedTools.find((candidate) => candidate.name === toolCall.name);
      let content: string;
      let isError = false;
      let outcome: 'confirmed' | 'failed' | 'unknown' | 'not_replayed' = 'failed';
      let result: ToolResult | undefined;
      if (!tool || !allowedTools.includes(tool)) {
        content = `Tool ${toolCall.name} is unavailable in ${input.mode} mode.`;
        isError = true;
      } else if (!this.hasToolCapabilities(tool, input)) {
        content = `Tool ${toolCall.name} is unavailable for the current principal or workspace.`;
        isError = true;
      } else if (tool.sideEffect !== 'read'
        && (!toolCall.actionHash || !input.approvedActionHashes?.has(toolCall.actionHash))) {
        await input.onEvent?.({
          type: 'approval_required',
          taskId: input.taskId,
          toolCall,
          ...(toolCall.actionHash ? { actionHash: toolCall.actionHash } : {}),
        });
        return {
          pendingActions: [{
            toolCallId: toolCall.id,
            toolName: toolCall.name,
            input: toolCall.arguments,
            ...(toolCall.actionHash ? { actionHash: toolCall.actionHash } : {}),
          }],
        };
      } else if (tool.sideEffect !== 'read' && consumedActionHashes.has(toolCall.actionHash!)) {
        content = `Tool ${toolCall.name} was not replayed because this approved action was already dispatched.`;
        isError = true;
        outcome = 'not_replayed';
      } else {
        const execute = async (): Promise<ToolResult> => {
          await input.onEvent?.({
            type: 'tool_dispatched',
            taskId: input.taskId,
            toolCall,
            actionHash: toolCall.actionHash!,
            sideEffect: tool.sideEffect,
          });
          return tool.execute(toolCall.arguments, {
              principal: input.principal,
              ...(input.workspace ? { workspace: input.workspace } : {}),
              taskId: input.taskId,
              signal,
              ...(input.approvedActionHashes ? { approvedActionHashes: input.approvedActionHashes } : {}),
              ...(input.pluginVersions ? { pluginVersions: input.pluginVersions } : {}),
              ...(input.workspaceWriteLease ? { workspaceWriteLease: input.workspaceWriteLease } : {}),
          });
        };
        try {
          result = tool.sideEffect === 'write' && input.workspace
            ? await this.workspaceWriteLimiter.use(input.workspace.id, signal, execute)
            : await execute();
          content = result.content;
          isError = result.isError ?? false;
          outcome = isError ? 'failed' : 'confirmed';
          if (tool.sideEffect !== 'read') {
            consumedActionHashes.add(toolCall.actionHash!);
          }
        } catch (error) {
          if (error instanceof DomainError && error.code === 'waiting_for_device') {
            throw error;
          }
          if (tool.sideEffect === 'external'
            || (error instanceof DomainError && error.code === 'outcome_unknown')) {
            await input.onEvent?.({
              type: 'tool_result',
              taskId: input.taskId,
              toolCallId: toolCall.id,
              isError: true,
              outcome: 'unknown',
              actionHash: toolCall.actionHash,
              sideEffect: tool.sideEffect,
            });
            throw new DomainError(
              'outcome_unknown',
              'External action was dispatched but its result was not confirmed. Verify the outcome before retrying.',
              409,
            );
          }
          if (isAbortError(error)) {
            throw error;
          }
          content = `Tool error: ${error instanceof Error ? error.message : String(error)}`;
          isError = true;
          outcome = 'failed';
        }
      }
      messages.push({
        role: 'tool',
        content,
        name: toolCall.name,
        toolCallId: toolCall.id,
        actionHash: toolCall.actionHash,
        toolOutcome: outcome,
      });
      if (input.mode === 'act' && tool && tool.sideEffect !== 'read') {
        const key = actionFailureKey(toolCall);
        if (outcome === 'failed') {
          unresolvedFailures.set(key, { tool: tool.name });
        } else if (outcome === 'confirmed') {
          unresolvedFailures.delete(key);
        }
      }
      await input.onEvent?.({
        type: 'tool_result',
        taskId: input.taskId,
        toolCallId: toolCall.id,
        isError,
        outcome,
        actionHash: toolCall.actionHash,
        ...(tool ? { sideEffect: tool.sideEffect } : {}),
        ...(result ? { result } : {}),
        checkpointMessages: [...messages],
      });
      if (toolCall.name === 'agent.delegate' && outcome === 'confirmed' && !isError) {
        return { waitingForChildren: true };
      }
    }
    return {};
  }

  private waitingResult(
    model: ModelConfig,
    usage: RunUsage,
    strategy: RunResult['strategy'],
    messages: ChatMessage[],
    pendingActions: PendingAction[],
  ): RunResult {
    return {
      status: 'waiting_for_approval',
      content: '',
      modelId: model.id,
      usage,
      strategy,
      messages,
      pendingActions,
    };
  }

  private waitingForChildrenResult(
    model: ModelConfig,
    usage: RunUsage,
    strategy: RunResult['strategy'],
    messages: ChatMessage[],
  ): RunResult {
    return {
      status: 'waiting_for_children',
      content: '',
      modelId: model.id,
      usage,
      strategy,
      messages,
    };
  }

  private hasToolCapabilities(tool: ToolDefinition, input: RunInput): boolean {
    return tool.requiredCapabilities.every((capability) => hasScope(input.principal.scopes, capability)
      && (!input.workspace || input.workspace.capabilities.includes(capability)));
  }

  private selectModel(input: RunInput, required: Set<string>): ModelConfig {
    const policy = input.modelPolicy ?? 'auto';
    const privateRun = input.privacy === 'private' || input.workspace?.allowCloud === false;
    const eligible = this.models
      .filter((model) => model.enabled !== false)
      .filter((model) => this.providers.has(model.providerId))
      .filter((model) => !input.modelId || model.id === input.modelId)
      .filter((model) => [...required].every((capability) => model.capabilities.includes(capability)))
      .filter((model) => policy === 'auto' || model.locality === policy)
      .filter((model) => !privateRun || model.locality === 'local')
      .sort((left, right) => {
        if (policy === 'auto' && left.locality !== right.locality) {
          return left.locality === 'local' ? -1 : 1;
        }
        return (left.priority ?? 0) - (right.priority ?? 0);
      });
    const selected = eligible[0];
    if (!selected) {
      throw new DomainError(
        privateRun ? 'private_model_unavailable' : 'model_unavailable',
        'No model satisfies the requested policy and capabilities.',
        503,
      );
    }
    return selected;
  }

  private assertNotAborted(signal: AbortSignal): void {
    if (signal.aborted) {
      throw signal.reason instanceof Error
        ? signal.reason
        : new DOMException('The operation was aborted.', 'AbortError');
    }
  }
}

class Limiter {
  private readonly active = new Map<string, number>();
  private readonly queues = new Map<string, Array<() => void>>();

  public constructor(private readonly limit: number, private readonly keyed = false) {}

  public async acquire(key: string, signal: AbortSignal): Promise<() => void> {
    if (signal.aborted) {
      throw signal.reason ?? new DOMException('The operation was aborted.', 'AbortError');
    }
    const actualKey = this.keyed ? key : 'global';
    if ((this.active.get(actualKey) ?? 0) >= this.limit) {
      await new Promise<void>((resolve, reject) => {
        const queue = this.queues.get(actualKey) ?? [];
        const resume = (): void => {
          signal.removeEventListener('abort', abort);
          resolve();
        };
        const abort = (): void => {
          const index = queue.indexOf(resume);
          if (index >= 0) {
            queue.splice(index, 1);
          }
          reject(signal.reason ?? new DOMException('The operation was aborted.', 'AbortError'));
        };
        queue.push(resume);
        this.queues.set(actualKey, queue);
        signal.addEventListener('abort', abort, { once: true });
      });
    }
    this.active.set(actualKey, (this.active.get(actualKey) ?? 0) + 1);
    let released = false;
    return () => {
      if (released) {
        return;
      }
      released = true;
      this.active.set(actualKey, Math.max(0, (this.active.get(actualKey) ?? 1) - 1));
      this.queues.get(actualKey)?.shift()?.();
    };
  }

  public async use<T>(key: string, signal: AbortSignal, operation: () => Promise<T>): Promise<T> {
    const release = await this.acquire(key, signal);
    try {
      return await operation();
    } finally {
      release();
    }
  }
}

class BudgetLedger {
  private readonly usage: RunUsage;
  private readonly maxCalls: number;
  private readonly maxTokens: number;

  public constructor(budgets: RunBudgets | undefined, prior: RunUsage | undefined) {
    this.maxCalls = budgets?.maxCalls ?? DEFAULT_MAX_CALLS;
    this.maxTokens = budgets?.maxTokens ?? DEFAULT_MAX_TOKENS;
    if (!Number.isSafeInteger(this.maxCalls) || this.maxCalls < 1
      || !Number.isSafeInteger(this.maxTokens) || this.maxTokens < 1) {
      throw new DomainError('invalid_budget', 'Runtime budgets must be positive safe integers.');
    }
    this.usage = prior ? { ...prior } : {
      calls: 0,
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
    };
    if (this.usage.calls > this.maxCalls || this.usage.totalTokens > this.maxTokens) {
      throw new DomainError('budget_violation', 'Prior usage already exceeds the runtime budget.', 409);
    }
  }

  public availableTokens(): number {
    return Math.max(0, this.maxTokens - this.usage.totalTokens);
  }

  public reserveCall(tokens: number): void {
    if (this.usage.calls >= this.maxCalls) {
      throw new DomainError(
        'call_budget_exceeded',
        `Model call budget of ${this.maxCalls} was exhausted.`,
        429,
      );
    }
    if (!Number.isSafeInteger(tokens) || tokens < 1 || tokens > this.availableTokens()) {
      throw new DomainError('token_budget_exceeded', 'The model request does not fit the remaining token budget.', 429);
    }
    this.usage.calls += 1;
  }

  public addTokens(tokens: { inputTokens: number; outputTokens: number }, reservedTokens: number): boolean {
    this.usage.inputTokens += tokens.inputTokens;
    this.usage.outputTokens += tokens.outputTokens;
    this.usage.totalTokens = this.usage.inputTokens + this.usage.outputTokens;
    return tokens.inputTokens + tokens.outputTokens > reservedTokens
      || this.usage.totalTokens > this.maxTokens;
  }

  public snapshot(): RunUsage {
    return { ...this.usage };
  }
}

function pendingToolCalls(messages: ChatMessage[]): ToolCall[] {
  const completed = new Set(messages
    .filter((message) => message.role === 'tool' && message.toolCallId)
    .map((message) => message.toolCallId));
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role === 'assistant' && message.toolCalls?.length) {
      return message.toolCalls.filter((call) => !completed.has(call.id));
    }
  }
  return [];
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableJson).join(',')}]`;
  }
  if (value && typeof value === 'object') {
    return `{${Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function actionFailureKey(toolCall: ToolCall): string {
  if (toolCall.name === 'terminal.run') {
    return `${toolCall.name}\0${stableJson(toolCall.arguments)}`;
  }
  for (const field of ['path', 'target', 'url', 'resourceId', 'id']) {
    const value = toolCall.arguments[field];
    if (typeof value === 'string' || typeof value === 'number') {
      return `${toolCall.name}\0${field}\0${stableJson(value)}`;
    }
  }
  return `${toolCall.name}\0${stableJson(toolCall.arguments)}`;
}

function unresolvedActionFailures(
  messages: ChatMessage[],
  tools: Map<string, ToolDefinition>,
): Map<string, ActionFailure> {
  const calls = new Map<string, ToolCall>();
  const failures = new Map<string, ActionFailure>();
  for (const message of messages) {
    for (const call of message.toolCalls ?? []) calls.set(call.id, call);
    if (message.role !== 'tool' || !message.toolCallId || !message.name) continue;
    const call = calls.get(message.toolCallId) ?? {
      id: message.toolCallId,
      name: message.name,
      arguments: {},
    };
    const tool = tools.get(call.name);
    if (!tool || tool.sideEffect === 'read') continue;
    const key = actionFailureKey(call);
    if (message.toolOutcome === 'failed') {
      failures.set(key, { tool: tool.name });
    } else if (message.toolOutcome === 'confirmed') {
      failures.delete(key);
    }
  }
  return failures;
}

function actionHash(principalId: string, taskId: string, toolCall: ToolCall): string {
  return createHash('sha256')
    .update(`${principalId}\0${taskId}\0${toolCall.id}\0${toolCall.name}\0${stableJson(toolCall.arguments)}`)
    .digest('hex');
}

function hasScope(grants: string[], scope: string): boolean {
  const namespace = scope.split(':')[0];
  return grants.some((grant) => grant === '*'
    || grant === 'kiancode:*'
    || grant === scope
    || grant === `kiancode:${scope}`
    || grant === `${namespace}:*`);
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError';
}

export function createRuntime(options: RuntimeOptions): AgentRuntime {
  return new AgentRuntime(options);
}
