import { DomainError } from '../contracts.js';

function hasUnsupportedText(value: unknown, seen: Set<object>): boolean {
  if (typeof value === 'string') {
    for (let index = 0; index < value.length; index += 1) {
      const code = value.charCodeAt(index);
      if (code === 0) return true;
      if (code >= 0xd800 && code <= 0xdbff) {
        const next = value.charCodeAt(index + 1);
        if (!Number.isFinite(next) || next < 0xdc00 || next > 0xdfff) return true;
        index += 1;
      } else if (code >= 0xdc00 && code <= 0xdfff) return true;
    }
    return false;
  }
  if (!value || typeof value !== 'object' || seen.has(value)) return false;
  seen.add(value);
  for (const [key, item] of Object.entries(value)) {
    if (hasUnsupportedText(key, seen) || hasUnsupportedText(item, seen)) return true;
  }
  return false;
}

export function serializeData(data: unknown): string {
  if (hasUnsupportedText(data, new Set())) throw new DomainError('invalid_data', 'Data contains unsupported text', 400);
  try {
    const serialized = JSON.stringify(data);
    if (serialized === undefined) throw new Error('Data is not JSON serializable');
    return serialized;
  } catch (error) {
    if (error instanceof DomainError) throw error;
    throw new DomainError('invalid_data', 'Data is not JSON serializable', 400);
  }
}
