import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { requireOwner, requireScope } from './auth.js';
import { DomainError, type Principal, type ToolDefinition } from './contracts.js';
import type { Store } from './storage/store.js';
import { AgentRuntime, type ChatRequest, type ChatResponse, type ModelConfig, type ModelProvider } from './runtime/index.js';

const identifier = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/);
export const providerSettingsSchema = z.object({
  name: z.string().trim().min(1).max(100),
  type: z.enum(['openai-compatible', 'ollama', 'device']),
  locality: z.enum(['cloud', 'local']),
  baseUrl: z.url().optional(),
  enabled: z.boolean().default(true),
}).strict().superRefine((value, context) => {
  if (value.type === 'device') {
    if (value.locality !== 'local' || value.baseUrl) context.addIssue({ code: 'custom', message: 'Device providers must be local and cannot define a network URL' });
  } else if (!value.baseUrl) context.addIssue({ code: 'custom', message: 'A provider URL is required' });
  if (value.type === 'ollama' && value.locality !== 'local') context.addIssue({ code: 'custom', message: 'Ollama providers must be local' });
  if (value.baseUrl) {
    const url = new URL(value.baseUrl);
    const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
    if (url.username || url.password || url.search || url.hash || (url.protocol !== 'https:' && !(url.protocol === 'http:' && value.locality === 'local' && local))) {
      context.addIssue({ code: 'custom', message: 'Provider URLs require HTTPS or a local loopback HTTP endpoint, without credentials, query or fragment' });
    }
  }
});
export const modelSettingsSchema = z.object({
  providerId: identifier,
  model: z.string().trim().min(1).max(255),
  deviceId: identifier.optional(),
  enabled: z.boolean().default(false),
  priority: z.number().int().min(-100).max(100).default(0),
  architecture: z.enum(['dense', 'moe', 'unknown']).default('unknown'),
  dailyTokenLimit: z.number().int().min(1).max(1_000_000_000).optional(),
}).strict();
export type ProviderSettings = z.infer<typeof providerSettingsSchema>;
export type ModelSettings = z.infer<typeof modelSettingsSchema>;
interface SealedCredential { nonce: string; ciphertext: string; tag: string }
interface ProviderRecord extends ProviderSettings { id: string; credential?: SealedCredential; inheritCredential?: boolean }
interface ModelRecord extends ModelSettings { id: string; capabilities: string[]; verifiedProviderVersion?: string; verifiedAt?: string; lastProbeError?: string }
interface UsageDay { modelId: string; day: string; reservedTokens: number; confirmedInputTokens: number; confirmedOutputTokens: number; calls: number; failedCalls: number; unreportedCalls: number }
export interface ProviderSeed extends ProviderSettings { id: string; apiKey?: string }
export interface ModelManagementOptions {
  store: Store;
  providers: ProviderSeed[];
  models: ModelConfig[];
  tools: ToolDefinition[];
  createProvider: (settings: ProviderSettings & { id: string; apiKey?: string }) => ModelProvider;
  credentialKey?: Uint8Array;
  now?: () => number;
}

export class ModelManagement {
  private readonly now: () => number;
  private readonly key?: Buffer;
  private readonly runtimeLimits = new AgentRuntime({ providers: [], models: [] });

  constructor(private readonly options: ModelManagementOptions) {
    this.now = options.now ?? Date.now;
    if (options.credentialKey) {
      this.key = Buffer.from(options.credentialKey);
      if (this.key.length !== 32) throw new Error('Provider credential key must contain 32 bytes');
    }
  }

  async providers(ownerId: string) {
    const overrides = await this.options.store.scan<ProviderRecord>('model_provider', ownerId);
    const ids = new Set([...this.options.providers.map((row) => row.id), ...overrides.map((row) => row.data.id)]);
    return [...ids].map((id) => {
      const override = overrides.find((row) => row.data.id === id);
      const seed = this.options.providers.find((row) => row.id === id);
      const data = override?.data ?? seed!;
      return { id, revision: override?.revision ?? 0, name: data.name, type: data.type, locality: data.locality, baseUrl: data.baseUrl, enabled: data.enabled,
        credentialConfigured: Boolean(override ? override.data.credential || (override.data.inheritCredential && seed?.apiKey) : seed?.apiKey),
        credentialEditable: Boolean(this.key), source: override ? 'account' : 'configuration' };
    });
  }

