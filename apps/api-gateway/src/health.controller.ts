import { Controller, Post, Body, Inject, OnModuleInit, UseInterceptors, UseGuards, Req } from '@nestjs/common';
import type { ClientGrpc } from '@nestjs/microservices';
import { ApiTags, ApiOperation, ApiBody, ApiProperty, ApiBearerAuth } from '@nestjs/swagger';
import { Observable, lastValueFrom } from 'rxjs';
import { IdempotencyInterceptor } from './common/interceptors/idempotency.interceptor';

class VitalDataDto {
    @ApiProperty()
    heartRate: number;
    @ApiProperty()
    spo2: number;
    @ApiProperty()
    temperature: number;
    @ApiProperty()
    timestamp: number;
}

class LogEntryDto {
    @ApiProperty()
    id: number;

    @ApiProperty()
    data: VitalDataDto;

    @ApiProperty()
    timestamp: string; // ISO String from the outer object
}

class SyncLogsDto {
    @ApiProperty({ type: [LogEntryDto] })
    logs: LogEntryDto[];
}

interface HealthService {
    syncLogs(data: { userId: number; logs: any[] }): Observable<any>;
}

@ApiTags('health')
@Controller('logs')
@UseInterceptors(IdempotencyInterceptor)
export class HealthController implements OnModuleInit {
    private healthService: HealthService;

    constructor(@Inject('HEALTH_SERVICE') private client: ClientGrpc) { }

    onModuleInit() {
        this.healthService = this.client.getService<HealthService>('HealthService');
    }

    @Post('sync')
    @ApiOperation({ summary: 'Sync vital sign logs' })
    @ApiBody({ type: SyncLogsDto })
    async syncLogs(@Body() body: SyncLogsDto) {
        // Mock userId for now
        const userId = 1;

        // Map incoming REST payload (with 'data' wrapper) to Flat gRPC Message
        const grpcLogs = body.logs.map(log => ({
            id: log.id,
            heartRate: log.data.heartRate,
            spo2: log.data.spo2,
            temperature: log.data.temperature,
            // Use the timestamp from 'data' (measurement time)
            timestamp: log.data.timestamp
        }));

        console.log(`[HealthController] Syncing ${grpcLogs.length} logs for user ${userId}`);

        return lastValueFrom(this.healthService.syncLogs({ userId, logs: grpcLogs }));
    }
}
