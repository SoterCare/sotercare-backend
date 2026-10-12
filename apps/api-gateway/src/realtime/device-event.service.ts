import { Injectable, Logger, Optional } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, EntityManager } from 'typeorm';
import { AlertDispatchService } from '../alerts/alert-dispatch.service';
import { AlertType } from '../database/entities';
import { OwnershipService } from '../ownership/ownership.service';
import {
  DeviceEventAck,
  DeviceEventV1,
  parseDeviceEvent,
} from './device-event.contract';

// Same ids, types and titles as the legacy boolean path (AlertWriterService),
// so both paths converge on one alert row for the same frame.
const KINDS = {
  fall: { prefix: 'fall', type: AlertType.FALL, title: 'Fall Detected' },
  sos: { prefix: 'sos', type: AlertType.HELP_CALL, title: 'Help Call' },
} as const;
const MIN_PLAUSIBLE_MS = Date.UTC(2020, 0, 1);
const FUTURE_TOLERANCE_MS = 120_000;

type Outcome =
  | { kind: 'conflict' }
  | { kind: 'duplicate'; alertId: string | null; quarantined: boolean }
  | {
      kind: 'recorded';
      alertId: string | null;
      quarantined: boolean;
      created: boolean;
    };

type Rejection = Extract<DeviceEventAck, { accepted: false }>;

const rowsOf = <T>(result: unknown): T[] =>
  (Array.isArray(result) && Array.isArray(result[0])
    ? result[0]
    : result) as T[];

/**
 * AR-9: durable fall/SOS events from the gateway outbox. The ack is the
 * gateway's only signal to delete its local copy, so `accepted:true` is sent
 * only after the transaction committed, and every failure is a retryable ack.
 * Never throws (a WsException would look like auth loss to the gateway).
 */
