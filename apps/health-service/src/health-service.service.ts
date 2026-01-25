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
      // Handle potential snake_case from gRPC (keepCase: true)
      entity.heartRate = log.heartRate ?? log.heart_rate;
      entity.spo2 = log.spo2 ?? log.spo2; // spo2 is distinct enough, but checked
      entity.temperature = log.temperature ?? log.temperature;
      entity.timestamp = log.timestamp ? log.timestamp.toString() : Date.now().toString();

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
    return this.vitalSignRepository
      .createQueryBuilder('vital')
      .where('vital.userId = :userId', { userId })
      .andWhere('vital.timestamp >= :startDate', { startDate: new Date(startDate).getTime() })
      .andWhere('vital.timestamp <= :endDate', { endDate: new Date(endDate).getTime() })
      .orderBy('vital.timestamp', 'ASC')
      .getMany();
  }
}
