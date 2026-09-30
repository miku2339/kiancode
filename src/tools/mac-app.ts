import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { constants as fsConstants } from 'node:fs';
import { access, chmod, lstat, mkdir, readFile, realpath, unlink } from 'node:fs/promises';
import path from 'node:path';
import { DomainError, type ToolContext, type ToolDefinition, type ToolResult, type ToolSpecification } from '../contracts.js';
import { requireScope } from '../auth.js';

export interface MacAppToolOptions {
  permission: 'configured';
  helperPath: string;
  controlFile: string;
  screenshotDirectory: string;
  allowedBundleIds: string[];
  allowedActions?: string[];
  pinnedSha256?: string;
  timeoutMs?: number;
  maxOutputBytes?: number;
  maxSnapshotNodes?: number;
  maxSnapshotCharacters?: number;
  maxScreenshotBytes?: number;
}

export interface MacAppHealth {
  available: boolean;
  accessibility: boolean;
  screenCapture: boolean;
  enabled: boolean;
  paused: boolean;
  reason?: string;
}

interface HelperResponse {
  ok: boolean;
  error?: string;
  code?: string;
  data?: unknown;
}

const bundlePattern = /^[A-Za-z0-9][A-Za-z0-9.-]{1,254}$/;
const actionPattern = /^AX[A-Za-z][A-Za-z0-9]{1,80}$/;

function schema(properties: Record<string, unknown>, required: string[] = []): Record<string, unknown> {
  return { type: 'object', additionalProperties: false, properties, required };
}

const macCapability = (capability: string) => ({ requiredCapabilities: [capability], requiresWorkspace: true as const });

export const macAppToolSpecifications = [
  {
    name: 'mac.app.health', description: 'Read actual macOS Accessibility, Screen Recording, and local pause state.',
    inputSchema: schema({}), ...macCapability('desktop:read'), sideEffect: 'read',
  },
  {
    name: 'mac.app.list', description: 'List running applications in the configured bundle identifier allowlist.',
    inputSchema: schema({}), ...macCapability('desktop:read'), sideEffect: 'read',
  },
  {
    name: 'mac.app.snapshot', description: 'Read a bounded Accessibility snapshot from one allowed running app.',
    inputSchema: schema({ bundleId: { type: 'string', minLength: 2, maxLength: 255 } }, ['bundleId']),
    ...macCapability('desktop:read'), sideEffect: 'read',
  },
  {
    name: 'mac.app.focus', description: 'Activate one running app from the configured bundle identifier allowlist.',
    inputSchema: schema({ bundleId: { type: 'string', minLength: 2, maxLength: 255 } }, ['bundleId']),
    ...macCapability('desktop:write'), sideEffect: 'write',
  },
  {
    name: 'mac.app.window', description: 'Raise, minimize, or restore one indexed window in an allowed app.',
    inputSchema: schema({
      bundleId: { type: 'string', minLength: 2, maxLength: 255 }, windowIndex: { type: 'integer', minimum: 0, maximum: 100 },
      action: { type: 'string', enum: ['raise', 'minimize', 'unminimize'] },
    }, ['bundleId', 'windowIndex', 'action']), ...macCapability('desktop:write'), sideEffect: 'write',
  },
  {
    name: 'mac.app.action', description: 'Perform one explicitly configured Accessibility action on a snapshot element.',
    inputSchema: schema({
      bundleId: { type: 'string', minLength: 2, maxLength: 255 }, elementRef: { type: 'string', pattern: '^root(?:/[0-9]+)*$' },
      action: { type: 'string', pattern: '^AX[A-Za-z][A-Za-z0-9]+$' },
    }, ['bundleId', 'elementRef', 'action']), ...macCapability('desktop:external'), sideEffect: 'external',
  },
  {
    name: 'mac.app.menu', description: 'Select an exact menu path in one allowed app.',
    inputSchema: schema({
      bundleId: { type: 'string', minLength: 2, maxLength: 255 },
      menuPath: { type: 'array', minItems: 2, maxItems: 8, items: { type: 'string', minLength: 1, maxLength: 200 } },
    }, ['bundleId', 'menuPath']), ...macCapability('desktop:external'), sideEffect: 'external',
  },
  {
    name: 'mac.app.screenshot', description: 'Capture one allowed app window for upload as a bounded task artifact.',
    inputSchema: schema({ bundleId: { type: 'string', minLength: 2, maxLength: 255 }, windowIndex: { type: 'integer', minimum: 0, maximum: 100 } }, ['bundleId']),
    ...macCapability('screenshot:read'), sideEffect: 'external',
  },
] as const satisfies readonly ToolSpecification[];

