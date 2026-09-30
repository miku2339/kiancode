import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import {
  access,
  lstat,
  mkdir,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { DomainError, type ToolContext, type ToolDefinition, type Workspace } from '../contracts.js';
import { requireScope } from '../auth.js';
import { applyWorkspacePatch, parseWorkspacePatch } from './workspace-patch.js';
import { MAX_WORKSPACE_EXPORT_BYTES, readStableWorkspaceExport, validateWorkspaceExport, workspaceExportMimeType } from './workspace-export.js';

export interface WorkspaceExportRequest {
  ownerId: string;
  taskId: string;
  name: string;
  mimeType: string;
  bytes: Uint8Array;
  sha256: string;
}

export interface WorkspaceToolOptions {
  checkpointDirectory?: string;
  maxReadBytes?: number;
  maxEntries?: number;
  maxSearchFiles?: number;
  maxPatchBytes?: number;
  maxExportBytes?: number;
  exportArtifact?: (request: WorkspaceExportRequest) => Promise<{ artifactId: string }>;
}

interface Checkpoint {
  id: string;
  workspaceId: string;
  workspaceRoot: string;
  relativePath: string;
  taskId: string;
  principalId: string;
  previousExists: boolean;
  previousContent?: string;
  previousHash?: string;
  writtenHash: string;
  restoreTokenHash?: string;
  createdAt: string;
}

const READ_CAPABILITY = 'workspace:read';
const WRITE_CAPABILITY = 'workspace:write';
const EXPORT_CAPABILITY = 'workspace:export';
const GIT_STATUS_MAX_BYTES = 256 * 1024;
const GIT_STATUS_TIMEOUT_MS = 5_000;

function hash(content: Buffer | string): string {
  return createHash('sha256').update(content).digest('hex');
}

function validRestoreToken(checkpoint: Checkpoint, token: string | undefined): boolean {
  if (!checkpoint.restoreTokenHash || !token) return false;
  const actual = Buffer.from(hash(token), 'hex');
  const expected = Buffer.from(checkpoint.restoreTokenHash, 'hex');
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function stringInput(input: Record<string, unknown>, key: string, required = true): string | undefined {
  const value = input[key];
  if (value === undefined && !required) return undefined;
  if (typeof value !== 'string') throw new DomainError('invalid_input', `${key} must be a string`);
  return value;
}

function numberInput(input: Record<string, unknown>, key: string, fallback: number, maximum: number): number {
  const value = input[key];
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || (value as number) <= 0 || (value as number) > maximum) {
    throw new DomainError('invalid_input', `${key} must be an integer from 1 to ${maximum}`);
  }
  return value as number;
}

function isWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function hasScope(context: ToolContext, scope: string): boolean {
  try { requireScope(context.principal, scope); return true; } catch { return false; }
}

function requireWorkspace(context: ToolContext, capability: string): Workspace {
  const workspace = context.workspace;
  if (!workspace) throw new DomainError('workspace_required', 'A workspace is required', 400);
  const workspaceScope = `workspace:${workspace.id}`;
  const isOwner = workspace.ownerId === context.principal.id;
  const delegatedAction = capability === EXPORT_CAPABILITY ? 'export' : capability.endsWith('write') ? 'write' : 'read';
  const hasDelegation = hasScope(context, workspaceScope)
    || hasScope(context, `${workspaceScope}:${delegatedAction}`);
  if (!isOwner && !hasDelegation) throw new DomainError('forbidden', 'Principal cannot access this workspace', 403);
  if (!workspace.capabilities.includes(capability)) throw new DomainError('capability_required', `Missing ${capability} capability`, 403);
  requireScope(context.principal, capability);
  return workspace;
}

async function existingWorkspaceRoot(workspace: Workspace): Promise<string> {
  const resolved = await realpath(workspace.root).catch(() => {
    throw new DomainError('workspace_unavailable', 'Workspace root is unavailable', 404);
  });
  const details = await stat(resolved);
  if (!details.isDirectory()) throw new DomainError('workspace_unavailable', 'Workspace root is not a directory', 400);
  return resolved;
}

async function resolveExisting(root: string, requested: string): Promise<string> {
  const lexical = path.resolve(root, requested || '.');
  if (!isWithin(root, lexical)) throw new DomainError('path_outside_workspace', 'Path is outside workspace', 403);
  const resolved = await realpath(lexical).catch(() => {
    throw new DomainError('path_not_found', 'Workspace path was not found', 404);
  });
  if (!isWithin(root, resolved)) throw new DomainError('path_outside_workspace', 'Path resolves outside workspace', 403);
  return resolved;
}

async function resolveForWrite(root: string, requested: string): Promise<string> {
  const lexical = path.resolve(root, requested);
  if (!requested || !isWithin(root, lexical) || lexical === root) {
    throw new DomainError('path_outside_workspace', 'Path is outside workspace', 403);
  }
  let ancestor = path.dirname(lexical);
  while (isWithin(root, ancestor)) {
    try {
      const resolvedAncestor = await realpath(ancestor);
      if (!isWithin(root, resolvedAncestor)) {
        throw new DomainError('path_outside_workspace', 'Path resolves outside workspace', 403);
      }
      const suffix = path.relative(ancestor, lexical);
      const target = path.resolve(resolvedAncestor, suffix);
      if (!isWithin(root, target)) throw new DomainError('path_outside_workspace', 'Path resolves outside workspace', 403);
      try {
        const targetRealpath = await realpath(target);
        if (!isWithin(root, targetRealpath)) throw new DomainError('path_outside_workspace', 'Path resolves outside workspace', 403);
        return targetRealpath;
      } catch (error) {
        if (error instanceof DomainError) throw error;
        return target;
      }
    } catch (error) {
      if (error instanceof DomainError) throw error;
      if (ancestor === root) break;
      ancestor = path.dirname(ancestor);
    }
  }
  throw new DomainError('path_outside_workspace', 'Path resolves outside workspace', 403);
}

function schema(properties: Record<string, unknown>, required: string[] = []): Record<string, unknown> {
  return { type: 'object', additionalProperties: false, properties, required };
}

function diffText(previous: string, next: string): string {
  if (previous === next) return '';
  const before = previous.split('\n');
  const after = next.split('\n');
  let prefix = 0;
  while (prefix < before.length && prefix < after.length && before[prefix] === after[prefix]) prefix += 1;
  let beforeEnd = before.length - 1;
  let afterEnd = after.length - 1;
  while (beforeEnd >= prefix && afterEnd >= prefix && before[beforeEnd] === after[afterEnd]) {
    beforeEnd -= 1;
    afterEnd -= 1;
  }
  const removed = before.slice(prefix, beforeEnd + 1).map((line) => `-${line}`);
  const added = after.slice(prefix, afterEnd + 1).map((line) => `+${line}`);
  return [`@@ line ${prefix + 1} @@`, ...removed, ...added].join('\n');
}

function gitEnvironment(): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {
    PATH: '/usr/bin:/bin',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_LITERAL_PATHSPECS: '1',
    GIT_OPTIONAL_LOCKS: '0',
    GIT_TERMINAL_PROMPT: '0',
  };
  for (const name of ['LANG', 'LANGUAGE', 'LC_ALL', 'LC_CTYPE', 'LC_MESSAGES', 'TZ']) {
    if (process.env[name] !== undefined) environment[name] = process.env[name];
  }
  return environment;
}

