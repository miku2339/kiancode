export const memoryTimestampPattern = '^[0-9]{4}-((01|03|05|07|08|10|12)-(0[1-9]|[12][0-9]|3[01])|(04|06|09|11)-(0[1-9]|[12][0-9]|30)|02-(0[1-9]|1[0-9]|2[0-9]))T([01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9](\\.[0-9]+)?Z$';
export const memoryLeapDayPattern = '^([0-9]{2}(0[48]|[2468][048]|[13579][26])|(0[48]|[2468][048]|[13579][26])00)-02-29T';

const memoryTimestamp = new RegExp(memoryTimestampPattern);
const memoryLeapDay = new RegExp(memoryLeapDayPattern);

export function validMemoryTimestamp(value: unknown): boolean {
  if (value === undefined) return true;
  if (typeof value !== 'string') return false;
  if (!memoryTimestamp.test(value) || value.startsWith('0000-')) return false;
  return !value.startsWith(`${value.slice(0, 4)}-02-29T`) || memoryLeapDay.test(value);
}
