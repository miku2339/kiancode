import { createHash } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { access, readFile, realpath } from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import { DomainError, type ToolDefinition } from '../contracts.js';
import { requireScope } from '../auth.js';

export interface AutomationHealth {
  available: boolean;
  reason?: string;
}

export interface ConfiguredScriptToolConfig {
  id: string;
  description: string;
  permission: 'configured';
  command: string;
  args?: string[];
  cwd?: string;
  capability: string;
  sideEffect: 'read' | 'write' | 'external';
  inputSchema?: Record<string, unknown>;
  timeoutMs?: number;
  maxOutputBytes?: number;
  pinnedSha256?: string;
  requireMacAccessibility?: boolean;
}

function kill(pid: number | undefined): void {
  if (!pid) return;
  try {
    process.kill(-pid, 'SIGTERM');
  } catch {
    try { process.kill(pid, 'SIGTERM'); } catch { /* Already exited. */ }
  }
}

export function macAccessibilityHealth(): AutomationHealth {
  if (process.platform !== 'darwin') return { available: false, reason: 'macOS accessibility automation is only available on macOS.' };
  const result = spawnSync('/usr/bin/osascript', ['-e', 'tell application "System Events" to get UI elements enabled'], {
    encoding: 'utf8', timeout: 2_000,
  });
  if (result.status !== 0 || result.stdout.trim() !== 'true') {
    return { available: false, reason: 'macOS Accessibility permission is unavailable for this process.' };
  }
  return { available: true };
}

export async function createConfiguredScriptTool(config: ConfiguredScriptToolConfig): Promise<ToolDefinition> {
  if (config.permission !== 'configured') throw new DomainError('script_permission_required', 'Script adapter requires explicit configured permission', 403);
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(config.id)) throw new DomainError('invalid_script_config', 'Script tool id is invalid');
  const command = await realpath(config.command).catch(() => {
    throw new DomainError('script_unavailable', 'Configured command was not found', 404);
  });
  await access(command, fsConstants.X_OK).catch(() => {
    throw new DomainError('script_unavailable', 'Configured command is not executable', 403);
  });
  if (config.pinnedSha256) {
    const digest = createHash('sha256').update(await readFile(command)).digest('hex');
    if (digest !== config.pinnedSha256) throw new DomainError('script_pin_mismatch', 'Configured command does not match its pinned hash', 409);
  }
  const cwd = config.cwd ? await realpath(config.cwd) : undefined;
  const timeoutMs = config.timeoutMs ?? 30_000;
  const maxOutputBytes = config.maxOutputBytes ?? 256 * 1024;

  return {
    name: config.id,
    description: config.description,
    inputSchema: config.inputSchema ?? { type: 'object' },
    requiredCapabilities: [config.capability],
    sideEffect: config.sideEffect,
    async execute(input, context) {
      requireScope(context.principal, config.capability);
      if (config.requireMacAccessibility) {
        const health = macAccessibilityHealth();
        if (!health.available) throw new DomainError('automation_unavailable', health.reason ?? 'macOS automation is unavailable', 503);
      }
      return new Promise((resolve, reject) => {
        const child = spawn(command, config.args ?? [], {
          cwd,
          detached: process.platform !== 'win32',
          shell: false,
          stdio: ['pipe', 'pipe', 'pipe'],
        });
        let stdout: Buffer<ArrayBufferLike> = Buffer.alloc(0);
        let stderr: Buffer<ArrayBufferLike> = Buffer.alloc(0);
        let truncated = false;
        let timedOut = false;
        let aborted = context.signal.aborted;
        const capture = (current: Buffer<ArrayBufferLike>, chunk: Buffer<ArrayBufferLike>): Buffer<ArrayBufferLike> => {
          const remaining = maxOutputBytes - current.length;
          if (remaining <= 0) { truncated = true; return current; }
          if (chunk.length > remaining) truncated = true;
          return Buffer.concat([current, chunk.subarray(0, remaining)]);
        };
        const timeout = setTimeout(() => { timedOut = true; kill(child.pid); }, timeoutMs);
        const abort = (): void => { aborted = true; kill(child.pid); };
        context.signal.addEventListener('abort', abort, { once: true });
        child.stdout.on('data', (chunk: Buffer) => { stdout = capture(stdout, chunk); });
        child.stderr.on('data', (chunk: Buffer) => { stderr = capture(stderr, chunk); });
        child.once('error', (error) => {
          clearTimeout(timeout);
          context.signal.removeEventListener('abort', abort);
          reject(error);
        });
        child.once('close', (exitCode, signal) => {
          clearTimeout(timeout);
          context.signal.removeEventListener('abort', abort);
          resolve({
            content: JSON.stringify({
              exitCode, signal, stdout: stdout.toString('utf8'), stderr: stderr.toString('utf8'),
              truncated, timedOut, aborted, isolation: 'none',
            }),
            isError: exitCode !== 0 || timedOut || aborted,
          });
        });
        child.stdin.end(JSON.stringify(input));
        if (aborted) kill(child.pid);
      });
    },
  };
}
