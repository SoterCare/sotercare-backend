import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { VitalSign } from './vital-sign.entity';

// Hard cap on rows returned by a single date-range query so an unbounded
// range (e.g. years of 1Hz readings) cannot load the whole table into memory.
const MAX_RANGE_ROWS = 50000;

/** A raw log from the device; snake_case and camelCase aliases are both accepted. */
export interface VitalLogInput {
  deviceId?: string | null;
  device_id?: string | null;
  temperature?: number;
  temp?: number;
  ambientTemp?: number | null;
  ambient_temp?: number | null;
  moisture?: number | null;
  sos?: boolean | null;
  fallAlert?: boolean | null;
  fall_alert?: boolean | null;
  gaitLabel?: string | null;
  gait_label?: string | null;
  thighnodeStatus?: string | null;
  thighnode_status?: string | null;
  heartRate?: number | string | null;
  heart_rate?: number | string | null;
  spo2?: number | string | null;
  timestamp?: number | string;
  ts?: number | string;
}

@Injectable()
export class HealthServiceService {
  private readonly logger = new Logger(HealthServiceService.name);

  constructor(
    @InjectRepository(VitalSign)
    private vitalSignRepository: Repository<VitalSign>,
  ) {}

  // gRPC SyncLogsResponse uses snake_case (proto keepCase: true), so the response
  // field MUST be `synced_count` — not `syncedCount` — or it serializes as absent.
  async syncLogs(
    userId: number,
    logs: VitalLogInput[],
  ): Promise<{ success: boolean; message: string; synced_count: number }> {
    if (!logs || logs.length === 0) {
      return { success: true, message: 'No logs to sync', synced_count: 0 };
    }

    const toInt = (v: unknown): number | null => {
      if (v === undefined || v === null || v === '') return null;
      const n = Number(v);
      return Number.isFinite(n) ? Math.round(n) : null;
    };

    const entities = logs.map((log) => {
      const entity = new VitalSign();
      entity.userId = userId;
      entity.deviceId = (log.deviceId ?? log.device_id ?? null) || null;
      entity.temperature = log.temperature ?? log.temp ?? 0;
      entity.ambientTemp = log.ambientTemp ?? log.ambient_temp ?? null;
      entity.moisture = log.moisture ?? null;
      entity.sos = log.sos ?? null;
      entity.fallAlert = log.fallAlert ?? log.fall_alert ?? null;
      entity.gaitLabel = log.gaitLabel ?? log.gait_label ?? null;
      entity.thighnodeStatus =
        log.thighnodeStatus ?? log.thighnode_status ?? null;
      // C1 fix: heart_rate / spo2 are now persisted so the Safety Guard's SpO2/HR
      // threshold checks operate on real data instead of always-NULL columns.
      entity.heartRate = toInt(log.heartRate ?? log.heart_rate) || null;
      entity.spo2 = toInt(log.spo2) || null;
      entity.timestamp = (log.timestamp ?? log.ts ?? Date.now()).toString();

      return entity;
    });

    // Insert-or-ignore on the (userId, timestamp) unique index so device/client
    // retries don't create duplicate readings (M2). orIgnore returns only the
    // rows actually inserted, which is the true synced count.
    const result = await this.vitalSignRepository
      .createQueryBuilder()
      .insert()
      .into(VitalSign)
      .values(entities)
      .orIgnore()
      .execute();

    const syncedCount = result.identifiers.filter((id) => id != null).length;

    return {
      success: true,
      message: 'Logs synced successfully',
      synced_count: syncedCount,
    };
  }

  async getLogDates(userId: number): Promise<string[]> {
    // Dedupe to calendar dates in SQL instead of loading every row and
    // deduping in JS. to_timestamp(ms / 1000.0) AT TIME ZONE 'UTC' + to_char
    // reproduces the previous `new Date(ts).toISOString().split('T')[0]`
    // output exactly: UTC 'YYYY-MM-DD' strings, most recent date first.
    const rows = await this.vitalSignRepository
      .createQueryBuilder('vital')
      .select(
        "DISTINCT to_char(to_timestamp(CAST(vital.timestamp AS BIGINT) / 1000.0) AT TIME ZONE 'UTC', 'YYYY-MM-DD')",
        'date',
      )
      .where('vital.userId = :userId', { userId })
      .orderBy('date', 'DESC')
      .getRawMany<{ date: string }>();

    return rows.map((row) => row.date);
  }

  async getLogsByDateRange(
    userId: number,
    startDate: string,
    endDate: string,
  ): Promise<VitalSign[]> {
    const start = new Date(startDate).getTime();
    const end = new Date(endDate).getTime();

    // Guard against invalid dates: getTime() returns NaN for unparseable input,
    // which would otherwise bind NaN into the query and silently return wrong rows.
    if (Number.isNaN(start) || Number.isNaN(end)) {
      throw new Error('Invalid startDate or endDate');
    }

    const logs = await this.vitalSignRepository
      .createQueryBuilder('vital')
      // timestamp is a bigint stored as string — bind epoch-ms as strings so the
      // comparison stays numeric/consistent with the stored representation.
      .where('vital.userId = :userId', { userId })
      .andWhere('vital.timestamp >= :startDate', {
        startDate: start.toString(),
      })
      .andWhere('vital.timestamp <= :endDate', { endDate: end.toString() })
      .orderBy('vital.timestamp', 'ASC')
      .take(MAX_RANGE_ROWS)
      .getMany();

    if (logs.length === MAX_RANGE_ROWS) {
      this.logger.warn(
        `getLogsByDateRange likely truncated at the ${MAX_RANGE_ROWS}-row cap for user ${userId} (${startDate} → ${endDate})`,
      );
    }

    return logs;
  }
}
