import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Vital } from '../database/entities';

export interface RawLog {
  temperature?: number;
  temp?: number;
  ambient_temp?: number;
  ambientTemp?: number;
  moisture?: number;
  gaitLabel?: string;
  gait_label?: string;
  sos?: boolean;
  sos_trigger?: boolean;
  fallAlert?: boolean;
  fall_alert?: boolean;
  thighnodeStatus?: string;
  thighnode_status?: string;
  timestamp?: number | string;
  ts?: number | string;
  unix_timestamp?: number | string;
  unix_times?: number | string;
}

@Injectable()
export class VitalSyncService {
  private readonly logger = new Logger(VitalSyncService.name);

  constructor(
    @InjectRepository(Vital)
    private readonly vitalRepository: Repository<Vital>,
  ) {}

  /**
   * Upserts the latest vital snapshot for a device based on the most recent
   * log entry in a batch. Silently skips if no usable data is present.
   */
  async upsertLatestVital(deviceId: string, logs: RawLog[]): Promise<void> {
    if (!logs || logs.length === 0) return;

    // Pick the newest log by timestamp
    const latest = logs.reduce<RawLog>((newest, log) => {
      const tsA = this.toMs(
        log.timestamp ?? log.ts ?? log.unix_timestamp ?? log.unix_times,
      );
      const tsB = this.toMs(
        newest.timestamp ??
          newest.ts ??
          newest.unix_timestamp ??
          newest.unix_times,
      );
      return tsA >= tsB ? log : newest;
    }, logs[0]);

    const timestamp = new Date(
      this.toMs(
        latest.timestamp ??
          latest.ts ??
          latest.unix_timestamp ??
          latest.unix_times,
      ),
    );
    const temperature = latest.temperature ?? latest.temp ?? null;
    const roomTemperature = latest.ambient_temp ?? latest.ambientTemp ?? null;
    const moisture = latest.moisture ?? null;
    const gaitAnalysis = latest.gaitLabel ?? latest.gait_label ?? null;

    // Skip if all vital fields are empty
    if (
      temperature === null &&
      roomTemperature === null &&
      moisture === null &&
      gaitAnalysis === null
    ) {
      return;
    }

    try {
      // Single round-trip, race-free: ON CONFLICT DO NOTHING against the
      // unique (deviceId, timestamp) index replaces the old findOne-then-save.
      const result = await this.vitalRepository
        .createQueryBuilder()
        .insert()
        .values(
          this.vitalRepository.create({
            deviceId,
            timestamp,
            temperature,
            roomTemperature,
            moisture,
            gaitAnalysis,
            thighnodeStatus: latest.thighnodeStatus ?? latest.thighnode_status ?? null,
            syncSlot: 'iot_live',
          }),
        )
        .orIgnore()
        .execute();

      // RETURNING yields rows only for actual inserts; conflicts come back empty.
      if (Array.isArray(result.raw) && result.raw.length > 0) {
        this.logger.log(
          `Vital upserted for device ${deviceId} at ${timestamp.toISOString()}`,
        );
      }
    } catch (err) {
      // Non-fatal — health data still saved via gRPC
      this.logger.warn(`Failed to upsert vital for device ${deviceId}: ${err}`);
    }
  }

  private toMs(value: number | string | undefined): number {
    if (value === undefined || value === null) return Date.now();
    if (typeof value === 'number' && Number.isFinite(value)) {
      return value < 1_000_000_000_000 ? value * 1000 : value;
    }
    const n = Number(value);
    if (!Number.isNaN(n) && Number.isFinite(n)) {
      return n < 1_000_000_000_000 ? n * 1000 : n;
    }
    const p = Date.parse(String(value));
    return Number.isNaN(p) ? Date.now() : p;
  }
}
