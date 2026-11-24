import {
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import { DataSource, In, IsNull, MoreThanOrEqual, Repository } from 'typeorm';
import {
  Alert,
  AlertAction,
  AlertActionSource,
  AlertType,
  Device,
} from '../database/entities';
import {
  AlertEventsPublisher,
  severityOf,
} from '../realtime/alert-events.publisher';

const CRITICAL_TYPES = [AlertType.FALL, AlertType.HELP_CALL];
const SEVERITY_RANK = { critical: 0, high: 1, normal: 2 } as const;
import { OwnershipService } from '../ownership/ownership.service';
import { AlertSeenDto } from './dto/alert-seen.dto';

@Injectable()
export class AlertsService {
  private readonly logger = new Logger(AlertsService.name);

  constructor(
    @InjectRepository(Alert)
    private readonly alertRepository: Repository<Alert>,
    @InjectRepository(Device)
    private readonly deviceRepository: Repository<Device>,
    private readonly alertEvents: AlertEventsPublisher,
    private readonly ownershipService: OwnershipService,
    @InjectDataSource()
    private readonly dataSource: DataSource,
  ) {}

  /**
   * [deviceId, since] pairs the caller may read (PH0-07): the explicit device
   * when given (404 if not currently theirs), otherwise every current device.
   * `since` is the start of the caller's ownership period.
   */
  private async readableWindows(
    userId: number,
    deviceId?: string,
  ): Promise<[string, Date][]> {
    if (deviceId) {
      const device = await this.deviceRepository.findOne({
        where: { id: deviceId, userId },
      });
      const since = device
        ? await this.ownershipService.currentWindow(userId, deviceId)
        : null;
      if (!device || !since) {
        throw new NotFoundException(
          'Device not found or does not belong to user',
        );
      }
      return [[deviceId, since]];
    }
    const devices = await this.deviceRepository.find({ where: { userId } });
    const windows = await this.ownershipService.currentWindows(userId);
    return devices
      .filter((device) => windows.has(device.id))
      .map((device) => [device.id, windows.get(device.id) as Date]);
  }

  async getRecentAlerts(userId: number, deviceId?: string, limit = 20) {
    const windows = await this.readableWindows(userId, deviceId);
    if (windows.length === 0) {
      return { alerts: [], total: 0 };
    }

    const pending = (extra: Record<string, unknown> = {}) =>
      windows.map(([id, since]) => ({
        deviceId: id,
        isDismissed: false,
        isAttended: false,
        createdAt: MoreThanOrEqual(since),
        ...extra,
      }));
    // AR-3: severity first. Critical alerts are fetched on their own so a
    // burst of lower-severity alerts can never push a fall out of the window.
    const [critical, newest] = await Promise.all([
      this.alertRepository.find({
        where: pending({ type: In(CRITICAL_TYPES) }),
        order: { timestamp: 'DESC' },
        take: limit,
      }),
      this.alertRepository.find({
        where: pending(),
        order: { timestamp: 'DESC' },
        take: limit,
      }),
    ]);
    const byId = new Map([...critical, ...newest].map((a) => [a.id, a]));
    const alerts = [...byId.values()]
      .sort(
        (a, b) =>
          SEVERITY_RANK[severityOf(a.type)] -
            SEVERITY_RANK[severityOf(b.type)] ||
          b.timestamp.getTime() - a.timestamp.getTime(),
      )
      .slice(0, limit);

    return {
      alerts: alerts.map((alert) => ({
        id: alert.id,
        type: alert.type,
        title: alert.title,
        timestamp: alert.timestamp.getTime(),
        deviceId: alert.deviceId,
        severity: severityOf(alert.type),
      })),
      total: alerts.length,
    };
  }

  async getAttendedAlerts(userId: number, deviceId?: string, limit = 50) {
    const windows = await this.readableWindows(userId, deviceId);
    if (windows.length === 0) {
      return { alerts: [], total: 0 };
    }

    const alerts = await this.alertRepository.find({
      where: windows.map(([id, since]) => ({
        deviceId: id,
        isAttended: true,
        createdAt: MoreThanOrEqual(since),
      })),
      order: { timestamp: 'DESC' },
      take: limit,
    });

    return {
      alerts: alerts.map((alert) => ({
        id: alert.id,
        type: alert.type,
        title: alert.title,
        timestamp: alert.timestamp.getTime(),
        deviceId: alert.deviceId,
        // AR-4: recorded acknowledgement time; legacy rows fall back to the
        // alert time and say so.
        attendedAt: (alert.acknowledgedAt ?? alert.timestamp).getTime(),
        attendedAtSource: alert.acknowledgedAt
          ? ('recorded' as const)
          : ('legacy_alert_time' as const),
      })),
      total: alerts.length,
    };
  }

  /**
   * AR-4: first caregiver decision wins (conditional UPDATE ... WHERE
   * acknowledgedAt IS NULL). A repeat of the same decision is idempotent; a
   * different decision is a controlled 409. Every attempt is audited in the
   * same transaction; events are published only after commit.
   */
  /** PH0-07: an alert from before the caller's ownership period is not theirs. */
  private async findOwnedAlert(userId: number, alertId: string) {
    const alert = await this.alertRepository.findOne({
      where: { id: alertId },
      relations: ['device'],
    });
    const since =
      alert && alert.device.userId === userId
        ? await this.ownershipService.currentWindow(userId, alert.deviceId)
        : null;
    if (!alert || !since || alert.createdAt < since) {
      throw new NotFoundException('Alert not found or access denied');
    }
    return alert;
  }

  /**
   * AR-7: client-reported evidence that a push was shown or opened. Recorded
   * in the audit trail; never acknowledges the alert.
   */
  async markSeen(
    userId: number,
    alertId: string,
    dto: AlertSeenDto,
    clientSource: AlertActionSource = 'unknown',
  ) {
    await this.findOwnedAlert(userId, alertId);
    const now = new Date();
    let attemptId: string | null = null;
    if (dto.notificationAttemptId) {
      const column =
        dto.source === 'push_opened' ? '"openedAt"' : '"receivedOnDeviceAt"';
      const result: unknown = await this.dataSource.query(
        `UPDATE notification_attempts SET ${column} = COALESCE(${column}, $4)
         WHERE id = $1 AND "alertId" = $2 AND "userId" = $3 RETURNING id`,
        [dto.notificationAttemptId, alertId, userId, now],
      );
      const rows = (
        Array.isArray(result) && Array.isArray(result[0]) ? result[0] : result
      ) as { id: string }[];
      attemptId = rows[0]?.id ?? null;
    }
    await this.dataSource.getRepository(AlertAction).insert({
      alertId,
      userId,
      action: dto.source === 'push_opened' ? 'opened_from_push' : 'seen',
      source: dto.source === 'in_app' ? clientSource : 'push',
      previousState: null,
      newState: null,
      reason: dto.source,
      notificationAttemptId: attemptId,
    });
    return { id: alertId, recorded: true, acknowledged: false };
  }

  async resolveAlert(
    userId: number,
    alertId: string,
    resolution: 'attended' | 'false-alarm',
    source: AlertActionSource = 'unknown',
  ) {
    const alert = await this.findOwnedAlert(userId, alertId);

    const action = resolution === 'attended' ? 'attended' : 'false_alarm';
    const now = new Date();
    const previousState =
      alert.ackAction ??
      (alert.isDismissed
        ? 'dismissed'
        : alert.isAttended
          ? 'attended'
          : 'active');

    const outcome = await this.dataSource.transaction(async (manager) => {
      const updated = await manager.update(
        Alert,
        { id: alertId, acknowledgedAt: IsNull() },
        {
          acknowledgedAt: now,
          acknowledgedByUserId: userId,
          ackAction: action,
          ...(action === 'attended'
            ? { isAttended: true }
            : { isFalseAlarm: true, isDismissed: true, dismissedAt: now }),
        },
      );
      if (updated.affected) {
        await manager.insert(AlertAction, {
          alertId,
          userId,
          action,
          source,
          previousState,
          newState: action,
          reason: null,
          notificationAttemptId: null,
        });
        return { won: true as const };
      }
      const current = await manager.findOne(Alert, { where: { id: alertId } });
      await manager.insert(AlertAction, {
        alertId,
        userId,
        action: 'ack_rejected_already_acknowledged',
        source,
        previousState: current?.ackAction ?? null,
        newState: current?.ackAction ?? null,
        reason: `requested ${action}`,
        notificationAttemptId: null,
      });
      return { won: false as const, current };
    });

    if (outcome.won) {
      await this.alertEvents.publishUpdated(alert, action, userId, now);
      return {
        id: alertId,
        status: resolution,
        acknowledgedAt: now.getTime(),
        acknowledgedBy: { userId },
        alreadyAcknowledged: false,
      };
    }
    const current = outcome.current;
    const response = {
      id: alertId,
      status: current?.ackAction === 'false_alarm' ? 'false-alarm' : 'attended',
      acknowledgedAt: current?.acknowledgedAt?.getTime() ?? null,
      acknowledgedBy: { userId: current?.acknowledgedByUserId ?? null },
      alreadyAcknowledged: true,
    };
    if (current?.ackAction === action) {
      return response;
    }
    throw new ConflictException({
      message: 'Alert was already acknowledged with a different decision',
      ...response,
    });
  }
}
