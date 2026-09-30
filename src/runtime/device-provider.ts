import { DomainError, type ToolContext, type ToolDefinition, type ToolResult } from '../contracts.js';
import { OllamaProvider, OpenAICompatibleProvider } from './providers.js';
import type {
  ChatMessage,
  ChatRequest,
  ChatResponse,
  ModelConfig,
  ModelProvider,
  ToolCall,
} from './types.js';
import type { EphemeralAttachmentPayload, EphemeralPayloadStore } from './visual-context.js';

export interface DeviceModelDispatcher {
  executeModel(
    deviceId: string,
    input: Record<string, unknown>,
    context: ToolContext,
  ): Promise<ToolResult>;
}

export interface DeviceModelProviderOptions {
  id: string;
  dispatcher: DeviceModelDispatcher;
  ephemeralPayloads?: EphemeralPayloadStore;
}

export interface LocalInferenceModelConfig {
  id: string;
  type: 'openai' | 'ollama';
  baseUrl: string;
  model: string;
  capabilities: string[];
  apiKey?: string;
}

export interface LocalModelToolOptions {
  models: LocalInferenceModelConfig[];
  fetch?: typeof fetch;
}

interface WireTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  requiredCapabilities: string[];
  sideEffect: ToolDefinition['sideEffect'];
  requiresWorkspace?: boolean;
}

export class DeviceModelProvider implements ModelProvider {
  public readonly locality = 'local' as const;
  public readonly id: string;
  private readonly dispatcher: DeviceModelDispatcher;
  private readonly ephemeralPayloads?: EphemeralPayloadStore;

  public constructor(options: DeviceModelProviderOptions) {
    this.id = options.id;
    this.dispatcher = options.dispatcher;
    this.ephemeralPayloads = options.ephemeralPayloads;
  }

  public async chat(request: ChatRequest): Promise<ChatResponse> {
    const context = request.context;
    const deviceId = request.model.deviceId;
    if (!context || !deviceId) {
      throw new DomainError(
        'device_model_context_required',
        'Device model calls require a principal, task, and configured device.',
        500,
      );
    }
    const staged = stageEphemeralMessages(request.messages);
    let ephemeralPayloadRef: string | undefined;
    if (staged.attachments.length > 0) {
      if (!this.ephemeralPayloads) {
        throw new DomainError('ephemeral_context_unavailable', 'Ephemeral visual context is unavailable.', 503);
      }
      ephemeralPayloadRef = this.ephemeralPayloads.stagePayload(
        context.principal.id,
        context.taskId,
        { attachments: staged.attachments },
      );
    }
    const result = await this.dispatcher.executeModel(deviceId, {
      operation: 'chat',
      modelId: request.model.id,
      messages: staged.messages,
      tools: request.tools.map(wireTool),
      requiredCapabilities: request.model.capabilities,
      maxOutputTokens: request.maxOutputTokens ?? 4096,
      ...(ephemeralPayloadRef ? { ephemeralPayloadRef } : {}),
    }, {
      principal: context.principal,
      taskId: context.taskId,
      signal: request.signal,
    });
    if (result.isError) {
      if (result.content === 'ephemeral_context_missing') {
        throw new DomainError(
          'ephemeral_context_missing',
          'The visual context expired or was lost before local inference started.',
          503,
        );
      }
      throw new DomainError('provider_request_failed', 'Device model generation failed.', 502);
    }
    const response = parseChatResponse(result.content);
    if (response.message.content) {
      await request.onToken?.(response.message.content);
    }
    return response;
  }
}

function stageEphemeralMessages(messages: ChatMessage[]): {
  messages: ChatMessage[];
  attachments: EphemeralAttachmentPayload[];
} {
  const attachments: EphemeralAttachmentPayload[] = [];
  const sanitized = messages.map((message, messageIndex) => {
    if (!message.attachments?.some((attachment) => attachment.ephemeral)) return message;
    const retained = message.attachments.filter((attachment, attachmentIndex) => {
      if (!attachment.ephemeral) return true;
      attachments.push({
        messageIndex,
        attachmentIndex,
        mimeType: attachment.mimeType,
        data: attachment.data,
      });
      return false;
    });
    return {
      ...message,
      ...(retained.length ? { attachments: retained } : { attachments: undefined }),
    };
  });
  return { messages: sanitized, attachments };
}

