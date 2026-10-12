import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
  Optional,
} from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { rowsOf } from '../notifications/db-rows';
import { NotificationAttemptsService } from '../notifications/notification-attempts.service';
import { AlertEventsPublisher } from '../realtime/alert-events.publisher';

const LIVE_SLOTS = new Set(['iot_live', 'realtime', 'iot_event']);
const STALE_AFTER_MS = 24 * 3_600_000;
const CLAIM_BATCH = 50;

type ClaimedRow = {
  id: string;
  deviceId: string;
  type: string;
  title: string;
  timestamp: Date;
  syncSlot: string;
  createdAt: Date;
  eventId: string | null;
};

/**
 * AR-5: single post-commit emission path for every alert producer. Producers
 * only insert rows ('pending') and optionally kick; the dispatcher claims each
 * row exactly once (FOR UPDATE SKIP LOCKED) and hands it to the publisher. A
 * periodic sweep recovers rows whose producer crashed or whose webhook failed.
 * Claiming is the durable record; emission stays best-effort.
 */
@Injectable()
export class AlertDispatchService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(AlertDispatchService.name);
  private timer: NodeJS.Timeout | null = null;
  private sweeping = false;

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly publisher: AlertEventsPublisher,
    @Optional() private readonly attempts?: NotificationAttemptsService,
  ) {}

  onModuleInit() {
    if (process.env.ALERT_DISPATCHER_ENABLED === 'false') return;
    const everyMs = Number(process.env.ALERT_DISPATCH_SWEEP_MS ?? 2000);
    this.timer = setInterval(() => void this.sweep(), everyMs);
    this.timer.unref?.();
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Fast path after a producer committed; safe to call repeatedly. */
  async kick(ids?: string[], deviceId?: string): Promise<number> {
    if (ids && ids.length === 0) return 0;
    try {
      return await this.dispatch(ids ?? null, deviceId ?? null);
    } catch (error) {
      this.logger.warn(`alert dispatch kick failed: ${String(error)}`);
      return 0;
    }
  }

  async sweep(): Promise<void> {
    if (this.sweeping) return;
    this.sweeping = true;
    try {
      while ((await this.dispatch(null, null)) === CLAIM_BATCH) {
        // keep draining a backlog
      }
    } catch (error) {
      this.logger.warn(`alert dispatch sweep failed: ${String(error)}`);
    } finally {
      this.sweeping = false;
    }
  }

  private async dispatch(
    ids: string[] | null,
    deviceId: string | null,
  ): Promise<number> {
    // Claim, policy skips and push-attempt creation commit together: a
    // claimed alert always has its durable push attempts (AR-6).
    const claim = await this.dataSource.transaction(async (manager) => {
      const rows = rowsOf<ClaimedRow>(
        await manager.query(
          `UPDATE alerts SET "dispatchState" = 'dispatched', "dispatchedAt" = now()
           WHERE id IN (
             SELECT id FROM alerts
             WHERE "dispatchState" = 'pending'
               AND ($1::varchar[] IS NULL OR id = ANY($1))
               AND ($2::varchar IS NULL OR "deviceId" = $2)
             ORDER BY "createdAt"
             LIMIT ${CLAIM_BATCH}
             FOR UPDATE SKIP LOCKED)
           RETURNING id, "deviceId", type, title, timestamp, "syncSlot", "createdAt", "eventId"`,
          [ids, deviceId],
        ),
      );
      const now = Date.now();
      const skipped: { id: string; note: string }[] = [];
      const publishable = rows
        .filter((row) => {
          if (!LIVE_SLOTS.has(row.syncSlot)) {
            skipped.push({ id: row.id, note: 'historical_sync' });
            return false;
          }
          if (now - new Date(row.timestamp).getTime() > STALE_AFTER_MS) {
            skipped.push({ id: row.id, note: 'stale' });
            return false;
          }
          return true;
        })
        .map((row) => ({
          ...row,
          timestamp: new Date(row.timestamp),
          createdAt: new Date(row.createdAt),
        }));
      for (const { id, note } of skipped) {
        await manager.query(
          `UPDATE alerts SET "dispatchState" = 'skipped', "dispatchNote" = $2 WHERE id = $1`,
          [id, note],
        );
      }
      await this.attempts?.enqueue(publishable, 0, manager);
      return { claimed: rows.length, publishable };
    });
    if (!claim.claimed) return 0;
    await this.publisher.publishNew(claim.publishable);
    return claim.claimed;
  }
}
