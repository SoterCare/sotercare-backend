import {
  Controller,
  Post,
  Body,
  UseGuards,
  Req,
  UploadedFile,
  UseInterceptors,
  BadRequestException,
  BadGatewayException,
  ConflictException,
  Inject,
  Logger,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import type { RedisClientType } from 'redis';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { SummaryService } from './summary.service';
import { SummaryHistory } from './summary-history.entity';

@Controller('summary')
@UseGuards(JwtAuthGuard)
export class SummaryController {
  private readonly logger = new Logger(SummaryController.name);

  constructor(
    private readonly summaryService: SummaryService,
    @InjectRepository(SummaryHistory)
    private readonly summaryHistoryRepo: Repository<SummaryHistory>,
    @Inject('REDIS_CLIENT')
    private readonly redisClient: RedisClientType,
  ) {}

  private async acquireSummaryLock(userId: number, date: string): Promise<boolean> {
    try {
      const result = await this.redisClient.set(
        `summary:lock:${userId}:${date}`,
        '1',
        { NX: true, EX: 120 },
      );
      return result === 'OK';
    } catch (err) {
      this.logger.warn(
        `Summary lock unavailable (Redis): ${err instanceof Error ? err.message : String(err)}`,
      );
      return true;
    }
  }

  private async releaseSummaryLock(userId: number, date: string): Promise<void> {
    try {
      await this.redisClient.del(`summary:lock:${userId}:${date}`);
    } catch {
      // TTL ensures eventual release.
    }
  }

  /**
   * Derives the report date from the request body.
   *
   * Priority:
   *   1. body.date  — explicit YYYY-MM-DD field
   *   2. body.text  — parse first YYYY-MM-DD found in the text
   *   3. Default    — 'today'
   */
  private static extractDate(body: { text?: string; date?: string }): string {
    if (body.date && /^\d{4}-\d{2}-\d{2}$/.test(body.date)) {
      return body.date;
    }
    if (body.text) {
      const m = body.text.match(/\b(\d{4}-\d{2}-\d{2})\b/);
      if (m) return m[1];
    }
    return 'today';
  }

  @Post()
  async generateSummary(
    @Body() body: { text?: string; date?: string; logs?: any[] },
    @Req() req: any,
  ) {
    const userId: number = req.user.userId;
    const reportDate = SummaryController.extractDate(body);
    this.logger.log(`[generateSummary] userId=${userId} reportDate=${reportDate}`);

    // windowStart is UTC midnight for the report date — used as the cache key.
    const windowStart =
      reportDate === 'today'
        ? (() => {
            const d = new Date();
            d.setUTCHours(0, 0, 0, 0);
            return d;
          })()
        : new Date(`${reportDate}T00:00:00.000Z`);

    // Cache check: return existing report for this date if one exists.
    const existing = await this.summaryHistoryRepo.findOne({
      where: { userId, windowStart },
      order: { createdAt: 'DESC' },
    });
    if (existing?.summary) {
      this.logger.log(`[generateSummary] cache hit for userId=${userId}`);
      const cached = JSON.parse(existing.summary);
      return {
        cached: true,
        summary: cached.summary ?? '',
        report: cached,
        hasCritical: existing.hasCritical,
      };
    }

    if (!(await this.acquireSummaryLock(userId, reportDate))) {
      await new Promise((resolve) => setTimeout(resolve, 1000));
      const raced = await this.summaryHistoryRepo.findOne({
        where: { userId, windowStart },
        order: { createdAt: 'DESC' },
      });
      if (raced?.summary) {
        const cached = JSON.parse(raced.summary);
        return {
          cached: true,
          summary: cached.summary ?? '',
          report: cached,
          hasCritical: raced.hasCritical,
        };
      }
      throw new ConflictException(
        'Summary generation already in progress — retry shortly.',
      );
    }

    let grpcResponse: any;
    try {
      this.logger.log(`[generateSummary] calling gRPC analyzeData userId=${userId}`);
      const requestData = JSON.stringify({ type: 'brief', date: reportDate });
      grpcResponse = await this.summaryService.analyzeData(requestData, userId);
      this.logger.log(`[generateSummary] gRPC response keys=${Object.keys(grpcResponse ?? {}).join(',')}`);
    } catch (err) {
      this.logger.error(`[generateSummary] gRPC analyzeData failed: ${err instanceof Error ? err.message : String(err)}`);
      await this.releaseSummaryLock(userId, reportDate);
      throw err;
    }

    const reportJson =
      grpcResponse.report_json ?? grpcResponse.reportJson ?? null;

    if (!reportJson) {
      await this.releaseSummaryLock(userId, reportDate);
      throw new BadGatewayException(
        'Summary engine returned no report. Please retry shortly.',
      );
    }

    let report: any;
    try {
      report = JSON.parse(reportJson);
    } catch {
      await this.releaseSummaryLock(userId, reportDate);
      throw new BadGatewayException('Summary engine returned a malformed report.');
    }

    const hasCritical: boolean =
      grpcResponse.has_critical ?? grpcResponse.hasCritical ?? report.has_critical ?? false;

    await this.summaryHistoryRepo.save({
      userId,
      summary: reportJson,
      recommendations: '',
      hasCritical,
      windowStart,
      reportType: 'on_demand',
    });

    await this.releaseSummaryLock(userId, reportDate);

    return {
      cached: false,
      summary: report.summary ?? '',
      report,
      hasCritical,
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
    const result = await this.summaryService.queryPrescription(
      userId,
      body.question,
    );
    return { success: result.success, answer: result.answer };
  }
}
