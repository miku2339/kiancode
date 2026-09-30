import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import { McpToolProvider } from '../src/tools/mcp.js';

test('MCP stdio tools map schemas, progress, and results through ToolDefinition', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'kiancode-mcp-'));
  const serverFile = path.join(directory, 'server.mjs');
  const sdkRoot = path.resolve('node_modules/@modelcontextprotocol/sdk/dist/esm');
  const zodUrl = pathToFileURL(path.resolve('node_modules/zod/index.js')).href;
  const serverUrl = pathToFileURL(path.join(sdkRoot, 'server/mcp.js')).href;
  const transportUrl = pathToFileURL(path.join(sdkRoot, 'server/stdio.js')).href;
  await writeFile(serverFile, `
import { McpServer } from ${JSON.stringify(serverUrl)};
import { StdioServerTransport } from ${JSON.stringify(transportUrl)};
import { z } from ${JSON.stringify(zodUrl)};
const server = new McpServer({ name: 'test-server', version: '1.0.0' });
server.registerTool('echo', { description: 'Echo input', inputSchema: { value: z.string() }, annotations: { readOnlyHint: true } }, async ({ value }, extra) => {
  process.stdout.cork();
  if (extra._meta?.progressToken !== undefined) await extra.sendNotification({ method: 'notifications/progress', params: { progressToken: extra._meta.progressToken, progress: 1, total: 1, message: 'done' } });
  setImmediate(() => process.stdout.uncork());
  return { content: [{ type: 'text', text: value }], structuredContent: { echoed: value } };
});
server.registerTool('claimed-read', { description: 'Untrusted hint', inputSchema: {}, annotations: { readOnlyHint: true } }, async () => ({ content: [{ type: 'text', text: 'ok' }] }));
await server.connect(new StdioServerTransport());
`);
  let provider: McpToolProvider | undefined;
  try {
    provider = await McpToolProvider.connect({
      id: 'test', permission: 'configured', transport: 'stdio', command: process.execPath, args: [serverFile], readOnlyTools: ['echo'],
    });
    const tools = await provider.asToolDefinitions();
    const echo = tools.find((tool) => tool.name === 'mcp.test.echo');
    assert.ok(echo);
    assert.equal(echo.sideEffect, 'read');
    assert.equal(tools.find((tool) => tool.name === 'mcp.test.claimed-read')?.sideEffect, 'external');
    assert.equal((echo.inputSchema.properties as Record<string, unknown>).value !== undefined, true);
    const context = {
      principal: { id: 'user-1', level: 4 as const, scopes: ['mcp:test'] }, taskId: 'task-1', signal: new AbortController().signal,
    };
    await assert.rejects(
      echo.execute({ value: 42 }, context),
      (error: unknown) => error instanceof Error && 'code' in error && error.code === 'invalid_tool_input',
    );
    const result = JSON.parse((await echo.execute({ value: 'hello' }, context)).content) as { content: Array<{ text: string }>; progress: Array<{ message?: string }> };
    assert.equal(result.content[0]?.text, 'hello');
    assert.equal(result.progress[0]?.message, 'done');
  } finally {
    await provider?.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('MCP tool discovery rejects unsupported nested JSON schemas', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'kiancode-mcp-schema-'));
  const serverFile = path.join(directory, 'server.mjs');
  const sdkRoot = path.resolve('node_modules/@modelcontextprotocol/sdk/dist/esm');
  const serverUrl = pathToFileURL(path.join(sdkRoot, 'server/index.js')).href;
  const transportUrl = pathToFileURL(path.join(sdkRoot, 'server/stdio.js')).href;
  const typesUrl = pathToFileURL(path.join(sdkRoot, 'types.js')).href;
  await writeFile(serverFile, `
import { Server } from ${JSON.stringify(serverUrl)};
import { StdioServerTransport } from ${JSON.stringify(transportUrl)};
import { ListToolsRequestSchema } from ${JSON.stringify(typesUrl)};
const server = new Server({ name: 'invalid-schema', version: '1.0.0' }, { capabilities: { tools: {} } });
server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [{
  name: 'unsafe',
  inputSchema: { type: 'object', properties: { value: { type: 'not-a-json-type' } } },
}] }));
await server.connect(new StdioServerTransport());
`);
  let provider: McpToolProvider | undefined;
  try {
    provider = await McpToolProvider.connect({
      id: 'invalid', permission: 'configured', transport: 'stdio', command: process.execPath, args: [serverFile],
    });
    await assert.rejects(
      provider.asToolDefinitions(),
      (error: unknown) => error instanceof Error && 'code' in error && error.code === 'invalid_mcp_schema',
    );
  } finally {
    await provider?.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('MCP configuration rejects literal secret headers and missing env references', async () => {
  await assert.rejects(McpToolProvider.connect({
    id: 'remote', permission: 'configured', transport: 'http', url: 'http://example.com/mcp',
  }), /HTTPS/i);
  await assert.rejects(McpToolProvider.connect({
    id: 'bad', permission: 'configured', transport: 'http', url: 'http://127.0.0.1:1/mcp',
    headers: { authorization: 'Bearer secret' } as never,
  }), /envRef/i);
  await assert.rejects(McpToolProvider.connect({
    id: 'bad', permission: 'configured', transport: 'http', url: 'http://127.0.0.1:1/mcp',
    headers: { authorization: { envRef: 'KIANCODE_TEST_MISSING_SECRET' } },
  }), /not set/i);
});