  async saveProvider(actor: Principal, id: string, input: ProviderSettings, revision: number, apiKey?: string | null) {
    this.manage(actor); identifier.parse(id);
    const data = providerSettingsSchema.parse(input);
    if (apiKey !== undefined && apiKey !== null && (!apiKey || apiKey.length > 16384 || /[\r\n\0]/.test(apiKey))) throw new DomainError('invalid_credential', 'Provider credential is invalid');
    if (data.type === 'device' && apiKey) throw new DomainError('invalid_credential', 'Device providers use device authentication');
    const existing = await this.options.store.get<ProviderRecord>('model_provider', storageId(actor.id, id), actor.id);
    const seed = this.options.providers.find((row) => row.id === id);
    if ((existing?.revision ?? 0) !== revision) throw new DomainError('conflict', 'Provider settings have changed', 409);
    const previousUrl = existing?.data.baseUrl ?? seed?.baseUrl;
    const previousType = existing?.data.type ?? seed?.type;
    const hasCredential = Boolean(existing ? existing.data.credential || existing.data.inheritCredential : seed?.apiKey);
    if (apiKey === undefined && hasCredential && (data.baseUrl !== previousUrl || data.type !== previousType)) {
      throw new DomainError('credential_confirmation_required', 'Provide or remove the credential when changing its destination');
    }
    const credential = typeof apiKey === 'string' ? this.seal(actor.id, id, apiKey) : apiKey === null ? undefined : existing?.data.credential;
    const inheritCredential = apiKey === undefined && !credential && (existing ? existing.data.inheritCredential : Boolean(seed?.apiKey));
    const record: ProviderRecord = { ...data, id, ...(credential ? { credential } : {}), ...(inheritCredential ? { inheritCredential: true } : {}) };
    if (existing) await this.options.store.put('model_provider', storageId(actor.id, id), actor.id, record, revision);
    else await this.options.store.create('model_provider', actor.id, record, storageId(actor.id, id));
    return (await this.providers(actor.id)).find((row) => row.id === id)!;
  }

  async disableProvider(actor: Principal, id: string, revision: number): Promise<void> {
    const provider = (await this.providers(actor.id)).find((row) => row.id === id);
    if (!provider) throw new DomainError('not_found', 'Provider not found', 404);
    await this.saveProvider(actor, id, { name: provider.name, type: provider.type, locality: provider.locality, baseUrl: provider.baseUrl, enabled: false }, revision);
  }

  async models(ownerId: string) {
    const overrides = await this.options.store.scan<ModelRecord>('model_setting', ownerId);
    const ids = new Set([...this.options.models.map((row) => row.id), ...overrides.map((row) => row.data.id)]);
    const output: Array<ModelConfig & { revision: number; architecture: string; dailyTokenLimit?: number; verifiedAt?: string; verificationRequired: boolean; lastProbeError?: string; source: string }> = [];
    for (const id of ids) {
      const override = overrides.find((row) => row.data.id === id);
      const seed = this.options.models.find((row) => row.id === id);
      const data = override?.data;
      const provider = await this.provider(ownerId, data?.providerId ?? seed!.providerId);
      const valid = data ? data.verifiedProviderVersion === provider.version : !provider.overridden;
      output.push({ id, model: data?.model ?? seed?.model ?? id, deviceId: data?.deviceId ?? seed?.deviceId, priority: data?.priority ?? seed?.priority,
        dailyTokenLimit: data?.dailyTokenLimit, verifiedAt: data?.verifiedAt, lastProbeError: data?.lastProbeError,
        providerId: provider.id, locality: provider.settings.locality,
        capabilities: valid ? data?.capabilities ?? seed!.capabilities : [],
        enabled: provider.settings.enabled && valid && (data?.enabled ?? seed?.enabled ?? true),
        revision: override?.revision ?? 0, architecture: data?.architecture ?? 'unknown',
        capabilitiesVerified: valid, verificationRequired: !valid, source: override ? 'account' : 'configuration' });
    }
    return output;
  }

