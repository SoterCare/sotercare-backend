import { Body, Controller, Get, Inject, OnModuleInit, Post, UseInterceptors, UseGuards, UploadedFile, Req } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import type { ClientGrpc } from '@nestjs/microservices';
import { Observable, lastValueFrom } from 'rxjs';
import { ApiTags, ApiOperation, ApiBody, ApiProperty, ApiBearerAuth } from '@nestjs/swagger';
import { IdempotencyInterceptor } from './common/interceptors/idempotency.interceptor';
import { JwtAuthGuard } from './common/guards/jwt-auth.guard';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { SummaryHistory } from './database/entities';

class SummarizeDto {
    @ApiProperty({ example: 'Long text to summarize...' })
    text: string;
}

class UploadPrescriptionDto {
    @ApiProperty({ type: 'string', format: 'binary' })
    file: any;

    @ApiProperty({ example: '1' })
    user_id: string;
}

class QueryPrescriptionDto {
    @ApiProperty({ example: '1' })
    user_id: string;

    @ApiProperty({ example: 'What medications are prescribed?' })
    question: string;
}

interface SummaryService {
    summarizeText(data: { text: string }): Observable<{ summary: string }>;
    uploadPrescription(data: { userId: number; fileData: Buffer; fileName: string }): Observable<{ success: boolean; message: string }>;
    queryPrescription(data: { userId: number; question: string }): Observable<{ success: boolean; answer: string }>;
    analyzeData(data: { data_json: string; format: string }): Observable<{ summary: string; recommendations: string }>;
}

interface HealthService {
    getLogsByDateRange(data: { user_id: number; start_date: string; end_date: string }): Observable<any>;
}

type UploadedPrescriptionFile = {
    buffer: Buffer;
    originalname: string;
};

@ApiTags('summary')
@ApiBearerAuth()
@Controller('summary')
@UseGuards(JwtAuthGuard)
@UseInterceptors(IdempotencyInterceptor)
export class SummaryController implements OnModuleInit {
    private summaryService: SummaryService;
    private healthService: HealthService;

    constructor(
        @Inject('SUMMARY_SERVICE') private summaryClient: ClientGrpc,
        @Inject('HEALTH_SERVICE') private healthClient: ClientGrpc,
        @InjectRepository(SummaryHistory) private summaryHistoryRepo: Repository<SummaryHistory>,
    ) { }

    onModuleInit() {
        this.summaryService = this.summaryClient.getService<SummaryService>('SummaryService');
        this.healthService = this.healthClient.getService<HealthService>('HealthService');
    }

    @Post()
    @ApiOperation({ summary: 'Generate or retrieve daily summary of vitals using AI' })
    async getDailySummary(@Req() req: any) {
        const userId = req.user.userId;

        // Check if we already generated a summary today
        const startOfDay = new Date();
        startOfDay.setHours(0, 0, 0, 0);

        const existingSummary = await this.summaryHistoryRepo
            .createQueryBuilder('summary')
            .where('summary.userId = :userId', { userId })
            .andWhere('summary.createdAt >= :startOfDay', { startOfDay })
            .orderBy('summary.createdAt', 'DESC')
            .getOne();

        if (existingSummary) {
            return {
                success: true,
                message: "Retrieved already generated summary for today.",
                data: existingSummary
            };
        }

        // Fetch today's logs
        const endOfDay = new Date();
        endOfDay.setHours(23, 59, 59, 999);

        const logsResponse = await lastValueFrom(this.healthService.getLogsByDateRange({
            user_id: userId,
            start_date: startOfDay.toISOString(),
            end_date: endOfDay.toISOString()
        }));

        const logs = logsResponse.logs || [];

        if (logs.length === 0) {
            return {
                success: false,
                message: 'No vital sign data available for today to summarize.'
            };
        }

        // Clean logs for AI
        const plainLogs = logs.map(log => ({
            temperature: log.temperature,
            ambientTemp: log.ambient_temp ?? log.ambientTemp,
            moisture: log.moisture,
            gaitLabel: log.gait_label ?? log.gaitLabel,
            sos: log.sos,
            fallAlert: log.fall_alert ?? log.fallAlert,
            timestamp: log.timestamp
        }));

        // Generate AI Analysis
        let aiAnalysis;
        try {
            aiAnalysis = await lastValueFrom(this.summaryService.analyzeData({
                data_json: JSON.stringify(plainLogs),
                format: 'markdown'
            }));
        } catch (e) {
            console.error('AI Analysis failed:', e);
            return { success: false, message: 'AI Analysis failed to generate' };
        }

        // Save to History
        const newSummary = this.summaryHistoryRepo.create({
            userId,
            summary: aiAnalysis.summary,
            recommendations: aiAnalysis.recommendations
        });
        
        await this.summaryHistoryRepo.save(newSummary);

        return {
            success: true,
            data: newSummary
        };
    }

    @Get('history')
    @ApiOperation({ summary: 'Get history of generated daily summaries' })
    async getSummaryHistory(@Req() req: any) {
        const userId = req.user.userId;
        const history = await this.summaryHistoryRepo.find({
            where: { userId },
            order: { createdAt: 'DESC' },
            take: 30 // Get last 30 summaries
        });

        return {
            success: true,
            data: history
        };
    }

    @Post('text')
    @ApiOperation({ summary: 'Summarize text using Python AI Service (Legacy)' })
    @ApiBody({ type: SummarizeDto })
    async summarizeTextLegacy(@Body() body: SummarizeDto) {
        return lastValueFrom(this.summaryService.summarizeText(body));
    }

    @Post('upload_prescription')
    @ApiOperation({ summary: 'Upload a prescription PDF for analysis' })
    @UseInterceptors(FileInterceptor('file'))
    async uploadPrescription(
        @Body() body: UploadPrescriptionDto,
        @UploadedFile() file: UploadedPrescriptionFile,
    ) {
        return lastValueFrom(
            this.summaryService.uploadPrescription({
                userId: parseInt(body.user_id, 10),
                fileData: file.buffer,
                fileName: file.originalname,
            })
        );
    }

    @Post('query_prescription')
    @ApiOperation({ summary: 'Query the uploaded prescription using RAG' })
    @ApiBody({ type: QueryPrescriptionDto })
    async queryPrescription(@Body() body: QueryPrescriptionDto) {
        return lastValueFrom(
            this.summaryService.queryPrescription({
                userId: parseInt(body.user_id, 10),
                question: body.question,
            })
        );
    }
}
