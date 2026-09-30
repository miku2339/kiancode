import { createHash } from 'node:crypto';
import { DomainError, type ToolDefinition, type Workspace } from '../contracts.js';
import type {
  ChatMessage,
  ChatRequest,
  ChatResponse,
  ModelConfig,
  ModelLocality,
  ModelProvider,
  TokenUsage,
  ToolCall,
} from './types.js';

interface BaseProviderOptions {
  id: string;
  baseUrl: string;
  fetch?: typeof fetch;
  headers?: Record<string, string>;
  timeoutMs?: number;
  maxResponseBytes?: number;
  availability?: (model: ModelConfig, workspace: Workspace | undefined, signal: AbortSignal) => Promise<boolean>;
}

export interface OpenAICompatibleProviderOptions extends BaseProviderOptions {
  locality: ModelLocality;
  apiKey?: string;
}

export interface OllamaProviderOptions extends BaseProviderOptions {
  id: string;
}

interface OpenAIStreamToolCall {
  index: number;
  id?: string;
  function?: { name?: string; arguments?: string };
}

export class OpenAICompatibleProvider implements ModelProvider {
  public readonly id: string;
  public readonly locality: ModelLocality;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly headers: Record<string, string>;
  private readonly availability?: BaseProviderOptions['availability'];
  private readonly timeoutMs: number;
  private readonly maxResponseBytes: number;

  public constructor(options: OpenAICompatibleProviderOptions) {
    this.id = options.id;
    this.locality = options.locality;
    this.baseUrl = validateBaseUrl(options.baseUrl, options.locality);
    this.fetchImpl = options.fetch ?? globalThis.fetch;
    this.headers = {
      'content-type': 'application/json',
      ...options.headers,
      ...(options.apiKey ? { authorization: `Bearer ${options.apiKey}` } : {}),
    };
    this.availability = options.availability;
    this.timeoutMs = boundedInteger(options.timeoutMs, 30_000, 1_000, 120_000);
    this.maxResponseBytes = boundedInteger(options.maxResponseBytes, 10 * 1024 * 1024, 1_024, 50 * 1024 * 1024);
  }

  public async isAvailable(
    model: ModelConfig,
    workspace: Workspace | undefined,
    signal: AbortSignal,
  ): Promise<boolean> {
    return this.availability ? this.availability(model, workspace, signal) : true;
  }

  public async chat(request: ChatRequest): Promise<ChatResponse> {
    const names = new FunctionNames();
    const signal = AbortSignal.any([request.signal, AbortSignal.timeout(this.timeoutMs)]);
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: this.headers,
        body: JSON.stringify({
          model: request.model.model ?? request.model.id,
          messages: request.messages.map((message) => openAIMessage(message, names)),
          ...(request.tools.length ? { tools: request.tools.map((tool) => openAITool(tool, names)) } : {}),
          stream: true,
          stream_options: { include_usage: true },
          max_tokens: request.maxOutputTokens ?? 4096,
        }),
        signal,
        redirect: 'error',
      });
    } catch (error) {
      throw providerFetchError(error, request.signal, this.id);
    }
    await assertOk(response, this.id);
    if (!response.body) {
      throw new DomainError('provider_protocol_error', `${this.id} returned an empty stream.`, 502);
    }
    let content = '';
    let usage: TokenUsage = { inputTokens: 0, outputTokens: 0 };
    const calls = new Map<number, { id: string; name: string; arguments: string }>();
    let sawDone = false;
    let finishReason: string | undefined;
    for await (const event of readSse(response.body, this.maxResponseBytes)) {
      if (event === '[DONE]') {
        sawDone = true;
        break;
      }
      const chunk = parseJson(event, this.id) as {
        choices?: Array<{
          delta?: { content?: string; tool_calls?: OpenAIStreamToolCall[] };
          finish_reason?: string | null;
        }>;
        usage?: { prompt_tokens?: number; completion_tokens?: number };
      };
      const delta = chunk.choices?.[0]?.delta;
      const reason = chunk.choices?.[0]?.finish_reason;
      if (typeof reason === 'string') finishReason = reason;
      if (delta?.content) {
        content += delta.content;
        await request.onToken?.(delta.content);
      }
      for (const part of delta?.tool_calls ?? []) {
        const existing = calls.get(part.index) ?? { id: '', name: '', arguments: '' };
        existing.id = part.id ?? existing.id;
        existing.name += part.function?.name ?? '';
        existing.arguments += part.function?.arguments ?? '';
        calls.set(part.index, existing);
      }
      if (chunk.usage) {
        usage = {
          inputTokens: chunk.usage.prompt_tokens ?? 0,
          outputTokens: chunk.usage.completion_tokens ?? 0,
        };
      }
    }
    assertOpenAICompletion(this.id, sawDone, finishReason, content, calls.size);
    const toolCalls = [...calls.entries()]
      .sort(([left], [right]) => left - right)
      .map(([, call], index): ToolCall => ({
        id: call.id || `call-${index + 1}`,
        name: names.decode(call.name),
        arguments: parseArguments(call.arguments, this.id),
      }));
    return {
      message: {
        role: 'assistant',
        content,
        ...(toolCalls.length ? { toolCalls } : {}),
      },
      usage,
    };
  }
}

