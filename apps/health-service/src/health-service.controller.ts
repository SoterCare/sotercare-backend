import { Controller } from '@nestjs/common';
import { GrpcMethod } from '@nestjs/microservices';
import { HealthServiceService } from './health-service.service';

@Controller()
export class HealthServiceController {
  constructor(private readonly healthService: HealthServiceService) { }

  @GrpcMethod('HealthService', 'SyncLogs')
  async syncLogs(data: any) {


    // Map snake_case (from proto with keepCase: true) or camelCase accordingly
    const userId = data.user_id || data.userId;
    const logs = data.logs || [];

    console.log(`[HealthService] Syncing ${logs?.length} logs for user ${userId}`);
    return this.healthService.syncLogs(userId, logs);
  }

  @GrpcMethod('HealthService', 'GetLogDates')
  async getLogDates(data: any) {
    const userId = data.user_id || data.userId;
    console.log(`[HealthService] Fetching log dates for user ${userId}`);
    const dates = await this.healthService.getLogDates(userId);
    return { dates };
  }
}
