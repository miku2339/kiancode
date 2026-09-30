import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import type { ToolDefinition } from '../src/contracts.js';
import { OllamaProvider, OpenAICompatibleProvider, type ChatRequest } from '../src/runtime/index.js';

test('OpenAI-compatible provider parses streamed text, tools, and usage', async () => {
  const bodies: unknown[] = [];
  const fetchImpl: typeof fetch = async (_url, init) => {
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    bodies.push(body);
    const safeName = `kc_${createHash('sha256').update('workspace.read').digest('hex').slice(0, 40)}`;
    const chunks = [
      'data: {"choices":[{"delta":{"content":"Hello "}}]}\n\n',
      `data: {"choices":[{"delta":{"content":"world","tool_calls":[{"index":0,"id":"call-1","function":{"name":"${safeName}","arguments":"{\\"q\\":"}}]}}]}\n\n`,
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\\"Kian\\"}"}}]}}],"usage":{"prompt_tokens":9,"completion_tokens":4}}\n\n',
      'data: [DONE]\n\n',
    ];
    return new Response(new ReadableStream({
      start(controller) {
        for (const chunk of chunks) {
          controller.enqueue(new TextEncoder().encode(chunk));
        }
        controller.close();
      },
    }), { status: 200, headers: { 'content-type': 'text/event-stream' } });
  };
  const provider = new OpenAICompatibleProvider({
    id: 'openai-local',
    locality: 'local',
    baseUrl: 'http://127.0.0.1:11434/v1',
    fetch: fetchImpl,
  });
  const tokens: string[] = [];
  const tool: ToolDefinition = {
    name: 'workspace.read',
    description: 'Read workspace data',
    inputSchema: { type: 'object' },
    requiredCapabilities: [],
    sideEffect: 'read',
    async execute() { return { content: '' }; },
  };
  const request: ChatRequest = {
    model: {
      id: 'model-config',
      providerId: provider.id,
      locality: 'local',
      model: 'model-name',
      capabilities: ['tools', 'streaming'],
    },
    messages: [{
      role: 'user',
      content: 'hello',
      attachments: [{ mimeType: 'image/png', data: 'aW1hZ2U=' }],
    }],
    tools: [tool],
    signal: new AbortController().signal,
    onToken(token) {
      tokens.push(token);
    },
  };

  const response = await provider.chat(request);

  assert.equal(response.message.content, 'Hello world');
  assert.deepEqual(response.message.toolCalls, [{
    id: 'call-1',
    name: 'workspace.read',
    arguments: { q: 'Kian' },
  }]);
  assert.deepEqual(response.usage, { inputTokens: 9, outputTokens: 4 });
  assert.deepEqual(tokens, ['Hello ', 'world']);
  const sent = bodies[0] as { tools?: Array<{ function?: { name?: string } }> };
  assert.match(sent.tools?.[0]?.function?.name ?? '', /^kc_[a-f0-9]{40}$/);
  assert.doesNotMatch(sent.tools?.[0]?.function?.name ?? '', /\./);
  const sentMessages = (bodies[0] as { messages: Array<{ content: unknown }> }).messages;
  assert.deepEqual(sentMessages[0]?.content, [
    { type: 'text', text: 'hello' },
    { type: 'image_url', image_url: { url: 'data:image/png;base64,aW1hZ2U=' } },
  ]);
});

test('providers reject insecure remote endpoints and do not expose error bodies', async () => {
  assert.throws(() => new OpenAICompatibleProvider({
    id: 'insecure',
    locality: 'cloud',
    baseUrl: 'http://models.example.com/v1',
  }), /HTTPS/);
  const provider = new OpenAICompatibleProvider({
    id: 'safe-errors',
    locality: 'cloud',
    baseUrl: 'https://models.example.com/v1',
    fetch: async () => new Response('secret-provider-detail', { status: 500 }),
  });
  await assert.rejects(provider.chat({
    model: { id: 'model', providerId: provider.id, locality: 'cloud', capabilities: [] },
    messages: [{ role: 'user', content: 'hello' }],
    tools: [],
    signal: new AbortController().signal,
  }), (error: unknown) => error instanceof Error
    && error.message.includes('HTTP 500')
    && !error.message.includes('secret-provider-detail'));
});

