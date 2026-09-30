import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';

const modelSchema = z.object({ id: z.string().min(1), providerId: z.string().min(1), model: z.string().optional(), locality: z.enum(['cloud', 'local']), deviceId: z.string().optional(), capabilities: z.array(z.string()).min(1), enabled: z.boolean().default(true), priority: z.number().default(0) }).strict();
const providerSchema = z.object({ id: z.string().min(1), type: z.enum(['openai-compatible', 'ollama', 'device']), locality: z.enum(['cloud', 'local']), baseUrl: z.url().optional(), apiKeyEnv: z.string().regex(/^[A-Z][A-Z0-9_]*$/).optional() }).strict();
const defaultTerminalReadOnlyPaths = ['/usr'];
const pluginCommandProfileSchema = z.object({
  id: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/),
  command: z.string().startsWith('/'),
  args: z.array(z.string().max(4096)).max(128).default([]),
  cwd: z.string().startsWith('/').optional(),
  environmentEnv: z.record(
    z.string().regex(/^[A-Z_][A-Z0-9_]*$/),
    z.string().regex(/^[A-Z_][A-Z0-9_]*$/),
  ).default({}),
}).strict().superRefine((profile, context) => {
  if (Object.keys(profile.environmentEnv).length > 64) {
    context.addIssue({ code: 'custom', message: 'Plugin command profiles may map at most 64 environment variables' });
  }
});
export const configSchema = z.object({
  mode: z.enum(['development', 'production']).default('development'),
  host: z.string().default('127.0.0.1'), port: z.number().int().min(1).max(65535).default(8768),
  stateDirectory: z.string().min(1).optional(),
  checkpointDirectory: z.string().min(1).optional(),
  database: z.object({ urlEnv: z.string().default('DATABASE_URL'), sqlitePath: z.string().default('.runtime/kiancode.sqlite') }).strict().default({ urlEnv: 'DATABASE_URL', sqlitePath: '.runtime/kiancode.sqlite' }),
  auth: z.object({
    mode: z.enum(['account', 'oidc', 'development']).optional(),
    issuer: z.url().optional(),
    accountApiUrl: z.url().optional(),
    audience: z.string().default('kiancode'),
    jwksUri: z.url().optional(),
    introspectionUrl: z.url().optional(),
    introspectionClientIdEnv: z.string().regex(/^[A-Z][A-Z0-9_]*$/).default('KIANCODE_OIDC_CLIENT_ID'),
    introspectionClientSecretEnv: z.string().regex(/^[A-Z][A-Z0-9_]*$/).default('KIANCODE_OIDC_CLIENT_SECRET'),
    ownerSubjectEnv: z.string().default('KIANCODE_OWNER_SUBJECT'),
    serviceTokenEnv: z.string().default('KIANCODE_ACCOUNT_SERVICE_TOKEN'),
    developmentTokenEnv: z.string().default('KIANCODE_DEV_TOKEN'),
  }).strict().default({
    audience: 'kiancode',
    introspectionClientIdEnv: 'KIANCODE_OIDC_CLIENT_ID',
    introspectionClientSecretEnv: 'KIANCODE_OIDC_CLIENT_SECRET',
    ownerSubjectEnv: 'KIANCODE_OWNER_SUBJECT',
    serviceTokenEnv: 'KIANCODE_ACCOUNT_SERVICE_TOKEN',
    developmentTokenEnv: 'KIANCODE_DEV_TOKEN',
  }),
  providers: z.array(providerSchema).default([]), models: z.array(modelSchema).default([]),
  providerManagement: z.object({
    credentialKeyEnv: z.string().regex(/^[A-Z][A-Z0-9_]*$/).default('KIANCODE_PROVIDER_KEY'),
  }).strict().default({ credentialKeyEnv: 'KIANCODE_PROVIDER_KEY' }),
  automations: z.object({
    eventTriggersEnabled: z.boolean().default(false),
    schedulerEnabled: z.boolean().default(false),
  }).strict().default({ eventTriggersEnabled: false, schedulerEnabled: false }),
  serverWorkspaceRoots: z.array(z.string().startsWith('/')).default([]),
  attachments: z.object({ url: z.url().optional(), tokenEnv: z.string().default('KIANCODE_BLOB_TOKEN'), localDirectory: z.string().default('.runtime/attachments') }).strict().default({ tokenEnv: 'KIANCODE_BLOB_TOKEN', localDirectory: '.runtime/attachments' }),
  outage: z.object({
    directory: z.string().min(1).default('.runtime/outage'),
    keyEnv: z.string().regex(/^[A-Z][A-Z0-9_]*$/).default('KIANCODE_OUTAGE_KEY'),
    maxBytes: z.number().int().min(1).max(1024 * 1024 * 1024).default(1024 * 1024 * 1024),
    maxAgeSeconds: z.number().int().min(1).max(24 * 60 * 60).default(24 * 60 * 60),
    maxResponseBytes: z.number().int().min(1).max(64 * 1024 * 1024).default(1024 * 1024),
    reconcileIntervalSeconds: z.number().int().min(1).max(300).default(5),
  }).strict().optional(),
  terminal: z.object({
    environmentEnv: z.record(
      z.string().regex(/^[A-Z_][A-Z0-9_]*$/),
      z.string().regex(/^[A-Z_][A-Z0-9_]*$/),
    ).default({}),
    isolation: z.enum(['none', 'bubblewrap']).default('none'),
    binary: z.string().startsWith('/').optional(),
    readOnlyPaths: z.array(z.string().startsWith('/')).min(1).default(defaultTerminalReadOnlyPaths),
    allowNetwork: z.boolean().default(false),
  }).strict().default({
    environmentEnv: {},
    isolation: 'none',
    readOnlyPaths: defaultTerminalReadOnlyPaths,
    allowNetwork: false,
  }),
  plugins: z.object({
    allowedOrigins: z.array(z.url()).default([]),
    allowedCommands: z.array(z.string().startsWith('/')).default([]),
    commandProfiles: z.array(pluginCommandProfileSchema).max(100).default([]),
  }).strict().default({ allowedOrigins: [], allowedCommands: [], commandProfiles: [] }),
}).strict().superRefine((config, context) => {
  if (config.mode === 'development' && !['127.0.0.1', '::1', 'localhost'].includes(config.host)) context.addIssue({ code: 'custom', message: 'Development mode must bind to loopback' });
  const authMode = config.auth.mode ?? (config.auth.issuer ? 'account' : 'development');
  if (config.mode === 'production' && authMode === 'development') context.addIssue({ code: 'custom', message: 'Production requires account or OIDC authentication' });
  if (authMode !== 'development' && !config.auth.issuer) context.addIssue({ code: 'custom', message: 'Account and OIDC authentication require an issuer' });
  if (authMode === 'oidc' && !config.auth.jwksUri) context.addIssue({ code: 'custom', message: 'OIDC authentication requires jwksUri' });
  for (const [name, raw] of [['issuer', config.auth.issuer], ['jwksUri', config.auth.jwksUri], ['introspectionUrl', config.auth.introspectionUrl]] as const) {
    if (!raw) continue;
    const url = new URL(raw);
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))) {
      context.addIssue({ code: 'custom', message: `Authentication ${name} must use HTTPS` });
    }
  }
  if (config.auth.accountApiUrl) {
    const url = new URL(config.auth.accountApiUrl);
    const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) {
      context.addIssue({ code: 'custom', message: 'Authentication accountApiUrl must use HTTPS or loopback HTTP' });
    }
    if (url.username || url.password) {
      context.addIssue({ code: 'custom', message: 'Authentication accountApiUrl must not include user information' });
    }
  }
  for (const name of Object.keys(config.terminal.environmentEnv)) {
    if (['HOME', 'TMPDIR', 'TMP', 'TEMP', 'ZDOTDIR', 'ENV', 'BASH_ENV'].includes(name)) {
      context.addIssue({ code: 'custom', message: `Terminal environment ${name} is reserved` });
    }
  }
  if (config.terminal.isolation === 'bubblewrap' && !config.terminal.binary) {
    context.addIssue({ code: 'custom', message: 'Bubblewrap isolation requires an absolute binary path' });
  }
  if (config.terminal.isolation === 'none' && config.terminal.allowNetwork) {
    context.addIssue({ code: 'custom', message: 'Terminal allowNetwork applies only to Bubblewrap isolation' });
  }
  if (new Set(config.plugins.commandProfiles.map((profile) => profile.id)).size !== config.plugins.commandProfiles.length) {
    context.addIssue({ code: 'custom', message: 'Plugin command profile IDs must be unique' });
  }
  for (const candidate of config.terminal.readOnlyPaths) {
    const resolved = path.resolve(candidate);
    const allowed = ['/usr', '/bin', '/lib', '/lib64', '/opt'].some((root) => {
      const relative = path.relative(root, resolved);
      return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
    });
    if (!allowed) {
      context.addIssue({ code: 'custom', message: 'Terminal readOnlyPaths must stay inside system or /opt paths' });
    }
  }
  if (config.mode === 'production' && config.serverWorkspaceRoots.length > 0
    && config.terminal.isolation !== 'bubblewrap') {
    context.addIssue({ code: 'custom', message: 'Production server workspaces require Bubblewrap terminal isolation' });
  }
  if (config.mode === 'production' && !config.attachments.url) context.addIssue({ code: 'custom', message: 'Production requires the primary attachment service URL' });
  if (new Set(config.providers.map((provider) => provider.id)).size !== config.providers.length) context.addIssue({ code: 'custom', message: 'Provider IDs must be unique' });
  if (new Set(config.models.map((model) => model.id)).size !== config.models.length) context.addIssue({ code: 'custom', message: 'Model IDs must be unique' });
  for (const provider of config.providers) {
    if (provider.type !== 'device' && !provider.baseUrl) context.addIssue({ code: 'custom', message: `Provider ${provider.id} requires baseUrl` });
    if (provider.type === 'device' && provider.locality !== 'local') context.addIssue({ code: 'custom', message: 'Device model providers must be local' });
  }
  for (const model of config.models) {
    const provider = config.providers.find((provider) => provider.id === model.providerId);
    if (!provider || model.locality !== provider.locality) context.addIssue({ code: 'custom', message: `Model ${model.id} has an inconsistent provider` });
    if (provider?.type === 'device' && !model.deviceId) context.addIssue({ code: 'custom', message: `Model ${model.id} requires deviceId` });
  }
  const stateDirectory = config.stateDirectory ?? (config.mode === 'production' ? '/var/lib/kiancode' : '.runtime');
  const checkpointDirectory = config.checkpointDirectory ?? path.join(stateDirectory, 'checkpoints');
  if (config.mode === 'production' && (!path.isAbsolute(stateDirectory) || !path.isAbsolute(checkpointDirectory))) {
    context.addIssue({ code: 'custom', message: 'Production state and checkpoint directories must be absolute paths' });
  }
}).transform((config) => {
  const stateDirectory = config.stateDirectory ?? (config.mode === 'production' ? '/var/lib/kiancode' : '.runtime');
  return {
    ...config,
    stateDirectory,
    checkpointDirectory: config.checkpointDirectory ?? path.join(stateDirectory, 'checkpoints'),
  };
});
export type Configuration = z.infer<typeof configSchema>;
export async function loadConfig(file: string): Promise<Configuration> { return configSchema.parse(JSON.parse(await readFile(file, 'utf8'))); }
