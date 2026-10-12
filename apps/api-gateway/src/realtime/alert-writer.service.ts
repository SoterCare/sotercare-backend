import { Injectable } from '@nestjs/common';
import { Repository } from 'typeorm';
import { Alert, AlertType } from '../database/entities';
import { loadAlertPolicy } from '../alert-policy/alert-policy';

function helpCallMergeWindowMs(): number {
  try {
    return loadAlertPolicy().helpCall.mergeWindowMs;
  } catch {
    return 3000; // firmware SOS cooldown; used only if the policy file is unreadable
  }
}

export interface NormalizedLog {
  sos?: boolean;
  fall_alert?: boolean;
  moisture?: number;
  temperature?: number;
  gait_label?: string;
  timestamp: number; // unix ms
}

interface AlertCandidate {
  idPrefix: string;
  type: AlertType;
  title: string;
}


@Injectable()
export class AlertWriterService {
  // AR-3: last SOS frame time per device, to merge the firmware's 3-frame
  // latch when it straddles a whole-second boundary (S13).
  private readonly lastSosAt = new Map<string, number>();
  private readonly sosMergeWindowMs = helpCallMergeWindowMs();

  /**
   * Derives all alert candidates for a batch of log entries and persists them
   * in a single batched insert. The deterministic alert ids plus
   * ON CONFLICT DO NOTHING make this idempotent without any pre-SELECT.
   * Returns the candidate alerts (some may have already existed in the
   * database — callers tolerate re-emitting those).
   */
  async writeAlertsForLogs(
    deviceId: string,
    logs: NormalizedLog[],
    syncSlot: string,
    alertRepo: Repository<Alert>,
  ): Promise<Alert[]> {
    // Keyed by id so repeated readings within one batch collapse to one row.
    const rowsById = new Map<string, Alert>();

    for (const log of logs) {
      const ts = new Date(log.timestamp);
      for (const { idPrefix, type, title } of this.deriveCandidates(
        deviceId,
        log,
      )) {
        const alertId = `${idPrefix}_${deviceId}_${log.timestamp}`;
        rowsById.set(
          alertId,
          alertRepo.create({
            id: alertId,
            deviceId,
            type,
            title,
            timestamp: ts,
            isDismissed: false,
            dismissedAt: null,
            syncSlot,
          }),
        );
      }
    }

    const rows = [...rowsById.values()];
    if (rows.length === 0) return rows;

    // RETURNING with ON CONFLICT DO NOTHING yields only newly inserted rows, so
    // the caller dispatches exactly the alerts this call created (AR-2/AR-5).
    const result = await alertRepo
      .createQueryBuilder()
      .insert()
      .values(rows)
      .orIgnore()
      .returning(['id'])
      .execute();
    const insertedIds = new Set(
      ((result.raw ?? []) as { id: string }[]).map((row) => row.id),
    );
    return rows.filter((row) => insertedIds.has(row.id));
  }

  /**
   * Backward-compatible single-log entry point, implemented via the batched
   * path. Returns the count of candidate alerts written (may include alerts
   * that already existed, since the dedupe now happens in the database).
   */
  async writeAlertsForLog(
    deviceId: string,
    log: NormalizedLog,
    syncSlot: string,
    alertRepo: Repository<Alert>,
  ): Promise<number> {
    const written = await this.writeAlertsForLogs(
      deviceId,
      [log],
      syncSlot,
      alertRepo,
    );
    return written.length;
  }

  // ─── Rule Engine ─────────────────────────────────────────────────────────────

  private deriveCandidates(
    deviceId: string,
    log: NormalizedLog,
  ): AlertCandidate[] {
    const candidates: AlertCandidate[] = [];

    // 1. Help Call (SOS button) — one alert per press: frames within the merge
    // window of the previous SOS frame belong to the same press.
    if (log.sos && this.isNewSosPress(deviceId, log.timestamp)) {
      candidates.push({
        idPrefix: 'sos',
        type: AlertType.HELP_CALL,
        title: 'Help Call',
      });
    }

    // 2. Fall Detection
    if (log.fall_alert) {
      candidates.push({
        idPrefix: 'fall',
        type: AlertType.FALL,
        title: 'Fall Detected',
      });
    }

    // 3. Moisture thresholds — owned by the MoistureEpisodeService (AR-3)
    // unless episodes are explicitly disabled.
    if (
      log.moisture != null &&
      process.env.MOISTURE_EPISODES_ENABLED === 'false'
    ) {
      const candidate = this.getMoistureCandidate(log.moisture);
      if (candidate) candidates.push(candidate);
    }

    return candidates;
  }

  private isNewSosPress(deviceId: string, timestamp: number): boolean {
    const last = this.lastSosAt.get(deviceId);
    this.lastSosAt.set(deviceId, Math.max(last ?? timestamp, timestamp));
    return last === undefined || Math.abs(timestamp - last) >= this.sosMergeWindowMs;
  }

  private getMoistureCandidate(moisture: number): AlertCandidate | null {
    if (moisture >= 25) {
      return {
        idPrefix: 'moisture',
        type: AlertType.MOISTURE,
        title: 'Moisture Detected',
      };
    }
    return null;
  }
}
