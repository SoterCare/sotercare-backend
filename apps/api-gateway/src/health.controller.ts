import {
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
  Get,
  Headers,
  Inject,
  Logger,
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
import { Observable, lastValueFrom, timeout } from 'rxjs';
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

  @ApiPropertyOptional()
  heartRate?: number;

  @ApiPropertyOptional()
  spo2?: number;

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

  @ApiProperty({ required: false })
  heartRate?: number;

  @ApiProperty({ required: false })
  heart_rate?: number;

  @ApiProperty({ required: false })
  spo2?: number;
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

// Deadlines so a stalled health-service can't hang device syncs or mobile reads.
const SYNC_GRPC_TIMEOUT_MS = 10000;
const READ_GRPC_TIMEOUT_MS = 15000;

@ApiTags('health')
@Controller('logs')
@UseInterceptors(IdempotencyInterceptor)
export class HealthController implements OnModuleInit {
  private healthService: HealthService;
  private readonly logger = new Logger(HealthController.name);
  private readonly maxClockSkewMs = Number(
    process.env.IOT_MAX_CLOCK_SKEW_MS || 15 * 60 * 1000,
  );

  // Shared normalization (M1): accept unix seconds OR milliseconds and always
  // return epoch-ms. Previously this path did NOT upconvert seconds, so a device
  // sending second-precision timestamps was always rejected by replay protection.
  private toUnixMs(value: number | string | undefined): number {
    if (value === undefined || value === null) {
      return Date.now();
    }

    if (typeof value === 'number' && Number.isFinite(value)) {
      return value < 1_000_000_000_000 ? value * 1000 : value;
    }

    const numeric = Number(value);
    if (!Number.isNaN(numeric) && Number.isFinite(numeric)) {
      return numeric < 1_000_000_000_000 ? numeric * 1000 : numeric;
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
      // C1: forward heart_rate / spo2 so they reach vital_sign.
      heart_rate: log.data.heartRate,
      spo2: log.data.spo2,
      timestamp: log.data.timestamp,
    }));


    return lastValueFrom(
      this.healthService
        .syncLogs({ user_id: userId, logs: grpcLogs })
        .pipe(timeout(SYNC_GRPC_TIMEOUT_MS)),
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
    // H1: fail closed. A missing RASPBERRY_API_KEY must disable the endpoint, not
    // silently bypass the gateway-level key check.
    const expectedKey = process.env.RASPBERRY_API_KEY;
    if (!expectedKey) {
      throw new ForbiddenException(
        'Raspberry sync disabled: RASPBERRY_API_KEY is not configured',
      );
    }
    if (raspberryKey !== expectedKey) {
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
        // C1: persist heart_rate / spo2. C2: tag every reading with the resolved
        // physical device so the Safety Guard can attribute alerts correctly.
        heart_rate: log.heartRate ?? log.heart_rate,
        spo2: log.spo2,
        device_id: deviceId,
        timestamp: ts,
      };
    });

    // The gRPC persist and the dashboard snapshot upsert are independent —
    // run them in parallel instead of serially extending the device's wait.
    const [result] = await Promise.all([
      lastValueFrom(
        this.healthService
          .syncLogs({ user_id: ownerId, logs: grpcLogs })
          .pipe(timeout(SYNC_GRPC_TIMEOUT_MS)),
      ),
      this.vitalSyncService.upsertLatestVital(deviceId, body.logs),
    ]);

    // Emit a summary, not the full batch: a 1k-log backlog would otherwise be
    // ~250KB stringified per connected socket on the event loop.
    const latest = grpcLogs[grpcLogs.length - 1] ?? null;
    this.realtimeGateway.emitToUser(ownerId, 'device.logs.ingested', {
      device_id: deviceId,
      count: grpcLogs.length,
      latest,
      time_range:
        grpcLogs.length > 0
          ? { from: grpcLogs[0].timestamp, to: latest!.timestamp }
          : null,
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
    this.logger.debug(`Fetching log dates for user ${userId}`);
    return lastValueFrom(
      this.healthService
        .getLogDates({ user_id: userId })
        .pipe(timeout(READ_GRPC_TIMEOUT_MS)),
    );
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
      this.healthService
        .getLogsByDateRange({
          user_id: userId,
          start_date: startDate,
          end_date: endDate,
        })
        .pipe(timeout(READ_GRPC_TIMEOUT_MS)),
    );
  }
}
