import { constants as fsConstants } from 'node:fs';
import { access as fsAccess, realpath } from 'node:fs/promises';
import path from 'node:path';
import { accountAuth, developmentAuth, oidcAuth } from './auth.js';
import { AccessService } from './access.js';
import { ArtifactService } from './artifacts.js';
import { type Configuration } from './config.js';
import { DomainError, type ToolDefinition } from './contracts.js';
import { DeviceService } from './devices.js';
import { createServer } from './http/server.js';
import { AgentRuntime, DeviceModelProvider, OllamaProvider, OpenAICompatibleProvider, VisualContextStore } from './runtime/index.js';
import { PluginService } from './plugins.js';
import { createTaskRunner, reconcileAgentTasks } from './runtime-adapter.js';
import type { TaskRunner } from './tasks.js';
import { PostgresStore } from './storage/postgres.js';
import { SqliteStore } from './storage/sqlite.js';
import type { Entity, Store } from './storage/store.js';
import { HttpBlobStore, LocalBlobStore } from './storage/blobs.js';
import { browserToolSpecifications, createTerminalTool, createWorkspaceTools, macAppToolSpecifications } from './tools/index.js';
import { AgentCoordinator } from './agents/index.js';
import { createStoreReplaySink, OutageService } from './outage/index.js';
import { accountDeviceVerifier, NotificationService } from './notifications.js';
import { ModelManagement, type ProviderSeed, type ProviderSettings } from './model-management.js';
import { MaintenanceService } from './maintenance.js';
import type { MemoryQuery, MemoryQueryPage } from './memory-query.js';
import { WorkspaceWriteLeaseService } from './workspace-write-lease.js';

export interface BootstrapOptions {
  wrapTaskRunner?(runner: TaskRunner, store: Store): TaskRunner;
}