export function createLocalModelTool(options: LocalModelToolOptions): ToolDefinition {
  const models = new Map<string, {
    config: ModelConfig;
    provider: ModelProvider;
  }>();
  for (const model of options.models) {
    if (models.has(model.id)) {
      throw new Error(`Duplicate local inference model id: ${model.id}`);
    }
    assertLoopbackProvider(model.baseUrl);
    const provider = model.type === 'ollama'
      ? new OllamaProvider({
          id: `local-tool:${model.id}`,
          baseUrl: model.baseUrl,
          ...(options.fetch ? { fetch: options.fetch } : {}),
        })
      : new OpenAICompatibleProvider({
          id: `local-tool:${model.id}`,
          locality: 'local',
          baseUrl: model.baseUrl,
          ...(model.apiKey ? { apiKey: model.apiKey } : {}),
          ...(options.fetch ? { fetch: options.fetch } : {}),
        });
    models.set(model.id, {
      provider,
      config: {
        id: model.id,
        providerId: provider.id,
        locality: 'local',
        model: model.model,
        capabilities: [...model.capabilities],
        capabilitiesVerified: false,
      },
    });
  }
  return {
    name: 'model.generate',
    description: 'Generate one model response using an allowlisted loopback inference provider.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        operation: { const: 'chat' },
        modelId: { type: 'string' },
        messages: { type: 'array' },
        tools: { type: 'array' },
        requiredCapabilities: { type: 'array', items: { type: 'string' } },
      },
      required: ['operation', 'modelId', 'messages', 'tools', 'requiredCapabilities'],
    },
    requiredCapabilities: ['model:generate'],
    requiresWorkspace: false,
    sideEffect: 'read',
    async execute(input, context) {
      if (input.operation !== 'chat' || typeof input.modelId !== 'string') {
        throw new DomainError('invalid_input', 'Invalid local model request.');
      }
      const selected = models.get(input.modelId);
      if (!selected) {
        throw new DomainError('model_not_allowed', 'The requested local model is not allowlisted.', 403);
      }
      const messages = parseMessages(input.messages);
      const tools = parseWireTools(input.tools);
      const requiredCapabilities = stringArray(input.requiredCapabilities, 'requiredCapabilities');
      if (requiredCapabilities.some((capability) => !selected.config.capabilities.includes(capability))) {
        throw new DomainError('model_capability_unavailable', 'The local model lacks a required capability.', 400);
      }
      const response = await selected.provider.chat({
        model: selected.config,
        messages,
        tools: tools.map(fromWireTool),
        signal: context.signal,
        maxOutputTokens: typeof input.maxOutputTokens === 'number' && Number.isSafeInteger(input.maxOutputTokens) && input.maxOutputTokens > 0 ? Math.min(input.maxOutputTokens, 16_384) : 4096,
      });
      return { content: JSON.stringify(response) };
    },
  };
}

function wireTool(tool: ToolDefinition): WireTool {
  return {
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema,
    requiredCapabilities: tool.requiredCapabilities,
    sideEffect: tool.sideEffect,
    ...(tool.requiresWorkspace !== undefined ? { requiresWorkspace: tool.requiresWorkspace } : {}),
  };
}

function fromWireTool(tool: WireTool): ToolDefinition {
  return {
    ...tool,
    async execute() {
      throw new DomainError('invalid_tool_execution', 'Inference schemas cannot execute tools on the device.', 500);
    },
  };
}

