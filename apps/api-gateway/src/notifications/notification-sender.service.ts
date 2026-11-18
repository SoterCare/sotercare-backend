import {
  Inject,
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import {
  AlertEventsPublisher,
  severityOf,
} from '../realtime/alert-events.publisher';
import { rowsOf } from './db-rows';
import { PUSH_PROVIDER } from './push-provider';
import type { PushMessage, PushProvider, PushTicket } from './push-provider';

// Retry delays by attempt number; the last value repeats. Retries continue
// for as long as the push is still useful (PUSH_LIFETIME_MS, = message ttl),
// so a provider outage of a few minutes does not lose a safety alert.
const BACKOFF_S = [5, 15, 30, 60, 120];
const PUSH_LIFETIME_MS = 3_600_000;
const CLAIM_BATCH = 100;
const RECEIPT_BATCH = 300;
const RECEIPT_DELAY_MS = 15 * 60_000;
const RECEIPT_GIVE_UP_MS = 24 * 3_600_000;
const STUCK_SENDING_MS = 120_000;
const STALE_ALERT_MS = 24 * 3_600_000;
const LATE_MS = 15 * 60_000;
const TITLES: Record<string, string> = {
  fall: 'Possible fall detected',
  help_call: 'Help call',
  temperature: 'Temperature alert',
  moisture: 'Moisture detected',
};

type Claimed = {
  id: string;
  alertId: string;
  userId: number;
  pushTokenId: string | null;
  escalationLevel: number;
  attemptCount: number;
  createdAt: Date;
};

type Context = {
  type: string;
  deviceId: string;
  createdAt: Date;
  timestamp: Date;
  acknowledgedAt: Date | null;
  isDismissed: boolean;
  token: string | null;
  tokenUserId: number | null;
  revokedAt: Date | null;
};

/**
 * AR-6 sender: claims due attempts (FOR UPDATE SKIP LOCKED, safe across
 * instances), re-checks that the alert still needs this user before every
 * send, and records only what the provider reported. Provider acceptance is
 * never treated as delivery or acknowledgement.
 */
@Injectable()
export class NotificationSenderService
  implements OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(NotificationSenderService.name);
  private timers: NodeJS.Timeout[] = [];
  private busy = false;

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly recipients: AlertEventsPublisher,
    @Inject(PUSH_PROVIDER) private readonly provider: PushProvider,
  ) {}

  onModuleInit() {
    if (process.env.PUSH_ENABLED !== 'true') {
      this.logger.log('push sending disabled (PUSH_ENABLED is not "true")');
      return;
    }
    this.logger.log(
      `push sending enabled via provider "${this.provider.name}"`,
    );
    const every = (ms: number, fn: () => Promise<unknown>) => {
      const t = setInterval(() => void fn(), ms);
      t.unref?.();
      this.timers.push(t);
    };
    every(Number(process.env.PUSH_SEND_INTERVAL_MS ?? 1000), () =>
      this.guarded(() => this.sendDue()),
    );
    every(60_000, () =>
      this.pollReceipts().catch((e) =>
        this.logger.warn(`receipts: ${String(e)}`),
      ),
    );
  }

  onModuleDestroy() {
    this.timers.forEach(clearInterval);
    this.timers = [];
  }

  private async guarded(fn: () => Promise<unknown>) {
    if (this.busy) return;
    this.busy = true;
    try {
      await fn();
    } catch (error) {
      this.logger.warn(`push send loop failed: ${String(error)}`);
    } finally {
      this.busy = false;
    }
  }

  async sendDue(now = new Date()): Promise<number> {
    await this.dataSource.query(
      `UPDATE notification_attempts SET state = 'queued', "updatedAt" = $1
       WHERE state = 'sending' AND "updatedAt" < $2`,
      [now, new Date(now.getTime() - STUCK_SENDING_MS)],
    );
    const claimed = rowsOf<Claimed>(
      await this.dataSource.query(
        `UPDATE notification_attempts SET state = 'sending', "attemptCount" = "attemptCount" + 1, "updatedAt" = $1
         WHERE id IN (
           SELECT id FROM notification_attempts
           WHERE state = 'queued' AND "nextAttemptAt" <= $1
           ORDER BY "nextAttemptAt", id
           LIMIT ${CLAIM_BATCH}
           FOR UPDATE SKIP LOCKED)
         RETURNING id, "alertId", "userId", "pushTokenId", "escalationLevel", "attemptCount", "createdAt"`,
        [now],
      ),
    ).sort((a, b) => Number(a.id) - Number(b.id));
    if (!claimed.length) return 0;

    const ready: { attempt: Claimed; message: PushMessage }[] = [];
    for (const attempt of claimed) {
      const ctx = await this.context(attempt);
      const reason = ctx
        ? await this.cancelReason(attempt, ctx, now)
        : 'alert_missing';
      if (reason || !ctx) {
        await this.finish(attempt.id, 'cancelled', now, { error: reason });
        continue;
      }
      ready.push({ attempt, message: this.message(attempt, ctx, now) });
    }
    if (!ready.length) return 0;

    let tickets: PushTicket[];
    try {
      tickets = await this.provider.send(ready.map((r) => r.message));
    } catch (error) {
      this.logger.warn(`push provider unavailable: ${String(error)}`);
      for (const { attempt } of ready)
        await this.retryLater(attempt, now, String(error));
      return 0;
    }

    let accepted = 0;
    for (const [i, { attempt }] of ready.entries()) {
      const ticket = tickets[i];
      if (ticket?.status === 'ok') {
        accepted += 1;
        await this.dataSource.query(
          `UPDATE notification_attempts SET state = 'provider_accepted', "expoTicketId" = $2,
             "acceptedAt" = $3, "receiptCheckAfter" = $4, "providerError" = NULL, "updatedAt" = $3
           WHERE id = $1`,
          [
            attempt.id,
            ticket.id,
            now,
            new Date(now.getTime() + RECEIPT_DELAY_MS),
          ],
        );
        continue;
      }
      const code = ticket?.details?.error ?? 'unknown';
      if (!ticket || code === 'MessageRateExceeded') {
        await this.retryLater(attempt, now, ticket ? code : 'missing_ticket');
        continue;
      }
      if (code === 'DeviceNotRegistered')
        await this.revokeToken(attempt.pushTokenId);
      else
        this.logger.error(`push rejected for attempt ${attempt.id}: ${code}`);
      await this.finish(attempt.id, 'provider_rejected', now, {
        error: code,
        message: ticket.message,
      });
    }
    return accepted;
  }

  async pollReceipts(now = new Date()): Promise<number> {
    const rows = rowsOf<{
      id: string;
      expoTicketId: string;
      pushTokenId: string | null;
      acceptedAt: Date;
    }>(
      await this.dataSource.query(
        `SELECT id, "expoTicketId", "pushTokenId", "acceptedAt" FROM notification_attempts
         WHERE state = 'provider_accepted' AND "receiptCheckAfter" <= $1
         ORDER BY "receiptCheckAfter" LIMIT ${RECEIPT_BATCH}`,
        [now],
      ),
    );
    if (!rows.length) return 0;
    const receipts = await this.provider.getReceipts(
      rows.map((r) => r.expoTicketId),
    );
    for (const row of rows) {
      const receipt = receipts[row.expoTicketId];
      if (receipt?.status === 'ok') {
        await this.finish(row.id, 'receipt_ok', now, { receiptAt: now });
      } else if (receipt) {
        const code = receipt.details?.error ?? 'unknown';
        if (code === 'DeviceNotRegistered')
          await this.revokeToken(row.pushTokenId);
        await this.finish(row.id, 'receipt_error', now, {
          error: code,
          message: receipt.message,
          receiptAt: now,
        });
      } else if (
        now.getTime() - new Date(row.acceptedAt).getTime() >
        RECEIPT_GIVE_UP_MS
      ) {
        await this.finish(row.id, 'receipt_unknown', now, {});
      } else {
        await this.dataSource.query(
          `UPDATE notification_attempts SET "receiptCheckAfter" = $2 WHERE id = $1`,
          [row.id, new Date(now.getTime() + RECEIPT_DELAY_MS)],
        );
      }
    }
    return rows.length;
  }

  private async context(attempt: Claimed): Promise<Context | null> {
    const [row] = rowsOf<Context>(
      await this.dataSource.query(
        `SELECT a.type, a."deviceId", a."createdAt", a.timestamp, a."acknowledgedAt", a."isDismissed",
                t.token, t."userId" AS "tokenUserId", t."revokedAt"
         FROM alerts a LEFT JOIN push_tokens t ON t.id = $2
         WHERE a.id = $1`,
        [attempt.alertId, attempt.pushTokenId],
      ),
    );
    return row ?? null;
  }

  private async cancelReason(attempt: Claimed, ctx: Context, now: Date) {
    if (ctx.acknowledgedAt) return 'acknowledged';
    if (ctx.isDismissed) return 'dismissed';
    if (now.getTime() - new Date(ctx.timestamp).getTime() > STALE_ALERT_MS)
      return 'stale';
    if (
      now.getTime() - new Date(attempt.createdAt).getTime() >
      PUSH_LIFETIME_MS
    )
      return 'expired';
    if (!ctx.token || ctx.revokedAt || ctx.tokenUserId !== attempt.userId) {
      return 'token_revoked';
    }
    const owner = await this.recipients.recipientFor({
      deviceId: ctx.deviceId,
      createdAt: new Date(ctx.createdAt),
    });
    if (owner !== attempt.userId) return 'owner_changed';
    return null;
  }

  private message(attempt: Claimed, ctx: Context, now: Date): PushMessage {
    const lateMin = Math.floor(
      (now.getTime() - new Date(ctx.timestamp).getTime()) / 60_000,
    );
    const title = TITLES[ctx.type] ?? 'Alert';
    return {
      to: ctx.token as string,
      title: attempt.escalationLevel > 0 ? `Reminder: ${title}` : title,
      body:
        lateMin * 60_000 > LATE_MS
          ? `Detected ${lateMin} min ago (delayed). Tap to respond.`
          : 'Tap to view and respond.',
      data: { alertId: attempt.alertId, attemptId: Number(attempt.id) },
      priority: 'high',
      channelId:
        severityOf(ctx.type) === 'critical' ? 'critical-alerts' : 'alerts',
      sound: 'default',
      ttl: 3600,
    };
  }

  private async retryLater(attempt: Claimed, now: Date, error: string) {
    const step = Math.min(attempt.attemptCount, BACKOFF_S.length) - 1;
    const next = new Date(now.getTime() + BACKOFF_S[step] * 1000);
    const expiresAt = new Date(attempt.createdAt).getTime() + PUSH_LIFETIME_MS;
    if (next.getTime() > expiresAt) {
      this.logger.error(
        `push attempt ${attempt.id} failed after ${attempt.attemptCount} tries (push lifetime over)`,
      );
      await this.finish(attempt.id, 'failed', now, {
        error: error.slice(0, 64),
      });
      return;
    }
    await this.dataSource.query(
      `UPDATE notification_attempts SET state = 'queued', "nextAttemptAt" = $2,
         "providerError" = $3, "updatedAt" = $4 WHERE id = $1`,
      [attempt.id, next, error.slice(0, 64), now],
    );
  }

  private async finish(
    id: string,
    state:
      | 'cancelled'
      | 'provider_rejected'
      | 'failed'
      | 'receipt_ok'
      | 'receipt_error'
      | 'receipt_unknown',
    now: Date,
    extra: { error?: string | null; message?: string; receiptAt?: Date },
  ) {
    await this.dataSource.query(
      `UPDATE notification_attempts SET state = $2, "providerError" = COALESCE($3, "providerError"),
         "providerMessage" = COALESCE($4, "providerMessage"), "receiptAt" = COALESCE($5, "receiptAt"),
         "updatedAt" = $6
       WHERE id = $1`,
      [
        id,
        state,
        extra.error ?? null,
        extra.message?.slice(0, 500) ?? null,
        extra.receiptAt ?? null,
        now,
      ],
    );
  }

  private async revokeToken(pushTokenId: string | null) {
    if (!pushTokenId) return;
    await this.dataSource.query(
      `UPDATE push_tokens SET "revokedAt" = now(), "revokedReason" = 'DeviceNotRegistered'
       WHERE id = $1 AND "revokedAt" IS NULL`,
      [pushTokenId],
    );
  }
}
