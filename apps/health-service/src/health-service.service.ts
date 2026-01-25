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
      entity.heartRate = log.heartRate;
      entity.spo2 = log.spo2;
      entity.temperature = log.temperature;
      entity.timestamp = log.timestamp ? log.timestamp.toString() : Date.now().toString();
      console.log(`[HealthService] Processing Log: User=${userId}, TS=${entity.timestamp}, HR=${entity.heartRate}`);
      return entity;
    });

    await this.vitalSignRepository.save(entities);

    return {
      success: true,
      message: 'Logs synced successfully',
      syncedCount: entities.length,
    };
  }
}