function parseChatResponse(content: string): ChatResponse {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    throw new DomainError('provider_protocol_error', 'Device model returned invalid JSON.', 502);
  }
  if (!isRecord(parsed) || !isRecord(parsed.message) || parsed.message.role !== 'assistant'
    || typeof parsed.message.content !== 'string' || !isRecord(parsed.usage)
    || !nonnegativeNumber(parsed.usage.inputTokens) || !nonnegativeNumber(parsed.usage.outputTokens)) {
    throw new DomainError('provider_protocol_error', 'Device model returned an invalid response.', 502);
  }
  const toolCalls = parsed.message.toolCalls === undefined
    ? undefined
    : parseToolCalls(parsed.message.toolCalls);
  return {
    message: {
      role: 'assistant',
      content: parsed.message.content,
      ...(toolCalls ? { toolCalls } : {}),
    },
    usage: {
      inputTokens: parsed.usage.inputTokens,
      outputTokens: parsed.usage.outputTokens,
    },
  };
}

function parseMessages(value: unknown): ChatMessage[] {
  if (!Array.isArray(value) || value.length > 200) {
    throw new DomainError('invalid_input', 'messages must be a bounded array.');
  }
  return value.map((item) => {
    if (!isRecord(item) || !['system', 'user', 'assistant', 'tool'].includes(String(item.role))
      || typeof item.content !== 'string') {
      throw new DomainError('invalid_input', 'A model message is invalid.');
    }
    const role = item.role as ChatMessage['role'];
    const toolCalls = item.toolCalls === undefined ? undefined : parseToolCalls(item.toolCalls);
    const attachments = item.attachments === undefined ? undefined : parseAttachments(item.attachments);
    return {
      role,
      content: item.content,
      ...(typeof item.name === 'string' ? { name: item.name } : {}),
      ...(typeof item.toolCallId === 'string' ? { toolCallId: item.toolCallId } : {}),
      ...(toolCalls ? { toolCalls } : {}),
      ...(attachments ? { attachments } : {}),
    };
  });
}

function parseAttachments(value: unknown): Array<{ mimeType: string; data: string }> {
  if (!Array.isArray(value) || value.length > 10) {
    throw new DomainError('invalid_input', 'attachments must be a bounded array.');
  }
  return value.map((item) => {
    if (!isRecord(item) || typeof item.mimeType !== 'string' || typeof item.data !== 'string') {
      throw new DomainError('invalid_input', 'A model attachment is invalid.');
    }
    return { mimeType: item.mimeType, data: item.data };
  });
}

function parseToolCalls(value: unknown): ToolCall[] {
  if (!Array.isArray(value) || value.length > 100) {
    throw new DomainError('provider_protocol_error', 'Device model returned invalid tool calls.', 502);
  }
  return value.map((item) => {
    if (!isRecord(item) || typeof item.id !== 'string' || typeof item.name !== 'string'
      || !isRecord(item.arguments)) {
      throw new DomainError('provider_protocol_error', 'Device model returned an invalid tool call.', 502);
    }
    return { id: item.id, name: item.name, arguments: item.arguments };
  });
}

function parseWireTools(value: unknown): WireTool[] {
  if (!Array.isArray(value) || value.length > 100) {
    throw new DomainError('invalid_input', 'tools must be a bounded array.');
  }
  return value.map((item) => {
    if (!isRecord(item) || typeof item.name !== 'string' || typeof item.description !== 'string'
      || !isRecord(item.inputSchema) || !['read', 'write', 'external'].includes(String(item.sideEffect))) {
      throw new DomainError('invalid_input', 'A model tool schema is invalid.');
    }
    return {
      name: item.name,
      description: item.description,
      inputSchema: item.inputSchema,
      requiredCapabilities: stringArray(item.requiredCapabilities, 'requiredCapabilities'),
      sideEffect: item.sideEffect as ToolDefinition['sideEffect'],
      ...(typeof item.requiresWorkspace === 'boolean' ? { requiresWorkspace: item.requiresWorkspace } : {}),
    };
  });
}

function stringArray(value: unknown, name: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    throw new DomainError('invalid_input', `${name} must be an array of strings.`);
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function nonnegativeNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function assertLoopbackProvider(value: string): void {
  const url = new URL(value);
  if (!['localhost', '127.0.0.1', '[::1]', '::1'].includes(url.hostname)) {
    throw new Error('Local inference provider must use a loopback hostname.');
  }
}
