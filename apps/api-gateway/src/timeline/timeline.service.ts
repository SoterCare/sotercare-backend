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
    const { start, end } = this.getRange(query.period, query.date);

    const vitals = await this.vitalRepository.find({
      where: {
        deviceId: query.deviceId,
        timestamp: Between(start, end),
      },
      order: { timestamp: 'ASC' },
    });

    const points =
      query.period === 'day'
        ? this.aggregateDailyVitals(vitals, query.metric)
        : this.aggregateMultiDayVitals(vitals, query.metric, start, end);

    return {
      metric: query.metric,
      period: query.period,
      points,
      yAxis: this.getYAxisMeta(query.metric),
    };
  }

  async getEvents(userId: number, query: QueryTimelineEventsDto) {
    await this.ensureDeviceOwnership(userId, query.deviceId);
    const { start, end } = this.getRange(query.period, query.date);

    const where: FindOptionsWhere<Alert> = {
      deviceId: query.deviceId,
      timestamp: Between(start, end),
      isDismissed: false,
    };

    if (query.filter && query.filter !== 'all') {
      where.type = query.filter as AlertType;
    }

    const alerts = await this.alertRepository.find({
      where,
      order: { timestamp: 'DESC' },
    });

    return {
      events: alerts.map((alert) => ({
        id: alert.id,
        type: alert.type,
        label: alert.title,
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
    );

    const alerts = await this.alertRepository.find({
      where: {
        deviceId: query.deviceId,
        timestamp: Between(start, end),
      },
    });

    const counts = alerts.reduce(
      (accumulator, alert) => {
        switch (alert.type) {
          case AlertType.MOVEMENT:
            accumulator.movements += 1;
            break;
          case AlertType.FALL:
            accumulator.falls += 1;
            break;
          case AlertType.URINE:
            accumulator.urine += 1;
            break;
          case AlertType.TEMPERATURE:
            accumulator.temperature += 1;
            break;
          case AlertType.MOISTURE:
            accumulator.moisture += 1;
            break;
        }
        return accumulator;
      },
      { movements: 0, falls: 0, urine: 0, temperature: 0, moisture: 0 },
    );

    return counts;
  }

  async getDateOptions(userId: number, query: QueryDateOptionsDto) {
    await this.ensureDeviceOwnership(userId, query.deviceId);
    const vitals = await this.vitalRepository.find({
      where: { deviceId: query.deviceId },
      order: { timestamp: 'DESC' },
      select: { timestamp: true },
    });

    const options = Array.from(
      new Set(
        vitals.map((vital) => {
          const year = vital.timestamp.getUTCFullYear();
          const month = String(vital.timestamp.getUTCMonth() + 1).padStart(
            2,
            '0',
          );
          const day = String(vital.timestamp.getUTCDate()).padStart(2, '0');
          return `${year}/${month}/${day}`;
        }),
      ),
    );

    return { options };
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
    });

    return {
      items: items.map((item) => ({
        id: item.id,
        type: item.type,
        title: item.title,
        time: item.timestamp,
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

  private aggregateDailyVitals(
    vitals: Vital[],
    metric: QueryTimelineVitalsDto['metric'],
  ) {
    const buckets = new Map<number, number[]>();
    for (let hour = 0; hour < 24; hour += 1) {
      buckets.set(hour, []);
    }

    for (const vital of vitals) {
      const hour = vital.timestamp.getUTCHours();
      const val = this.resolveMetricValue(vital, metric);
      if (val !== null) {
        buckets.get(hour)?.push(val);
      }
    }

    return Array.from(buckets.entries()).map(([hour, values]) => ({
      xLabel: `${String(hour).padStart(2, '0')}:00`,
      value: this.averageValues(values, metric),
    }));
  }

  private aggregateMultiDayVitals(
    vitals: Vital[],
    metric: QueryTimelineVitalsDto['metric'],
    start: Date,
    end: Date,
  ) {
    const days = new Map<string, number[]>();
    const cursor = new Date(
      Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), start.getUTCDate()),
    );

    while (cursor <= end) {
      days.set(this.toDateKey(cursor), []);
      cursor.setUTCDate(cursor.getUTCDate() + 1);
    }

    for (const vital of vitals) {
      const key = this.toDateKey(vital.timestamp);
      const val = this.resolveMetricValue(vital, metric);
      if (val !== null) {
        days.get(key)?.push(val);
      }
    }

    return Array.from(days.entries()).map(([day, values]) => ({
      xLabel: day,
      value: this.averageValues(values, metric),
    }));
  }

  private resolveMetricValue(
    vital: Vital,
    metric: QueryTimelineVitalsDto['metric'],
  ): number | null {
    switch (metric) {
      case 'temp':
        return vital.temperature ?? null;
      case 'roomTemp':
        return vital.roomTemperature ?? null;
      case 'moisture':
        return vital.moisture ?? null;
      case 'gait':
        return vital.gaitAnalysis && vital.gaitAnalysis !== 'N/A' ? 1 : null;
    }
  }

  private averageValues(
    values: number[],
    metric: QueryTimelineVitalsDto['metric'],
  ) {
    if (values.length === 0) {
      return null;
    }

    if (metric === 'gait') {
      return values.reduce((sum, value) => sum + value, 0);
    }

    const total = values.reduce((sum, value) => sum + value, 0);
    return Number((total / values.length).toFixed(2));
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
    period: 'day' | 'week' | 'month',
    date: string,
    month?: string,
  ) {
    if (period === 'month') {
      const monthValue = month ?? date.slice(0, 7);
      const [year, monthNumber] = monthValue.split('-').map(Number);
      const start = new Date(Date.UTC(year, monthNumber - 1, 1));
      const end = new Date(Date.UTC(year, monthNumber, 0, 23, 59, 59, 999));
      return { start, end };
    }

    const anchor = new Date(`${date}T00:00:00.000Z`);
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
