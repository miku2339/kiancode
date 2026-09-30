import { constants as fsConstants } from 'node:fs';
import { open, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { DomainError } from '../contracts.js';

export const MAX_WORKSPACE_EXPORT_BYTES = 6 * 1024 * 1024;

export const WORKSPACE_EXPORT_MIME_TYPES = [
  'application/json',
  'application/pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'image/jpeg',
  'image/png',
  'image/webp',
  'text/csv',
  'text/markdown',
  'text/plain',
] as const;

export const WORKSPACE_EXPORT_MIME_BY_EXTENSION = {
  '.csv': 'text/csv',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.json': 'application/json',
  '.md': 'text/markdown',
  '.pdf': 'application/pdf',
  '.png': 'image/png',
  '.txt': 'text/plain',
  '.webp': 'image/webp',
} as const;

export type WorkspaceExportMimeType = typeof WORKSPACE_EXPORT_MIME_TYPES[number];

export function workspaceExportMimeType(name: string): WorkspaceExportMimeType | undefined {
  return WORKSPACE_EXPORT_MIME_BY_EXTENSION[path.extname(name).toLowerCase() as keyof typeof WORKSPACE_EXPORT_MIME_BY_EXTENSION];
}

function isWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

async function verifyOpenedPath(target: string, root: string | undefined, device: number, inode: number): Promise<void> {
  const resolved = await realpath(target).catch(() => {
    throw new DomainError('export_conflict', 'Workspace file path changed while it was being exported', 409);
  });
  if (root && !isWithin(root, resolved)) throw new DomainError('path_outside_workspace', 'Export path resolves outside workspace', 403);
  const current = await stat(resolved);
  if (current.dev !== device || current.ino !== inode) {
    throw new DomainError('export_conflict', 'Workspace file path changed while it was being exported', 409);
  }
}

export async function readStableWorkspaceExport(
  target: string,
  maximumBytes = MAX_WORKSPACE_EXPORT_BYTES,
  workspaceRoot?: string,
): Promise<Buffer> {
  let file;
  try {
    file = await open(target, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ELOOP') {
      throw new DomainError('path_outside_workspace', 'Export path changed to a symbolic link', 409);
    }
    throw error;
  }
  try {
    const before = await file.stat();
    if (!before.isFile()) throw new DomainError('not_a_file', 'Workspace path is not a regular file');
    await verifyOpenedPath(target, workspaceRoot, before.dev, before.ino);
    if (before.size <= 0 || before.size > maximumBytes) {
      throw new DomainError('file_too_large', `Export file must contain data and not exceed ${maximumBytes} bytes`, 413);
    }
    const chunks: Buffer[] = [];
    let total = 0;
    while (total <= maximumBytes) {
      const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, maximumBytes + 1 - total));
      const { bytesRead } = await file.read(chunk, 0, chunk.length, total);
      if (bytesRead === 0) break;
      chunks.push(chunk.subarray(0, bytesRead));
      total += bytesRead;
    }
    if (total > maximumBytes) {
      throw new DomainError('file_too_large', `Export file must not exceed ${maximumBytes} bytes`, 413);
    }
    const after = await file.stat();
    await verifyOpenedPath(target, workspaceRoot, after.dev, after.ino);
    if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size
      || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs || total !== after.size) {
      throw new DomainError('export_conflict', 'Workspace file changed while it was being exported', 409);
    }
    return Buffer.concat(chunks, total);
  } finally {
    await file.close();
  }
}

export function validateWorkspaceExport(bytes: Uint8Array, name: string, mimeType: string): void {
  if (!name || name.length > 255 || /[\x00-\x1f\x7f/\\]/.test(name) || workspaceExportMimeType(name) !== mimeType) {
    throw new DomainError('invalid_export', 'Workspace export name or media type is not allowed');
  }
  if (bytes.byteLength === 0 || bytes.byteLength > MAX_WORKSPACE_EXPORT_BYTES) {
    throw new DomainError('file_too_large', `Export file must contain data and not exceed ${MAX_WORKSPACE_EXPORT_BYTES} bytes`, 413);
  }
  const content = Buffer.from(bytes);
  if (mimeType === 'application/pdf' && !content.subarray(0, 5).equals(Buffer.from('%PDF-'))) {
    throw new DomainError('invalid_export', 'Export file does not contain a valid PDF header');
  }
  if (mimeType === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
    && !content.subarray(0, 4).equals(Buffer.from([80, 75, 3, 4]))) {
    throw new DomainError('invalid_export', 'Export file does not contain a valid DOCX header');
  }
  if (mimeType === 'image/png' && !content.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
    throw new DomainError('invalid_export', 'Export file does not contain a valid PNG header');
  }
  if (mimeType === 'image/jpeg' && !content.subarray(0, 3).equals(Buffer.from([255, 216, 255]))) {
    throw new DomainError('invalid_export', 'Export file does not contain a valid JPEG header');
  }
  if (mimeType === 'image/webp'
    && (!content.subarray(0, 4).equals(Buffer.from('RIFF')) || !content.subarray(8, 12).equals(Buffer.from('WEBP')))) {
    throw new DomainError('invalid_export', 'Export file does not contain a valid WebP header');
  }
  if (mimeType.startsWith('text/') || mimeType === 'application/json') {
    let text: string;
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(content);
    } catch {
      throw new DomainError('invalid_export', 'Text exports must contain valid UTF-8');
    }
    if (mimeType === 'application/json') {
      try { JSON.parse(text); } catch { throw new DomainError('invalid_export', 'JSON exports must contain valid JSON'); }
    }
  }
}
