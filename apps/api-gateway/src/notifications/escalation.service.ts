import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import {
  AlertPolicy,
  escalationAllowed,
  loadAlertPolicy,
} from '../alert-policy/alert-policy';
import { AlertEventsPublisher } from '../realtime/alert-events.publisher';
import { rowsOf } from './db-rows';
import { NotificationAttemptsService } from './notification-attempts.service';

const LOOKBACK_MS = 24 * 3_600_000;

/**
 * AR-8: re-notifies the SAME current owner of an unacknowledged critical alert
 * on the policy schedule. No other recipients, channels or emergency contacts
 * exist. Runs only with an approved alert policy AND ESCALATION_ENABLED=true;
 * the shipped policy is not approved, so escalation is off by default.
 */
@Injectable()
export class EscalationService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(EscalationService.name);
  private timer: NodeJS.Timeout | null = null;

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly recipients: AlertEventsPublisher,
    private readonly attempts: NotificationAttemptsService,
  ) {}

  onModuleInit() {
    if (process.env.ESCALATION_ENABLED !== 'true') return;
    const policy = safePolicy();
    if (!policy || !escalationAllowed(policy)) {
      this.logger.warn(
        'ESCALATION_ENABLED=true but the alert policy is not approved: escalation stays off',
      );
      return;
    }
    this.timer = setInterval(() => {
      this.tick().catch((e) =>
        this.logger.warn(`escalation tick failed: ${String(e)}`),
      );
    }, 15_000);
    this.timer.unref?.();
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Returns the number of alerts escalated in this pass. */
  async tick(now = new Date()): Promise<number> {
    const policy = safePolicy();
    if (!policy || !escalationAllowed(policy)) return 0;
    const { types, scheduleSeconds } = policy.notifications.escalation;
    const candidates = rowsOf<{
      id: string;
      deviceId: string;
      type: string;
      createdAt: Date;
      dispatchedAt: Date;
      level: number;
    }>(
      await this.dataSource.query(
        `SELECT a.id, a."deviceId", a.type, a."createdAt", a."dispatchedAt",
                (SELECT count(*)::int FROM alert_actions x
                 WHERE x."alertId" = a.id AND x.action = 'escalated') AS level
         FROM alerts a
         WHERE a.type::text = ANY($1) AND a."dispatchState" = 'dispatched'
           AND a."acknowledgedAt" IS NULL AND a."isDismissed" = false
           AND a."dispatchedAt" > $2
         ORDER BY a."dispatchedAt" LIMIT 100`,
        [types, new Date(now.getTime() - LOOKBACK_MS)],
      ),
    );

    let escalated = 0;
    for (const alert of candidates) {
      const next = alert.level + 1;
      if (next > scheduleSeconds.length) continue;
      const dueAt =
        new Date(alert.dispatchedAt).getTime() +
        scheduleSeconds[next - 1] * 1000;
      if (now.getTime() < dueAt) continue;
      const userId = await this.recipients.recipientFor(alert);
      if (userId === null) continue; // owner changed or none: stop

      const done = await this.dataSource.transaction(async (manager) => {
        await manager.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [
          `escalate:${alert.id}`,
        ]);
        const [state] = rowsOf<{ open: boolean; level: number }>(
          await manager.query(
            `SELECT a."acknowledgedAt" IS NULL AND a."isDismissed" = false AS open,
                    (SELECT count(*)::int FROM alert_actions x
                     WHERE x."alertId" = a.id AND x.action = 'escalated') AS level
             FROM alerts a WHERE a.id = $1`,
            [alert.id],
          ),
        );
        if (!state?.open || state.level !== alert.level) return false;
        await manager.query(
          `INSERT INTO alert_actions ("alertId", "userId", action, source, reason)
           VALUES ($1, $2, 'escalated', 'system', $3)`,
          [alert.id, userId, `level_${next}`],
        );
        await this.attempts.enqueue([alert], next, manager);
        return true;
      });
      if (done) {
        escalated += 1;
        this.logger.log(
          `alert ${alert.id} escalated to level ${next} (same owner)`,
        );
      }
    }
    return escalated;
  }
}

function safePolicy(): AlertPolicy | null {
  try {
    return loadAlertPolicy();
  } catch {
    return null;
  }
}
