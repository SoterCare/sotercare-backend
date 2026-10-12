import { Injectable, Logger } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { AlertPolicy, loadAlertPolicy } from './alert-policy';
import {
  EpisodeEvent,
  EpisodeState,
  initialEpisodeState,
  stepEpisode,
} from './moisture-episode.machine';

type Entry = { state: EpisodeState; episodeId: string | null };
type Sample = { ts: number; moisture?: number | null };
const UNIQUE_VIOLATION = '23505';

/**
 * AR-3: applies the moisture episode machine per device and persists only
 * transitions. Calls for one device are serialised in-process; across
 * processes the partial unique index uq_alert_episodes_active guarantees a
 * single active episode (a losing process reloads the winner's state). The
 * alert id is deterministic (moisture_<device>_<openedAtMs>), so two
 * processes opening the same episode converge on one alert row.
 */
@Injectable()
export class MoistureEpisodeService {
  private readonly logger = new Logger(MoistureEpisodeService.name);
  private readonly policy: AlertPolicy;
  private readonly entries = new Map<string, Entry>();
  private readonly queues = new Map<string, Promise<unknown>>();

  constructor(@InjectDataSource() private readonly dataSource: DataSource) {
    this.policy = loadAlertPolicy();
  }

  get enabled() {
    return process.env.MOISTURE_EPISODES_ENABLED !== 'false';
  }

  /** Returns the alerts created (0 or more) for the caller to dispatch. */
  process(deviceId: string, samples: Sample[]): Promise<{ id: string }[]> {
    const previous = this.queues.get(deviceId) ?? Promise.resolve();
    const next = previous
      .catch(() => undefined)
      .then(() => this.run(deviceId, samples));
    this.queues.set(deviceId, next);
    return next;
  }

  private async run(deviceId: string, samples: Sample[]) {
    const entry = this.entries.get(deviceId) ?? (await this.load(deviceId));
    this.entries.set(deviceId, entry);
    const created: { id: string }[] = [];
    const ordered = samples
      .filter((s) => typeof s.moisture === 'number')
      .sort((a, b) => a.ts - b.ts);
    try {
      for (const sample of ordered) {
        const result = stepEpisode(
          entry.state,
          { ts: sample.ts, value: sample.moisture as number },
          this.policy.moisture,
        );
        entry.state = result.state;
        if (!result.event) continue;
        const alert = await this.persist(deviceId, entry, result.event);
        if (alert) created.push(alert);
      }
    } catch (error) {
      // The in-memory state ran ahead of the database: forget it so the next
      // batch (the gateway resends on a non-success ack) reloads what was
      // actually committed instead of believing an unpersisted episode is open.
      this.entries.delete(deviceId);
      throw error;
    }
    return created;
  }

  private async load(deviceId: string): Promise<Entry> {
    const rows: any[] = await this.dataSource.query(
      `SELECT id, state, "candidateSince", "openedAt", "belowSince", "closedAt", "lastSampleAt", "peakValue"
       FROM alert_episodes WHERE "deviceId" = $1 AND type = 'moisture'
       ORDER BY id DESC LIMIT 1`,
      [deviceId],
    );
    const row = rows[0];
    if (!row) return { state: initialEpisodeState(), episodeId: null };
    const ms = (v: unknown) => (v ? new Date(v as string).getTime() : null);
    return {
      episodeId: String(row.id),
      state: {
        phase: row.state,
        candidateSince: ms(row.candidateSince),
        openedAt: ms(row.openedAt),
        belowSince: ms(row.belowSince),
        closedAt: ms(row.closedAt),
        lastSampleAt: ms(row.lastSampleAt),
        peak: row.peakValue ?? null,
      },
    };
  }

  private async persist(
    deviceId: string,
    entry: Entry,
    event: EpisodeEvent,
  ): Promise<{ id: string } | null> {
    const at = new Date(event.at);
    if (event.kind !== 'opened') {
      if (!entry.episodeId) return null;
      const state =
        event.kind === 'closed' ? 'closed' : event.kind === 'clearing' ? 'clearing' : 'open';
      await this.dataSource.query(
        `UPDATE alert_episodes SET state = $2, "lastSampleAt" = $3,
           "belowSince" = $4, "closedAt" = $5, "peakValue" = $6, "updatedAt" = now()
         WHERE id = $1`,
        [
          entry.episodeId,
          state,
          at,
          entry.state.belowSince ? new Date(entry.state.belowSince) : null,
          entry.state.closedAt ? new Date(entry.state.closedAt) : null,
          entry.state.peak,
        ],
      );
      return null;
    }

    const alertId = `moisture_${deviceId}_${event.at}`;
    try {
      return await this.dataSource.transaction(async (manager) => {
        const [episode] = await manager.query(
          `INSERT INTO alert_episodes ("deviceId", type, state, "candidateSince", "openedAt",
             "lastSampleAt", "peakValue", "alertId", "ruleVersion")
           VALUES ($1, 'moisture', 'open', $2, $3, $3, $4, NULL, $5) RETURNING id`,
          [deviceId, new Date(event.candidateSince), at, event.peak, this.policy.version],
        );
        const inserted = await manager.query(
          `INSERT INTO alerts (id, "deviceId", type, title, timestamp, "isDismissed", "isAttended",
             "isFalseAlarm", "syncSlot", "episodeId")
           VALUES ($1, $2, 'moisture', 'Moisture Detected', $3, false, false, false, 'iot_live', $4)
           ON CONFLICT (id) DO NOTHING RETURNING id`,
          [alertId, deviceId, at, episode.id],
        );
        await manager.query(`UPDATE alert_episodes SET "alertId" = $2 WHERE id = $1`, [episode.id, alertId]);
        entry.episodeId = String(episode.id);
        return inserted.length ? { id: alertId } : null;
      });
    } catch (error) {
      if ((error as { code?: string }).code === UNIQUE_VIOLATION) {
        // Another process opened this episode first: adopt its state.
        Object.assign(entry, await this.load(deviceId));
        return null;
      }
      this.logger.warn(`moisture episode persist failed for ${deviceId}: ${String(error)}`);
      throw error;
    }
  }
}
