import { Injectable } from '@nestjs/common';
import { Repository } from 'typeorm';
import { Alert, AlertType } from '../database/entities';

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

const GAIT_MOVEMENT_LABELS = new Set(['standing up', 'sitting down']);

@Injectable()
export class AlertWriterService {
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
      for (const { idPrefix, type, title } of this.deriveCandidates(log)) {
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

    await alertRepo
      .createQueryBuilder()
      .insert()
      .values(rows)
      .orIgnore()
      .execute();

    return rows;
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

  private deriveCandidates(log: NormalizedLog): AlertCandidate[] {
    const candidates: AlertCandidate[] = [];

    // 1. Help Call (SOS button)
    if (log.sos) {
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

    // 3. Moisture thresholds
    if (log.moisture != null) {
      const candidate = this.getMoistureCandidate(log.moisture);
      if (candidate) candidates.push(candidate);
    }

    // 4. Gait movement — fire on every log with a target label.
    const currentGait = log.gait_label ?? '';
    if (GAIT_MOVEMENT_LABELS.has(currentGait)) {
      // Capitalise each word: "standing up" → "Standing Up"
      const label = currentGait
        .split(' ')
        .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
        .join(' ');
      candidates.push({
        idPrefix: `gait_${currentGait.replace(/\s+/g, '_')}`,
        type: AlertType.MOVEMENT,
        title: label,
      });
    }

    return candidates;
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
