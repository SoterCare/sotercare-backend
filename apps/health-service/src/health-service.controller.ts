import { Controller, Logger } from '@nestjs/common';
import { GrpcMethod } from '@nestjs/microservices';
import { HealthServiceService, VitalLogInput } from './health-service.service';

interface UserRequest {
  user_id?: number;
  userId?: number;
}

interface SyncLogsRequest extends UserRequest {
  logs?: VitalLogInput[];
}

interface LogsByDateRangeRequest {
  user_id: number;
  start_date: string;
  end_date: string;
}

@Controller()
export class HealthServiceController {
  private readonly logger = new Logger(HealthServiceController.name);

  constructor(private readonly healthService: HealthServiceService) {}

  @GrpcMethod('HealthService', 'SyncLogs')
  async syncLogs(data: SyncLogsRequest) {
    // Map snake_case (from proto with keepCase: true) or camelCase accordingly
    const userId = (data.user_id || data.userId) as number;
    const logs = data.logs || [];

    return this.healthService.syncLogs(userId, logs);
  }

  @GrpcMethod('HealthService', 'GetLogDates')
  async getLogDates(data: UserRequest) {
    const userId = (data.user_id || data.userId) as number;
    this.logger.debug(`Fetching log dates for user ${userId}`);
    const dates = await this.healthService.getLogDates(userId);
    return { dates };
  }

  @GrpcMethod('HealthService', 'GetLogsByDateRange')
  async getLogsByDateRange(data: LogsByDateRangeRequest) {
    const userId = data.user_id;
    const { start_date, end_date } = data;
    this.logger.debug(
      `Fetching logs for user ${userId} from ${start_date} to ${end_date}`,
    );
    const logs = await this.healthService.getLogsByDateRange(
      userId,
      start_date,
      end_date,
    );
    return { logs };
  }
}