test('Ollama provider parses NDJSON streaming responses', async () => {
  const safeName = `kc_${createHash('sha256').update('workspace.read').digest('hex').slice(0, 40)}`;
  const fetchImpl: typeof fetch = async () => new Response([
    '{"message":{"role":"assistant","content":"本地"},"done":false}\n',
    `{"message":{"role":"assistant","content":"答案","tool_calls":[{"function":{"name":"${safeName}","arguments":{"path":"a"}}}]},"done":false}\n`,
    '{"message":{"role":"assistant","content":""},"done":true,"prompt_eval_count":5,"eval_count":3}\n',
  ].join(''), { status: 200 });
  const provider = new OllamaProvider({ id: 'ollama', baseUrl: 'http://127.0.0.1:11434', fetch: fetchImpl });
  const tool: ToolDefinition = {
    name: 'workspace.read',
    description: 'Read workspace data',
    inputSchema: { type: 'object' },
    requiredCapabilities: [],
    sideEffect: 'read',
    async execute() { return { content: '' }; },
  };
  const response = await provider.chat({
    model: {
      id: 'local',
      providerId: provider.id,
      locality: 'local',
      model: 'qwen',
      capabilities: ['tools'],
    },
    messages: [{ role: 'user', content: '讀取' }],
    tools: [tool],
    signal: new AbortController().signal,
  });

  assert.equal(response.message.content, '本地答案');
  assert.deepEqual(response.message.toolCalls, [{
    id: 'call-1',
    name: 'workspace.read',
    arguments: { path: 'a' },
  }]);
  assert.deepEqual(response.usage, { inputTokens: 5, outputTokens: 3 });
});

test('OpenAI-compatible provider rejects truncated, empty, and unterminated streams', async () => {
  const request = (provider: OpenAICompatibleProvider): ChatRequest => ({
    model: { id: 'model', providerId: provider.id, locality: 'local', capabilities: [] },
    messages: [{ role: 'user', content: 'Use the tool' }],
    tools: [],
    signal: new AbortController().signal,
  });
  const provider = (body: string) => new OpenAICompatibleProvider({
    id: 'openai-local', locality: 'local', baseUrl: 'http://127.0.0.1:11434/v1',
    fetch: async () => new Response(body, { status: 200 }),
  });

  const truncated = provider('data: {"choices":[{"delta":{"content":"\\n\\n"},"finish_reason":"length"}]}\n\ndata: [DONE]\n\n');
  await assert.rejects(truncated.chat(request(truncated)), (error: unknown) => error instanceof Error
    && 'code' in error && error.code === 'provider_output_truncated');

  const empty = provider('data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');
  await assert.rejects(empty.chat(request(empty)), (error: unknown) => error instanceof Error
    && 'code' in error && error.code === 'provider_empty_response');

  const unterminated = provider('data: {"choices":[{"delta":{"content":"partial"}}]}\n\n');
  await assert.rejects(unterminated.chat(request(unterminated)), (error: unknown) => error instanceof Error
    && 'code' in error && error.code === 'provider_protocol_error');
});

test('Ollama provider requires a completed nonempty response and reports output limits', async () => {
  const request = (provider: OllamaProvider): ChatRequest => ({
    model: { id: 'model', providerId: provider.id, locality: 'local', capabilities: [] },
    messages: [{ role: 'user', content: 'Answer' }], tools: [], signal: new AbortController().signal,
  });
  const provider = (body: string) => new OllamaProvider({
    id: 'ollama', baseUrl: 'http://127.0.0.1:11434', fetch: async () => new Response(body),
  });

  const truncated = provider('{"message":{"content":"thinking"},"done":true,"done_reason":"length"}\n');
  await assert.rejects(truncated.chat(request(truncated)), (error: unknown) => error instanceof Error
    && 'code' in error && error.code === 'provider_output_truncated');

  const unterminated = provider('{"message":{"content":"partial"},"done":false}\n');
  await assert.rejects(unterminated.chat(request(unterminated)), (error: unknown) => error instanceof Error
    && 'code' in error && error.code === 'provider_protocol_error');
});
