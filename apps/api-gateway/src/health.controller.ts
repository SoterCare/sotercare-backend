import {
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
  Get,
  Headers,
  Inject,
  OnModuleInit,
  Post,
  Query,
  Req,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import type { ClientGrpc } from '@nestjs/microservices';
import {
  ApiTags,
  ApiOperation,
  ApiBody,
  ApiProperty,
  ApiPropertyOptional,
  ApiBearerAuth,
  ApiQuery,
} from '@nestjs/swagger';
import { Observable, lastValueFrom } from 'rxjs';
import { IdempotencyInterceptor } from './common/interceptors/idempotency.interceptor';
import { JwtAuthGuard } from './common/guards/jwt-auth.guard';
import { IotDeviceService } from './iot-device/iot-device.service';
import { RealtimeGateway } from './realtime/realtime.gateway';
import { VitalSyncService } from './realtime/vital-sync.service';

type AuthenticatedRequest = {
  user: {
    userId: number;
  };
};

class VitalDataDto {
  @ApiPropertyOptional()
  temperature?: number;

  @ApiPropertyOptional()
  ambientTemp?: number;

  @ApiPropertyOptional()
  moisture?: number;

  @ApiPropertyOptional()
  gaitLabel?: string;

  @ApiPropertyOptional()
  sos?: boolean;

  @ApiPropertyOptional()
  fallAlert?: boolean;

  @ApiPropertyOptional()
  thighnodeStatus?: string;

  @ApiProperty()
  timestamp: number | string;
}

class LogEntryDto {
  @ApiProperty()
  id: number;

  @ApiProperty()
  data: VitalDataDto;

  @ApiProperty()
  timestamp: string;
}

class SyncLogsDto {
  @ApiProperty({ type: [LogEntryDto] })
  logs: LogEntryDto[];
}

class RaspberryLogDto {
  @ApiProperty({ required: false })
  id?: number;

  @ApiProperty({ required: false })
  temperature?: number;

  @ApiProperty({ required: false })
  temp?: number;

  @ApiProperty({ required: false })
  timestamp?: number | string;

  @ApiProperty({ required: false })
  ts?: number | string;

  @ApiProperty({ required: false })
  unix_timestamp?: number | string;

  @ApiProperty({ required: false })
  unix_times?: number | string;

  @ApiProperty({ required: false })
  ambientTemp?: number;

  @ApiProperty({ required: false })
  ambient_temp?: number;

  @ApiProperty({ required: false })
  moisture?: number;

  @ApiProperty({ required: false })
  sos?: boolean;

  @ApiProperty({ required: false })
  sos_trigger?: boolean;

  @ApiProperty({ required: false })
  fallAlert?: boolean;

  @ApiProperty({ required: false })
  fall_alert?: boolean;

  @ApiProperty({ required: false })
  gaitLabel?: string;

  @ApiProperty({ required: false })
  gait_label?: string;

  @ApiProperty({ required: false })
  thighnodeStatus?: string;

  @ApiProperty({ required: false })
  thighnode_status?: string;
}

class RaspberrySyncDto {
  @ApiProperty()
  device_id: string;

  @ApiProperty({ type: [RaspberryLogDto] })
  logs: RaspberryLogDto[];
}

interface HealthService {
  syncLogs(data: unknown): Observable<unknown>;
  getLogDates(data: unknown): Observable<unknown>;
  getLogsByDateRange(data: unknown): Observable<unknown>;
}

@ApiTags('health')
@Controller('logs')
@UseInterceptors(IdempotencyInterceptor)
export class HealthController implements OnModuleInit {
  private healthService: HealthService;
  private readonly maxClockSkewMs = Number(
    process.env.IOT_MAX_CLOCK_SKEW_MS || 15 * 60 * 1000,
  );

  private toUnixMs(value: number | string | undefined): number {
    if (value === undefined || value === null) {
      return Date.now();
    }

    if (typeof value === 'number' && Number.isFinite(value)) {
      return value;
    }

    const numeric = Number(value);
    if (!Number.isNaN(numeric) && Number.isFinite(numeric)) {
      return numeric;
    }

    const parsed = Date.parse(String(value));
    return Number.isNaN(parsed) ? Date.now() : parsed;
  }

  constructor(
    @Inject('HEALTH_SERVICE') private client: ClientGrpc,
    private readonly iotDeviceService: IotDeviceService,
    private readonly realtimeGateway: RealtimeGateway,
    private readonly vitalSyncService: VitalSyncService,
  ) {}

  onModuleInit() {
    this.healthService = this.client.getService<HealthService>('HealthService');
  }

  @Post('sync')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Sync vital sign logs' })
  @ApiBody({ type: SyncLogsDto })
  async syncLogs(@Body() body: SyncLogsDto, @Req() req: AuthenticatedRequest) {
    const userId = req.user.userId;

    const grpcLogs = body.logs.map((log) => ({
      id: log.id,
      temperature: log.data.temperature,
      ambient_temp: log.data.ambientTemp,
      moisture: log.data.moisture,
      gait_label: log.data.gaitLabel,
      sos: log.data.sos,
      fall_alert: log.data.fallAlert,
      thighnode_status: log.data.thighnodeStatus,
      timestamp: log.data.timestamp,
    }));

    console.log(
      `[HealthController] Syncing ${grpcLogs.length} logs for user ${userId}`,
    );

    return lastValueFrom(
      this.healthService.syncLogs({ user_id: userId, logs: grpcLogs }),
    );
  }

  @Post('raspberry/sync')
  @ApiOperation({
    summary: 'Raspberry Pi direct sync endpoint (backend managed)',
  })
  @ApiBody({ type: RaspberrySyncDto })
  async syncRaspberryLogs(
    @Body() body: RaspberrySyncDto,
    @Headers('x-raspberry-key') raspberryKey?: string,
    @Headers('x-device-key') deviceKeyHeader?: string,
  ) {
    const expectedKey = process.env.RASPBERRY_API_KEY;
    if (expectedKey && raspberryKey !== expectedKey) {
      throw new ForbiddenException('Invalid Raspberry API key');
    }

    if (!body?.device_id || !Array.isArray(body.logs)) {
      throw new BadRequestException('device_id and logs are required');
    }

    // Use a dedicated per-device key when gateway-level key is enabled.
    const headerKey = String(
      deviceKeyHeader || (expectedKey ? '' : raspberryKey || ''),
    );
    if (!headerKey) {
      throw new ForbiddenException('Device key is required');
    }

    const { ownerId, deviceId } =
      await this.iotDeviceService.authenticateAndResolveOwner(
        body.device_id,
        headerKey,
      );

    const now = Date.now();
    const grpcLogs = body.logs.map((log, index) => {
      const ts = this.toUnixMs(log.timestamp ?? log.ts);
      if (Math.abs(now - ts) > this.maxClockSkewMs) {
        throw new BadRequestException(
          'Log timestamp rejected (replay protection)',
        );
      }

      return {
        id: Number(log.id ?? index + 1),
        temperature: Number(log.temperature ?? log.temp ?? 0),
        ambient_temp: log.ambientTemp ?? log.ambient_temp,
        moisture: log.moisture,
        gait_label: log.gaitLabel ?? log.gait_label ?? '',
        sos: Boolean(log.sos ?? log.sos_trigger ?? false),
        fall_alert: Boolean(log.fallAlert ?? log.fall_alert ?? false),
        thighnode_status: log.thighnodeStatus ?? log.thighnode_status ?? '',
        timestamp: ts,
      };
    });

    const result = await lastValueFrom(
      this.healthService.syncLogs({ user_id: ownerId, logs: grpcLogs }),
    );

    // Upsert latest vital snapshot to the dashboard vitals table
    await this.vitalSyncService.upsertLatestVital(deviceId, body.logs);

    this.realtimeGateway.emitToUser(ownerId, 'device.logs.ingested', {
      device_id: deviceId,
      count: grpcLogs.length,
      logs: grpcLogs,
      ingested_at: new Date().toISOString(),
    });

    return result;
  }

  @Get('dates')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Get dates with available logs' })
  async getLogDates(@Req() req: AuthenticatedRequest) {
    const userId = req.user.userId;
    console.log(`[HealthController] Fetching log dates for user ${userId}`);
    return lastValueFrom(this.healthService.getLogDates({ user_id: userId }));
  }

  @Get('range')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Get logs by date range (mobile read API)' })
  @ApiQuery({
    name: 'startDate',
    required: true,
    description: 'ISO 8601 start date',
  })
  @ApiQuery({
    name: 'endDate',
    required: true,
    description: 'ISO 8601 end date',
  })
  async getLogsByDateRange(
    @Req() req: AuthenticatedRequest,
    @Query('startDate') startDate: string,
    @Query('endDate') endDate: string,
  ) {
    if (!startDate || !endDate) {
      throw new BadRequestException('startDate and endDate are required');
    }

    const userId = req.user.userId;
    return lastValueFrom(
      this.healthService.getLogsByDateRange({
        user_id: userId,
        start_date: startDate,
        end_date: endDate,
      }),
    );
  }
}
