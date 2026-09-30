import { createHash } from 'node:crypto';
import { z } from 'zod';
import { DomainError, type Principal, type ToolDefinition } from './contracts.js';
import { requireOwner, requireScope } from './auth.js';
import type { Entity, Store } from './storage/store.js';
import { McpToolProvider, type McpEnvReference, type McpServerConfig } from './tools/mcp.js';
import { parseSkillMarkdown } from './tools/skills.js';

const pluginIdSchema = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/);
const envReferenceSchema = z.object({ envRef: z.string().regex(/^[A-Z_][A-Z0-9_]*$/) }).strict();
const mcpBase = {
  id: pluginIdSchema,
  permission: z.literal('configured'),
  timeoutMs: z.number().int().min(1).max(300_000).optional(),
  readOnlyTools: z.array(z.string().min(1).max(200)).max(256).optional(),
};
const pluginMcpServerSchema = z.discriminatedUnion('transport', [
  z.object({
    ...mcpBase,
    transport: z.literal('stdio'),
    profile: pluginIdSchema,
  }).strict(),
  z.object({
    ...mcpBase,
    transport: z.literal('http'),
    url: z.url(),
    headers: z.record(z.string(), envReferenceSchema).optional(),
  }).strict(),
]);
const commandProfileSchema = z.object({
  id: pluginIdSchema,
  command: z.string().startsWith('/'),
  args: z.array(z.string().max(4096)).max(128).optional(),
  cwd: z.string().startsWith('/').optional(),
  environmentEnv: z.record(
    z.string().regex(/^[A-Z_][A-Z0-9_]*$/),
    z.string().regex(/^[A-Z_][A-Z0-9_]*$/),
  ).optional(),
}).strict().refine((profile) => Object.keys(profile.environmentEnv ?? {}).length <= 64, {
  message: 'Plugin command profiles may map at most 64 environment variables',
});
export const pluginContentSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('skill'), files: z.record(z.string(), z.string()) }).strict(),
  z.object({ kind: z.literal('mcp'), server: pluginMcpServerSchema }).strict(),
]);

export type PluginContent = z.infer<typeof pluginContentSchema>;
export interface Plugin { name: string; kind: 'skill' | 'mcp'; enabled: boolean; activeVersion: string; versions: string[] }
export interface PluginCommandProfile {
  id: string;
  command: string;
  args?: string[];
  cwd?: string;
  environmentEnv?: Record<string, string>;
}

export async function snapshotEnabledPluginVersions(store: Store, ownerId: string): Promise<Record<string, string>> {
  return Object.fromEntries((await store.scan<Plugin>('plugin', ownerId))
    .filter((row) => row.data.enabled)
    .sort((left, right) => left.id.localeCompare(right.id))
    .map((row) => [row.id, row.data.activeVersion]));
}

interface PluginServiceOptions {
  allowedOrigins: string[];
  allowedCommands?: string[];
  commandProfiles?: PluginCommandProfile[];
}

export class PluginService {
  private connections = new Map<string, McpToolProvider>();
  private allowedOrigins: Set<string>;
  private commandProfiles: Map<string, PluginCommandProfile>;
  constructor(private store: Store, options: PluginServiceOptions) {
    this.allowedOrigins = new Set(options.allowedOrigins);
    this.commandProfiles = new Map();
    for (const requestedProfile of options.commandProfiles ?? []) {
      const profile = commandProfileSchema.parse(requestedProfile);
      if (this.commandProfiles.has(profile.id)) throw new Error(`Duplicate plugin command profile ${profile.id}`);
      this.commandProfiles.set(profile.id, profile);
    }
  }
  private async content(ownerId: string, pluginId: string, version?: string) {
    const plugin = await this.store.get<Plugin>('plugin', pluginId, ownerId);
    if (!plugin) throw new DomainError('plugin_unavailable', 'Plugin is unavailable', 404);
    const selected = version ?? plugin.data.activeVersion;
    if (!plugin.data.versions.includes(selected)) throw new DomainError('version_not_found', 'Plugin version not found', 404);
    const content = await this.store.get<PluginContent>('plugin_version', `${pluginId}:${selected}`, ownerId);
    if (!content) throw new DomainError('plugin_unavailable', 'Plugin version is unavailable', 503);
    const parsed = pluginContentSchema.safeParse(content.data);
    if (!parsed.success) throw new DomainError('invalid_plugin', 'Plugin content is invalid or no longer supported', 503);
    return { plugin, version: selected, content: parsed.data };
  }

  async snapshot(ownerId: string): Promise<Record<string, string>> {
    return snapshotEnabledPluginVersions(this.store, ownerId);
  }

