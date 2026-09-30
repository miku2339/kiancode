import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { setTimeout as delay } from 'node:timers/promises';
import { DeviceConnector } from './connectors/device.js';
import { WebSocketDeviceTransport } from './connectors/websocket.js';
import { createMacAppTools } from './tools/mac-app.js';
import { createTerminalTool } from './tools/terminal.js';
import { createWorkspaceTools } from './tools/workspace.js';
import { createLocalModelTool } from './runtime/device-provider.js';
import type { McpServerConfig } from './tools/mcp.js';
import type { ToolDefinition, Workspace } from './contracts.js';

const workspace = z.object({ id: z.string().min(1), ownerId: z.string().min(1), deviceId: z.string().min(1), name: z.string().min(1), root: z.string().startsWith('/'), capabilities: z.array(z.string()), allowCloud: z.boolean() }).strict();
const environmentName = z.string().regex(/^[A-Z_][A-Z0-9_]*$/);
const reservedTerminalEnvironment = new Set(['HOME', 'TMPDIR', 'TMP', 'TEMP', 'ZDOTDIR', 'ENV', 'BASH_ENV']);
export const connectorConfig = z.object({
  url: z.url(), deviceId: z.string().min(1), ownerId: z.string().min(1), tokenFile: z.string().optional(), tokenEnv: environmentName.optional(), capabilities: z.array(z.string()),
  journalPath: z.string(), checkpointDirectory: z.string(), lockPath: z.string().optional(), workspaces: z.array(workspace),
  terminal: z.object({
    environmentEnv: z.record(environmentName, environmentName).refine(
      (mapping) => Object.keys(mapping).every((name) => !reservedTerminalEnvironment.has(name)),
      'Reserved terminal environment names cannot be configured',
    ).default({}),
  }).strict().default({ environmentEnv: {} }),
  models: z.array(z.object({ id: z.string(), type: z.enum(['openai', 'ollama']), baseUrl: z.url(), model: z.string(), capabilities: z.array(z.string()), apiKeyEnv: z.string().optional() }).strict()).default([]),
  browser: z.object({ executablePath: z.string().startsWith('/'), allowedOrigins: z.array(z.url()) }).strict().optional(),
  macApp: z.object({
    helperPath: z.string().startsWith('/'), controlFile: z.string().startsWith('/'), screenshotDirectory: z.string().startsWith('/'),
    allowedBundleIds: z.array(z.string().min(2).max(255)).min(1).max(50), allowedActions: z.array(z.string().min(3).max(80)).max(30).default([]),
    pinnedSha256: z.string().regex(/^[a-f0-9]{64}$/).optional(), timeoutMs: z.number().int().min(1000).max(60000).optional(),
  }).strict().optional(),
  mcp: z.array(z.custom<McpServerConfig>()).default([]),
}).strict().refine((value) => Boolean(value.tokenFile) !== Boolean(value.tokenEnv), 'Configure exactly one device token source');

interface ProcessLock {
  lost: Promise<void>;
  release(): Promise<void>;
}

const lockReadyMarker = 'KIANCODE_LOCK_READY';
const lockOwnerPattern = /^\d+(?: [0-9a-f-]{36})?\n?$/i;

async function waitForLockHolder(holder: ChildProcessWithoutNullStreams): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    const timeout = setTimeout(() => finish(new Error('Timed out acquiring device connector lock')), 5_000);
    const finish = (error?: Error) => {
      clearTimeout(timeout);
      holder.stdout.off('data', onStdout);
      holder.stderr.off('data', onStderr);
      holder.off('error', onError);
      holder.off('exit', onExit);
      if (error) reject(error); else resolve();
    };
    const onStdout = (chunk: Buffer) => {
      stdout = (stdout + chunk.toString('utf8')).slice(-256);
      if (stdout.includes(lockReadyMarker)) finish();
    };
    const onStderr = (chunk: Buffer) => { stderr = (stderr + chunk.toString('utf8')).slice(-2_048); };
    const onError = (error: Error) => finish(error);
    const onExit = () => finish(new Error(`Device connector is already running${stderr.trim() ? `: ${stderr.trim()}` : ''}`));
    holder.stdout.on('data', onStdout);
    holder.stderr.on('data', onStderr);
    holder.once('error', onError);
    holder.once('exit', onExit);
  });
}

