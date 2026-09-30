import { randomUUID } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport, getDefaultEnvironment } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { ProgressNotificationSchema } from '@modelcontextprotocol/sdk/types.js';
import { Ajv, type ValidateFunction } from 'ajv';
import { Ajv2020 } from 'ajv/dist/2020.js';
import * as formatsModule from 'ajv-formats';
import type { FormatsPlugin } from 'ajv-formats';
import { requireScope } from '../auth.js';
import { DomainError, type ToolDefinition } from '../contracts.js';

export interface McpEnvReference {
  envRef: string;
}

interface McpBaseConfig {
  id: string;
  permission: 'configured';
  timeoutMs?: number;
  readOnlyTools?: string[];
}

export interface McpStdioConfig extends McpBaseConfig {
  transport: 'stdio';
  command: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, McpEnvReference>;
}

export interface McpHttpConfig extends McpBaseConfig {
  transport: 'http';
  url: string;
  headers?: Record<string, McpEnvReference>;
  fetch?: typeof fetch;
}

export type McpServerConfig = McpStdioConfig | McpHttpConfig;

interface McpProgress {
  progress: number;
  total?: number;
  message?: string;
}

const schemaOptions = {
  allErrors: false,
  coerceTypes: false,
  removeAdditional: false,
  strict: true,
  useDefaults: false,
  validateFormats: true,
} as const;
const schemaValidator2020 = new Ajv2020(schemaOptions);
const schemaValidatorDraft7 = new Ajv(schemaOptions);
const addFormats = formatsModule.default as unknown as FormatsPlugin;
addFormats(schemaValidator2020);
addFormats(schemaValidatorDraft7);

function compileInputSchema(schema: Record<string, unknown>): ValidateFunction {
  try {
    const serialized = JSON.stringify(schema);
    if (Buffer.byteLength(serialized) > 256 * 1024) {
      throw new DomainError('invalid_mcp_schema', 'MCP tool input schema exceeds 256 KB', 502);
    }
    const dialect = schema.$schema;
    if (dialect === undefined || dialect === 'https://json-schema.org/draft/2020-12/schema') {
      return schemaValidator2020.compile(schema);
    }
    if (dialect === 'http://json-schema.org/draft-07/schema#' || dialect === 'https://json-schema.org/draft-07/schema#') {
      return schemaValidatorDraft7.compile(schema);
    }
    throw new DomainError('invalid_mcp_schema', 'MCP tool declared an unsupported JSON Schema dialect', 502);
  } catch (error) {
    if (error instanceof DomainError) throw error;
    throw new DomainError('invalid_mcp_schema', 'MCP tool declared an invalid or unsupported input schema', 502);
  }
}

function validateId(id: string): void {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(id)) throw new DomainError('invalid_mcp_config', 'MCP id is invalid');
}

function validateHttpUrl(value: string): URL {
  const url = new URL(value);
  const host = url.hostname.toLowerCase();
  const loopback = host === 'localhost' || host === '127.0.0.1' || host === '[::1]' || host === '::1';
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) {
    throw new DomainError('invalid_mcp_config', 'MCP URL must use HTTPS except for loopback HTTP');
  }
  if (url.username || url.password) throw new DomainError('invalid_mcp_config', 'MCP URL must not include user information');
  return url;
}

function boundedFetch(baseFetch: typeof fetch, timeoutMs: number): typeof fetch {
  return async (input, init = {}) => {
    const timeoutSignal = AbortSignal.timeout(timeoutMs);
    const signal = init.signal ? AbortSignal.any([init.signal, timeoutSignal]) : timeoutSignal;
    return baseFetch(input, { ...init, redirect: 'error', signal });
  };
}

function resolveReferences(values: Record<string, McpEnvReference> | undefined): Record<string, string> {
  const resolved: Record<string, string> = {};
  for (const [key, reference] of Object.entries(values ?? {})) {
    if (!reference || typeof reference !== 'object' || typeof reference.envRef !== 'string' || Object.keys(reference).length !== 1) {
      throw new DomainError('invalid_mcp_config', `${key} must use an envRef`);
    }
    if (!/^[A-Z_][A-Z0-9_]*$/.test(reference.envRef)) throw new DomainError('invalid_mcp_config', `${key} has an invalid envRef`);
    const value = process.env[reference.envRef];
    if (value === undefined) throw new DomainError('missing_mcp_secret', `Environment variable ${reference.envRef} is not set`);
    resolved[key] = value;
  }
  return resolved;
}

