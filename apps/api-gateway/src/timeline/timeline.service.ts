import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Between, FindOptionsWhere, In, Repository } from 'typeorm';
import { Alert, AlertType, Device, Vital } from '../database/entities';
import { DismissTimelineItemDto } from './dto/dismiss-item.dto';
import { QueryDateOptionsDto } from './dto/query-date-options.dto';
import { QueryTimelineEventsDto } from './dto/query-events.dto';
import { QueryTimelineStatsDto } from './dto/query-stats.dto';
import { QueryTimelineVitalsDto } from './dto/query-vitals.dto';
import { RestoreTimelineItemDto } from './dto/restore-item.dto';

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
  ) {}

  async getVitalsTimeline(userId: number, query: QueryTimelineVitalsDto) {
    await this.ensureDeviceOwnership(userId, query.deviceId);
    const { start, end } = this.getRange(
      query.period,
      query.date,
      undefined,
      query.startDate,
      query.endDate,
    );

    // Aggregate in SQL (GROUP BY time bucket + AVG/COUNT) instead of loading
    // every raw row into JS — a month of 1Hz data is ~2.6M rows otherwise.
    const bucketUnit = query.period === 'day' ? 'hour' : 'day';
    const buckets = await this.queryVitalBuckets(query, start, end, bucketUnit);

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
  ): Promise<{ bucket: Date | string; value: string | number | null }[]> {
    const bucketExpr = `date_trunc('${unit}', v.timestamp)`;
    const qb = this.vitalRepository
      .createQueryBuilder('v')
      .select(bucketExpr, 'bucket')
      .where('v."deviceId" = :deviceId', { deviceId: query.deviceId })
      .andWhere('v.timestamp BETWEEN :start AND :end', { start, end })
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
    buckets: { bucket: Date | string; value: string | number | null }[],
  ) {
    const byHour = new Map<number, number>();
    for (const row of buckets) {
      const date = new Date(row.bucket);
      byHour.set(date.getUTCHours(), this.roundBucketValue(row.value));
    }

    return Array.from({ length: 24 }, (_, hour) => ({
      xLabel: `${String(hour).padStart(2, '0')}:00`,
      value: byHour.get(hour) ?? null,
    }));
  }

  /** Multi-day view: one point per day, trimmed of leading/trailing empty days. */
  private mapDailyBuckets(
    buckets: { bucket: Date | string; value: string | number | null }[],
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
    await this.ensureDeviceOwnership(userId, query.deviceId);
    const { start, end } = this.getRange(
      query.period,
      query.date,
      undefined,
      query.startDate,
      query.endDate,
    );

    const where: FindOptionsWhere<Alert> = {
      deviceId: query.deviceId,
      timestamp: Between(start, end),
      isDismissed: false,
      isAttended: true,
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
    await this.ensureDeviceOwnership(userId, query.deviceId);
    const { start, end } = this.getRange(
      query.period,
      query.date ?? `${query.month}-01`,
      query.month,
      query.startDate,
      query.endDate,
    );

    // COUNT per type in SQL — one row per alert type instead of every alert row.
    const rows: { type: AlertType; count: string }[] =
      await this.alertRepository
        .createQueryBuilder('a')
        .select('a.type', 'type')
        .addSelect('COUNT(*)', 'count')
        .where('a."deviceId" = :deviceId', { deviceId: query.deviceId })
        .andWhere('a.timestamp BETWEEN :start AND :end', { start, end })
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
    await this.ensureDeviceOwnership(userId, query.deviceId);

    // Dedupe to calendar days in SQL — previously this loaded every vital row
    // ever stored for the device just to derive the distinct dates.
    const rows: { date: string }[] = await this.vitalRepository
      .createQueryBuilder('v')
      .select(
        `DISTINCT to_char(v.timestamp AT TIME ZONE 'UTC', 'YYYY/MM/DD')`,
        'date',
      )
      .where('v."deviceId" = :deviceId', { deviceId: query.deviceId })
      .orderBy('date', 'DESC')
      .getRawMany();

    return { options: rows.map((row) => row.date) };
  }

  async getDismissed(userId: number) {
    const devices = await this.deviceRepository.find({ where: { userId } });
    const deviceIds = devices.map((device) => device.id);

    if (deviceIds.length === 0) {
      return { items: [] };
    }

    const items = await this.alertRepository.find({
      where: {
        deviceId: In(deviceIds),
        isDismissed: true,
      },
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

  async restore(userId: number, body: RestoreTimelineItemDto) {
    const alert = await this.getOwnedAlert(userId, body.id);
    alert.isDismissed = false;
    alert.dismissedAt = null;
    await this.alertRepository.save(alert);

    return { restoredId: body.id };
  }

  async dismiss(userId: number, body: DismissTimelineItemDto) {
    const alert = await this.getOwnedAlert(userId, body.id);
    alert.isDismissed = true;
    alert.dismissedAt = new Date();
    await this.alertRepository.save(alert);

    return { dismissedId: body.id };
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
  ) {
    if (period === 'custom' && startDate && endDate) {
      const start = new Date(`${startDate}T00:00:00.000Z`);
      const end = new Date(`${endDate}T23:59:59.999Z`);
      return { start, end };
    }

    if (period === 'month') {
      const monthValue =
        month ??
        (date ? date.slice(0, 7) : new Date().toISOString().slice(0, 7));
      const [year, monthNumber] = monthValue.split('-').map(Number);
      const start = new Date(Date.UTC(year, monthNumber - 1, 1));
      const end = new Date(Date.UTC(year, monthNumber, 0, 23, 59, 59, 999));
      return { start, end };
    }

    const anchorDateString = date || new Date().toISOString().split('T')[0];
    const anchor = new Date(`${anchorDateString}T00:00:00.000Z`);
    if (period === 'week') {
      const start = new Date(anchor);
      start.setUTCDate(start.getUTCDate() - 6);
      start.setUTCHours(0, 0, 0, 0);

      const end = new Date(anchor);
      end.setUTCHours(23, 59, 59, 999);
      return { start, end };
    }

    const start = new Date(anchor);
    const end = new Date(anchor);
    end.setUTCHours(23, 59, 59, 999);
    return { start, end };
  }

  private async ensureDeviceOwnership(userId: number, deviceId: string) {
    const device = await this.deviceRepository.findOne({
      where: { id: deviceId, userId },
    });

    if (!device) {
      throw new NotFoundException(
        'Device not found or does not belong to user',
      );
    }

    return device;
  }

  private async getOwnedAlert(userId: number, alertId: string) {
    const alert = await this.alertRepository.findOne({
      where: { id: alertId },
    });
    if (!alert) {
      throw new NotFoundException('Timeline item not found');
    }

    await this.ensureDeviceOwnership(userId, alert.deviceId);
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
