import { Body, Controller, Inject, OnModuleInit, Post, UseInterceptors } from '@nestjs/common';
import type { ClientGrpc } from '@nestjs/microservices';
import { Observable, lastValueFrom } from 'rxjs';
import { ApiTags, ApiOperation, ApiBody, ApiProperty } from '@nestjs/swagger';
import { IdempotencyInterceptor } from './common/interceptors/idempotency.interceptor';

class SummarizeDto {
    @ApiProperty({ example: 'Long text to summarize...' })
    text: string;
}

interface SummaryService {
    summarizeText(data: { text: string }): Observable<{ summary: string }>;
}

@ApiTags('summary')
@Controller('summary')
@UseInterceptors(IdempotencyInterceptor)
export class SummaryController implements OnModuleInit {
    private summaryService: SummaryService;

    constructor(@Inject('SUMMARY_SERVICE') private client: ClientGrpc) { }

    onModuleInit() {
        this.summaryService = this.client.getService<SummaryService>('SummaryService');
    }

    @Post()
    @ApiOperation({ summary: 'Summarize text using Python AI Service' })
    @ApiBody({ type: SummarizeDto })
    async summarize(@Body() body: SummarizeDto) {
        return lastValueFrom(this.summaryService.summarizeText(body));
    }
}
