import { Body, Controller, Get, Inject, OnModuleInit, Post, UseInterceptors, UseGuards, Req } from '@nestjs/common';
import type { ClientGrpc } from '@nestjs/microservices';
import { Observable, lastValueFrom } from 'rxjs';
import { ApiTags, ApiOperation, ApiBody, ApiProperty, ApiBearerAuth } from '@nestjs/swagger';
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
    getLogsByDateRange(data: { user_id: number; start_date: string; end_date: string }): Observable<any>;
}

interface SummaryService {
    analyzeData(data: { data_json: string; format: string }): Observable<any>;
}

@ApiTags('reports')
@ApiBearerAuth()
@Controller('reports')
@UseGuards(JwtAuthGuard)
@UseInterceptors(IdempotencyInterceptor)
export class ReportsController implements OnModuleInit {
    private healthService: HealthService;
    private summaryService: SummaryService;

    constructor(
        @Inject('HEALTH_SERVICE') private healthClient: ClientGrpc,
        @Inject('SUMMARY_SERVICE') private summaryClient: ClientGrpc,
        private readonly devicesService: DevicesService,
    ) { }

    onModuleInit() {
        this.healthService = this.healthClient.getService<HealthService>('HealthService');
        this.summaryService = this.summaryClient.getService<SummaryService>('SummaryService');
    }

    @Post('export')
    @ApiOperation({ summary: 'Get report data (Logs + AI Analysis) in JSON format' })
    @ApiBody({ type: ExportReportDto })
    async exportReport(@Body() body: ExportReportDto, @Req() req: any) {
        const userId = req.user.userId;
        console.log(`[ReportsController] Exporting data for user ${userId} (${body.startDate} - ${body.endDate})`);

        // 1. Fetch Logs
        const logsResponse = await lastValueFrom(this.healthService.getLogsByDateRange({
            user_id: userId,
            start_date: body.startDate,
            end_date: body.endDate
        }));

        const logs = logsResponse.logs || [];
        console.log(`[ReportsController] Fetched ${logs.length} logs`);

        // 2. AI Analysis (Optional: Only if logs exist)
        let aiAnalysis = { summary: 'No data to analyze', recommendations: '' };

        if (logs.length > 0) {
            try {
                // Convert entity objects to plain data for serialization
                const plainLogs = logs.map(log => ({
                    temperature: log.temperature,
                    ambientTemp: log.ambient_temp ?? log.ambientTemp,
                    moisture: log.moisture,
                    gaitLabel: log.gait_label ?? log.gaitLabel,
                    sos: log.sos,
                    fallAlert: log.fall_alert ?? log.fallAlert,
                    timestamp: log.timestamp
                }));

                console.log(`[ReportsController] Sending ${plainLogs.length} logs to AI (${JSON.stringify(plainLogs[0])})`);
                const aiResponse = await lastValueFrom(this.summaryService.analyzeData({
                    data_json: JSON.stringify(plainLogs),
                    format: 'text' // Request text summary
                }));
                aiAnalysis = aiResponse;
            } catch (e) {
                console.error('AI Analysis failed:', e);
                aiAnalysis = { summary: 'AI Analysis unavailable', recommendations: '' };
            }
        }

        // 3. Construct Response (Report only, no raw data)
        return {
            meta: {
                startDate: body.startDate,
                endDate: body.endDate,
                device: body.device,
                metrics: body.metrics,
                format: body.format,
                dataPointsAnalyzed: logs.length,
                generatedAt: new Date().toISOString()
            },
            report: aiAnalysis.summary,
            recommendations: aiAnalysis.recommendations
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
