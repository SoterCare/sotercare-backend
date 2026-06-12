import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Inject,
  OnModuleInit,
  Post,
  UseInterceptors,
  UseGuards,
  Req,
} from '@nestjs/common';
import type { ClientGrpc } from '@nestjs/microservices';
import { Observable, lastValueFrom, timeout } from 'rxjs';
import {
  ApiTags,
  ApiOperation,
  ApiBody,
  ApiProperty,
  ApiBearerAuth,
} from '@nestjs/swagger';
import { IdempotencyInterceptor } from './common/interceptors/idempotency.interceptor';
import { JwtAuthGuard } from './common/guards/jwt-auth.guard';
import { DevicesService } from './devices/devices.service';

class MetricsDto {
  @ApiProperty()
  temperature: boolean;
  @ApiProperty()
  ambientTemp: boolean;
  @ApiProperty()
  moisture: boolean;
}

class ExportReportDto {
  @ApiProperty({ example: 'Device 01' })
  device: string;

  @ApiProperty({ example: '2026-01-22T00:00:00.000Z' })
  startDate: string;

  @ApiProperty({ example: '2026-01-25T00:00:00.000Z' })
  endDate: string;

  @ApiProperty({ example: false })
  isSingleDate: boolean;

  @ApiProperty({ type: MetricsDto })
  metrics: MetricsDto;

  @ApiProperty({ example: 'PDF' })
  format: string;

  @ApiProperty({ example: true })
  includeActivity: boolean;
}

interface HealthService {
  getLogsByDateRange(data: {
    user_id: number;
    start_date: string;
    end_date: string;
  }): Observable<any>;
}

// Cap how long we'll wait on the health-service, and how wide a range a report
// may cover — an unbounded range fetches an unbounded number of log rows.
const HEALTH_GRPC_TIMEOUT_MS = 15000;
const MAX_REPORT_RANGE_DAYS = 92;

@ApiTags('reports')
@ApiBearerAuth()
@Controller('reports')
@UseGuards(JwtAuthGuard)
@UseInterceptors(IdempotencyInterceptor)
export class ReportsController implements OnModuleInit {
  private healthService: HealthService;

  constructor(
    @Inject('HEALTH_SERVICE') private healthClient: ClientGrpc,
    private readonly devicesService: DevicesService,
  ) {}

  onModuleInit() {
    this.healthService =
      this.healthClient.getService<HealthService>('HealthService');
  }

  @Post('export')
  @ApiOperation({ summary: 'Get report data (logs) for a date range' })
  @ApiBody({ type: ExportReportDto })
  async exportReport(@Body() body: ExportReportDto, @Req() req: any) {
    const userId = req.user.userId;

    const start = new Date(body.startDate).getTime();
    const end = new Date(body.endDate).getTime();
    if (Number.isNaN(start) || Number.isNaN(end) || end < start) {
      throw new BadRequestException('Invalid startDate/endDate');
    }
    const rangeDays = (end - start) / (24 * 60 * 60 * 1000);
    if (rangeDays > MAX_REPORT_RANGE_DAYS) {
      throw new BadRequestException(
        `Date range too large — maximum is ${MAX_REPORT_RANGE_DAYS} days`,
      );
    }

    const logsResponse = await lastValueFrom(
      this.healthService
        .getLogsByDateRange({
          user_id: userId,
          start_date: body.startDate,
          end_date: body.endDate,
        })
        .pipe(timeout(HEALTH_GRPC_TIMEOUT_MS)),
    );

    const logs = logsResponse.logs || [];

    return {
      meta: {
        startDate: body.startDate,
        endDate: body.endDate,
        device: body.device,
        metrics: body.metrics,
        format: body.format,
        dataPointsAnalyzed: logs.length,
        generatedAt: new Date().toISOString(),
      },
      report: null,
      recommendations: null,
      logs,
    };
  }

  @Get('devices')
  @ApiOperation({ summary: 'Get minimal device list for report dropdowns' })
  async getReportDevices(@Req() req: any) {
    return {
      success: true,
      data: await this.devicesService.getDevices(req.user.userId, false, true),
    };
  }
}
