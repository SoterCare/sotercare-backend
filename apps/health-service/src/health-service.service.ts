import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { VitalSign } from './vital-sign.entity';

@Injectable()
export class HealthServiceService {
  constructor(
    @InjectRepository(VitalSign)
    private vitalSignRepository: Repository<VitalSign>,
  ) { }

  async syncLogs(userId: number, logs: any[]): Promise<{ success: boolean; message: string; syncedCount: number }> {
    if (!logs || logs.length === 0) {
      return { success: true, message: 'No logs to sync', syncedCount: 0 };
    }

    const entities = logs.map(log => {
      const entity = new VitalSign();
      entity.userId = userId;
      entity.temperature = log.temperature ?? log.temp ?? 0;
      entity.ambientTemp = log.ambientTemp ?? log.ambient_temp ?? null;
      entity.moisture = log.moisture ?? null;
      entity.sos = log.sos ?? null;
      entity.fallAlert = log.fallAlert ?? log.fall_alert ?? null;
      entity.gaitLabel = log.gaitLabel ?? log.gait_label ?? null;
      entity.thighnodeStatus = log.thighnodeStatus ?? log.thighnode_status ?? null;
      entity.timestamp = (log.timestamp ?? log.ts ?? Date.now()).toString();

      return entity;
    });

    await this.vitalSignRepository.save(entities);

    return {
      success: true,
      message: 'Logs synced successfully',
      syncedCount: entities.length,
    };
  }

  async getLogDates(userId: number): Promise<string[]> {
    // Query distinct timestamps, convert to date string, and filter
    const rawData = await this.vitalSignRepository
      .createQueryBuilder('vital')
      .select('vital.timestamp', 'timestamp')
      .where('vital.userId = :userId', { userId })
      .orderBy('vital.timestamp', 'DESC')
      .getRawMany();

    // Set to store unique dates (YYYY-MM-DD)
    const dates = new Set<string>();

    rawData.forEach(row => {
      // Timestamp is stored as BigInt string or string, convert to number/Date
      // If timestamp is purely numeric string
      const ts = Number(row.timestamp);
      if (!isNaN(ts)) {
        const date = new Date(ts).toISOString().split('T')[0];
        dates.add(date);
      }
    });

    return Array.from(dates);
  }

  async getLogsByDateRange(userId: number, startDate: string, endDate: string): Promise<VitalSign[]> {
    const start = new Date(startDate).getTime();
    const end = new Date(endDate).getTime();

    // Guard against invalid dates: getTime() returns NaN for unparseable input,
    // which would otherwise bind NaN into the query and silently return wrong rows.
    if (Number.isNaN(start) || Number.isNaN(end)) {
      throw new Error('Invalid startDate or endDate');
    }

    return this.vitalSignRepository
      .createQueryBuilder('vital')
      // timestamp is a bigint stored as string — bind epoch-ms as strings so the
      // comparison stays numeric/consistent with the stored representation.
      .where('vital.userId = :userId', { userId })
      .andWhere('vital.timestamp >= :startDate', { startDate: start.toString() })
      .andWhere('vital.timestamp <= :endDate', { endDate: end.toString() })
      .orderBy('vital.timestamp', 'ASC')
      .getMany();
  }
}
