import { Injectable, Logger } from '@nestjs/common';
import { OwnershipService } from '../ownership/ownership.service';
import { UserSocketRegistry } from './user-socket.registry';

export type AlertSeverity = 'critical' | 'high' | 'normal';

const SEVERITY: Record<string, AlertSeverity> = {
  fall: 'critical',
  help_call: 'critical',
  temperature: 'high',
};
export const severityOf = (type: string): AlertSeverity =>
  SEVERITY[type] ?? 'normal';

const LATE_AFTER_MS = 15 * 60_000;

export type PublishableAlert = {
  id: string;
  deviceId: string;
  type: string;
  title: string;
  timestamp: Date;
  createdAt: Date;
  eventId?: string | null;
};

export type AlertUpdateStatus =
  | 'attended'
  | 'false_alarm'
  | 'dismissed'
  | 'restored'
  | 'escalated'
  | 'condition_cleared';

/**
 * AR-2: canonical real-time alert events. The recipient is resolved at send
 * time from the device's current ownership period (I-4); an alert recorded
 * before that period started belongs to a previous owner and is not sent to
 * anyone (PH0-07). Emission is best-effort: the alert row stays the durable
 * source that clients reconcile against (GET /alerts/recent).
 */
@Injectable()
export class AlertEventsPublisher {
  private readonly logger = new Logger(AlertEventsPublisher.name);

  constructor(
    private readonly registry: UserSocketRegistry,
    private readonly ownershipService: OwnershipService,
  ) {}

  /** Current owner allowed to see this alert, or null. */
  async recipientFor(alert: Pick<PublishableAlert, 'deviceId' | 'createdAt'>) {
    const owner = await this.ownershipService.currentOwnership(alert.deviceId);
    if (!owner || alert.createdAt < owner.since) return null;
    return owner.userId;
  }

  async publishNew(alerts: PublishableAlert[], now = new Date()): Promise<number> {
    let sent = 0;
    for (const alert of alerts) {
      const userId = await this.recipientFor(alert);
      if (userId === null) continue;
      this.registry.emitToUser(userId, 'alert.new', {
        id: alert.id,
        type: alert.type,
        title: alert.title,
        timestamp: alert.timestamp.getTime(),
        deviceId: alert.deviceId,
        severity: severityOf(alert.type),
        eventId: alert.eventId ?? null,
        late: now.getTime() - alert.timestamp.getTime() > LATE_AFTER_MS,
      });
      sent += 1;
    }
    return sent;
  }

  async publishUpdated(
    alert: Pick<PublishableAlert, 'id' | 'deviceId' | 'createdAt'>,
    status: AlertUpdateStatus,
    actorUserId: number | null,
    at = new Date(),
  ): Promise<void> {
    const userId = await this.recipientFor(alert);
    if (userId === null) return;
    this.registry.emitToUser(userId, 'alert.updated', {
      id: alert.id,
      deviceId: alert.deviceId,
      status,
      at: at.getTime(),
      actorUserId,
    });
    // Compatibility shim for clients built before alert.updated existed.
    if (process.env.EMIT_LEGACY_ALERT_EVENTS !== 'false') {
      if (status === 'attended') {
        this.registry.emitToUser(userId, 'alert.attended', {
          id: alert.id,
          deviceId: alert.deviceId,
          attendedAt: at.getTime(),
        });
      } else if (status === 'false_alarm' || status === 'dismissed') {
        this.registry.emitToUser(userId, 'alert.dismissed', {
          id: alert.id,
          deviceId: alert.deviceId,
        });
      }
    }
  }
}