async function runGit(root: string, args: string[], maximumBytes: number): Promise<{ code: number | null; output: string }> {
  return new Promise((resolve) => {
    const child = spawn('git', [
      '-c', 'core.fsmonitor=false',
      '-c', 'core.untrackedCache=false',
      '-c', 'core.hooksPath=/dev/null',
      '-C', root,
      ...args,
    ], {
      env: gitEnvironment(),
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const chunks: Buffer[] = [];
    let bytes = 0;
    let exceeded = false;
    let settled = false;
    const finish = (code: number | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve({ code: exceeded ? null : code, output: exceeded ? '' : Buffer.concat(chunks, bytes).toString('utf8') });
    };
    const timeout = setTimeout(() => {
      exceeded = true;
      child.kill('SIGKILL');
      finish(null);
    }, GIT_STATUS_TIMEOUT_MS);
    child.stdout.on('data', (chunk: Buffer) => {
      if (exceeded) return;
      if (bytes + chunk.length > maximumBytes) {
        exceeded = true;
        child.kill('SIGKILL');
        return;
      }
      chunks.push(chunk);
      bytes += chunk.length;
    });
    child.once('error', () => finish(null));
    child.once('close', (code) => finish(code));
  });
}

async function gitStatus(root: string, relativePath?: string): Promise<string> {
  const repository = await runGit(root, ['rev-parse', '--show-toplevel'], 4_096);
  if (repository.code !== 0) return '';
  const topLevel = await realpath(repository.output.trim()).catch(() => undefined);
  if (!topLevel || !isWithin(root, topLevel)) return '';
  const args = ['status', '--short'];
  if (relativePath) args.push('--', relativePath);
  const status = await runGit(root, args, GIT_STATUS_MAX_BYTES);
  return status.code === 0 ? status.output : '';
}

async function atomicWrite(target: string, content: string | Buffer): Promise<void> {
  await mkdir(path.dirname(target), { recursive: true });
  const temporary = path.join(path.dirname(target), `.${path.basename(target)}.${randomUUID()}.tmp`);
  let existingMode: number | undefined;
  try {
    existingMode = (await stat(target)).mode & 0o777;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  await writeFile(temporary, content, { flag: 'wx', ...(existingMode === undefined ? {} : { mode: existingMode }) });
  try {
    await rename(temporary, target);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

export async function createWorkspaceTools(options: WorkspaceToolOptions = {}): Promise<ToolDefinition[]> {
  const checkpointDirectory = options.checkpointDirectory ?? path.join(tmpdir(), 'kiancode-checkpoints');
  const maxReadBytes = options.maxReadBytes ?? 1024 * 1024;
  const maxEntries = options.maxEntries ?? 1_000;
  const maxSearchFiles = options.maxSearchFiles ?? 1_000;
  const maxPatchBytes = options.maxPatchBytes ?? 256 * 1024;
  const maxExportBytes = options.maxExportBytes ?? MAX_WORKSPACE_EXPORT_BYTES;
  if (!Number.isSafeInteger(maxExportBytes) || maxExportBytes <= 0 || maxExportBytes > MAX_WORKSPACE_EXPORT_BYTES) {
    throw new DomainError('invalid_configuration', `maxExportBytes must be from 1 to ${MAX_WORKSPACE_EXPORT_BYTES}`);
  }
  await mkdir(checkpointDirectory, { recursive: true, mode: 0o700 });
  const checkpointRoot = await realpath(checkpointDirectory);

  const list: ToolDefinition = {
    name: 'workspace.list',
    description: 'List files and directories within the configured workspace root.',
    inputSchema: schema({
      path: { type: 'string', default: '.' },
      recursive: { type: 'boolean', default: false },
      maxEntries: { type: 'integer', minimum: 1, maximum: maxEntries },
    }),
    requiredCapabilities: [READ_CAPABILITY],
    requiresWorkspace: true,
    sideEffect: 'read',
    async execute(input, context) {
      const workspace = requireWorkspace(context, READ_CAPABILITY);
      const root = await existingWorkspaceRoot(workspace);
      const base = await resolveExisting(root, stringInput(input, 'path', false) ?? '.');
      const recursive = input.recursive === true;
      const limit = numberInput(input, 'maxEntries', Math.min(200, maxEntries), maxEntries);
      const entries: Array<{ path: string; type: 'file' | 'directory' | 'symlink'; size?: number }> = [];
      const pending = [base];
      while (pending.length > 0 && entries.length < limit) {
        const current = pending.shift();
        if (!current) break;
        const children = await readdir(current, { withFileTypes: true });
        children.sort((a, b) => a.name.localeCompare(b.name));
        for (const child of children) {
          const target = path.join(current, child.name);
          const relative = path.relative(root, target);
          if (child.isSymbolicLink()) {
            entries.push({ path: relative, type: 'symlink' });
          } else if (child.isDirectory()) {
            entries.push({ path: relative, type: 'directory' });
            if (recursive) pending.push(target);
          } else if (child.isFile()) {
            entries.push({ path: relative, type: 'file', size: (await lstat(target)).size });
          }
          if (entries.length >= limit) break;
        }
      }
      return { content: JSON.stringify({ entries, truncated: pending.length > 0 || entries.length >= limit }) };
    },
  };

  const read: ToolDefinition = {
    name: 'workspace.read',
    description: 'Read a workspace file and return its SHA-256 hash for conflict-safe writes.',
    inputSchema: schema({ path: { type: 'string' }, maxBytes: { type: 'integer', minimum: 1, maximum: maxReadBytes } }, ['path']),
    requiredCapabilities: [READ_CAPABILITY],
    requiresWorkspace: true,
    sideEffect: 'read',
    async execute(input, context) {
      const workspace = requireWorkspace(context, READ_CAPABILITY);
      const root = await existingWorkspaceRoot(workspace);
      const target = await resolveExisting(root, stringInput(input, 'path')!);
      const details = await stat(target);
      if (!details.isFile()) throw new DomainError('not_a_file', 'Workspace path is not a file');
      const limit = numberInput(input, 'maxBytes', maxReadBytes, maxReadBytes);
      if (details.size > limit) throw new DomainError('file_too_large', `File exceeds ${limit} bytes`, 413);
      const content = await readFile(target);
      return { content: JSON.stringify({ path: path.relative(root, target), content: content.toString('utf8'), sha256: hash(content), size: content.length }) };
    },
  };

  const exportTool: ToolDefinition = {
    name: 'workspace.export',
    description: 'Export one explicitly selected workspace file as an owner- and task-bound artifact.',
    inputSchema: schema({ path: { type: 'string' } }, ['path']),
    requiredCapabilities: [EXPORT_CAPABILITY],
    requiresWorkspace: true,
    sideEffect: 'external',
    async execute(input, context) {
      const workspace = requireWorkspace(context, EXPORT_CAPABILITY);
      context.signal.throwIfAborted();
      const root = await existingWorkspaceRoot(workspace);
      const requested = stringInput(input, 'path')!;
      const target = await resolveExisting(root, requested);
      const name = path.basename(requested);
      const relativePath = path.relative(root, path.resolve(root, requested));
      const mimeType = workspaceExportMimeType(name);
      if (!mimeType) throw new DomainError('unsupported_export_type', 'Workspace file type cannot be exported', 415);
      const bytes = await readStableWorkspaceExport(target, maxExportBytes, root);
      validateWorkspaceExport(bytes, name, mimeType);
      const sha256 = hash(bytes);
      context.signal.throwIfAborted();
      if (options.exportArtifact) {
        const exported = await options.exportArtifact({
          ownerId: context.principal.id,
          taskId: context.taskId,
          name,
          mimeType,
          bytes,
          sha256,
        });
        return {
          content: JSON.stringify({ path: relativePath, name, mimeType, size: bytes.length, sha256, artifactId: exported.artifactId }),
          artifactIds: [exported.artifactId],
        };
      }
      return {
        content: JSON.stringify({ path: relativePath, name, mimeType, size: bytes.length, sha256 }),
        artifacts: [{ name, path: target, mimeType, transient: false, sha256 }],
      };
    },
  };

  const search: ToolDefinition = {
    name: 'workspace.search',
    description: 'Search UTF-8 workspace files for a literal string.',
    inputSchema: schema({
      query: { type: 'string', minLength: 1 },
      path: { type: 'string', default: '.' },
      maxResults: { type: 'integer', minimum: 1, maximum: 500 },
    }, ['query']),
    requiredCapabilities: [READ_CAPABILITY],
    requiresWorkspace: true,
    sideEffect: 'read',
    async execute(input, context) {
      const workspace = requireWorkspace(context, READ_CAPABILITY);
      const root = await existingWorkspaceRoot(workspace);
      const base = await resolveExisting(root, stringInput(input, 'path', false) ?? '.');
      const query = stringInput(input, 'query')!;
      if (query.length === 0) throw new DomainError('invalid_input', 'query cannot be empty');
      const resultLimit = numberInput(input, 'maxResults', 100, 500);
      const results: Array<{ path: string; line: number; text: string }> = [];
      const pending = [base];
      let scannedFiles = 0;
      while (pending.length && results.length < resultLimit && scannedFiles < maxSearchFiles) {
        const current = pending.shift()!;
        const details = await lstat(current);
        if (details.isSymbolicLink()) continue;
        if (details.isDirectory()) {
          for (const child of await readdir(current)) pending.push(path.join(current, child));
          continue;
        }
        if (!details.isFile() || details.size > maxReadBytes) continue;
        scannedFiles += 1;
        const content = await readFile(current);
        if (content.includes(0)) continue;
        const lines = content.toString('utf8').split('\n');
        for (let index = 0; index < lines.length && results.length < resultLimit; index += 1) {
          const line = lines[index];
          if (line?.includes(query)) results.push({ path: path.relative(root, current), line: index + 1, text: line });
        }
      }
      return { content: JSON.stringify({ results, truncated: results.length >= resultLimit || scannedFiles >= maxSearchFiles, scannedFiles }) };
    },
  };

  const write: ToolDefinition = {
    name: 'workspace.write',
    description: 'Write a workspace file with SHA-256 conflict detection and a task-owned restore checkpoint.',
    inputSchema: schema({
      path: { type: 'string' },
      content: { type: 'string' },
      expectedHash: { type: 'string', description: 'Required when replacing an existing file.' },
    }, ['path', 'content']),
    requiredCapabilities: [WRITE_CAPABILITY],
    requiresWorkspace: true,
    sideEffect: 'write',
    async execute(input, context) {
      const workspace = requireWorkspace(context, WRITE_CAPABILITY);
      const root = await existingWorkspaceRoot(workspace);
      const requested = stringInput(input, 'path')!;
      const target = await resolveForWrite(root, requested);
      const content = stringInput(input, 'content')!;
      const expectedHash = stringInput(input, 'expectedHash', false);
      let previous: Buffer | undefined;
      try {
        previous = await readFile(target);
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== 'ENOENT') throw error;
      }
      const previousHash = previous ? hash(previous) : undefined;
      if (previous && expectedHash === undefined) {
        throw new DomainError('hash_required', 'expectedHash is required when replacing an existing file', 409);
      }
      if (previousHash !== expectedHash && (previous !== undefined || expectedHash !== undefined)) {
        throw new DomainError('write_conflict', 'File changed since it was read (hash conflict)', 409);
      }
      const writtenHash = hash(content);
      const restoreToken = randomBytes(32).toString('base64url');
      const checkpointId = randomUUID();
      const checkpoint: Checkpoint = {
        id: checkpointId,
        workspaceId: workspace.id,
        workspaceRoot: root,
        relativePath: path.relative(root, target),
        taskId: context.taskId,
        principalId: context.principal.id,
        previousExists: previous !== undefined,
        previousContent: previous?.toString('base64'),
        previousHash,
        writtenHash,
        restoreTokenHash: hash(restoreToken),
        createdAt: new Date().toISOString(),
      };
      const checkpointPath = path.join(checkpointRoot, `${checkpointId}.json`);
      context.signal.throwIfAborted();
      await writeFile(checkpointPath, JSON.stringify(checkpoint), { flag: 'wx', mode: 0o600 });
      try {
        context.signal.throwIfAborted();
        await atomicWrite(target, content);
      } catch (error) {
        await rm(checkpointPath, { force: true });
        throw error;
      }
      return {
        content: JSON.stringify({
          path: checkpoint.relativePath,
          previousHash,
          sha256: writtenHash,
          checkpointId,
          restoreToken,
          diff: diffText(previous?.toString('utf8') ?? '', content),
          gitStatus: await gitStatus(root, checkpoint.relativePath),
        }),
      };
    },
  };

  const patchTool: ToolDefinition = {
    name: 'workspace.patch',
    description: 'Apply one bounded context patch with SHA-256 conflict detection and a task-owned restore checkpoint.',
    inputSchema: schema({
      patch: { type: 'string', maxLength: maxPatchBytes },
      expectedHash: { type: 'string', pattern: '^[0-9a-f]{64}$' },
    }, ['patch', 'expectedHash']),
    requiredCapabilities: [WRITE_CAPABILITY],
    requiresWorkspace: true,
    sideEffect: 'write',
    async execute(input, context) {
      const workspace = requireWorkspace(context, WRITE_CAPABILITY);
      const root = await existingWorkspaceRoot(workspace);
      const parsed = parseWorkspacePatch(stringInput(input, 'patch')!, { maxBytes: maxPatchBytes });
      const target = await resolveForWrite(root, parsed.path);
      const details = await stat(target).catch((error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') throw new DomainError('path_not_found', 'Workspace path was not found', 404);
        throw error;
      });
      if (!details.isFile()) throw new DomainError('not_a_file', 'Workspace path is not a file');
      if (details.size > maxReadBytes) throw new DomainError('file_too_large', `File exceeds ${maxReadBytes} bytes`, 413);
      const expectedHash = stringInput(input, 'expectedHash')!;
      if (!/^[0-9a-f]{64}$/.test(expectedHash)) {
        throw new DomainError('invalid_input', 'expectedHash must be a lowercase SHA-256 hash');
      }
      const previous = await readFile(target);
      const previousHash = hash(previous);
      if (previousHash !== expectedHash) {
        throw new DomainError('write_conflict', 'File changed since it was read (hash conflict)', 409);
      }
      let previousText: string;
      try {
        previousText = new TextDecoder('utf-8', { fatal: true }).decode(previous);
      } catch {
        throw new DomainError('binary_file', 'Only valid UTF-8 text files can be patched.');
      }
      const content = applyWorkspacePatch(previousText, parsed);
      const writtenHash = hash(content);
      if (writtenHash === previousHash) throw new DomainError('no_change', 'Patch does not change the file.', 409);
      const restoreToken = randomBytes(32).toString('base64url');
      const current = await readFile(target);
      if (hash(current) !== previousHash) {
        throw new DomainError('write_conflict', 'File changed while the patch was prepared (hash conflict)', 409);
      }
      const checkpointId = randomUUID();
      const checkpoint: Checkpoint = {
        id: checkpointId,
        workspaceId: workspace.id,
        workspaceRoot: root,
        relativePath: path.relative(root, target),
        taskId: context.taskId,
        principalId: context.principal.id,
        previousExists: true,
        previousContent: previous.toString('base64'),
        previousHash,
        writtenHash,
        restoreTokenHash: hash(restoreToken),
        createdAt: new Date().toISOString(),
      };
      const checkpointPath = path.join(checkpointRoot, `${checkpointId}.json`);
      context.signal.throwIfAborted();
      await writeFile(checkpointPath, JSON.stringify(checkpoint), { flag: 'wx', mode: 0o600 });
      try {
        context.signal.throwIfAborted();
        await atomicWrite(target, content);
      } catch (error) {
        await rm(checkpointPath, { force: true });
        throw error;
      }
      return {
        content: JSON.stringify({
          path: checkpoint.relativePath,
          previousHash,
          sha256: writtenHash,
          checkpointId,
          restoreToken,
          diff: diffText(previousText, content),
          gitStatus: await gitStatus(root, checkpoint.relativePath),
        }),
      };
    },
  };

  const statusTool: ToolDefinition = {
    name: 'workspace.status',
    description: 'Return Git short status for the workspace or one workspace path.',
    inputSchema: schema({ path: { type: 'string' } }),
    requiredCapabilities: [READ_CAPABILITY],
    requiresWorkspace: true,
    sideEffect: 'read',
    async execute(input, context) {
      const workspace = requireWorkspace(context, READ_CAPABILITY);
      const root = await existingWorkspaceRoot(workspace);
      const requested = stringInput(input, 'path', false);
      let relative: string | undefined;
      if (requested) relative = path.relative(root, await resolveExisting(root, requested));
      return { content: JSON.stringify({ status: await gitStatus(root, relative) }) };
    },
  };

  const restore: ToolDefinition = {
    name: 'workspace.restore',
    description: 'Restore one task-owned write checkpoint, or a holder-authorized checkpoint, if the file has not changed again.',
    inputSchema: schema({
      checkpointId: { type: 'string', format: 'uuid' },
      restoreToken: { type: 'string', pattern: '^[A-Za-z0-9_-]{43}$' },
    }, ['checkpointId']),
    requiredCapabilities: [WRITE_CAPABILITY],
    requiresWorkspace: true,
    sideEffect: 'write',
    async execute(input, context) {
      const workspace = requireWorkspace(context, WRITE_CAPABILITY);
      const root = await existingWorkspaceRoot(workspace);
      const checkpointId = stringInput(input, 'checkpointId')!;
      if (!/^[0-9a-f-]{36}$/i.test(checkpointId)) throw new DomainError('invalid_input', 'Invalid checkpointId');
      const checkpointPath = path.join(checkpointRoot, `${checkpointId}.json`);
      const resolvedCheckpoint = path.resolve(checkpointPath);
      if (!isWithin(checkpointRoot, resolvedCheckpoint)) throw new DomainError('invalid_input', 'Invalid checkpointId');
      const checkpoint = JSON.parse(await readFile(resolvedCheckpoint, 'utf8').catch(() => {
        throw new DomainError('checkpoint_not_found', 'Checkpoint was not found', 404);
      })) as Checkpoint;
      if (checkpoint.principalId !== context.principal.id) throw new DomainError('checkpoint_forbidden', 'Checkpoint belongs to another principal', 403);
      const restoreToken = stringInput(input, 'restoreToken', false);
      if (checkpoint.taskId !== context.taskId && !validRestoreToken(checkpoint, restoreToken)) {
        throw new DomainError('checkpoint_forbidden', 'A valid restore token is required outside the creating task', 403);
      }
      if (checkpoint.workspaceId !== workspace.id || checkpoint.workspaceRoot !== root) {
        throw new DomainError('checkpoint_forbidden', 'Checkpoint belongs to another workspace', 403);
      }
      const target = await resolveForWrite(root, checkpoint.relativePath);
      const current = await readFile(target).catch(() => undefined);
      if (!current || hash(current) !== checkpoint.writtenHash) {
        throw new DomainError('restore_conflict', 'File changed after this checkpoint (restore conflict)', 409);
      }
      if (checkpoint.previousExists) {
        context.signal.throwIfAborted();
        await atomicWrite(target, Buffer.from(checkpoint.previousContent ?? '', 'base64'));
      } else {
        context.signal.throwIfAborted();
        await rm(target);
      }
      await rm(resolvedCheckpoint);
      return { content: JSON.stringify({ restored: checkpoint.relativePath, sha256: checkpoint.previousHash ?? null }) };
    },
  };

  return [list, read, search, exportTool, write, patchTool, statusTool, restore];
}