@Injectable()
export class DeviceEventService {
  private readonly logger = new Logger(DeviceEventService.name);

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly ownershipService: OwnershipService,
    @Optional() private readonly alertDispatch?: AlertDispatchService,
  ) {}

  /** Workstream I: outcomes since this process started (not persisted). */
  readonly counters = {
    accepted: 0,
    duplicate: 0,
    quarantined: 0,
    rejected: {} as Record<string, number>,
  };

  async ingest(
    socketDeviceId: string | undefined,
    body: unknown,
    now = Date.now(),
  ): Promise<DeviceEventAck> {
    const ack = await this.decide(socketDeviceId, body, now);
    if (ack.accepted) {
      if (ack.duplicate) this.counters.duplicate += 1;
      else this.counters.accepted += 1;
      if (ack.quarantined && !ack.duplicate) this.counters.quarantined += 1;
    } else {
      this.counters.rejected[ack.reason] =
        (this.counters.rejected[ack.reason] ?? 0) + 1;
    }
    return ack;
  }

  private async decide(
    socketDeviceId: string | undefined,
    body: unknown,
    now: number,
  ): Promise<DeviceEventAck> {
    const rawId = rawEventId(body);
    const reject = (
      reason: Rejection['reason'],
      retryable: boolean,
    ): Rejection => ({
      accepted: false,
      success: false,
      event_id: rawId,
      retryable,
      reason,
    });
    try {
      if (process.env.DEVICE_EVENTS_ENABLED === 'false') {
        return reject('disabled', true);
      }
      if (!socketDeviceId) return reject('not_authenticated', true);
      const event = parseDeviceEvent(body);
      if (!event) return reject('invalid_payload', false);
      if (event.device_id !== socketDeviceId) {
        this.logger.warn(
          `device_event ${event.event_id} device_mismatch socket=${socketDeviceId}`,
        );
        return reject('device_mismatch', false);
      }
      return await this.record(event, now);
    } catch (error) {
      this.logger.error(
        `device_event ${rawId ?? '?'} not accepted (retryable): ${String(error)}`,
      );
      return reject('internal_error', true);
    }
  }

  private async record(
    event: DeviceEventV1,
    now: number,
  ): Promise<DeviceEventAck> {
    const deviceId = event.device_id;
    const maxSkewMs = Number(
      process.env.IOT_MAX_CLOCK_SKEW_MS || 15 * 60 * 1000,
    );
    const plausible =
      event.detected_at >= MIN_PLAUSIBLE_MS &&
      event.detected_at <= now + FUTURE_TOLERANCE_MS;
    const clockSuspect =
      !plausible || Math.abs(now - event.detected_at) > maxSkewMs;
    const alertTs = plausible ? event.detected_at : now;

    // Fail closed: with no current owner, or an event observed before the
    // current owner's period, record it but create no alert (quarantine).
    const owner = await this.ownershipService.currentOwnership(deviceId);
    const quarantined = !owner || alertTs < owner.since.getTime();

    const kind = KINDS[event.type];
    const evtId = `${kind.prefix}_${deviceId}_evt_${event.event_id}`;
    const primaryId = plausible
      ? `${kind.prefix}_${deviceId}_${Math.floor(alertTs / 1000) * 1000}`
      : evtId;

    const outcome = await this.dataSource.transaction(
      async (manager): Promise<Outcome> => {
        await manager.query(`SELECT set_config('lock_timeout', $1, true)`, [
          `${Number(process.env.DEVICE_EVENT_LOCK_TIMEOUT_MS || 5000)}ms`,
        ]);
        await manager.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [
          `alert:${deviceId}:${event.type}`,
        ]);
        const inserted = rowsOf<{ id: string }>(
          await manager.query(
            `INSERT INTO device_events ("deviceId", "eventId", type, "nodeMac", "detectedAt", "gatewaySeq",
               "bootId", "clockSynced", "clockSuspect", attempt, quarantined, payload)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
             ON CONFLICT ("deviceId", "eventId") DO NOTHING
             RETURNING id`,
            [
              deviceId,
              event.event_id,
              event.type,
              event.node_mac ?? null,
              new Date(event.detected_at),
              event.seq,
              event.boot_id ?? null,
              event.clock_synced ?? null,
              clockSuspect,
              event.attempt,
              quarantined,
              JSON.stringify(event),
            ],
          ),
        );
        if (!inserted.length) return this.existing(manager, event);
        if (quarantined) {
          return {
            kind: 'recorded',
            alertId: null,
            quarantined,
            created: false,
          };
        }

        let alert = await this.upsertAlert(
          manager,
          primaryId,
          kind,
          alertTs,
          event,
        );
        if (alert.eventId !== event.event_id) {
          // The legacy-compatible id already belongs to another event in the
          // same second: this event gets its own alert.
          alert = await this.upsertAlert(manager, evtId, kind, alertTs, event);
        }
        await manager.query(
          `UPDATE device_events SET "alertId" = $1 WHERE id = $2`,
          [alert.id, inserted[0].id],
        );
        return {
          kind: 'recorded',
          alertId: alert.id,
          quarantined: false,
          created: alert.inserted,
        };
      },
    );

    // Committed. Announce new alerts without delaying the ack; the sweep
    // recovers anything this kick misses.
    if (outcome.kind === 'recorded' && outcome.created && outcome.alertId) {
      void this.alertDispatch?.kick([outcome.alertId]);
    }
    if (outcome.kind === 'conflict') {
      this.logger.warn(
        `device_event ${event.event_id} event_conflict device=${deviceId}`,
      );
      return {
        accepted: false,
        success: false,
        event_id: event.event_id,
        retryable: false,
        reason: 'event_conflict',
      };
    }
    this.logger.log(
      `device_event ${event.event_id} accepted device=${deviceId} type=${event.type} ` +
        `attempt=${event.attempt} duplicate=${outcome.kind === 'duplicate'} ` +
        `quarantined=${outcome.quarantined} clockSuspect=${clockSuspect} alert=${outcome.alertId ?? '-'}`,
    );
    return {
      accepted: true,
      success: true,
      event_id: event.event_id,
      alert_id: outcome.alertId,
      duplicate: outcome.kind === 'duplicate',
      quarantined: outcome.quarantined,
      server_received_at: now,
    };
  }

  /** A retry of an already recorded event: same content is a duplicate. */
  private async existing(
    manager: EntityManager,
    event: DeviceEventV1,
  ): Promise<Outcome> {
    const [row] = rowsOf<{
      type: string;
      detectedAt: Date;
      alertId: string | null;
      quarantined: boolean;
    }>(
      await manager.query(
        `SELECT type, "detectedAt", "alertId", quarantined FROM device_events
         WHERE "deviceId" = $1 AND "eventId" = $2`,
        [event.device_id, event.event_id],
      ),
    );
    if (
      row.type !== event.type ||
      new Date(row.detectedAt).getTime() !== event.detected_at
    ) {
      return { kind: 'conflict' };
    }
    return {
      kind: 'duplicate',
      alertId: row.alertId,
      quarantined: row.quarantined,
    };
  }

  private async upsertAlert(
    manager: EntityManager,
    id: string,
    kind: (typeof KINDS)[keyof typeof KINDS],
    alertTs: number,
    event: DeviceEventV1,
  ) {
    const [row] = rowsOf<{
      id: string;
      eventId: string | null;
      inserted: boolean;
    }>(
      await manager.query(
        `INSERT INTO alerts (id, "deviceId", type, title, timestamp, "syncSlot", "eventId")
         VALUES ($1, $2, $3, $4, $5, 'iot_event', $6)
         ON CONFLICT (id) DO UPDATE SET "eventId" = COALESCE(alerts."eventId", EXCLUDED."eventId")
         RETURNING id, "eventId", (xmax = 0) AS inserted`,
        [
          id,
          event.device_id,
          kind.type,
          kind.title,
          new Date(alertTs),
          event.event_id,
        ],
      ),
    );
    return row;
  }
}

function rawEventId(body: unknown): string | null {
  if (typeof body !== 'object' || body === null) return null;
  const id = (body as { event_id?: unknown }).event_id;
  return typeof id === 'string' && id.length <= 64 ? id : null;
}