function contentBlock(block: Record<string, unknown>): Record<string, unknown> {
  switch (block.type) {
    case 'text':
      return { type: 'text', text: block.text };
    case 'image':
    case 'audio':
      return { type: block.type, mimeType: block.mimeType, data: block.data };
    case 'resource':
      return { type: 'resource', resource: block.resource };
    case 'resource_link':
      return { type: 'resource_link', uri: block.uri, name: block.name, mimeType: block.mimeType };
    default:
      return { type: 'unknown' };
  }
}

export class McpToolProvider {
  private readonly progressByToken = new Map<string, McpProgress[]>();

  private constructor(
    private readonly config: McpServerConfig,
    private readonly client: Client,
    private readonly transport: Transport,
  ) {
    client.setNotificationHandler(ProgressNotificationSchema, (notification) => {
      const progress = this.progressByToken.get(String(notification.params.progressToken));
      if (progress) {
        progress.push({
          progress: notification.params.progress,
          total: notification.params.total,
          message: notification.params.message,
        });
      }
    });
  }

  static async connect(config: McpServerConfig): Promise<McpToolProvider> {
    if (config.permission !== 'configured') throw new DomainError('mcp_permission_required', 'MCP server requires explicit configured permission', 403);
    validateId(config.id);
    let transport: Transport;
    if (config.transport === 'stdio') {
      if (!config.command) throw new DomainError('invalid_mcp_config', 'MCP stdio command is required');
      transport = new StdioClientTransport({
        command: config.command,
        args: config.args,
        cwd: config.cwd,
        env: { ...getDefaultEnvironment(), ...resolveReferences(config.env) },
        stderr: 'pipe',
      });
    } else {
      const url = validateHttpUrl(config.url);
      transport = new StreamableHTTPClientTransport(url, {
        fetch: boundedFetch(config.fetch ?? fetch, config.timeoutMs ?? 60_000),
        requestInit: { headers: resolveReferences(config.headers), redirect: 'error' },
      });
    }
    const client = new Client({ name: 'kiancode', version: '0.1.0' }, { capabilities: {} });
    try {
      await client.connect(transport);
      return new McpToolProvider(config, client, transport);
    } catch (error) {
      await transport.close().catch(() => undefined);
      throw error;
    }
  }

  async listTools(): Promise<Awaited<ReturnType<Client['listTools']>>['tools']> {
    return (await this.client.listTools()).tools;
  }

  async asToolDefinitions(): Promise<ToolDefinition[]> {
    const tools = await this.listTools();
    return tools.map((tool): ToolDefinition => {
      const validateInput = compileInputSchema(tool.inputSchema);
      return {
        name: `mcp.${this.config.id}.${tool.name}`,
        description: tool.description ?? `MCP tool ${tool.name}`,
        inputSchema: tool.inputSchema,
        requiredCapabilities: [`mcp:${this.config.id}`],
        sideEffect: this.config.readOnlyTools?.includes(tool.name) === true && tool.annotations?.readOnlyHint === true ? 'read' : 'external',
        execute: async (input, context) => {
          requireScope(context.principal, `mcp:${this.config.id}`);
          if (!validateInput(input)) {
            throw new DomainError('invalid_tool_input', 'MCP tool input does not match its declared schema');
          }
          const progress: McpProgress[] = [];
          const progressToken = randomUUID();
          this.progressByToken.set(progressToken, progress);
          let result;
          try {
            result = await this.client.callTool(
              { name: tool.name, arguments: input, _meta: { progressToken } },
              undefined,
              { signal: context.signal, timeout: this.config.timeoutMs ?? 60_000 },
            );
          } finally {
            this.progressByToken.delete(progressToken);
          }
          if ('toolResult' in result) {
            return { content: JSON.stringify({ toolResult: result.toolResult, progress }) };
          }
          return {
            content: JSON.stringify({
              content: result.content.map((block) => contentBlock(block as unknown as Record<string, unknown>)),
              structuredContent: result.structuredContent,
              progress,
            }),
            isError: result.isError,
          };
        },
      };
    });
  }

  async close(): Promise<void> {
    await this.client.close();
  }
}