function stringInput(input: Record<string, unknown>, key: string): string {
  const value = input[key];
  if (typeof value !== 'string' || !value) throw new DomainError('invalid_input', `${key} must be a non-empty string`);
  return value;
}

function integerInput(input: Record<string, unknown>, key: string, fallback = 0): number {
  const value = input[key] ?? fallback;
  if (!Number.isInteger(value) || (value as number) < 0) throw new DomainError('invalid_input', `${key} must be a non-negative integer`);
  return value as number;
}

function inside(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function kill(pid: number | undefined): void {
  if (!pid) return;
  try { process.kill(-pid, 'SIGTERM'); }
  catch { try { process.kill(pid, 'SIGTERM'); } catch { /* Process already stopped. */ } }
}

export class MacAppToolProvider {
  private constructor(
    private readonly options: Required<Pick<MacAppToolOptions, 'timeoutMs' | 'maxOutputBytes' | 'maxSnapshotNodes' | 'maxSnapshotCharacters' | 'maxScreenshotBytes'>> & MacAppToolOptions,
    private readonly helperPath: string,
    private readonly screenshotDirectory: string,
    private readonly bundleIds: Set<string>,
    private readonly actions: Set<string>,
  ) {}

  static async create(options: MacAppToolOptions): Promise<MacAppToolProvider> {
    if (options.permission !== 'configured') throw new DomainError('desktop_permission_required', 'Mac app tools require explicit configured permission', 403);
    if (process.platform !== 'darwin') throw new DomainError('desktop_unavailable', 'Mac app tools are available only on macOS', 503);
    if (options.allowedBundleIds.length === 0 || options.allowedBundleIds.some((id) => !bundlePattern.test(id))) {
      throw new DomainError('invalid_desktop_config', 'Configure at least one valid allowed bundle identifier');
    }
    const actions = new Set(options.allowedActions ?? []);
    if ([...actions].some((action) => !actionPattern.test(action))) throw new DomainError('invalid_desktop_config', 'Configured AX action is invalid');
    const helperPath = await realpath(options.helperPath).catch(() => {
      throw new DomainError('desktop_unavailable', 'Configured Mac helper was not found', 404);
    });
    await access(helperPath, fsConstants.X_OK).catch(() => {
      throw new DomainError('desktop_unavailable', 'Configured Mac helper is not executable', 403);
    });
    if (options.pinnedSha256) {
      const digest = createHash('sha256').update(await readFile(helperPath)).digest('hex');
      if (digest !== options.pinnedSha256) throw new DomainError('desktop_helper_pin_mismatch', 'Configured Mac helper does not match its pinned hash', 409);
    }
    await mkdir(options.screenshotDirectory, { recursive: true, mode: 0o700 });
    const screenshotDirectory = await realpath(options.screenshotDirectory);
    await mkdir(path.dirname(options.controlFile), { recursive: true, mode: 0o700 });
    return new MacAppToolProvider({
      ...options,
      timeoutMs: options.timeoutMs ?? 15_000,
      maxOutputBytes: options.maxOutputBytes ?? 512 * 1024,
      maxSnapshotNodes: options.maxSnapshotNodes ?? 400,
      maxSnapshotCharacters: options.maxSnapshotCharacters ?? 100_000,
      maxScreenshotBytes: options.maxScreenshotBytes ?? 6 * 1024 * 1024,
    }, helperPath, screenshotDirectory, new Set(options.allowedBundleIds), actions);
  }

  async health(signal = new AbortController().signal): Promise<MacAppHealth> {
    const data = await this.invoke({ operation: 'health' }, signal) as MacAppHealth;
    return data;
  }

  asToolDefinitions(): ToolDefinition[] {
    return [
      {
        ...macAppToolSpecifications[0],
        execute: async (_input, context) => ({ content: JSON.stringify(await this.executeRead(context, { operation: 'health' })) }),
      },
      {
        ...macAppToolSpecifications[1],
        execute: async (_input, context) => ({ content: JSON.stringify(await this.executeRead(context, { operation: 'list' })) }),
      },
      {
        ...macAppToolSpecifications[2],
        execute: async (input, context) => ({ content: JSON.stringify(await this.executeRead(context, {
          operation: 'snapshot', bundleId: this.allowedBundle(input), maxNodes: this.options.maxSnapshotNodes,
          maxCharacters: this.options.maxSnapshotCharacters,
        })) }),
      },
      {
        ...macAppToolSpecifications[3],
        execute: async (input, context) => ({ content: JSON.stringify(await this.executeWrite(context, { operation: 'focus', bundleId: this.allowedBundle(input) })) }),
      },
      {
        ...macAppToolSpecifications[4],
        execute: async (input, context) => {
          const action = stringInput(input, 'action');
          if (!['raise', 'minimize', 'unminimize'].includes(action)) throw new DomainError('invalid_input', 'Unsupported window action');
          return { content: JSON.stringify(await this.executeWrite(context, { operation: 'window', bundleId: this.allowedBundle(input), windowIndex: integerInput(input, 'windowIndex'), action })) };
        },
      },
      {
        ...macAppToolSpecifications[5],
        execute: async (input, context) => {
          const action = stringInput(input, 'action');
          if (!this.actions.has(action)) throw new DomainError('desktop_action_forbidden', 'AX action is not explicitly configured', 403);
          return { content: JSON.stringify(await this.executeExternal(context, { operation: 'action', bundleId: this.allowedBundle(input), elementRef: stringInput(input, 'elementRef'), action })) };
        },
      },
      {
        ...macAppToolSpecifications[6],
        execute: async (input, context) => {
          if (!Array.isArray(input.menuPath) || input.menuPath.some((item) => typeof item !== 'string' || !item)) throw new DomainError('invalid_input', 'menuPath must contain non-empty strings');
          return { content: JSON.stringify(await this.executeExternal(context, { operation: 'menu', bundleId: this.allowedBundle(input), menuPath: input.menuPath })) };
        },
      },
      {
        ...macAppToolSpecifications[7],
        execute: async (input, context) => this.screenshot(input, context),
      },
    ];
  }

  private allowedBundle(input: Record<string, unknown>): string {
    const bundleId = stringInput(input, 'bundleId');
    if (!this.bundleIds.has(bundleId)) throw new DomainError('desktop_app_forbidden', 'App is outside the configured bundle identifier allowlist', 403);
    return bundleId;
  }

  private requireCapability(context: ToolContext, capability: string): void {
    requireScope(context.principal, capability);
    if (!context.workspace || !context.workspace.capabilities.includes(capability)) {
      throw new DomainError('workspace_denied', `Workspace lacks ${capability}`, 403);
    }
  }

  private async executeRead(context: ToolContext, request: Record<string, unknown>): Promise<unknown> {
    this.requireCapability(context, 'desktop:read');
    return this.invoke(request, context.signal);
  }

  private async executeWrite(context: ToolContext, request: Record<string, unknown>): Promise<unknown> {
    this.requireCapability(context, 'desktop:write');
    return this.invoke(request, context.signal);
  }

  private async executeExternal(context: ToolContext, request: Record<string, unknown>): Promise<unknown> {
    this.requireCapability(context, 'desktop:external');
    return this.invoke(request, context.signal);
  }

  private async screenshot(input: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
    this.requireCapability(context, 'screenshot:read');
    const fileName = `mac-app-${context.taskId.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 80)}-${randomUUID()}.png`;
    const outputPath = path.join(this.screenshotDirectory, fileName);
    try {
      const data = await this.invoke({
        operation: 'screenshot', bundleId: this.allowedBundle(input), windowIndex: integerInput(input, 'windowIndex'), outputPath,
      }, context.signal) as { capturedAt?: string };
      const resolved = await realpath(outputPath).catch(() => { throw new DomainError('screenshot_failed', 'Mac helper did not create the screenshot', 502); });
      if (!inside(this.screenshotDirectory, resolved)) throw new DomainError('screenshot_failed', 'Screenshot resolved outside its configured directory', 502);
      const stats = await lstat(resolved);
      const header = await readFile(resolved).then((bytes) => bytes.subarray(0, 8));
      if (!stats.isFile() || stats.size === 0 || stats.size > this.options.maxScreenshotBytes
        || !header.equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
        throw new DomainError('screenshot_failed', 'Screenshot is invalid or exceeds the configured size limit', 413);
      }
      await chmod(resolved, 0o600);
      return {
        content: JSON.stringify({ captured: true, capturedAt: data.capturedAt ?? new Date().toISOString(), bytes: stats.size }),
        artifacts: [{ name: fileName, path: resolved, mimeType: 'image/png', transient: true }],
      };
    } catch (error) {
      await unlink(outputPath).catch(() => undefined);
      throw error;
    }
  }

  private async invoke(request: Record<string, unknown>, signal: AbortSignal): Promise<unknown> {
    if (signal.aborted) throw new DOMException('Mac helper request was cancelled', 'AbortError');
    const payload = JSON.stringify({
      ...request,
      allowedBundleIds: [...this.bundleIds],
      allowedActions: [...this.actions],
      controlFile: this.options.controlFile,
    });
    return new Promise((resolve, reject) => {
      const child = spawn(this.helperPath, [], { detached: true, shell: false, stdio: ['pipe', 'pipe', 'pipe'] });
      let stdout: Buffer<ArrayBufferLike> = Buffer.alloc(0);
      let stderr: Buffer<ArrayBufferLike> = Buffer.alloc(0);
      let exceeded = false;
      let timedOut = false;
      const capture = (current: Buffer<ArrayBufferLike>, chunk: Buffer<ArrayBufferLike>): Buffer<ArrayBufferLike> => {
        const remaining = this.options.maxOutputBytes - current.length;
        if (remaining <= 0) { exceeded = true; return current; }
        if (chunk.length > remaining) exceeded = true;
        return Buffer.concat([current, chunk.subarray(0, remaining)]);
      };
      const timer = setTimeout(() => { timedOut = true; kill(child.pid); }, this.options.timeoutMs);
      const abort = () => kill(child.pid);
      signal.addEventListener('abort', abort, { once: true });
      child.stdout.on('data', (chunk: Buffer) => { stdout = capture(stdout, chunk); });
      child.stderr.on('data', (chunk: Buffer) => { stderr = capture(stderr, chunk); });
      child.once('error', reject);
      child.once('close', (code) => {
        clearTimeout(timer);
        signal.removeEventListener('abort', abort);
        if (signal.aborted) { reject(new DOMException('Mac helper request was cancelled', 'AbortError')); return; }
        if (timedOut) { reject(new DomainError('desktop_timeout', 'Mac helper exceeded its time limit', 504)); return; }
        if (exceeded) { reject(new DomainError('desktop_output_limit', 'Mac helper output exceeded its limit', 413)); return; }
        let response: HelperResponse;
        try { response = JSON.parse(stdout.toString('utf8')) as HelperResponse; }
        catch { reject(new DomainError('desktop_protocol_error', `Mac helper returned invalid JSON${stderr.length ? `: ${stderr.toString('utf8').slice(0, 500)}` : ''}`, 502)); return; }
        if (code !== 0 || !response.ok) {
          reject(new DomainError(response.code ?? 'desktop_helper_failed', response.error ?? 'Mac helper failed', code === 0 ? 400 : 502));
          return;
        }
        resolve(response.data ?? {});
      });
      child.stdin.end(payload);
    });
  }
}

export async function createMacAppTools(options: MacAppToolOptions): Promise<ToolDefinition[]> {
  return (await MacAppToolProvider.create(options)).asToolDefinitions();
}
