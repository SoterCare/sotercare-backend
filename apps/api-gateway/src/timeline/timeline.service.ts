import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import {
  Between,
  FindOptionsWhere,
  MoreThanOrEqual,
  Repository,
} from 'typeorm';
import {
  Alert,
  AlertAction,
  AlertActionSource,
  AlertType,
  Device,
  Vital,
} from '../database/entities';
import { DismissTimelineItemDto } from './dto/dismiss-item.dto';
import { QueryDateOptionsDto } from './dto/query-date-options.dto';
import { QueryTimelineEventsDto } from './dto/query-events.dto';
import { QueryTimelineStatsDto } from './dto/query-stats.dto';
import { QueryTimelineVitalsDto } from './dto/query-vitals.dto';
import { RestoreTimelineItemDto } from './dto/restore-item.dto';
import { requireDeviceId } from '../common/device-scope';
import { OwnershipService } from '../ownership/ownership.service';
import { AlertEventsPublisher } from '../realtime/alert-events.publisher';

// Bound list endpoints — these previously returned every matching row.
const TIMELINE_MAX_EVENTS = 500;

@Injectable()
export class TimelineService {
  constructor(
    @InjectRepository(Device)
    private readonly deviceRepository: Repository<Device>,
    @InjectRepository(Vital)
    private readonly vitalRepository: Repository<Vital>,
    @InjectRepository(Alert)
    private readonly alertRepository: Repository<Alert>,
    private readonly ownershipService: OwnershipService,
    private readonly alertEvents?: AlertEventsPublisher,
  ) {}

  async getVitalsTimeline(userId: number, query: QueryTimelineVitalsDto) {
    const since = await this.ensureDeviceOwnership(userId, query.deviceId);
    const tz = Math.round(Number(query.tzOffsetMinutes ?? 0));
    const { start, end } = this.getRange(
      query.period,
      query.date,
      undefined,
      query.startDate,
      query.endDate,
      tz,
    );

    // Aggregate in SQL (GROUP BY time bucket + AVG/COUNT) instead of loading
    // every raw row into JS — a month of 1Hz data is ~2.6M rows otherwise.
    const bucketUnit = query.period === 'day' ? 'hour' : 'day';
    const buckets = await this.queryVitalBuckets(
      query,
      start,
      end,
      bucketUnit,
      since,
    );

    const points =
      query.period === 'day'
        ? this.mapHourlyBuckets(buckets)
        : this.mapDailyBuckets(buckets, start, end);

    return {
      metric: query.metric,
      period: query.period,
      points,
      yAxis: this.getYAxisMeta(query.metric),
    };
  }

  private async queryVitalBuckets(
    query: QueryTimelineVitalsDto,
    start: Date,
    end: Date,
    unit: 'hour' | 'day',
    since: Date,
  ): Promise<
    { bucket: Date | string | number; value: string | number | null }[]
  > {
    // For day view: bucket by local hour (0-23) relative to the local midnight
    // represented by `start`. This gives correct local-time hour labels
    // regardless of the server or database timezone.
    const bucketExpr =
      unit === 'hour'
        ? `FLOOR(EXTRACT(EPOCH FROM (v.timestamp - :start::timestamptz)) / 3600)::int`
        : `date_trunc('${unit}', v.timestamp)`;

    const qb = this.vitalRepository
      .createQueryBuilder('v')
      .select(bucketExpr, 'bucket')
      .where('v."deviceId" = :deviceId', { deviceId: query.deviceId })
      .andWhere('v.timestamp BETWEEN :start AND :end')
      // PH0-07: only rows ingested during the caller's ownership period.
      .andWhere('v."createdAt" >= :since', { since: since.toISOString() })
      .setParameter('start', start.toISOString())
      .setParameter('end', end.toISOString())
      .groupBy(bucketExpr)
      .orderBy('bucket', 'ASC');

    // gait is a count of valid entries per bucket; the rest average the metric.
    if (query.metric === 'gait') {
      qb.addSelect('COUNT(*)', 'value').andWhere(
        `v."gaitAnalysis" IS NOT NULL AND v."gaitAnalysis" != 'N/A'`,
      );
    } else {
      const column = {
        temp: 'v.temperature',
        roomTemp: 'v."roomTemperature"',
        moisture: 'v.moisture',
      }[query.metric];
      qb.addSelect(`AVG(${column})`, 'value').andWhere(`${column} IS NOT NULL`);
    }

    return qb.getRawMany();
  }

