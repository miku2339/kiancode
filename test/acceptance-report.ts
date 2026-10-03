import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { stripVTControlCharacters } from 'node:util';

export interface AcceptanceReport {
  readonly path: string | undefined;
  passed(evidence: object): Promise<void>;
  failed(error: unknown, evidence: object): Promise<void>;
}

export interface AcceptanceReportFileOperations {
  rename(source: string, target: string): Promise<void>;
}

const defaultFileOperations: AcceptanceReportFileOperations = { rename };

const sensitiveKey = /authorization|cookie|token|secret|password|api.?key|database.?url|endpoint/i;

function safeText(value: string): string {
  return stripVTControlCharacters(value)
    .replace(/\b(?:https?|postgres(?:ql)?|socket):[^\s"'<>]+/gi, '[redacted endpoint]')
    .replace(/\bBearer\s+\S+/gi, 'Bearer [redacted]')
    .replace(/\b(ENOTFOUND|ECONNREFUSED|EHOSTUNREACH)\s+\S+/gi, '$1 [redacted endpoint]')
    .replace(/\b(token|secret|password|api[_ -]?key|database[_ -]?url)\b\s*[:=]\s*\S+/gi, '$1=[redacted]')
    .replace(/\b([A-Z0-9_]*(?:TOKEN|SECRET|PASSWORD|API_KEY|DATABASE_URL))=\S+/gi, '$1=[redacted]')
    .replace(/(?:\/[^/\s"'():]+){2,}/g, '[redacted path]');
}

function safeEvidence(value: object): Record<string, unknown> {
  const sanitize = (entry: unknown, key?: string): unknown => {
    if (key && sensitiveKey.test(key)) return '[redacted]';
    if (typeof entry === 'string') return safeText(entry);
    if (Array.isArray(entry)) return entry.map((item) => sanitize(item));
    if (entry && typeof entry === 'object') {
      return Object.fromEntries(Object.entries(entry).map(([childKey, child]) => [
        childKey,
        sanitize(child, childKey),
      ]));
    }
    return entry;
  };
  const sanitized = sanitize(value) as Record<string, unknown>;
  for (const reserved of ['status', 'startedAt', 'finishedAt', 'packageVersion', 'error']) {
    delete sanitized[reserved];
  }
  return sanitized;
}

export async function writeAcceptanceReportAtomically(
  file: string,
  value: object,
  operations: AcceptanceReportFileOperations = defaultFileOperations,
): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.${randomUUID()}.tmp`);
  let moved = false;
  let failure: unknown;
  try {
    await writeFile(temporary, `${JSON.stringify(value)}\n`, { flag: 'wx', mode: 0o600 });
    await operations.rename(temporary, file);
    moved = true;
  } catch (error) {
    failure = error;
  }
  if (!moved) {
    try {
      await rm(temporary, { force: true });
    } catch (cleanupError) {
      throw new AggregateError([failure, cleanupError], 'Writing and cleaning up the acceptance report failed');
    }
    throw failure;
  }
}

export async function openAcceptanceReport(
  target: string | undefined,
  operations: AcceptanceReportFileOperations = defaultFileOperations,
): Promise<AcceptanceReport> {
  const file = target ? path.resolve(target) : undefined;
  const startedAt = new Date().toISOString();
  const { version: packageVersion } = JSON.parse(
    await readFile(new URL('../package.json', import.meta.url), 'utf8'),
  ) as { version: string };
  const write = async (value: object): Promise<void> => {
    if (file) await writeAcceptanceReportAtomically(file, value, operations);
  };
  await write({ status: 'incomplete', startedAt, packageVersion });
  return {
    path: file,
    passed: (evidence) => write({
      status: 'passed',
      startedAt,
      finishedAt: new Date().toISOString(),
      packageVersion,
      ...safeEvidence(evidence),
    }),
    failed: (error, evidence) => write({
      status: 'failed',
      startedAt,
      finishedAt: new Date().toISOString(),
      packageVersion,
      error: safeText(error instanceof Error ? error.message : String(error)),
      ...safeEvidence(evidence),
    }),
  };
}