  async saveModel(actor: Principal, id: string, input: ModelSettings, revision: number) {
    this.manage(actor); identifier.parse(id);
    const data = modelSettingsSchema.parse(input);
    const provider = await this.provider(actor.id, data.providerId);
    if ((provider.settings.type === 'device') !== Boolean(data.deviceId)) throw new DomainError('invalid_device_model', 'Device models require a device ID; network models cannot specify one');
    if (data.deviceId) {
      const device = await this.options.store.get<{ revokedAt?: string; capabilities: string[] }>('device', data.deviceId, actor.id);
      if (!device || device.data.revokedAt || !device.data.capabilities.includes('model:generate')) throw new DomainError('device_not_found', 'An authorized model device is required', 404);
    }
    const existing = await this.options.store.get<ModelRecord>('model_setting', storageId(actor.id, id), actor.id);
    if ((existing?.revision ?? 0) !== revision) throw new DomainError('conflict', 'Model settings have changed', 409);
    const verified = existing?.data.verifiedProviderVersion === provider.version && existing.data.providerId === data.providerId && existing.data.model === data.model && existing.data.deviceId === data.deviceId;
    if (data.enabled && !verified) throw new DomainError('model_probe_required', 'Verify model capabilities before enabling it', 409);
    const record: ModelRecord = { ...data, id, capabilities: verified ? existing!.data.capabilities : [],
      ...(verified ? { verifiedAt: existing!.data.verifiedAt, verifiedProviderVersion: provider.version } : {}) };
    if (existing) await this.options.store.put('model_setting', storageId(actor.id, id), actor.id, record, revision);
    else await this.options.store.create('model_setting', actor.id, record, storageId(actor.id, id));
    return (await this.models(actor.id)).find((row) => row.id === id)!;
  }

  async disableModel(actor: Principal, id: string, revision: number): Promise<void> {
    const current = (await this.models(actor.id)).find((model) => model.id === id);
    if (!current) throw new DomainError('not_found', 'Model not found', 404);
    await this.saveModel(actor, id, { providerId: current.providerId, model: current.model!, deviceId: current.deviceId, enabled: false, priority: current.priority ?? 0, architecture: modelSettingsSchema.shape.architecture.parse(current.architecture), dailyTokenLimit: current.dailyTokenLimit }, revision);
  }

  async usage(ownerId: string) {
    return (await this.options.store.scan<UsageDay>('model_usage_day', ownerId)).map((row) => ({ id: row.id, ...row.data }));
  }

  async runtime(ownerId: string): Promise<AgentRuntime> {
    const models = await this.models(ownerId);
    const providers: ModelProvider[] = [];
    for (const id of new Set(models.filter((model) => model.enabled).map((model) => model.providerId))) {
      const resolved = await this.provider(ownerId, id);
      const provider = this.options.createProvider({ ...resolved.settings, id, ...(resolved.apiKey ? { apiKey: resolved.apiKey } : {}) });
      providers.push({ id: provider.id, locality: provider.locality,
        ...(provider.isAvailable ? { isAvailable: provider.isAvailable.bind(provider) } : {}),
        ...(provider.probeCapabilities ? { probeCapabilities: provider.probeCapabilities.bind(provider) } : {}),
        chat: (request) => this.meteredChat(ownerId, provider, request, models.find((model) => model.id === request.model.id)?.dailyTokenLimit) });
    }
    return this.runtimeLimits.withConfiguration({ providers, models, tools: this.options.tools });
  }