  async listVersions(principal: Principal, pluginId: string): Promise<Array<{ version: string; active: boolean; content: PluginContent }>> {
    requireScope(principal, 'plugin:manage');
    requireOwner(principal);
    const plugin = await this.store.get<Plugin>('plugin', pluginId, principal.id);
    if (!plugin) throw new DomainError('not_found', 'Plugin not found', 404);
    return Promise.all(plugin.data.versions.map(async (version) => ({
      version,
      active: version === plugin.data.activeVersion,
      content: (await this.content(principal.id, pluginId, version)).content,
    })));
  }
  async install(principal: Principal, pluginId: string, name: string, requestedContent: PluginContent) {
    requireScope(principal, 'plugin:manage');
    requireOwner(principal);
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(pluginId)) throw new DomainError('invalid_plugin_id', 'Invalid plugin ID');
    const content = pluginContentSchema.parse(requestedContent);
    if (content.kind === 'skill') {
      if (!content.files['SKILL.md']) throw new DomainError('invalid_skill', 'SKILL.md is required');
      if (Object.keys(content.files).length > 100) throw new DomainError('invalid_skill', 'A skill may contain at most 100 text files');
      for (const [file, value] of Object.entries(content.files)) {
        if (file.startsWith('/') || file.includes('\\') || file.split('/').includes('..') || typeof value !== 'string') throw new DomainError('invalid_skill', 'Skill files must have safe relative paths and text content');
      }
      parseSkillMarkdown(content.files['SKILL.md']);
    } else {
      const server = content.server;
      if (server.id !== pluginId || server.permission !== 'configured') throw new DomainError('invalid_plugin', 'MCP ID and permission must match the configured plugin');
      this.requireAllowedServer(server);
    }
    const serialized = JSON.stringify(content);
    if (Buffer.byteLength(serialized) > 1024 * 1024) throw new DomainError('plugin_too_large', 'Plugin text content exceeds 1 MB', 413);
    const version = createHash('sha256').update(serialized).digest('hex');
    const previous = await this.store.get<Plugin>('plugin', pluginId, principal.id);
    if (previous && previous.data.kind !== content.kind) throw new DomainError('plugin_kind_changed', 'A plugin cannot change its type', 409);
    if (!await this.store.get('plugin_version', `${pluginId}:${version}`, principal.id)) {
      try { await this.store.create('plugin_version', principal.id, content, `${pluginId}:${version}`); }
      catch (error) { if (!(error instanceof DomainError && error.code === 'conflict')) throw error; }
    }
    const data: Plugin = {
      name,
      kind: content.kind,
      enabled: previous?.data.enabled ?? false,
      activeVersion: previous?.data.enabled ? previous.data.activeVersion : version,
      versions: [...new Set([...(previous?.data.versions ?? []), version])],
    };
    return previous ? this.store.put('plugin', pluginId, principal.id, data, previous.revision) : this.store.create('plugin', principal.id, data, pluginId);
  }
  async configure(principal: Principal, pluginId: string, input: { enabled?: boolean; version?: string; revision: number }) {
    requireScope(principal, 'plugin:manage');
    requireOwner(principal);
    const row = await this.store.get<Plugin>('plugin', pluginId, principal.id);
    if (!row) throw new DomainError('not_found', 'Plugin not found', 404);
    if (input.version && !row.data.versions.includes(input.version)) throw new DomainError('version_not_found', 'Plugin version not found', 404);
    if (input.version && input.version !== row.data.activeVersion) {
      await this.validateVersion(principal.id, pluginId, input.version);
    }
    return this.store.put('plugin', pluginId, principal.id, { ...row.data, enabled: input.enabled ?? row.data.enabled, activeVersion: input.version ?? row.data.activeVersion }, input.revision);
  }
  private async validateVersion(ownerId: string, pluginId: string, version: string): Promise<void> {
    const resolved = await this.content(ownerId, pluginId, version);
    if (resolved.content.kind === 'skill') {
      parseSkillMarkdown(resolved.content.files['SKILL.md'] ?? '');
      return;
    }
    await (await this.mcp(ownerId, pluginId, version)).asToolDefinitions();
  }
  private async mcp(ownerId: string, pluginId: string, version: string) {
    const resolved = await this.content(ownerId, pluginId, version);
    if (resolved.content.kind !== 'mcp') throw new DomainError('invalid_plugin', 'Plugin is not an MCP server');
    const server = this.resolveServer(resolved.content.server);
    const key = `${ownerId}:${pluginId}:${version}`;
    let connection = this.connections.get(key);
    if (!connection) { connection = await McpToolProvider.connect(server); this.connections.set(key, connection); }
    return connection;
  }

  private pinnedVersion(context: { principal: Principal; pluginVersions?: Record<string, string> }, pluginId: string, requested: unknown): string {
    const version = context.pluginVersions?.[pluginId];
    if (!version) throw new DomainError('plugin_not_pinned', 'Plugin was not enabled when this task was created', 409);
    if (requested !== undefined && (typeof requested !== 'string' || requested !== version)) {
      throw new DomainError('plugin_version_pinned', 'Task plugin version is fixed and cannot be changed', 409);
    }
    return version;
  }
  private resolveServer(server: z.infer<typeof pluginMcpServerSchema>): McpServerConfig {
    this.requireAllowedServer(server);
    if (server.transport === 'http') return server;
    const profile = this.commandProfiles.get(server.profile);
    if (!profile) throw new DomainError('command_not_allowed', 'MCP command profile is not in the operator allowlist', 403);
    const env: Record<string, McpEnvReference> = {};
    for (const [name, envRef] of Object.entries(profile.environmentEnv ?? {})) env[name] = { envRef };
    return {
      id: server.id,
      permission: server.permission,
      transport: 'stdio',
      command: profile.command,
      args: profile.args,
      cwd: profile.cwd,
      ...(Object.keys(env).length ? { env } : {}),
      timeoutMs: server.timeoutMs,
      readOnlyTools: server.readOnlyTools,
    };
  }
  private requireAllowedServer(server: z.infer<typeof pluginMcpServerSchema>): void {
    if (server.transport === 'stdio') {
      if (!this.commandProfiles.has(server.profile)) throw new DomainError('command_not_allowed', 'MCP command profile is not in the operator allowlist', 403);
      return;
    }
    const url = new URL(server.url);
    if (url.username || url.password) throw new DomainError('invalid_secret_reference', 'MCP URL must not include credentials');
    const prefix = `KIANCODE_PLUGIN_${server.id.replace(/-/g, '_').toUpperCase()}_`;
    if (Object.values(server.headers ?? {}).some((reference) => !reference.envRef.startsWith(prefix))) {
      throw new DomainError('invalid_secret_reference', `Plugin credentials must use ${prefix} environment references`);
    }
    if (!this.allowedOrigins.has(url.origin)) throw new DomainError('origin_not_allowed', 'MCP origin is not in the operator allowlist', 403);
  }
  tools(): ToolDefinition[] {
    return [
      { name: 'plugin.list', description: 'List the plugin versions fixed when this task was created.', inputSchema: { type: 'object', properties: {}, additionalProperties: false }, requiredCapabilities: ['plugin:use'], sideEffect: 'read', execute: async (_input, context) => {
        const versions = context.pluginVersions ?? {};
        const plugins = (await this.store.scan<Plugin>('plugin', context.principal.id))
          .filter((row) => versions[row.id])
          .map((row): Entity<Plugin> => ({
            ...row,
            data: { ...row.data, enabled: true, activeVersion: versions[row.id]!, versions: [versions[row.id]!] },
          }));
        return { content: JSON.stringify(plugins) };
      } },
      { name: 'skill.read', description: 'Read a task-pinned skill or one of its supporting text files. Skill instructions do not expand tool grants.', inputSchema: { type: 'object', properties: { pluginId: { type: 'string' }, version: { type: 'string' }, file: { type: 'string', default: 'SKILL.md' } }, required: ['pluginId'], additionalProperties: false }, requiredCapabilities: ['plugin:use'], sideEffect: 'read', execute: async (input, context) => {
        const pluginId = String(input.pluginId);
        const resolved = await this.content(context.principal.id, pluginId, this.pinnedVersion(context, pluginId, input.version));
        if (resolved.content.kind !== 'skill') throw new DomainError('invalid_skill', 'Plugin is not a skill');
        const file = typeof input.file === 'string' ? input.file : 'SKILL.md'; const content = resolved.content.files[file];
        if (content === undefined) throw new DomainError('not_found', 'Skill file not found', 404);
        return { content };
      } },
      { name: 'plugin.tools', description: 'Discover tool schemas from the MCP plugin version fixed for this task.', inputSchema: { type: 'object', properties: { pluginId: { type: 'string' }, version: { type: 'string' } }, required: ['pluginId'], additionalProperties: false }, requiredCapabilities: ['plugin:use'], sideEffect: 'read', execute: async (input, context) => {
        const pluginId = String(input.pluginId);
        return { content: JSON.stringify(await (await this.mcp(context.principal.id, pluginId, this.pinnedVersion(context, pluginId, input.version))).listTools()) };
      } },
      { name: 'plugin.call', description: 'Call a tool from the MCP plugin version fixed for this task. The exact plugin, tool, and arguments require action approval.', inputSchema: { type: 'object', properties: { pluginId: { type: 'string' }, version: { type: 'string' }, tool: { type: 'string' }, arguments: { type: 'object' } }, required: ['pluginId', 'tool', 'arguments'], additionalProperties: false }, requiredCapabilities: ['plugin:use'], sideEffect: 'external', execute: async (input, context) => {
        const pluginId = String(input.pluginId);
        const provider = await this.mcp(context.principal.id, pluginId, this.pinnedVersion(context, pluginId, input.version));
        const tool = (await provider.asToolDefinitions()).find((candidate) => candidate.name === `mcp.${String(input.pluginId)}.${String(input.tool)}`);
        if (!tool || !input.arguments || typeof input.arguments !== 'object' || Array.isArray(input.arguments)) throw new DomainError('tool_unavailable', 'MCP tool or arguments are invalid');
        return tool.execute(input.arguments as Record<string, unknown>, context);
      } },
    ];
  }
  async close() { await Promise.allSettled([...this.connections.values()].map((connection) => connection.close())); }
}
