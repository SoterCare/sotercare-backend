import { Controller, Post, Body, Inject, OnModuleInit, UseInterceptors, UseGuards, Req } from '@nestjs/common';
import type { ClientGrpc } from '@nestjs/microservices';
import { ApiTags, ApiOperation, ApiBody, ApiProperty, ApiBearerAuth } from '@nestjs/swagger';
import { Observable, lastValueFrom } from 'rxjs';
import { IdempotencyInterceptor } from './common/interceptors/idempotency.interceptor';

class LogEntryDto {
    @ApiProperty()
    id: number;
    @ApiProperty()
    heartRate: number;
    @ApiProperty()
    spo2: number;
    @ApiProperty()
    temperature: number;
    @ApiProperty()
    timestamp: number;
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
        // In a real app, extract userId from JWT @Req()
        // For now, using a mock userId of 1 or getting it from body if auth is not ready
        const userId = 1;

        return lastValueFrom(this.healthService.syncLogs({ userId, logs: body.logs }));
    }
}
