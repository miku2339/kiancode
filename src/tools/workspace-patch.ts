/*
 * The update-hunk format and matching order are adapted from OpenAI Codex
 * codex-rs/apply-patch at 8f195c93d7e7acfef95acf273f0e49cce917e291.
 * This TypeScript version is modified to accept one update file only, require
 * a caller-supplied content hash, bound input, and reject ambiguous matches.
 * Licensed under Apache-2.0; see NOTICE and third_party/openai-codex/LICENSE.
 */
import { DomainError } from '../contracts.js';

interface PatchChunk {
  changeContext?: string;
  oldLines: string[];
  newLines: string[];
  endOfFile: boolean;
}

export interface ParsedWorkspacePatch {
  path: string;
  chunks: PatchChunk[];
}

export interface WorkspacePatchLimits {
  maxBytes: number;
  maxHunks?: number;
  maxLines?: number;
}

const beginMarker = '*** Begin Patch';
const endMarker = '*** End Patch';
const updateMarker = '*** Update File: ';
const endOfFileMarker = '*** End of File';

function invalid(message: string): never {
  throw new DomainError('invalid_patch', message);
}

export function parseWorkspacePatch(text: string, limits: WorkspacePatchLimits): ParsedWorkspacePatch {
  if (Buffer.byteLength(text, 'utf8') > limits.maxBytes) {
    throw new DomainError('patch_too_large', `Patch exceeds ${limits.maxBytes} bytes`, 413);
  }
  if (text.includes('\0')) invalid('Patch must contain UTF-8 text only.');
  const lines = text.replaceAll('\r\n', '\n').split('\n');
  if (lines.at(-1) === '') lines.pop();
  const maxLines = limits.maxLines ?? 10_000;
  if (lines.length > maxLines) throw new DomainError('patch_too_large', `Patch exceeds ${maxLines} lines`, 413);
  if (lines[0]?.trim() !== beginMarker || lines.at(-1)?.trim() !== endMarker) {
    invalid(`Patch must start with '${beginMarker}' and end with '${endMarker}'.`);
  }
  const header = lines[1];
  if (!header?.startsWith(updateMarker)) {
    invalid('Exactly one Update File operation is required.');
  }
  const filePath = header.slice(updateMarker.length).trim();
  if (!filePath) invalid('Update File path is required.');
  const chunks: PatchChunk[] = [];
  let index = 2;
  const maxHunks = limits.maxHunks ?? 100;
  while (index < lines.length - 1) {
    const marker = lines[index];
    if (marker !== '@@' && !marker?.startsWith('@@ ')) {
      invalid(`Expected a context marker at patch line ${index + 1}.`);
    }
    const chunk: PatchChunk = {
      ...(marker === '@@' ? {} : { changeContext: marker.slice(3) }),
      oldLines: [],
      newLines: [],
      endOfFile: false,
    };
    index += 1;
    let changed = false;
    while (index < lines.length - 1) {
      const line = lines[index]!;
      if (line === '@@' || line.startsWith('@@ ')) break;
      if (line === endOfFileMarker) {
        chunk.endOfFile = true;
        index += 1;
        break;
      }
      if (line.startsWith(' ')) {
        const content = line.slice(1);
        chunk.oldLines.push(content);
        chunk.newLines.push(content);
      } else if (line.startsWith('-')) {
        chunk.oldLines.push(line.slice(1));
        changed = true;
      } else if (line.startsWith('+')) {
        chunk.newLines.push(line.slice(1));
        changed = true;
      } else {
        invalid(`Invalid change line at patch line ${index + 1}.`);
      }
      index += 1;
    }
    if (!changed) invalid(`Patch hunk ${chunks.length + 1} has no changes.`);
    if (chunk.oldLines.length === 0) {
      invalid('Insertion-only hunks are not supported; include a context line.');
    }
    chunks.push(chunk);
    if (chunks.length > maxHunks) throw new DomainError('patch_too_large', `Patch exceeds ${maxHunks} hunks`, 413);
    if (chunk.endOfFile && index < lines.length - 1) {
      invalid('End of File must be the final marker in an update.');
    }
  }
  if (chunks.length === 0) invalid('Update File operation must contain at least one hunk.');
  return { path: filePath, chunks };
}

type Comparison = (value: string) => string;

function findUniqueSequence(
  lines: string[],
  pattern: string[],
  start: number,
  endOfFile: boolean,
): number {
  const comparisons: Comparison[] = [
    (value) => value,
    (value) => value.trimEnd(),
    (value) => value.trim(),
  ];
  for (const compare of comparisons) {
    const matches: number[] = [];
    const lastStart = lines.length - pattern.length;
    const first = endOfFile ? lastStart : start;
    const last = endOfFile ? lastStart : lastStart;
    for (let candidate = Math.max(0, first); candidate <= last; candidate += 1) {
      if (candidate < start) continue;
      if (pattern.every((line, offset) => compare(lines[candidate + offset] ?? '') === compare(line))) {
        matches.push(candidate);
      }
    }
    if (matches.length === 1) return matches[0]!;
    if (matches.length > 1) {
      throw new DomainError('patch_ambiguous', 'Patch context matches more than one location.', 409);
    }
  }
  throw new DomainError('patch_context_not_found', 'Patch context was not found.', 409);
}

function sourceLines(content: string): { lines: string[]; ending: '\n' | '\r\n'; finalNewline: boolean } {
  if (content.includes('\0')) throw new DomainError('binary_file', 'Binary files cannot be patched.');
  const withoutCrLf = content.replaceAll('\r\n', '');
  if (withoutCrLf.includes('\r')) throw new DomainError('unsupported_line_endings', 'Unsupported line endings.');
  const ending = content.includes('\r\n') ? '\r\n' : '\n';
  if (ending === '\r\n' && content.replaceAll('\r\n', '').includes('\n')) {
    throw new DomainError('unsupported_line_endings', 'Mixed line endings cannot be patched.');
  }
  const finalNewline = content.endsWith(ending);
  const body = finalNewline ? content.slice(0, -ending.length) : content;
  return { lines: body ? body.split(ending) : [], ending, finalNewline };
}

export function applyWorkspacePatch(original: string, patch: ParsedWorkspacePatch): string {
  const source = sourceLines(original);
  const lines = [...source.lines];
  let cursor = 0;
  for (const chunk of patch.chunks) {
    if (chunk.changeContext !== undefined) {
      cursor = findUniqueSequence(lines, [chunk.changeContext], cursor, false) + 1;
    }
    const location = findUniqueSequence(lines, chunk.oldLines, cursor, chunk.endOfFile);
    lines.splice(location, chunk.oldLines.length, ...chunk.newLines);
    cursor = location + chunk.newLines.length;
  }
  const result = lines.join(source.ending);
  return source.finalNewline ? `${result}${source.ending}` : result;
}