export class OllamaProvider implements ModelProvider {
  public readonly id: string;
  public readonly locality = 'local' as const;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly headers: Record<string, string>;
  private readonly availability?: BaseProviderOptions['availability'];
  private readonly timeoutMs: number;
  private readonly maxResponseBytes: number;

  public constructor(options: OllamaProviderOptions) {
    this.id = options.id;
    this.baseUrl = validateBaseUrl(options.baseUrl, 'local');
    this.fetchImpl = options.fetch ?? globalThis.fetch;
    this.headers = { 'content-type': 'application/json', ...options.headers };
    this.availability = options.availability;
    this.timeoutMs = boundedInteger(options.timeoutMs, 30_000, 1_000, 120_000);
    this.maxResponseBytes = boundedInteger(options.maxResponseBytes, 10 * 1024 * 1024, 1_024, 50 * 1024 * 1024);
  }

  public async isAvailable(
    model: ModelConfig,
    workspace: Workspace | undefined,
    signal: AbortSignal,
  ): Promise<boolean> {
    return this.availability ? this.availability(model, workspace, signal) : true;
  }

  public async chat(request: ChatRequest): Promise<ChatResponse> {
    const names = new FunctionNames();
    const signal = AbortSignal.any([request.signal, AbortSignal.timeout(this.timeoutMs)]);
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}/api/chat`, {
        method: 'POST',
        headers: this.headers,
        body: JSON.stringify({
          model: request.model.model ?? request.model.id,
          messages: request.messages.map((message) => ollamaMessage(message, names)),
          ...(request.tools.length ? { tools: request.tools.map((tool) => ollamaTool(tool, names)) } : {}),
          stream: true,
          options: { num_predict: request.maxOutputTokens ?? 4096 },
        }),
        signal,
        redirect: 'error',
      });
    } catch (error) {
      throw providerFetchError(error, request.signal, this.id);
    }
    await assertOk(response, this.id);
    if (!response.body) {
      throw new DomainError('provider_protocol_error', `${this.id} returned an empty stream.`, 502);
    }
    let content = '';
    let usage: TokenUsage = { inputTokens: 0, outputTokens: 0 };
    const toolCalls: ToolCall[] = [];
    let sawDone = false;
    let doneReason: string | undefined;
    for await (const line of readLines(response.body, this.maxResponseBytes)) {
      if (!line.trim()) {
        continue;
      }
      const chunk = parseJson(line, this.id) as {
        message?: {
          content?: string;
          tool_calls?: Array<{ function?: { name?: string; arguments?: Record<string, unknown> } }>;
        };
        prompt_eval_count?: number;
        eval_count?: number;
        done?: boolean;
        done_reason?: string;
      };
      if (chunk.done === true) sawDone = true;
      if (typeof chunk.done_reason === 'string') doneReason = chunk.done_reason;
      const token = chunk.message?.content ?? '';
      if (token) {
        content += token;
        await request.onToken?.(token);
      }
      for (const call of chunk.message?.tool_calls ?? []) {
        if (call.function?.name) {
          toolCalls.push({
            id: `call-${toolCalls.length + 1}`,
            name: names.decode(call.function.name),
            arguments: call.function.arguments ?? {},
          });
        }
      }
      if (chunk.prompt_eval_count !== undefined || chunk.eval_count !== undefined) {
        usage = {
          inputTokens: chunk.prompt_eval_count ?? 0,
          outputTokens: chunk.eval_count ?? 0,
        };
      }
    }
    assertOllamaCompletion(this.id, sawDone, doneReason, content, toolCalls.length);
    return {
      message: {
        role: 'assistant',
        content,
        ...(toolCalls.length ? { toolCalls } : {}),
      },
      usage,
    };
  }
}

function assertOpenAICompletion(
  providerId: string,
  sawDone: boolean,
  finishReason: string | undefined,
  content: string,
  toolCallCount: number,
): void {
  if (!sawDone && !finishReason) {
    throw new DomainError('provider_protocol_error', `${providerId} ended before a completion marker.`, 502);
  }
  if (finishReason === 'length' || finishReason === 'max_tokens') {
    throw new DomainError('provider_output_truncated', `${providerId} exhausted the model output limit.`, 502);
  }
  if (finishReason === 'content_filter') {
    throw new DomainError('provider_content_filtered', `${providerId} blocked the model response.`, 502);
  }
  if (!content.trim() && toolCallCount === 0) {
    throw new DomainError('provider_empty_response', `${providerId} returned no answer or tool call.`, 502);
  }
}

function assertOllamaCompletion(
  providerId: string,
  sawDone: boolean,
  doneReason: string | undefined,
  content: string,
  toolCallCount: number,
): void {
  if (!sawDone) {
    throw new DomainError('provider_protocol_error', `${providerId} ended before a completion marker.`, 502);
  }
  if (doneReason === 'length' || doneReason === 'max_tokens') {
    throw new DomainError('provider_output_truncated', `${providerId} exhausted the model output limit.`, 502);
  }
  if (!content.trim() && toolCallCount === 0) {
    throw new DomainError('provider_empty_response', `${providerId} returned no answer or tool call.`, 502);
  }
}

function openAIMessage(message: ChatMessage, names: FunctionNames): Record<string, unknown> {
  if (message.role === 'tool') {
    return { role: 'tool', content: message.content, tool_call_id: message.toolCallId };
  }
  const content = message.attachments?.length
    ? [
        { type: 'text', text: message.content },
        ...message.attachments.map((attachment) => ({
          type: 'image_url',
          image_url: { url: `data:${attachment.mimeType};base64,${attachment.data}` },
        })),
      ]
    : message.content;
  return {
    role: message.role,
    content,
    ...(message.toolCalls?.length ? {
      tool_calls: message.toolCalls.map((call) => ({
        id: call.id,
        type: 'function',
        function: { name: names.encode(call.name), arguments: JSON.stringify(call.arguments) },
      })),
    } : {}),
  };
}

function ollamaMessage(message: ChatMessage, names: FunctionNames): Record<string, unknown> {
  return {
    role: message.role === 'tool' ? 'tool' : message.role,
    content: message.content,
    ...(message.attachments?.length ? { images: message.attachments.map((attachment) => attachment.data) } : {}),
    ...(message.toolCalls?.length ? {
      tool_calls: message.toolCalls.map((call) => ({
        function: { name: names.encode(call.name), arguments: call.arguments },
      })),
    } : {}),
  };
}

function openAITool(tool: ToolDefinition, names: FunctionNames): Record<string, unknown> {
  return {
    type: 'function',
    function: { name: names.encode(tool.name), description: tool.description, parameters: tool.inputSchema },
  };
}

function ollamaTool(tool: ToolDefinition, names: FunctionNames): Record<string, unknown> {
  return {
    type: 'function',
    function: { name: names.encode(tool.name), description: tool.description, parameters: tool.inputSchema },
  };
}

async function assertOk(response: Response, providerId: string): Promise<void> {
  if (response.ok) {
    return;
  }
  throw new DomainError(
    'provider_request_failed',
    `${providerId} returned HTTP ${response.status}.`,
    502,
  );
}

async function* readSse(body: ReadableStream<Uint8Array>, maxBytes: number): AsyncGenerator<string> {
  let event = '';
  for await (const line of readLines(body, maxBytes)) {
    if (line === '') {
      if (event) {
        yield event;
        event = '';
      }
    } else if (line.startsWith('data:')) {
      event += `${event ? '\n' : ''}${line.slice(5).trimStart()}`;
    }
  }
  if (event) {
    yield event;
  }
}

async function* readLines(body: ReadableStream<Uint8Array>, maxBytes: number): AsyncGenerator<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let received = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) {
        break;
      }
      received += value.byteLength;
      if (received > maxBytes) {
        throw new DomainError('provider_response_too_large', 'Model response exceeded the configured size limit.', 502);
      }
      buffer += decoder.decode(value, { stream: true });
      let newline = buffer.indexOf('\n');
      while (newline >= 0) {
        const raw = buffer.slice(0, newline);
        yield raw.endsWith('\r') ? raw.slice(0, -1) : raw;
        buffer = buffer.slice(newline + 1);
        newline = buffer.indexOf('\n');
      }
    }
    buffer += decoder.decode();
    if (buffer) {
      yield buffer;
    }
  } finally {
    reader.releaseLock();
  }
}

function parseJson(value: string, providerId: string): unknown {
  try {
    return JSON.parse(value);
  } catch (error) {
    throw new DomainError(
      'provider_protocol_error',
      `${providerId} returned invalid JSON: ${error instanceof Error ? error.message : String(error)}.`,
      502,
    );
  }
}

function parseArguments(value: string, providerId: string): Record<string, unknown> {
  if (!value) {
    return {};
  }
  const parsed = parseJson(value, providerId);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new DomainError('provider_protocol_error', `${providerId} returned non-object tool arguments.`, 502);
  }
  return parsed as Record<string, unknown>;
}

class FunctionNames {
  private readonly encoded = new Map<string, string>();
  private readonly decoded = new Map<string, string>();

  public encode(name: string): string {
    const previous = this.encoded.get(name);
    if (previous) {
      return previous;
    }
    const safe = `kc_${createHash('sha256').update(name).digest('hex').slice(0, 40)}`;
    const collision = this.decoded.get(safe);
    if (collision && collision !== name) {
      throw new DomainError('tool_name_collision', 'Two tool names produced the same provider-safe identifier.', 500);
    }
    this.encoded.set(name, safe);
    this.decoded.set(safe, name);
    return safe;
  }

  public decode(name: string): string {
    const decoded = this.decoded.get(name);
    if (!decoded) {
      throw new DomainError('provider_protocol_error', 'Model requested a tool that was not exposed.', 502);
    }
    return decoded;
  }
}

function validateBaseUrl(value: string, locality: ModelLocality): string {
  const url = new URL(value);
  const loopback = ['localhost', '127.0.0.1', '[::1]', '::1'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(locality === 'local' && loopback && url.protocol === 'http:')) {
    throw new Error('Provider endpoint must use HTTPS; local providers may use HTTP only on loopback.');
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error('Provider endpoint must not contain credentials, query parameters, or fragments.');
  }
  return url.toString().replace(/\/$/, '');
}

function boundedInteger(value: number | undefined, fallback: number, minimum: number, maximum: number): number {
  const selected = value ?? fallback;
  if (!Number.isInteger(selected) || selected < minimum || selected > maximum) {
    throw new Error(`Provider limit must be an integer between ${minimum} and ${maximum}.`);
  }
  return selected;
}

function providerFetchError(error: unknown, callerSignal: AbortSignal, providerId: string): Error {
  if (callerSignal.aborted) {
    return callerSignal.reason instanceof Error
      ? callerSignal.reason
      : new DOMException('The operation was aborted.', 'AbortError');
  }
  if (error instanceof DOMException && error.name === 'TimeoutError') {
    return new DomainError('provider_timeout', `${providerId} did not respond before the timeout.`, 504);
  }
  return new DomainError('provider_unavailable', `${providerId} is unavailable.`, 503);
}
