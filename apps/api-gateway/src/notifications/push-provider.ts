import { Logger } from '@nestjs/common';
import { randomUUID } from 'crypto';

/** Minimal lock-screen-safe message: no measurements, names or diagnoses. */
export interface PushMessage {
  to: string;
  title: string;
  body: string;
  data: { alertId: string; attemptId: number };
  priority: 'high';
  channelId: 'critical-alerts' | 'alerts';
  sound: 'default';
  ttl: number;
}

export type PushTicket =
  | { status: 'ok'; id: string }
  | { status: 'error'; message?: string; details?: { error?: string } };

export type PushReceipt =
  | { status: 'ok' }
  | { status: 'error'; message?: string; details?: { error?: string } };

/**
 * AR-6 provider boundary. A ticket/receipt says only what the provider did
 * with the message; nothing here can tell whether a person saw it.
 */
export interface PushProvider {
  readonly name: string;
  /** Tickets map 1:1 to messages. Throws on transport/HTTP failure (retryable). */
  send(messages: PushMessage[]): Promise<PushTicket[]>;
  /** Receipts for the ids the provider still knows about. */
  getReceipts(ids: string[]): Promise<Record<string, PushReceipt>>;
}

export const PUSH_PROVIDER = Symbol('PUSH_PROVIDER');

const EXPO_BASE = 'https://exp.host/--/api/v2/push';
const SEND_CHUNK = 100;
const RECEIPT_CHUNK = 300;
const HTTP_TIMEOUT_MS = 10_000;

const chunks = <T>(items: T[], size: number) =>
  Array.from({ length: Math.ceil(items.length / size) }, (_, i) =>
    items.slice(i * size, (i + 1) * size),
  );

/** Expo push service over HTTPS (no SDK dependency). */
export class ExpoHttpPushProvider implements PushProvider {
  readonly name = 'expo';

  constructor(
    private readonly accessToken: string | undefined,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async send(messages: PushMessage[]): Promise<PushTicket[]> {
    const tickets: PushTicket[] = [];
    for (const chunk of chunks(messages, SEND_CHUNK)) {
      const body = await this.post<{ data?: PushTicket[] }>('/send', chunk);
      if (!Array.isArray(body.data) || body.data.length !== chunk.length) {
        throw new Error('expo push: ticket count does not match message count');
      }
      tickets.push(...body.data);
    }
    return tickets;
  }

  async getReceipts(ids: string[]): Promise<Record<string, PushReceipt>> {
    const receipts: Record<string, PushReceipt> = {};
    for (const chunk of chunks(ids, RECEIPT_CHUNK)) {
      const body = await this.post<{ data?: Record<string, PushReceipt> }>(
        '/getReceipts',
        { ids: chunk },
      );
      Object.assign(receipts, body.data ?? {});
    }
    return receipts;
  }

  private async post<T>(path: string, payload: unknown): Promise<T> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Accept: 'application/json',
    };
    if (this.accessToken) headers.Authorization = `Bearer ${this.accessToken}`;
    const res = await this.fetchImpl(`${EXPO_BASE}${path}`, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`expo push: HTTP ${res.status}`);
    return (await res.json()) as T;
  }
}

/** Default outside production: logs what would be sent, contacts no one. */
export class DryRunPushProvider implements PushProvider {
  readonly name = 'dryrun';
  private readonly logger = new Logger('DryRunPushProvider');

  send(messages: PushMessage[]): Promise<PushTicket[]> {
    for (const m of messages) {
      this.logger.log(
        `dry-run push: alert=${m.data.alertId} attempt=${m.data.attemptId} title="${m.title}"`,
      );
    }
    return Promise.resolve(
      messages.map(() => ({ status: 'ok', id: `dryrun-${randomUUID()}` })),
    );
  }

  getReceipts(ids: string[]): Promise<Record<string, PushReceipt>> {
    return Promise.resolve(
      Object.fromEntries(ids.map((id) => [id, { status: 'ok' } as const])),
    );
  }
}

/** PUSH_PROVIDER=expo selects Expo; anything else is a dry run. */
export function createPushProvider(
  env: NodeJS.ProcessEnv = process.env,
): PushProvider {
  return env.PUSH_PROVIDER === 'expo'
    ? new ExpoHttpPushProvider(env.EXPO_ACCESS_TOKEN)
    : new DryRunPushProvider();
}
