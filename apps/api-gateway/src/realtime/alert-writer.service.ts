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
   * Last known gait label per device, used for transition detection.
   * Keyed by deviceId. In-memory is fine — we only alert on transitions
   * and a server restart merely means the next label is treated as a transition.
   */
  private readonly lastGaitLabel = new Map<string, string>();

  /**
   * Derives all alert candidates for a single log entry and persists any
   * that are not yet in the database.  Returns the count of new alerts saved.
   */
  async writeAlertsForLog(
    deviceId: string,
    log: NormalizedLog,
    syncSlot: string,
    alertRepo: Repository<Alert>,
  ): Promise<number> {
    const candidates = this.deriveCandidates(deviceId, log);
    const ts = new Date(log.timestamp);
    let saved = 0;

    for (const { idPrefix, type, title } of candidates) {
      const alertId = `${idPrefix}_${deviceId}_${log.timestamp}`;
      const existing = await alertRepo.findOne({ where: { id: alertId } });
      if (existing) continue;

      await alertRepo.save(
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
      saved += 1;
    }

    return saved;
  }

  // ─── Rule Engine ─────────────────────────────────────────────────────────────

  private deriveCandidates(deviceId: string, log: NormalizedLog): AlertCandidate[] {
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

    // 4. Temperature thresholds (skin temp)
    if (log.temperature != null) {
      const candidate = this.getTemperatureCandidate(log.temperature);
      if (candidate) candidates.push(candidate);
    }

    // 5. Gait movement — only alert when the label *transitions* to a target.
    //    Repeated consecutive readings of the same label are silently skipped.
    const currentGait = log.gait_label ?? '';
    const previousGait = this.lastGaitLabel.get(deviceId) ?? '';

    if (currentGait !== previousGait) {
      this.lastGaitLabel.set(deviceId, currentGait);

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

  private getTemperatureCandidate(temp: number): AlertCandidate | null {
    if (temp > 39.5) {
      return {
        idPrefix: 'temp_urgent',
        type: AlertType.TEMPERATURE,
        title: 'Urgent High Temperature',
      };
    }
    if (temp >= 38.5) {
      return {
        idPrefix: 'temp_monitor',
        type: AlertType.TEMPERATURE,
        title: 'Monitor Temperature',
      };
    }
    return null;
  }
}