export async function bootstrap(config: Configuration, options: BootstrapOptions = {}) {
  const databaseUrl = process.env[config.database.urlEnv];
  if (config.mode === 'production' && !databaseUrl) throw new Error('Production requires PostgreSQL on the primary storage host');
  let store: Store;
  if (databaseUrl) {
    try {
      store = await PostgresStore.connect(databaseUrl);
    } catch (error) {
      if (!config.outage) throw error;
      store = new RecoveringPostgresStore(databaseUrl);
    }
  } else {
    store = new SqliteStore(config.database.sqlitePath);
  }
  try {
    const authMode = config.auth.mode ?? (config.auth.issuer ? 'account' : 'development');
    let identityAuth;
    if (authMode === 'oidc') {
      const clientId = config.auth.introspectionUrl ? process.env[config.auth.introspectionClientIdEnv] : undefined;
      const clientSecret = config.auth.introspectionUrl ? process.env[config.auth.introspectionClientSecretEnv] : undefined;
      if (config.auth.introspectionUrl && (!clientId || !clientSecret)) {
        throw new Error('OIDC introspection requires configured client credentials.');
      }
      identityAuth = oidcAuth({
        issuer: config.auth.issuer!,
        audience: config.auth.audience,
        jwksUri: config.auth.jwksUri!,
        ...(config.auth.introspectionUrl && clientId && clientSecret ? {
          introspection: { url: config.auth.introspectionUrl, clientId, clientSecret },
        } : {}),
      });
    } else if (authMode === 'account') {
      identityAuth = accountAuth(config.auth.issuer!, fetch, config.auth.audience, config.auth.accountApiUrl);
    } else {
      identityAuth = developmentAuth(process.env[config.auth.developmentTokenEnv] ?? '');
    }
    const access = new AccessService(
      store,
      process.env[config.auth.ownerSubjectEnv],
      process.env[config.auth.serviceTokenEnv],
      authMode,
      config.auth.accountApiUrl,
    );
    const authenticate = async (authorization: string | undefined) => access.authorize(await identityAuth(authorization));
    const notifications = new NotificationService(store, {
      ...(authMode === 'account' ? {
        verifyDevice: accountDeviceVerifier(config.auth.accountApiUrl ?? config.auth.issuer!),
      } : {}),
    });
    const maintenance = new MaintenanceService(store);
    const reauthorize = async (identity: Parameters<NonNullable<typeof identityAuth.reauthorize>>[0]) => {
      const refreshed = identityAuth.reauthorize ? await identityAuth.reauthorize(identity) : identity;
      if (!await access.validateDelegation(refreshed)) {
        throw new DomainError('grant_revoked', 'Task authorization has expired or been revoked', 403);
      }
      return access.authorize(refreshed);
    };
    const visualContexts = new VisualContextStore();
    const devices = new DeviceService(store, Date.now, visualContexts);
    const writeLeases = new WorkspaceWriteLeaseService(store);
    devices.setWriteLeaseService(writeLeases);
    const blobs = config.attachments.url ? new HttpBlobStore(config.attachments.url, process.env[config.attachments.tokenEnv] ?? '') : new LocalBlobStore(config.attachments.localDirectory);
    const artifacts = new ArtifactService(store, blobs);
    devices.setArtifactService(artifacts);
    const roots = await Promise.all(config.serverWorkspaceRoots.map((root) => realpath(root)));
    const terminalEnvironment = Object.fromEntries(Object.entries(config.terminal.environmentEnv).map(([name, source]) => {
      const value = process.env[source];
      if (value === undefined) throw new Error(`Missing terminal environment variable ${source}`);
      return [name, value];
    }));
    if (config.terminal.isolation === 'bubblewrap') {
      await fsAccess(config.terminal.binary!, fsConstants.X_OK).catch(() => {
        throw new Error('Configured Bubblewrap binary is not executable');
      });
    }
    const localTools = [
      ...await createWorkspaceTools({
        checkpointDirectory: config.checkpointDirectory,
        exportArtifact: async (request) => ({ artifactId: (await artifacts.upload(
          request.ownerId,
          request.name,
          request.mimeType,
          request.bytes,
          `workspace-export:${request.taskId}:${request.sha256}`,
          'tool',
          request.taskId,
        )).id }),
      }),
      createTerminalTool({
        environment: terminalEnvironment,
        runtimeDirectory: path.join(config.stateDirectory, 'terminal'),
        requireSandbox: config.mode === 'production' && config.terminal.isolation !== 'bubblewrap',
        ...(config.terminal.isolation === 'bubblewrap' ? { bubblewrap: {
          binary: config.terminal.binary!,
          readOnlyPaths: config.terminal.readOnlyPaths,
          allowNetwork: config.terminal.allowNetwork,
        } } : {}),
      }),
    ];
    const tools: ToolDefinition[] = localTools.map((tool) => ({
      ...tool,
      async execute(input, context) {
        if (context.workspace?.deviceId !== 'server') return devices.remoteTool(tool).execute(input, context);
        const actual = await realpath(context.workspace.root);
        if (!roots.some((root) => { const relative = path.relative(root, actual); return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative)); })) throw new DomainError('workspace_denied', 'Workspace is outside configured server roots', 403);
        return tool.execute(input, context);
      },
    }));
    tools.push(...[...browserToolSpecifications, ...macAppToolSpecifications].map((tool) => devices.remoteTool(tool)));
    const plugins = new PluginService(store, config.plugins);
    tools.push(...plugins.tools());
    const runtimeTools = tools.map((tool) => writeLeases.wrap(tool));
    const providerSeeds: ProviderSeed[] = config.providers.map((provider) => {
      const apiKey = provider.apiKeyEnv ? process.env[provider.apiKeyEnv] : undefined;
      if (provider.apiKeyEnv && !apiKey) throw new Error(`Missing provider credential environment variable ${provider.apiKeyEnv}`);
      return {
        id: provider.id,
        name: provider.id,
        type: provider.type,
        locality: provider.locality,
        baseUrl: provider.baseUrl,
        enabled: true,
        ...(apiKey ? { apiKey } : {}),
      };
    });
    const createProvider = (provider: ProviderSettings & { id: string; apiKey?: string }) => {
      if (provider.type === 'device') return new DeviceModelProvider({
        id: provider.id,
        dispatcher: devices,
        ephemeralPayloads: visualContexts,
      });
      if (provider.type === 'ollama') return new OllamaProvider({ id: provider.id, baseUrl: provider.baseUrl! });
      return new OpenAICompatibleProvider({ id: provider.id, baseUrl: provider.baseUrl!, locality: provider.locality, apiKey: provider.apiKey });
    };
    const providers = providerSeeds.map(createProvider);
    const credentialKeyValue = process.env[config.providerManagement.credentialKeyEnv];
    if (credentialKeyValue && !/^[a-f0-9]{64}$/i.test(credentialKeyValue)) {
      throw new Error('Provider credential key must be a 32-byte hexadecimal value');
    }
    const modelManagement = new ModelManagement({
      store,
      providers: providerSeeds,
      models: config.models,
      tools: runtimeTools,
      createProvider,
      ...(credentialKeyValue ? { credentialKey: Buffer.from(credentialKeyValue, 'hex') } : {}),
    });
    const runtime: Pick<AgentRuntime, 'run'> = {
      run: async (input) => (await modelManagement.runtime(input.principal.id)).run(input),
    };
    const outageRuntime = config.outage
      ? new AgentRuntime({ providers, models: config.models, tools: [] })
      : undefined;
    const outage = config.outage && outageRuntime ? new OutageService({
      directory: config.outage.directory,
      keyEnv: config.outage.keyEnv,
      maxBytes: config.outage.maxBytes,
      maxAgeMs: config.outage.maxAgeSeconds * 1_000,
      maxResponseBytes: config.outage.maxResponseBytes,
      replaySink: createStoreReplaySink(store),
      simpleChat: async (input) => {
        const result = await outageRuntime.run({
          taskId: input.taskId,
          principal: input.principal,
          messages: input.history.map((message) => ({ role: message.role, content: message.content })),
          prompt: input.prompt,
          mode: 'ask',
          strategy: 'single',
          modelPolicy: input.modelPolicy,
          ...(input.modelId ? { modelId: input.modelId } : {}),
          privacy: input.privacy,
          budgets: { maxCalls: 1, maxTokens: 16_000 },
          maxOutputTokens: Math.min(8_192, Math.max(1, Math.ceil(input.maxOutputBytes / 4))),
        });
        return { content: result.content };
      },
    }) : undefined;
    let taskControl: (
      ownerId: string,
      taskId: string,
      action: 'pause' | 'resume' | 'cancel',
      actor?: Parameters<typeof reauthorize>[0],
    ) => Promise<unknown> = async () => {
      throw new DomainError('task_service_unavailable', 'Task service is not ready.', 503);
    };
    const coordinator = new AgentCoordinator(
      store,
      (ownerId, taskId, action, actor) => taskControl(ownerId, taskId, action, actor),
    );
    const baseRunner = createTaskRunner(store, runtime, runtimeTools, artifacts, coordinator, visualContexts);
    const runner = options.wrapTaskRunner?.(baseRunner, store) ?? baseRunner;
    const server = await createServer({
      store,
      authenticate,
      runner,
      models: config.models,
      artifacts,
      tools: runtimeTools,
      access,
      plugins,
      coordinator,
      devices,
      notifications,
      modelManagement,
      maintenance,
      reauthorize,
      automations: config.automations,
      ...(outage ? { outage } : {}),
      logger: false,
    });
    taskControl = (ownerId, taskId, action, actor) => server.tasks.control(ownerId, taskId, action, [], actor);
    server.tasks.setReconciler(async () => {
      await reconcileAgentTasks(store, coordinator);
      await server.scheduler.reconcile();
      await server.eventTriggers.reconcile();
    });
    server.tasks.start();
    let reconcileTimer: ReturnType<typeof setInterval> | undefined;
    let reconciling: Promise<void> | undefined;
    const reconcileOutage = async (): Promise<void> => {
      if (!outage || reconciling) return reconciling;
      reconciling = (async () => {
        try {
          await outage.resumeQueued();
          const replay = await outage.reconcile();
          await store.scan('health');
          server.setDegraded(replay.remaining > 0);
        } catch {
          server.setDegraded(true);
        }
      })().finally(() => { reconciling = undefined; });
      return reconciling;
    };
    if (outage) {
      void reconcileOutage();
      reconcileTimer = setInterval(() => { void reconcileOutage(); }, config.outage!.reconcileIntervalSeconds * 1_000);
      reconcileTimer.unref();
    }
    return {
      ...server,
      store,
      config,
      access,
      authenticate,
      artifacts,
      outage,
      modelManagement,
      maintenance,
      eventTriggers: server.eventTriggers,
      scheduler: server.scheduler,
      coordinator,
      writeLeases,
      visualContexts,
      async close() {
        if (reconcileTimer) clearInterval(reconcileTimer);
        await reconciling?.catch(() => undefined);
        await plugins.close();
        await server.close();
      },
    };
  } catch (error) { await store.close(); throw error; }
}