  async probe(actor: Principal, id: string, capabilities: Array<'tools' | 'vision'> = []) {
    this.manage(actor);
    const row = await this.options.store.get<ModelRecord>('model_setting', storageId(actor.id, id), actor.id);
    if (!row) throw new DomainError('not_found', 'Save a model before probing it', 404);
    const resolved = await this.provider(actor.id, row.data.providerId);
    if (!resolved.settings.enabled) throw new DomainError('provider_disabled', 'Provider is disabled', 409);
    const provider = this.options.createProvider({ ...resolved.settings, id: resolved.id, ...(resolved.apiKey ? { apiKey: resolved.apiKey } : {}) });
    const limitedProvider: ModelProvider = { id: provider.id, locality: provider.locality, chat: (request) => this.runtimeLimits.chat(provider, request) };
    const model: ModelConfig = { id, model: row.data.model, deviceId: row.data.deviceId, providerId: resolved.id, locality: resolved.settings.locality, capabilities: [] };
    const verified = ['text'];
    const signal = AbortSignal.timeout(120_000);
    const taskId = `model-probe:${randomUUID()}`;
    const probe = await this.options.store.create('model_probe', actor.id, { modelId: id, deviceId: row.data.deviceId, state: 'running', expiresAt: new Date(this.now() + 120_000).toISOString() }, taskId);
    const request = (messages: ChatRequest['messages'], tools: ToolDefinition[] = []) => this.meteredChat(actor.id, limitedProvider, { model, messages, tools, signal, maxOutputTokens: 4096, context: { principal: actor, taskId } }, row.data.dailyTokenLimit);
    try {
      let streamed = false;
      const text = await this.meteredChat(actor.id, limitedProvider, { model, messages: [{ role: 'user', content: 'Reply exactly MODEL_READY.' }], tools: [], signal, maxOutputTokens: 4096, context: { principal: actor, taskId }, onToken: () => { streamed = true; } }, row.data.dailyTokenLimit);
      if (streamed) verified.push('streaming');
      if (text.message.content.trim() !== 'MODEL_READY') throw new DomainError('model_probe_failed', 'The model did not complete the text probe', 422);
      if (capabilities.includes('tools')) {
        model.capabilities = ['tools'];
        const tool: ToolDefinition = { name: 'probe.echo', description: 'Return the supplied value unchanged.', inputSchema: { type: 'object', properties: { value: { type: 'string', const: 'TOOL_READY' } }, required: ['value'], additionalProperties: false }, requiredCapabilities: [], sideEffect: 'read', async execute() { return { content: 'TOOL_READY' }; } };
        const messages: ChatRequest['messages'] = [{ role: 'user', content: 'Call probe.echo with value TOOL_READY, then repeat its returned value exactly.' }];
        const first = await request(messages, [tool]);
        const call = first.message.toolCalls?.[0];
        if (first.message.toolCalls?.length !== 1 || call?.name !== tool.name || JSON.stringify(call.arguments) !== JSON.stringify({ value: 'TOOL_READY' })) throw new DomainError('model_probe_failed', 'The model did not complete the tool probe', 422);
        const result = await request([...messages, first.message, { role: 'tool', toolCallId: call.id, content: 'TOOL_READY' }]);
        if (result.message.content.trim() !== 'TOOL_READY') throw new DomainError('model_probe_failed', 'The model did not incorporate the tool result', 422);
        verified.push('tools');
      }
      if (capabilities.includes('vision')) {
        model.capabilities = ['vision'];
        const result = await request([{ role: 'user', content: 'Name the single dominant color in this image. Reply with its uppercase English name only.', attachments: [{ mimeType: 'image/png', data: redImage }] }]);
        if (result.message.content.trim() !== 'RED') throw new DomainError('model_probe_failed', 'The model did not complete the image probe', 422);
        verified.push('vision');
      }
      const fresh = await this.provider(actor.id, row.data.providerId);
      if (fresh.version !== resolved.version) throw new DomainError('conflict', 'Provider settings changed during the probe', 409);
      await this.options.store.put<ModelRecord>('model_setting', storageId(actor.id, id), actor.id, { ...row.data, capabilities: verified, verifiedProviderVersion: resolved.version, verifiedAt: new Date(this.now()).toISOString(), lastProbeError: undefined }, row.revision);
      return { capabilities: verified, verifiedAt: new Date(this.now()).toISOString() };
    } catch (error) {
      const code = error instanceof DomainError ? error.code : 'provider_unavailable';
      await this.options.store.put<ModelRecord>('model_setting', storageId(actor.id, id), actor.id, { ...row.data, enabled: false, capabilities: [], verifiedProviderVersion: undefined, lastProbeError: code }, row.revision).catch(() => undefined);
      throw new DomainError(code, 'Model capability verification failed', error instanceof DomainError ? error.statusCode : 503);
    } finally {
      await this.options.store.put('model_probe', probe.id, actor.id, { ...probe.data, state: 'finished' }, probe.revision).catch(() => undefined);
    }
  }

  private manage(actor: Principal): void { requireOwner(actor); requireScope(actor, 'model:write'); }

  private async provider(ownerId: string, id: string) {
    const row = await this.options.store.get<ProviderRecord>('model_provider', storageId(ownerId, id), ownerId);
    const seed = this.options.providers.find((provider) => provider.id === id);
    if (!row && !seed) throw new DomainError('provider_not_found', 'Provider not found', 404);
    const source = row?.data ?? seed!;
    const settings: ProviderSettings = { name: source.name, type: source.type, locality: source.locality, baseUrl: source.baseUrl, enabled: source.enabled };
    const apiKey = row ? row.data.credential ? this.open(ownerId, id, row.data.credential) : row.data.inheritCredential ? seed?.apiKey : undefined : seed?.apiKey;
    const version = createHash('sha256').update(JSON.stringify({ id, settings, revision: row?.revision ?? 0, credential: apiKey ? createHash('sha256').update(apiKey).digest('hex') : null })).digest('hex');
    return { id, settings, apiKey, version, overridden: Boolean(row) };
  }