  /** Day view: 24 hourly slots, null where the hour has no data. */
  private mapHourlyBuckets(
    buckets: {
      bucket: Date | string | number;
      value: string | number | null;
    }[],
  ) {
    const byHour = new Map<number, number>();
    for (const row of buckets) {
      // bucket is now a local-hour integer 0-23 (from the FLOOR/EPOCH expression)
      const hour = Number(row.bucket);
      if (Number.isFinite(hour) && hour >= 0 && hour <= 23) {
        byHour.set(hour, this.roundBucketValue(row.value));
      }
    }

    return Array.from({ length: 24 }, (_, hour) => ({
      xLabel: `${String(hour).padStart(2, '0')}:00`,
      value: byHour.get(hour) ?? null,
    }));
  }

  /** Multi-day view: one point per day, trimmed of leading/trailing empty days. */
  private mapDailyBuckets(
    buckets: {
      bucket: Date | string | number;
      value: string | number | null;
    }[],
    start: Date,
    end: Date,
  ) {
    const byDay = new Map<string, number>();
    for (const row of buckets) {
      byDay.set(
        this.toDateKey(new Date(row.bucket)),
        this.roundBucketValue(row.value),
      );
    }

    const result: { xLabel: string; value: number | null }[] = [];
    const cursor = new Date(
      Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), start.getUTCDate()),
    );
    while (cursor <= end) {
      const key = this.toDateKey(cursor);
      result.push({ xLabel: key, value: byDay.get(key) ?? null });
      cursor.setUTCDate(cursor.getUTCDate() + 1);
    }

    let firstIndex = -1;
    let lastIndex = -1;
    for (let i = 0; i < result.length; i++) {
      if (result[i].value !== null) {
        if (firstIndex === -1) firstIndex = i;
        lastIndex = i;
      }
    }

    return firstIndex !== -1 ? result.slice(firstIndex, lastIndex + 1) : result;
  }

  private roundBucketValue(value: string | number | null): number {
    // pg returns AVG/COUNT as strings; tests may mock numbers.
    return Number(Number(value ?? 0).toFixed(2));
  }

  async getEvents(userId: number, query: QueryTimelineEventsDto) {
    const since = await this.ensureDeviceOwnership(userId, query.deviceId);
    const tz = Math.round(Number(query.tzOffsetMinutes ?? 0));
    const { start, end } = this.getRange(
      query.period,
      query.date,
      undefined,
      query.startDate,
      query.endDate,
      tz,
    );

    const where: FindOptionsWhere<Alert> = {
      deviceId: query.deviceId,
      timestamp: Between(start, end),
      isDismissed: false,
      isAttended: true,
      createdAt: MoreThanOrEqual(since),
    };

    if (query.filter && query.filter !== 'all') {
      where.type = query.filter as AlertType;
    }

    const alerts = await this.alertRepository.find({
      where,
      order: { timestamp: 'DESC' },
      take: TIMELINE_MAX_EVENTS,
    });

    return {
      events: alerts.map((alert) => ({
        id: alert.id,
        type: alert.type,
        label: alert.title,
        timestamp: alert.timestamp.getTime(),
        time: this.formatTime(alert.timestamp),
      })),
    };
  }

  async getStats(userId: number, query: QueryTimelineStatsDto) {
    const since = await this.ensureDeviceOwnership(userId, query.deviceId);
    const tz = Math.round(Number(query.tzOffsetMinutes ?? 0));
    const { start, end } = this.getRange(
      query.period,
      query.date ?? `${query.month}-01`,
      query.month,
      query.startDate,
      query.endDate,
      tz,
    );

    // COUNT per type in SQL — one row per alert type instead of every alert row.
    const rows: { type: AlertType; count: string }[] =
      await this.alertRepository
        .createQueryBuilder('a')
        .select('a.type', 'type')
        .addSelect('COUNT(*)', 'count')
        .where('a."deviceId" = :deviceId', { deviceId: query.deviceId })
        .andWhere('a.timestamp BETWEEN :start AND :end', { start, end })
        .andWhere('a."createdAt" >= :since', { since })
        .groupBy('a.type')
        .getRawMany();

    const counts = {
      movements: 0,
      falls: 0,
      urine: 0,
      temperature: 0,
      moisture: 0,
      helpCalls: 0,
    };

    for (const row of rows) {
      switch (row.type) {
        case AlertType.MOVEMENT:
          counts.movements = Number(row.count);
          break;
        case AlertType.FALL:
          counts.falls = Number(row.count);
          break;
        case AlertType.URINE:
          counts.urine = Number(row.count);
          break;
        case AlertType.TEMPERATURE:
          counts.temperature = Number(row.count);
          break;
        case AlertType.MOISTURE:
          counts.moisture = Number(row.count);
          break;
        case AlertType.HELP_CALL:
          counts.helpCalls = Number(row.count);
          break;
      }
    }

    return counts;
  }

  async getDateOptions(userId: number, query: QueryDateOptionsDto) {
    const since = await this.ensureDeviceOwnership(userId, query.deviceId);
    const tz = Math.round(Number(query.tzOffsetMinutes ?? 0));

    // Group by local calendar day by shifting the UTC timestamp by the device
    // timezone offset before truncating to a date string.
    const rows: { date: string }[] = await this.vitalRepository
      .createQueryBuilder('v')
      .select(
        `DISTINCT to_char((v.timestamp AT TIME ZONE 'UTC') + (INTERVAL '1 minute' * :tz), 'YYYY/MM/DD')`,
        'date',
      )
      .where('v."deviceId" = :deviceId', { deviceId: query.deviceId })
      .andWhere('v."createdAt" >= :since', { since })
      .setParameter('tz', tz)
      .orderBy('date', 'DESC')
      .getRawMany();

    return { options: rows.map((row) => row.date) };
  }

  async getDismissed(userId: number) {
    const windows = await this.currentWindows(userId);
    if (windows.length === 0) {
      return { items: [] };
    }

    const items = await this.alertRepository.find({
      where: windows.map(([deviceId, since]) => ({
        deviceId,
        isDismissed: true,
        createdAt: MoreThanOrEqual(since),
      })),
      order: { dismissedAt: 'DESC' },
      take: TIMELINE_MAX_EVENTS,
    });

    return {
      items: items.map((item) => ({
        id: item.id,
        type: item.type,
        title: item.title,
        timestamp: item.timestamp.getTime(),
      })),
    };
  }

  async restore(
    userId: number,
    body: RestoreTimelineItemDto,
    source: AlertActionSource = 'unknown',
  ) {
    await this.setDismissed(userId, body.id, false, source);
    return { restoredId: body.id };
  }

  async dismiss(
    userId: number,
    body: DismissTimelineItemDto,
    source: AlertActionSource = 'unknown',
  ) {
    await this.setDismissed(userId, body.id, true, source);
    return { dismissedId: body.id };
  }

  /**
   * AR-4: conditional state change plus one audit row in one transaction. A
   * repeat of the same action changes nothing, so it is neither audited nor
   * re-published.
   */
  private async setDismissed(
    userId: number,
    alertId: string,
    dismissed: boolean,
    source: AlertActionSource,
  ) {
    const alert = await this.getOwnedAlert(userId, alertId);
    const dismissedAt = dismissed ? new Date() : null;
    const changed = await this.alertRepository.manager.transaction(
      async (manager) => {
        const result = await manager.update(
          Alert,
          { id: alert.id, isDismissed: !dismissed },
          { isDismissed: dismissed, dismissedAt },
        );
        if (!result.affected) return false;
        await manager.insert(AlertAction, {
          alertId: alert.id,
          userId,
          action: dismissed ? 'dismissed' : 'restored',
          source,
          previousState: dismissed ? 'active' : 'dismissed',
          newState: dismissed ? 'dismissed' : 'active',
          reason: null,
        });
        return true;
      },
    );
    if (!changed) return;
    alert.isDismissed = dismissed;
    alert.dismissedAt = dismissedAt;
    await this.alertEvents?.publishUpdated(
      alert,
      dismissed ? 'dismissed' : 'restored',
      userId,
    );
  }

  private getYAxisMeta(metric: QueryTimelineVitalsDto['metric']) {
    switch (metric) {
      case 'temp':
        return {
          label: 'Temperature (°C)',
          minValue: 36,
          maxValue: 37.5,
          unit: '°C',
        };
      case 'roomTemp':
        return {
          label: 'Room Temperature (°C)',
          minValue: 20,
          maxValue: 40,
          unit: '°C',
        };
      case 'moisture':
        return {
          label: 'Moisture',
          minValue: 0,
          maxValue: 100,
          unit: '%',
        };
      case 'gait':
        return {
          label: 'Gait Analysis Entries',
          minValue: 0,
          maxValue: 10,
          unit: 'entries',
        };
    }
  }

  private getRange(
    period: 'day' | 'week' | 'month' | 'custom',
    date?: string,
    month?: string,
    startDate?: string,
    endDate?: string,
    tzOffsetMinutes: number = 0,
  ) {
    // tzOffsetMinutes = -device.getTimezoneOffset() (positive for UTC+ zones).
    // We subtract it from UTC midnight to get the UTC instant that corresponds
    // to local midnight on the requested date.
    const tzMs = tzOffsetMinutes * 60_000;

    if (period === 'custom' && startDate && endDate) {
      const start = new Date(
        new Date(`${startDate}T00:00:00.000Z`).getTime() - tzMs,
      );
      const end = new Date(
        new Date(`${endDate}T00:00:00.000Z`).getTime() - tzMs + 86_400_000 - 1,
      );
      return { start, end };
    }

    if (period === 'month') {
      const monthValue =
        month ??
        (date ? date.slice(0, 7) : new Date().toISOString().slice(0, 7));
      const [year, monthNumber] = monthValue.split('-').map(Number);
      // Month boundaries: local midnight on day 1 → local midnight on last day+1
      const start = new Date(Date.UTC(year, monthNumber - 1, 1) - tzMs);
      const end = new Date(
        Date.UTC(year, monthNumber, 0) - tzMs + 86_400_000 - 1,
      );
      return { start, end };
    }

    const anchorDateString = date || new Date().toISOString().split('T')[0];

    if (period === 'week') {
      const anchorLocalMidnight =
        new Date(`${anchorDateString}T00:00:00.000Z`).getTime() - tzMs;
      const start = new Date(anchorLocalMidnight - 6 * 86_400_000);
      const end = new Date(anchorLocalMidnight + 86_400_000 - 1);
      return { start, end };
    }

    // Day: exactly one local calendar day [local midnight, next local midnight)
    const localMidnightMs =
      new Date(`${anchorDateString}T00:00:00.000Z`).getTime() - tzMs;
    const start = new Date(localMidnightMs);
    const end = new Date(localMidnightMs + 86_400_000 - 1);
    return { start, end };
  }

  /**
   * Current ownership of the device by the caller, returned as the start of
   * their ownership period (PH0-07). History before it is not visible.
   */
  private async ensureDeviceOwnership(
    userId: number,
    deviceId: string,
  ): Promise<Date> {
    requireDeviceId(deviceId);
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

    return since;
  }

  /** [deviceId, since] for every device the caller currently owns. */
  private async currentWindows(userId: number): Promise<[string, Date][]> {
    const devices = await this.deviceRepository.find({ where: { userId } });
    const windows = await this.ownershipService.currentWindows(userId);
    return devices
      .filter((device) => windows.has(device.id))
      .map((device) => [device.id, windows.get(device.id) as Date]);
  }

  private async getOwnedAlert(userId: number, alertId: string) {
    const alert = await this.alertRepository.findOne({
      where: { id: alertId },
    });
    if (!alert) {
      throw new NotFoundException('Timeline item not found');
    }

    const since = await this.ensureDeviceOwnership(userId, alert.deviceId);
    if (alert.createdAt < since) {
      throw new NotFoundException('Timeline item not found');
    }
    return alert;
  }

  private formatTime(date: Date) {
    return date.toLocaleTimeString('en-US', {
      hour: '2-digit',
      minute: '2-digit',
      hour12: true,
      timeZone: 'UTC',
    });
  }

  private toDateKey(date: Date) {
    const year = date.getUTCFullYear();
    const month = String(date.getUTCMonth() + 1).padStart(2, '0');
    const day = String(date.getUTCDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
  }
}
