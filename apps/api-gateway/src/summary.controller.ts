import { Body, Controller, Inject, OnModuleInit, Post, UseInterceptors, UseGuards, UploadedFile } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import type { ClientGrpc } from '@nestjs/microservices';
import { Observable, lastValueFrom } from 'rxjs';
import { ApiTags, ApiOperation, ApiBody, ApiProperty, ApiBearerAuth } from '@nestjs/swagger';
import { IdempotencyInterceptor } from './common/interceptors/idempotency.interceptor';
import { JwtAuthGuard } from './common/guards/jwt-auth.guard';

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
}

@ApiTags('summary')
@ApiBearerAuth()
@Controller('summary')
@UseGuards(JwtAuthGuard)
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

    @Post('upload_prescription')
    @ApiOperation({ summary: 'Upload a prescription PDF for analysis' })
    @UseInterceptors(FileInterceptor('file'))
    async uploadPrescription(
        @Body() body: UploadPrescriptionDto,
        @UploadedFile() file: Express.Multer.File,
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
