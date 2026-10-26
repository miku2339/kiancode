import assert from 'node:assert/strict';
import test from 'node:test';
import type { ToolDefinition } from '../src/contracts.js';
import { OllamaProvider, OpenAICompatibleProvider, type ChatRequest } from '../src/runtime/index.js';

test('OpenAI-compatible provider parses streamed text, tools, and usage', async () => {
  const bodies: unknown[] = [];
  const fetchImpl: typeof fetch = async (_url, init) => {
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    bodies.push(body);
    const safeName = ((body.tools as Array<{ function: { name: string } }>)[0]?.function.name);
    assert.ok(safeName);
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
  assert.match(sent.tools?.[0]?.function?.name ?? '', /^kc_workspace_read_[a-f0-9]{40}$/);
  assert.ok((sent.tools?.[0]?.function?.name?.length ?? Infinity) <= 64);
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
  const fetchImpl: typeof fetch = async (_url, init) => {
    const body = JSON.parse(String(init?.body)) as { tools: Array<{ function: { name: string } }> };
    const safeName = body.tools[0]?.function.name;
    assert.ok(safeName);
    return new Response([
      '{"message":{"role":"assistant","content":"本地"},"done":false}\n',
      `{"message":{"role":"assistant","content":"答案","tool_calls":[{"function":{"name":"${safeName}","arguments":{"path":"a"}}}]},"done":false}\n`,
      '{"message":{"role":"assistant","content":""},"done":true,"prompt_eval_count":5,"eval_count":3}\n',
    ].join(''), { status: 200 });
  };
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

test('provider tool aliases stay readable, distinct, exact, and consistent across history and schema', async () => {
  let sentBody: {
    messages: Array<{ tool_calls?: Array<{ function: { name: string } }> }>;
    tools: Array<{ function: { name: string } }>;
  } | undefined;
  const provider = new OpenAICompatibleProvider({
    id: 'readable-aliases',
    locality: 'local',
    baseUrl: 'http://127.0.0.1:11434/v1',
    fetch: async (_url, init) => {
      sentBody = JSON.parse(String(init?.body)) as typeof sentBody;
      const selected = sentBody?.tools[1]?.function.name;
      assert.ok(selected);
      return new Response([
        `data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call-1","function":{"name":"${selected}","arguments":"{}"}}]},"finish_reason":"tool_calls"}]}\n\n`,
        'data: [DONE]\n\n',
      ].join(''));
    },
  });
  const tools = [
    'workspace.read',
    'workspace/read',
    '工作/工具',
    '',
    'abcdefghijklmnopqrstuvwx',
  ].map((name): ToolDefinition => ({
    name,
    description: name,
    inputSchema: { type: 'object' },
    requiredCapabilities: [],
    sideEffect: 'read',
    async execute() { return { content: '' }; },
  }));

  const response = await provider.chat({
    model: { id: 'model', providerId: provider.id, locality: 'local', capabilities: ['tools'] },
    messages: [{
      role: 'assistant',
      content: '',
      toolCalls: [{ id: 'previous-call', name: 'workspace/read', arguments: {} }],
    }],
    tools,
    signal: new AbortController().signal,
  });

  const aliases = sentBody?.tools.map((tool) => tool.function.name) ?? [];
  assert.equal(aliases.length, 5);
  assert.match(aliases[0] ?? '', /^kc_workspace_read_[a-f0-9]{40}$/);
  assert.match(aliases[1] ?? '', /^kc_workspace_read_[a-f0-9]{40}$/);
  assert.match(aliases[2] ?? '', /^kc_{7}[a-f0-9]{40}$/);
  assert.match(aliases[3] ?? '', /^kc_tool_[a-f0-9]{40}$/);
  assert.match(aliases[4] ?? '', /^kc_abcdefghijklmnopqrst_[a-f0-9]{40}$/);
  assert.equal(aliases[4]?.length, 64);
  assert.ok(aliases.every((name) => name.length <= 64 && /^[A-Za-z0-9_-]+$/.test(name)));
  assert.equal(new Set(aliases).size, aliases.length);
  assert.equal(sentBody?.messages[0]?.tool_calls?.[0]?.function.name, aliases[1]);
  assert.equal(response.message.toolCalls?.[0]?.name, 'workspace/read');
});

test('provider rejects guessed tool aliases even when their prefix or hash suffix looks valid', async () => {
  for (const alteration of ['suffix', 'prefix'] as const) {
    const provider = new OpenAICompatibleProvider({
      id: `exact-alias-${alteration}`,
      locality: 'local',
      baseUrl: 'http://127.0.0.1:11434/v1',
      fetch: async (_url, init) => {
        const body = JSON.parse(String(init?.body)) as { tools: Array<{ function: { name: string } }> };
        const exposed = body.tools[0]?.function.name;
        assert.ok(exposed);
        const guessed = alteration === 'suffix'
          ? `${exposed.slice(0, -1)}${exposed.endsWith('0') ? '1' : '0'}`
          : exposed.replace(/^kc_[A-Za-z0-9_-]{1,20}_/, 'kc_workspace_write_');
        assert.notEqual(guessed, exposed);
        return new Response([
          `data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call-1","function":{"name":"${guessed}","arguments":"{}"}}]},"finish_reason":"tool_calls"}]}\n\n`,
          'data: [DONE]\n\n',
        ].join(''));
      },
    });

    await assert.rejects(provider.chat({
      model: { id: 'model', providerId: provider.id, locality: 'local', capabilities: ['tools'] },
      messages: [{ role: 'user', content: 'Use the tool' }],
      tools: [{
        name: 'workspace.read',
        description: 'Read workspace data',
        inputSchema: { type: 'object' },
        requiredCapabilities: [],
        sideEffect: 'read',
        async execute() { return { content: '' }; },
      }],
      signal: new AbortController().signal,
    }), (error: unknown) => error instanceof Error
      && 'code' in error && error.code === 'provider_protocol_error');
  }
});

test('streaming providers preserve partial usage instead of coercing missing fields to zero', async () => {
  const openai = new OpenAICompatibleProvider({
    id: 'openai-partial', locality: 'local', baseUrl: 'http://127.0.0.1:11434/v1',
    fetch: async () => new Response([
      'data: {"choices":[{"delta":{"content":"answer"},"finish_reason":"stop"}],"usage":{"prompt_tokens":9}}\n\n',
      'data: [DONE]\n\n',
    ].join(''), { status: 200 }),
  });
  const request: ChatRequest = {
    model: { id: 'model', providerId: openai.id, locality: 'local', capabilities: [] },
    messages: [{ role: 'user', content: 'answer' }], tools: [], signal: new AbortController().signal,
  };
  assert.deepEqual((await openai.chat(request)).usage, { inputTokens: 9 });

  const ollama = new OllamaProvider({
    id: 'ollama-partial', baseUrl: 'http://127.0.0.1:11434',
    fetch: async () => new Response('{"message":{"content":"answer"},"done":true,"done_reason":"stop","eval_count":3}\n'),
  });
  assert.deepEqual(await ollama.chat({
    ...request,
    model: { ...request.model, providerId: ollama.id },
  }).then((response) => response.usage), { outputTokens: 3 });
});

test('streaming provider body timeouts use the stable provider timeout error', async () => {
  const timedFetch = (chunk: string): typeof fetch => async (_url, init) => new Response(new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(chunk));
      init?.signal?.addEventListener('abort', () => controller.error(init.signal?.reason), { once: true });
    },
  }));
  const openai = new OpenAICompatibleProvider({
    id: 'openai-timeout',
    locality: 'local',
    baseUrl: 'http://127.0.0.1:11434/v1',
    fetch: timedFetch('data: {"choices":[{"delta":{"content":"partial"}}]}\n\n'),
    timeoutMs: 1_000,
  });
  const ollama = new OllamaProvider({
    id: 'ollama-timeout',
    baseUrl: 'http://127.0.0.1:11434',
    fetch: timedFetch('{"message":{"content":"partial"},"done":false}\n'),
    timeoutMs: 1_000,
  });
  const request = (provider: OpenAICompatibleProvider | OllamaProvider): ChatRequest => ({
    model: { id: 'model', providerId: provider.id, locality: 'local', capabilities: [] },
    messages: [{ role: 'user', content: 'Answer' }],
    tools: [],
    signal: new AbortController().signal,
  });
  const providerTimeout = (error: unknown) => error instanceof Error
    && 'code' in error && error.code === 'provider_timeout';

  await Promise.all([
    assert.rejects(openai.chat(request(openai)), providerTimeout),
    assert.rejects(ollama.chat(request(ollama)), providerTimeout),
  ]);
});

test('streaming providers preserve the caller abort reason', async () => {
  const controller = new AbortController();
  const reason = new Error('caller stopped');
  const provider = new OpenAICompatibleProvider({
    id: 'openai-abort',
    locality: 'local',
    baseUrl: 'http://127.0.0.1:11434/v1',
    timeoutMs: 120_000,
    fetch: async (_url, init) => new Response(new ReadableStream({
      start(stream) {
        stream.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"content":"partial"}}]}\n\n'));
        init?.signal?.addEventListener('abort', () => stream.error(init.signal?.reason), { once: true });
      },
    })),
  });
  const pending = provider.chat({
    model: { id: 'model', providerId: provider.id, locality: 'local', capabilities: [] },
    messages: [{ role: 'user', content: 'Answer' }],
    tools: [],
    signal: controller.signal,
  });
  setTimeout(() => controller.abort(reason), 10);

  await assert.rejects(pending, (error: unknown) => error === reason);
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