class RecoveringPostgresStore implements Store {
  private connected?: PostgresStore;
  private connecting?: Promise<PostgresStore>;
  private retryAfter = 0;
  private closed = false;

  public constructor(private readonly connectionString: string) {}

  public create<T>(kind: string, ownerId: string, data: T, id?: string): Promise<Entity<T>> {
    return this.use((store) => store.create(kind, ownerId, data, id));
  }

  public get<T>(kind: string, id: string, ownerId: string): Promise<Entity<T> | undefined> {
    return this.use((store) => store.get<T>(kind, id, ownerId));
  }

  public scan<T>(kind: string, ownerId?: string): Promise<Array<Entity<T>>> {
    return this.use((store) => store.scan<T>(kind, ownerId));
  }

  public queryMemory(query: MemoryQuery): Promise<MemoryQueryPage> {
    return this.use((store) => store.queryMemory(query));
  }

  public put<T>(kind: string, id: string, ownerId: string, data: T, revision: number): Promise<Entity<T>> {
    return this.use((store) => store.put(kind, id, ownerId, data, revision));
  }

  public remove(kind: string, id: string, ownerId: string, revision: number): Promise<boolean> {
    return this.use((store) => store.remove(kind, id, ownerId, revision));
  }

  public async close(): Promise<void> {
    this.closed = true;
    const pending = await this.connecting?.catch(() => undefined);
    await (this.connected ?? pending)?.close();
  }

  private async use<T>(operation: (store: PostgresStore) => Promise<T>): Promise<T> {
    const store = await this.connection();
    try {
      return await operation(store);
    } catch (error) {
      if (error instanceof DomainError) throw error;
      throw new DomainError('storage_unavailable', 'Primary storage is unavailable.', 503);
    }
  }

  private async connection(): Promise<PostgresStore> {
    if (this.closed) throw new DomainError('storage_unavailable', 'Primary storage is closed.', 503);
    if (this.connected) return this.connected;
    if (this.connecting) return this.connecting;
    if (Date.now() < this.retryAfter) {
      throw new DomainError('storage_unavailable', 'Primary storage is unavailable.', 503);
    }
    this.connecting = PostgresStore.connect(this.connectionString).then((store) => {
      if (this.closed) {
        void store.close();
        throw new DomainError('storage_unavailable', 'Primary storage is closed.', 503);
      }
      this.connected = store;
      return store;
    }).catch(() => {
      this.retryAfter = Date.now() + 1_000;
      throw new DomainError('storage_unavailable', 'Primary storage is unavailable.', 503);
    }).finally(() => { this.connecting = undefined; });
    return this.connecting;
  }
}
