import { Controller, Logger } from '@nestjs/common';
import { GrpcMethod } from '@nestjs/microservices';
import { HealthServiceService } from './health-service.service';

@Controller()
export class HealthServiceController {
  private readonly logger = new Logger(HealthServiceController.name);

  constructor(private readonly healthService: HealthServiceService) { }

  @GrpcMethod('HealthService', 'SyncLogs')
  async syncLogs(data: any) {
    // Map snake_case (from proto with keepCase: true) or camelCase accordingly
    const userId = data.user_id || data.userId;
    const logs = data.logs || [];

    // PII (userId) — keep at debug level rather than always-on stdout.
    this.logger.debug(`Syncing ${logs.length} logs for user ${userId}`);
    return this.healthService.syncLogs(userId, logs);
  }

  @GrpcMethod('HealthService', 'GetLogDates')
  async getLogDates(data: any) {
    const userId = data.user_id || data.userId;
    this.logger.debug(`Fetching log dates for user ${userId}`);
    const dates = await this.healthService.getLogDates(userId);
    return { dates };
  }

  @GrpcMethod('HealthService', 'GetLogsByDateRange')
  async getLogsByDateRange(data: any) {
    const userId = data.user_id;
    const { start_date, end_date } = data;
    this.logger.debug(`Fetching logs for user ${userId} from ${start_date} to ${end_date}`);
    const logs = await this.healthService.getLogsByDateRange(userId, start_date, end_date);
    return { logs };
  }
}
