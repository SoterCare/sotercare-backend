import { Logger } from '@nestjs/common';

// Logs carry IDs only: no names, notes, health values or tokens.
export const REDACT = [
  'name',
  'displayName',
  'note',
  'text',
  'token',
  'password',
  'residentName',
] as const;

const DROP = new Set<string>(REDACT.map((k) => k.toLowerCase()));

export function redact(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      if (DROP.has(k.toLowerCase())) continue;
      out[k] = redact(v);
    }
    return out;
  }
  return value;
}

function line(event: string, fields: Record<string, unknown>): string {
  return JSON.stringify({ event, ...(redact(fields) as object) });
}

export const logger = {
  log(event: string, fields: Record<string, unknown> = {}): void {
    new Logger('app').log(line(event, fields));
  },
  warn(event: string, fields: Record<string, unknown> = {}): void {
    new Logger('app').warn(line(event, fields));
  },
  error(event: string, fields: Record<string, unknown> = {}): void {
    new Logger('app').error(line(event, fields));
  },
};
