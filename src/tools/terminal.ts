import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { chmod, mkdir, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DomainError, type ToolContext, type ToolDefinition } from '../contracts.js';
import { requireScope } from '../auth.js';

export interface TerminalToolOptions {
  allowedShells?: string[];
  maxOutputBytes?: number;
  maxTimeoutMs?: number;
  environment?: Record<string, string>;
  runtimeDirectory?: string;
  requireSandbox?: boolean;
  bubblewrap?: {
    binary: string;
    readOnlyPaths: string[];
    allowNetwork?: boolean;
  };
}

interface CapturedOutput {
  text: string;
  bytes: number;
  truncated: boolean;
}

function appendOutput(output: CapturedOutput, chunk: Buffer, maximum: number): void {
  if (output.bytes >= maximum) {
    output.truncated = true;
    return;
  }
  const remaining = maximum - output.bytes;
  const accepted = chunk.subarray(0, remaining);
  output.text += accepted.toString('utf8');
  output.bytes += accepted.length;
  if (accepted.length < chunk.length) output.truncated = true;
}

function within(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function hasScope(context: ToolContext, scope: string): boolean {
  try { requireScope(context.principal, scope); return true; } catch { return false; }
}

const inheritedEnvironment = ['PATH', 'LANG', 'LANGUAGE', 'LC_ALL', 'LC_CTYPE', 'LC_MESSAGES', 'TERM', 'COLORTERM', 'TZ'];
const protectedEnvironment = new Set(['HOME', 'TMPDIR', 'TMP', 'TEMP', 'ZDOTDIR', 'ENV', 'BASH_ENV']);

async function commandEnvironment(
  context: ToolContext,
  shell: string,
  options: TerminalToolOptions,
): Promise<NodeJS.ProcessEnv> {
  for (const name of Object.keys(options.environment ?? {})) {
    if (protectedEnvironment.has(name)) throw new Error(`${name} is reserved for terminal isolation`);
  }
  const environment: NodeJS.ProcessEnv = {};
  for (const name of inheritedEnvironment) {
    if (process.env[name] !== undefined) environment[name] = process.env[name];
  }
  environment.PATH ??= '/usr/local/bin:/usr/bin:/bin';
  if (options.bubblewrap) {
    return {
      ...environment,
      ...options.environment,
      HOME: '/home/kiancode',
      TMPDIR: '/tmp',
      TMP: '/tmp',
      TEMP: '/tmp',
      ZDOTDIR: '/home/kiancode',
      SHELL: shell,
    };
  }
  const runtimeDirectory = options.runtimeDirectory ?? path.join(tmpdir(), 'kiancode-terminal');
  await mkdir(runtimeDirectory, { recursive: true, mode: 0o700 });
  const runtimeRoot = await realpath(runtimeDirectory);
  const workspaceKey = createHash('sha256')
    .update(`${context.principal.id}\0${context.workspace?.id ?? ''}`)
    .digest('hex');
  const home = path.join(runtimeRoot, workspaceKey, 'home');
  const temporary = path.join(runtimeRoot, workspaceKey, 'tmp');
  await Promise.all([
    mkdir(home, { recursive: true, mode: 0o700 }),
    mkdir(temporary, { recursive: true, mode: 0o700 }),
  ]);
  await Promise.all([chmod(home, 0o700), chmod(temporary, 0o700)]);
  return {
    ...environment,
    ...options.environment,
    HOME: home,
    TMPDIR: temporary,
    TMP: temporary,
    TEMP: temporary,
    ZDOTDIR: home,
    SHELL: shell,
  };
}

function allowedReadOnlyPath(candidate: string): boolean {
  const resolved = path.resolve(candidate);
  return ['/usr', '/bin', '/lib', '/lib64', '/opt'].some((root) => within(root, resolved));
}

function validateBubblewrap(options: NonNullable<TerminalToolOptions['bubblewrap']>): void {
  if (!path.isAbsolute(options.binary)) throw new Error('Bubblewrap binary must be an absolute path');
  if (options.readOnlyPaths.length === 0) throw new Error('Bubblewrap requires at least one read-only system path');
  for (const candidate of options.readOnlyPaths) {
    if (!path.isAbsolute(candidate) || !allowedReadOnlyPath(candidate)) {
      throw new Error('Bubblewrap read-only paths must be inside /usr, /bin, /lib, /lib64, or /opt');
    }
  }
}

function shellArguments(shell: string, command: string): string[] {
  const name = path.basename(shell);
  if (name === 'bash') return ['--noprofile', '--norc', '-c', command];
  if (name === 'zsh') return ['-f', '-c', command];
  return ['-c', command];
}

async function resolveCwd(context: ToolContext, requested: unknown): Promise<{ root: string; cwd: string }> {
  const workspace = context.workspace;
  if (!workspace) throw new DomainError('workspace_required', 'A workspace is required');
  if (workspace.ownerId !== context.principal.id && !hasScope(context, `workspace:${workspace.id}`)) {
    throw new DomainError('forbidden', 'Principal cannot access this workspace', 403);
  }
  const root = await realpath(workspace.root).catch(() => {
    throw new DomainError('workspace_unavailable', 'Workspace root is unavailable', 404);
  });
  if (requested !== undefined && typeof requested !== 'string') throw new DomainError('invalid_input', 'cwd must be a string');
  const lexical = path.resolve(root, requested ?? '.');
  if (!within(root, lexical)) throw new DomainError('path_outside_workspace', 'cwd is outside workspace', 403);
  const resolved = await realpath(lexical).catch(() => {
    throw new DomainError('path_not_found', 'cwd was not found', 404);
  });
  if (!within(root, resolved)) throw new DomainError('path_outside_workspace', 'cwd resolves outside workspace', 403);
  return { root, cwd: resolved };
}

function sandboxPath(root: string, cwd: string): string {
  const relative = path.relative(root, cwd);
  return relative ? path.posix.join('/workspace', ...relative.split(path.sep)) : '/workspace';
}

function mountParents(paths: string[]): string[] {
  const parents = new Set<string>();
  for (const candidate of paths) {
    let parent = path.dirname(candidate);
    while (parent !== '/') {
      parents.add(parent);
      parent = path.dirname(parent);
    }
  }
  return [...parents].sort((left, right) => left.split(path.sep).length - right.split(path.sep).length);
}

function bubblewrapArguments(
  options: NonNullable<TerminalToolOptions['bubblewrap']>,
  context: ToolContext,
  root: string,
  cwd: string,
  shell: string,
  command: string,
): { args: string[]; network: 'isolated' | 'shared' } {
  const networkAllowed = options.allowNetwork === true
    && context.workspace?.capabilities.includes('network:access') === true
    && hasScope(context, 'network:access');
  const args = [
    '--die-with-parent',
    '--new-session',
    '--unshare-all',
    ...(networkAllowed ? ['--share-net'] : []),
    '--cap-drop', 'ALL',
    '--proc', '/proc',
    '--dev', '/dev',
    '--tmpfs', '/tmp',
    '--tmpfs', '/home',
    '--dir', '/home/kiancode',
  ];
  const networkPaths = networkAllowed
    ? ['/etc/resolv.conf', '/etc/hosts', '/etc/nsswitch.conf', '/etc/ssl/certs']
    : [];
  for (const directory of mountParents([...options.readOnlyPaths, ...networkPaths])) {
    args.push('--dir', directory);
  }
  for (const source of [...new Set(options.readOnlyPaths)]) {
    args.push('--ro-bind', source, source);
  }
  for (const [target, link] of [['usr/bin', '/bin'], ['usr/lib', '/lib'], ['usr/lib64', '/lib64']] as const) {
    if (!options.readOnlyPaths.some((source) => source === link || source.startsWith(`${link}/`))) {
      args.push('--symlink', target, link);
    }
  }
  if (networkAllowed) {
    for (const source of networkPaths) args.push('--ro-bind-try', source, source);
  }
  args.push(
    '--dir', '/workspace',
    '--bind', root, '/workspace',
    '--chdir', sandboxPath(root, cwd),
    '--', shell, ...shellArguments(shell, command),
  );
  return { args, network: networkAllowed ? 'shared' : 'isolated' };
}

function stopProcess(pid: number | undefined): void {
  if (!pid) return;
  try {
    process.kill(-pid, 'SIGTERM');
  } catch {
    try {
      process.kill(pid, 'SIGTERM');
    } catch {
      // Process already exited.
    }
  }
}

export function createTerminalTool(options: TerminalToolOptions = {}): ToolDefinition {
  const allowedShells = options.allowedShells ?? ['/bin/zsh', '/bin/bash', '/bin/sh'];
  const maxOutputBytes = options.maxOutputBytes ?? 256 * 1024;
  const maxTimeoutMs = options.maxTimeoutMs ?? 120_000;
  if (options.bubblewrap) validateBubblewrap(options.bubblewrap);

  return {
    name: 'terminal.run',
    description: options.bubblewrap
      ? 'Run a bounded command inside a Bubblewrap sandbox for the assigned workspace.'
      : 'Run a bounded command in a workspace cwd. The cwd boundary is not an OS sandbox.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        command: { type: 'string', minLength: 1 },
        shell: { type: 'string', enum: allowedShells },
        cwd: { type: 'string', default: '.' },
        timeoutMs: { type: 'integer', minimum: 1, maximum: maxTimeoutMs },
      },
      required: ['command', 'shell'],
    },
    requiredCapabilities: ['shell:execute'],
    requiresWorkspace: true,
    sideEffect: 'external',
    async execute(input, context) {
      if (options.requireSandbox) {
        throw new DomainError('terminal_sandbox_required', 'Server terminal execution requires an OS sandbox', 503);
      }
      if (!context.workspace?.capabilities.includes('shell:execute')) throw new DomainError('capability_required', 'Missing shell:execute capability', 403);
      requireScope(context.principal, 'shell:execute');
      const command = input.command;
      const shell = input.shell;
      if (typeof command !== 'string' || command.length === 0) throw new DomainError('invalid_input', 'command must be a non-empty string');
      if (typeof shell !== 'string' || !allowedShells.includes(shell)) throw new DomainError('shell_not_allowed', 'Shell is not explicitly allowed', 403);
      const timeoutMs = input.timeoutMs === undefined ? Math.min(30_000, maxTimeoutMs) : input.timeoutMs;
      if (!Number.isInteger(timeoutMs) || (timeoutMs as number) <= 0 || (timeoutMs as number) > maxTimeoutMs) {
        throw new DomainError('invalid_input', `timeoutMs must be from 1 to ${maxTimeoutMs}`);
      }
      const { root, cwd } = await resolveCwd(context, input.cwd);
      const stdout: CapturedOutput = { text: '', bytes: 0, truncated: false };
      const stderr: CapturedOutput = { text: '', bytes: 0, truncated: false };
      const startedAt = Date.now();
      const environment = await commandEnvironment(context, shell, options);
      const sandbox = options.bubblewrap
        ? bubblewrapArguments(options.bubblewrap, context, root, cwd, shell, command)
        : undefined;
      const executable = options.bubblewrap?.binary ?? shell;
      const arguments_ = sandbox?.args ?? shellArguments(shell, command);

      return new Promise((resolve, reject) => {
        let timedOut = false;
        let aborted = context.signal.aborted;
        const child = spawn(executable, arguments_, {
          cwd,
          detached: process.platform !== 'win32',
          env: environment,
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        const timeout = setTimeout(() => {
          timedOut = true;
          stopProcess(child.pid);
        }, timeoutMs as number);
        const abort = (): void => {
          aborted = true;
          stopProcess(child.pid);
        };
        context.signal.addEventListener('abort', abort, { once: true });
        child.stdout.on('data', (chunk: Buffer) => appendOutput(stdout, chunk, maxOutputBytes));
        child.stderr.on('data', (chunk: Buffer) => appendOutput(stderr, chunk, maxOutputBytes));
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
              exitCode,
              signal,
              stdout: stdout.text,
              stderr: stderr.text,
              truncated: stdout.truncated || stderr.truncated,
              timedOut,
              aborted,
              durationMs: Date.now() - startedAt,
              cwd,
              isolation: sandbox ? 'bubblewrap' : 'none',
              network: sandbox?.network ?? 'shared',
              isolationNote: sandbox
                ? 'The workspace is the only writable host bind inside the Bubblewrap sandbox.'
                : 'cwd is constrained to the workspace, but the process is not OS-sandboxed.',
            }),
            isError: exitCode !== 0 || timedOut || aborted,
          });
        });
        if (aborted) stopProcess(child.pid);
      });
    },
  };
}
