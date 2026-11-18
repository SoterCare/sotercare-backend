import { Injectable, Logger } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, EntityManager } from 'typeorm';
import { loadAlertPolicy } from '../alert-policy/alert-policy';
import { AlertEventsPublisher } from '../realtime/alert-events.publisher';
import { rowsOf } from './db-rows';

export type NotifiableAlert = {
  id: string;
  deviceId: string;
  type: string;
  createdAt: Date;
};

/**
 * AR-6: turns an announced alert into durable push attempts, one per active
 * token of the alert's current owner (same recipient rule as alert.new).
 * Idempotent per (alert, token, escalation level).
 */
@Injectable()
export class NotificationAttemptsService {
  private readonly logger = new Logger(NotificationAttemptsService.name);

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly recipients: AlertEventsPublisher,
  ) {}

  async enqueue(
    alerts: NotifiableAlert[],
    escalationLevel = 0,
    manager?: EntityManager,
  ): Promise<number> {
    const db = manager ?? this.dataSource;
    const push = pushPolicy();
    let created = 0;
    for (const alert of alerts) {
      if (push[alert.type] === false) continue;
      const userId = await this.recipients.recipientFor(alert);
      if (userId === null) continue;
      const inserted = rowsOf<{ id: string }>(
        await db.query(
          `INSERT INTO notification_attempts ("alertId", "userId", "pushTokenId", "escalationLevel")
           SELECT $1, $2, id, $3 FROM push_tokens
           WHERE "userId" = $2 AND "revokedAt" IS NULL ORDER BY id
           ON CONFLICT ON CONSTRAINT uq_notification_attempt DO NOTHING
           RETURNING id`,
          [alert.id, userId, escalationLevel],
        ),
      );
      created += inserted.length;
      const [{ n }] = rowsOf<{ n: number }>(
        await db.query(
          `SELECT count(*)::int n FROM push_tokens WHERE "userId" = $1 AND "revokedAt" IS NULL`,
          [userId],
        ),
      );
      if (n === 0) {
        // Visible gap, not a silent drop: the web shows "No phone registered".
        await db.query(
          `UPDATE alerts SET "dispatchNote" = 'no_active_tokens' WHERE id = $1`,
          [alert.id],
        );
        this.logger.warn(`alert ${alert.id}: owner has no active push token`);
      }
    }
    return created;
  }
}

function pushPolicy(): Record<string, boolean> {
  try {
    return loadAlertPolicy().notifications.push;
  } catch {
    return {}; // unreadable policy: push every type (fail towards notifying)
  }
}
