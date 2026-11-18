import { Injectable, NotFoundException, Optional } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { rowsOf } from '../notifications/db-rows';
import { DeviceEventService } from '../realtime/device-event.service';

const DAY_SQL = `now() - interval '24 hours'`;

type Percentiles = { n: number; p50: number | null; p95: number | null };

/**
 * Workstream I: an operator's view of the alert pipeline, derived from the
 * durable tables (plus process-local intake counters). Counts and ages only:
 * no tokens, payloads, measurements or names. Internal endpoints only.
 *
 * Telling failures apart:
 *  - producer/transport (gateway): gateway outbox backlog (outbox_cli status),
 *    and device events missing here;
 *  - backend persistence: deviceEvents.sinceProcessStart.rejected.internal_error;
 *  - dispatch: alerts.pendingDispatch / oldestPendingAgeMs;
 *  - push submission: notifications.queued / providerErrors / failed;
 *  - caregiver: alerts.unacknowledgedCritical and ackLatencyMs.
 */
@Injectable()
export class PipelineStatusService {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    @Optional() private readonly deviceEvents?: DeviceEventService,
  ) {}

  async snapshot() {
    const q = async <T>(sql: string, params: unknown[] = []) =>
      rowsOf<T>(await this.dataSource.query(sql, params));
    const ms = (v: unknown) =>
      v === null || v === undefined ? null : Math.round(Number(v));
    const pct = (row: {
      n: number;
      p50: unknown;
      p95: unknown;
    }): Percentiles => ({
      n: Number(row.n),
      p50: ms(row.p50),
      p95: ms(row.p95),
    });

    const [pending] = await q<{ n: number; oldest: unknown }>(
      `SELECT count(*)::int n, extract(epoch FROM now() - min("createdAt")) * 1000 oldest
       FROM alerts WHERE "dispatchState" = 'pending'`,
    );
    const [unacked] = await q<{ n: number }>(
      `SELECT count(*)::int n FROM alerts
       WHERE type IN ('fall','help_call') AND "dispatchState" = 'dispatched'
         AND "acknowledgedAt" IS NULL AND "isDismissed" = false AND "createdAt" > ${DAY_SQL}`,
    );
    const [ack] = await q<{ n: number; p50: unknown; p95: unknown }>(
      `SELECT count(*)::int n,
         percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM "acknowledgedAt" - "createdAt") * 1000) p50,
         percentile_cont(0.95) WITHIN GROUP (ORDER BY extract(epoch FROM "acknowledgedAt" - "createdAt") * 1000) p95
       FROM alerts WHERE "acknowledgedAt" IS NOT NULL AND "acknowledgedAt" > ${DAY_SQL}`,
    );
    const [events] = await q<{
      accepted: number;
      quarantined: number;
      clock: number;
    }>(
      `SELECT count(*)::int accepted,
              count(*) FILTER (WHERE quarantined)::int quarantined,
              count(*) FILTER (WHERE "clockSuspect")::int clock
       FROM device_events WHERE "receivedAt" > ${DAY_SQL}`,
    );
    const [lag] = await q<{ n: number; p50: unknown; p95: unknown }>(
      `SELECT count(*)::int n,
         percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM "receivedAt" - "detectedAt") * 1000) p50,
         percentile_cont(0.95) WITHIN GROUP (ORDER BY extract(epoch FROM "receivedAt" - "detectedAt") * 1000) p95
       FROM device_events WHERE "receivedAt" > ${DAY_SQL} AND NOT "clockSuspect"`,
    );
    const [queued] = await q<{ n: number; oldest: unknown }>(
      `SELECT count(*)::int n, extract(epoch FROM now() - min("createdAt")) * 1000 oldest
       FROM notification_attempts WHERE state IN ('queued','sending')`,
    );
    const byState = await q<{ state: string; n: number }>(
      `SELECT state, count(*)::int n FROM notification_attempts
       WHERE "createdAt" > ${DAY_SQL} GROUP BY state`,
    );
    const errors = await q<{ code: string; n: number }>(
      `SELECT "providerError" code, count(*)::int n FROM notification_attempts
       WHERE "createdAt" > ${DAY_SQL} AND "providerError" IS NOT NULL GROUP BY "providerError"`,
    );
    const [noPhone] = await q<{ n: number }>(
      `SELECT count(*)::int n FROM alerts WHERE "dispatchNote" = 'no_active_tokens' AND "createdAt" > ${DAY_SQL}`,
    );

    return {
      generatedAt: new Date().toISOString(),
      alerts: {
        pendingDispatch: pending.n,
        oldestPendingAgeMs: ms(pending.oldest),
        unacknowledgedCritical: unacked.n,
        ackLatencyMs: pct(ack),
        ownerWithoutPhone24h: noPhone.n,
      },
      deviceEvents: {
        last24h: {
          accepted: events.accepted,
          quarantined: events.quarantined,
          clockSuspect: events.clock,
        },
        /** detectedAt (gateway clock) -> receivedAt (server clock); excludes suspect clocks. */
        ingestLagMs: pct(lag),
        sinceProcessStart: this.deviceEvents?.counters ?? null,
      },
      notifications: {
        queued: queued.n,
        oldestQueuedAgeMs: ms(queued.oldest),
        last24hByState: Object.fromEntries(byState.map((r) => [r.state, r.n])),
        providerErrors24h: Object.fromEntries(errors.map((r) => [r.code, r.n])),
      },
    };
  }

  /** Follow one gateway event through the pipeline by its stable event id. */
  async trace(eventId: string) {
    if (!/^[0-9a-f-]{36}$/.test(eventId)) throw new NotFoundException();
    const q = async <T>(sql: string, params: unknown[]) =>
      rowsOf<T>(await this.dataSource.query(sql, params));
    const [event] = await q<{ alertId: string | null }>(
      `SELECT "eventId", "deviceId", type, "detectedAt", "receivedAt", "gatewaySeq", "bootId",
              "clockSynced", "clockSuspect", attempt, quarantined, "alertId"
       FROM device_events WHERE "eventId" = $1 ORDER BY id LIMIT 1`,
      [eventId],
    );
    if (!event) throw new NotFoundException('Unknown event id');
    const alertId = event.alertId;
    const [alert] = alertId
      ? await q(
          `SELECT id, type, "createdAt", "dispatchState", "dispatchedAt", "dispatchNote",
                  "acknowledgedAt", "acknowledgedByUserId", "ackAction", "isDismissed"
           FROM alerts WHERE id = $1`,
          [alertId],
        )
      : [null];
    const attempts = alertId
      ? await q(
          `SELECT id, "userId", "escalationLevel", state, "attemptCount", "providerError",
                  "createdAt", "acceptedAt", "receiptAt", "receivedOnDeviceAt", "openedAt"
           FROM notification_attempts WHERE "alertId" = $1 ORDER BY id`,
          [alertId],
        )
      : [];
    const actions = alertId
      ? await q(
          `SELECT action, source, "userId", reason, "notificationAttemptId", "createdAt"
           FROM alert_actions WHERE "alertId" = $1 ORDER BY id`,
          [alertId],
        )
      : [];
    return { event, alert: alert ?? null, attempts, actions };
  }
}
