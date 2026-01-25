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
}
