import { Controller } from '@nestjs/common';
import { GrpcMethod } from '@nestjs/microservices';
import { HealthServiceService } from './health-service.service';

@Controller()
export class HealthServiceController {
  constructor(private readonly healthService: HealthServiceService) { }

  @GrpcMethod('HealthService', 'SyncLogs')
  async syncLogs(data: { userId: number; logs: any[] }) {
    console.log(`[HealthService] Syncing ${data.logs?.length} logs for user ${data.userId}`);
    return this.healthService.syncLogs(data.userId, data.logs);
  }
}
