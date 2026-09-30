import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, realpath, rename, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { DomainError, type ToolContext, type ToolDefinition } from '../contracts.js';
import { requireScope } from '../auth.js';

export interface ParsedSkill {
  name: string;
  description: string;
  instructions: string;
  metadata: Record<string, string | boolean | string[]>;
}

export interface SkillManifestEntry {
  id: string;
  name: string;
  description: string;
  skillFile: string;
  enabled: boolean;
  pinnedHash?: string;
  importedAt: string;
}

interface SkillManifest {
  version: 1;
  skills: SkillManifestEntry[];
}

export interface SkillRegistryOptions {
  manifestPath: string;
  importRoots: string[];
}

function hash(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

function isWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function scalar(raw: string): string | boolean | string[] {
  const value = raw.trim();
  if (value === 'true') return true;
  if (value === 'false') return false;
  if (value.startsWith('[') && value.endsWith(']')) {
    return value.slice(1, -1).split(',').map((item) => item.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean);
  }
  return value.replace(/^['"]|['"]$/g, '');
}

export function parseSkillMarkdown(content: string): ParsedSkill {
  const normalized = content.replace(/\r\n/g, '\n');
  if (!normalized.startsWith('---\n')) throw new DomainError('invalid_skill', 'SKILL.md must start with YAML frontmatter');
  const end = normalized.indexOf('\n---\n', 4);
  if (end < 0) throw new DomainError('invalid_skill', 'SKILL.md frontmatter is not closed');
  const frontmatter = normalized.slice(4, end);
  const instructions = normalized.slice(end + 5).trim();
  const metadata: Record<string, string | boolean | string[]> = {};
  const lines = frontmatter.split('\n');
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;
    if (!line.trim() || line.trimStart().startsWith('#')) continue;
    if (/^\s/.test(line)) continue;
    const separator = line.indexOf(':');
    if (separator <= 0) throw new DomainError('invalid_skill', `Invalid frontmatter line: ${line}`);
    const key = line.slice(0, separator).trim();
    const raw = line.slice(separator + 1).trim();
    if (raw === '|' || raw === '>') {
      const block: string[] = [];
      while (index + 1 < lines.length && (/^\s/.test(lines[index + 1]!) || lines[index + 1] === '')) {
        index += 1;
        block.push(lines[index]!.replace(/^\s+/, ''));
      }
      metadata[key] = raw === '>' ? block.join(' ').trim() : block.join('\n').trim();
    } else {
      metadata[key] = scalar(raw);
    }
  }
  const name = metadata.name;
  const description = metadata.description;
  if (typeof name !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(name)) {
    throw new DomainError('invalid_skill', 'Skill name is missing or invalid');
  }
  if (typeof description !== 'string' || description.length === 0) {
    throw new DomainError('invalid_skill', 'Skill description is missing');
  }
  if (!instructions) throw new DomainError('invalid_skill', 'Skill instructions are empty');
  return { name, description, instructions, metadata };
}

export class SkillRegistry {
  constructor(private readonly options: SkillRegistryOptions) {
    if (options.importRoots.length === 0) throw new DomainError('invalid_configuration', 'At least one skill import root is required');
  }

  private async manifest(): Promise<SkillManifest> {
    try {
      const value = JSON.parse(await readFile(this.options.manifestPath, 'utf8')) as SkillManifest;
      if (value.version !== 1 || !Array.isArray(value.skills)) throw new Error('invalid manifest');
      return value;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { version: 1, skills: [] };
      throw new DomainError('invalid_skill_manifest', 'Skill manifest is invalid');
    }
  }

  private async save(manifest: SkillManifest): Promise<void> {
    await mkdir(path.dirname(this.options.manifestPath), { recursive: true });
    const temporary = `${this.options.manifestPath}.${randomUUID()}.tmp`;
    await writeFile(temporary, `${JSON.stringify(manifest, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
    await rename(temporary, this.options.manifestPath);
  }

  private async allowedSkillFile(source: string): Promise<string> {
    const resolvedSource = await realpath(source).catch(() => {
      throw new DomainError('skill_not_found', 'Skill source was not found', 404);
    });
    const details = await stat(resolvedSource);
    const file = details.isDirectory() ? path.join(resolvedSource, 'SKILL.md') : resolvedSource;
    const resolvedFile = await realpath(file).catch(() => {
      throw new DomainError('skill_not_found', 'SKILL.md was not found', 404);
    });
    if (path.basename(resolvedFile) !== 'SKILL.md') throw new DomainError('invalid_skill', 'Skill source must be a SKILL.md file');
    const roots = await Promise.all(this.options.importRoots.map(async (root) => realpath(root)));
    if (!roots.some((root) => isWithin(root, resolvedFile))) {
      throw new DomainError('skill_outside_roots', 'Skill source is outside configured import roots', 403);
    }
    return resolvedFile;
  }

  async importSkill(source: string): Promise<SkillManifestEntry> {
    const skillFile = await this.allowedSkillFile(source);
    const parsed = parseSkillMarkdown(await readFile(skillFile, 'utf8'));
    const manifest = await this.manifest();
    const existing = manifest.skills.find((entry) => entry.id === parsed.name);
    const entry: SkillManifestEntry = {
      id: parsed.name,
      name: parsed.name,
      description: parsed.description,
      skillFile,
      enabled: existing?.enabled ?? false,
      pinnedHash: existing?.pinnedHash,
      importedAt: existing?.importedAt ?? new Date().toISOString(),
    };
    manifest.skills = [...manifest.skills.filter((item) => item.id !== entry.id), entry];
    await this.save(manifest);
    return entry;
  }

  async list(): Promise<SkillManifestEntry[]> {
    return (await this.manifest()).skills.map((entry) => ({ ...entry }));
  }

  async setEnabled(id: string, enabled: boolean): Promise<SkillManifestEntry> {
    const manifest = await this.manifest();
    const entry = manifest.skills.find((item) => item.id === id);
    if (!entry) throw new DomainError('skill_not_found', 'Skill was not found', 404);
    entry.enabled = enabled;
    await this.save(manifest);
    return { ...entry };
  }

  async pin(id: string): Promise<SkillManifestEntry> {
    const manifest = await this.manifest();
    const entry = manifest.skills.find((item) => item.id === id);
    if (!entry) throw new DomainError('skill_not_found', 'Skill was not found', 404);
    entry.pinnedHash = hash(await readFile(entry.skillFile, 'utf8'));
    await this.save(manifest);
    return { ...entry };
  }

  async resolve(id: string): Promise<ParsedSkill> {
    const manifest = await this.manifest();
    const entry = manifest.skills.find((item) => item.id === id);
    if (!entry) throw new DomainError('skill_not_found', 'Skill was not found', 404);
    if (!entry.enabled) throw new DomainError('skill_disabled', 'Skill is disabled', 403);
    const content = await readFile(entry.skillFile, 'utf8').catch(() => {
      throw new DomainError('skill_not_found', 'SKILL.md was not found', 404);
    });
    if (entry.pinnedHash && hash(content) !== entry.pinnedHash) {
      throw new DomainError('skill_pin_mismatch', 'SKILL.md no longer matches its pinned hash', 409);
    }
    return parseSkillMarkdown(content);
  }

  asTools(): ToolDefinition[] {
    const requireCapability = (context: ToolContext): void => {
      requireScope(context.principal, 'skills:read');
    };
    return [
      {
        name: 'skill.list',
        description: 'List registered skills and their enabled and pinned state.',
        inputSchema: { type: 'object', additionalProperties: false, properties: {} },
        requiredCapabilities: ['skills:read'],
        sideEffect: 'read',
        execute: async (_input, context) => {
          requireCapability(context);
          return { content: JSON.stringify({ skills: await this.list() }) };
        },
      },
      {
        name: 'skill.read',
        description: 'Read an enabled skill after validating its optional pin.',
        inputSchema: {
          type: 'object', additionalProperties: false, properties: { id: { type: 'string' } }, required: ['id'],
        },
        requiredCapabilities: ['skills:read'],
        sideEffect: 'read',
        execute: async (input, context) => {
          requireCapability(context);
          if (typeof input.id !== 'string') throw new DomainError('invalid_input', 'id must be a string');
          return { content: JSON.stringify(await this.resolve(input.id)) };
        },
      },
    ];
  }
}