async function acquireProcessLock(lockPath: string): Promise<ProcessLock> {
  await mkdir(path.dirname(lockPath), { recursive: true, mode: 0o700 });
  const existing = await readFile(lockPath, 'utf8').catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return undefined;
    throw error;
  });
  const helper = `process.stdout.write('${lockReadyMarker}\\n');process.stdin.resume();`;
  const command = process.platform === 'darwin' ? '/usr/bin/lockf' : process.platform === 'linux' ? 'flock' : undefined;
  if (!command) throw new Error(`Device connector locking is unsupported on ${process.platform}`);
  const args = process.platform === 'darwin'
    ? ['-t', '0', lockPath, process.execPath, '-e', helper]
    : ['-n', lockPath, process.execPath, '-e', helper];
  const holder = spawn(command, args, {
    env: { PATH: process.env.PATH ?? '/usr/bin:/bin' },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  try {
    await waitForLockHolder(holder);
    if (existing !== undefined && !lockOwnerPattern.test(existing)) {
      throw new Error('Device connector lock is initializing or malformed');
    }
    await writeFile(lockPath, `${process.pid} ${randomUUID()}\n`, { mode: 0o600 });
  } catch (error) {
    holder.stdin.end();
    if (holder.exitCode === null && holder.signalCode === null) await new Promise<void>((resolve) => holder.once('exit', () => resolve()));
    throw error;
  }
  if (holder.exitCode !== null || holder.signalCode !== null) throw new Error('Device connector lock holder exited during initialization');

  let releasing = false;
  let resolveLost!: () => void;
  const lost = new Promise<void>((resolve) => { resolveLost = resolve; });
  holder.once('exit', () => { if (!releasing) resolveLost(); });
  return {
    lost,
    release: async () => {
      if (releasing) return;
      releasing = true;
      holder.stdin.end();
      if (holder.exitCode === null && holder.signalCode === null) {
        const exited = new Promise<void>((resolve) => holder.once('exit', () => resolve()));
        const graceful = await Promise.race([exited.then(() => true), delay(1_000).then(() => false)]);
        if (!graceful) { holder.kill('SIGKILL'); await exited; }
      }
    },
  };
}

export async function runConnector(file: string) {
  const config = connectorConfig.parse(JSON.parse(await readFile(file, 'utf8')));
  const token = config.tokenEnv ? process.env[config.tokenEnv]?.trim() : (await readFile(config.tokenFile!, 'utf8')).trim();
  if (!token) throw new Error(`Missing device token${config.tokenEnv ? ` in ${config.tokenEnv}` : ''}`);
  const processLock = await acquireProcessLock(config.lockPath ?? path.join(path.dirname(config.journalPath), 'connector.lock'));
  const resources: Array<{ close(): Promise<void> }> = [];
  try {
    const terminalEnvironment = Object.fromEntries(Object.entries(config.terminal.environmentEnv).map(([name, source]) => {
      const value = process.env[source];
      if (value === undefined) throw new Error(`Missing terminal environment variable ${source}`);
      return [name, value];
    }));
    const tools: ToolDefinition[] = [
      ...await createWorkspaceTools({ checkpointDirectory: config.checkpointDirectory }),
      createTerminalTool({ environment: terminalEnvironment, runtimeDirectory: path.join(path.dirname(config.journalPath), 'terminal') }),
    ];
    if (config.models.length) tools.push(createLocalModelTool({ models: config.models.map(({ apiKeyEnv, ...model }) => ({ ...model, ...(apiKeyEnv ? { apiKey: process.env[apiKeyEnv] } : {}) })) }));
    if (config.browser) {
      const { BrowserToolProvider } = await import('./tools/browser.js');
      const browser = await BrowserToolProvider.launch({ ...config.browser, permission: 'configured' }); resources.push(browser); tools.push(...browser.asToolDefinitions());
    }
    if (config.macApp) tools.push(...await createMacAppTools({ ...config.macApp, permission: 'configured' }));
    if (config.mcp.length) {
      const { McpToolProvider } = await import('./tools/mcp.js');
      for (const server of config.mcp) { const provider = await McpToolProvider.connect(server); resources.push(provider); tools.push(...await provider.asToolDefinitions()); }
    }
    let connector: DeviceConnector;
    const transport = new WebSocketDeviceTransport({ baseUrl: config.url, token, deviceId: config.deviceId, onCancel: (id) => connector?.cancel(id) });
    connector = new DeviceConnector({ deviceId: config.deviceId, ownerId: config.ownerId, transport, capabilities: config.capabilities, workspaces: new Map(config.workspaces.map((item) => [item.id, item as Workspace])), tools, journalPath: config.journalPath });
    const controller = new AbortController();
    const stop = () => { controller.abort(); transport.close(); };
    void processLock.lost.then(stop);
    process.on('SIGINT', stop); process.on('SIGTERM', stop);
    const heartbeat = setInterval(() => { void transport.heartbeat(config.deviceId, config.capabilities).catch(() => { /* The authenticated socket cancels active jobs on loss. */ }); }, 15000);
    try {
      process.stdout.write('Device connector started\n');
      let reconnectDelay = 500;
      while (!controller.signal.aborted) {
        try {
          const result = await connector.pollOnce();
          if (!result.online) {
            process.stderr.write(`Device connection unavailable; retrying in ${reconnectDelay} ms\n`);
            await delay(reconnectDelay, undefined, { signal: controller.signal }).catch(() => {});
            reconnectDelay = Math.min(reconnectDelay * 2, 30_000);
            continue;
          }
          reconnectDelay = 500;
          await delay(500, undefined, { signal: controller.signal }).catch(() => {});
        } catch (error) {
          if (controller.signal.aborted) break;
          process.stderr.write(`Device connection unavailable; retrying in ${reconnectDelay} ms: ${error instanceof Error ? error.message : 'unknown error'}\n`);
          await delay(reconnectDelay, undefined, { signal: controller.signal }).catch(() => {});
          reconnectDelay = Math.min(reconnectDelay * 2, 30_000);
        }
      }
    } finally {
      clearInterval(heartbeat); transport.close();
      process.off('SIGINT', stop); process.off('SIGTERM', stop);
    }
  } finally {
    await Promise.allSettled(resources.map((resource) => resource.close()));
    await processLock.release();
  }
}
