import {
  Controller,
  Post,
  Body,
  UseGuards,
  Req,
  UploadedFile,
  UseInterceptors,
  BadRequestException,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, MoreThanOrEqual } from 'typeorm';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { SummaryService } from './summary.service';
import { SummaryHistory } from './summary-history.entity';
import { prepareLogs } from './log-sampler';

@Controller('summary')
@UseGuards(JwtAuthGuard)
export class SummaryController {
  constructor(
    private readonly summaryService: SummaryService,
    @InjectRepository(SummaryHistory)
    private readonly summaryHistoryRepo: Repository<SummaryHistory>,
  ) {}

  @Post()
  async generateSummary(@Body() body: { logs: any[] }, @Req() req: any) {
    const userId: number = req.user.userId;

    // Cache check: return today's report if already generated
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);
    const existing = await this.summaryHistoryRepo.findOne({
      where: { userId, createdAt: MoreThanOrEqual(todayStart) },
      order: { createdAt: 'DESC' },
    });
    if (existing?.summary) {
      const cached = JSON.parse(existing.summary);
      return {
        cached: true,
        report: cached,
        recommendations: existing.recommendations?.split('\n') ?? [],
        hasCritical: existing.hasCritical,
      };
    }

    const sampledLogs = prepareLogs(body.logs ?? [], 200);
    const grpcResponse = await this.summaryService.analyzeData(
      JSON.stringify(sampledLogs),
      userId,
    );

    const reportJson = grpcResponse.report_json ?? grpcResponse.reportJson ?? null;
    let report: any = {};
    try {
      if (reportJson) report = JSON.parse(reportJson);
    } catch {
      report = {};
    }

    const recommendations: string[] = grpcResponse.recommendations ?? report.recommendations ?? [];
    const hasCritical: boolean = grpcResponse.has_critical ?? grpcResponse.hasCritical ?? false;

    await this.summaryHistoryRepo.save({
      userId,
      summary: reportJson,
      recommendations: recommendations.join('\n'),
      hasCritical,
      reportType: 'on_demand',
    });

    return {
      cached: false,
      report,
      hasCritical,
      overview: grpcResponse.overview ?? report.overview ?? '',
      recommendations,
    };
  }

  @Post('upload-prescription')
  @UseInterceptors(FileInterceptor('file'))
  async uploadPrescription(
    @UploadedFile() file: Express.Multer.File,
    @Req() req: any,
  ) {
    if (!file) throw new BadRequestException('No file uploaded');
    const userId: number = req.user.userId;
    const result = await this.summaryService.uploadPrescription(
      userId,
      file.buffer,
      file.originalname,
    );
    return {
      success: result.success,
      message: result.message,
      docId: result.doc_id ?? result.docId,
    };
  }

  @Post('query-prescription')
  async queryPrescription(@Body() body: { question: string }, @Req() req: any) {
    if (!body.question) throw new BadRequestException('question is required');
    const userId: number = req.user.userId;
    const result = await this.summaryService.queryPrescription(userId, body.question);
    return { success: result.success, answer: result.answer };
  }
}