  private seal(ownerId: string, providerId: string, value: string): SealedCredential {
    if (!this.key) throw new DomainError('credential_storage_unavailable', 'Provider credential storage is not configured', 503);
    const nonce = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, nonce);
    cipher.setAAD(Buffer.from(`${ownerId}\0${providerId}`));
    const ciphertext = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
    return { nonce: nonce.toString('base64'), ciphertext: ciphertext.toString('base64'), tag: cipher.getAuthTag().toString('base64') };
  }

  private open(ownerId: string, providerId: string, value: SealedCredential): string {
    if (!this.key) throw new DomainError('credential_storage_unavailable', 'Provider credential storage is not configured', 503);
    try {
      const decipher = createDecipheriv('aes-256-gcm', this.key, Buffer.from(value.nonce, 'base64'));
      decipher.setAAD(Buffer.from(`${ownerId}\0${providerId}`));
      decipher.setAuthTag(Buffer.from(value.tag, 'base64'));
      return Buffer.concat([decipher.update(Buffer.from(value.ciphertext, 'base64')), decipher.final()]).toString('utf8');
    } catch { throw new DomainError('credential_unavailable', 'Provider credential cannot be opened', 503); }
  }

  private async changeUsage(ownerId: string, modelId: string, day: string, update: (row: UsageDay) => UsageDay): Promise<void> {
    const id = storageId(ownerId, `${modelId}:${day}`);
    for (let attempt = 0; attempt < 16; attempt += 1) {
      const row = await this.options.store.get<UsageDay>('model_usage_day', id, ownerId);
      const next = update(row?.data ?? { modelId, day, reservedTokens: 0, confirmedInputTokens: 0, confirmedOutputTokens: 0, calls: 0, failedCalls: 0, unreportedCalls: 0 });
      try {
        if (row) await this.options.store.put('model_usage_day', id, ownerId, next, row.revision);
        else await this.options.store.create('model_usage_day', ownerId, next, id);
        return;
      } catch (error) { if (!(error instanceof DomainError && error.code === 'conflict')) throw error; }
    }
    throw new DomainError('busy', 'Model usage ledger is busy', 409);
  }

  private async meteredChat(ownerId: string, provider: ModelProvider, request: ChatRequest, limit?: number): Promise<ChatResponse> {
    const day = new Date(this.now()).toISOString().slice(0, 10);
    const modelId = request.model.id;
    const reserved = Buffer.byteLength(JSON.stringify(request.messages), 'utf8') + Buffer.byteLength(JSON.stringify(request.tools.map((tool) => tool.inputSchema))) + (request.maxOutputTokens ?? 4096);
    await this.changeUsage(ownerId, modelId, day, (row) => {
      if (limit && row.reservedTokens + row.confirmedInputTokens + row.confirmedOutputTokens + reserved > limit) throw new DomainError('model_quota_exceeded', 'Daily model token allowance is exhausted', 429);
      return { ...row, reservedTokens: row.reservedTokens + reserved, calls: row.calls + 1 };
    });
    let response: ChatResponse;
    try { response = await provider.chat(request); }
    catch (error) {
      await this.changeUsage(ownerId, modelId, day, (row) => ({ ...row, failedCalls: row.failedCalls + 1 })).catch(() => undefined);
      throw error;
    }
    const { inputTokens, outputTokens } = response.usage;
    const reported = [inputTokens, outputTokens].every((count) => Number.isSafeInteger(count) && count >= 0) && inputTokens + outputTokens > 0;
    await this.changeUsage(ownerId, modelId, day, (row) => reported
      ? { ...row, reservedTokens: Math.max(0, row.reservedTokens - reserved), confirmedInputTokens: row.confirmedInputTokens + inputTokens, confirmedOutputTokens: row.confirmedOutputTokens + outputTokens }
      : { ...row, unreportedCalls: (row.unreportedCalls ?? 0) + 1 });
    return response;
  }
}

function storageId(ownerId: string, id: string): string { return createHash('sha256').update(`${ownerId}\0${id}`).digest('hex'); }

const redImage = 'iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAIAAAAlC+aJAAAAb0lEQVR4nO3PAQkAAAyEwO9feoshgnABdLep8QUNyPEFDcjxBQ3I8QUNyPEFDcjxBQ3I8QUNyPEFDcjxBQ3I8QUNyPEFDcjxBQ3I8QUNyPEFDcjxBQ3I8QUNyPEFDcjxBQ3I8QUNyPEFDcjxBQ3IPanc8OLDQitxAAAAAElFTkSuQmCC';
