import {
  Controller,
  Post,
  Get,
  Body,
  UseGuards,
  Req,
  UploadedFile,
  UseInterceptors,
  BadRequestException,
  BadGatewayException,
  ConflictException,
  ForbiddenException,
  Inject,
  Logger,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, Not, IsNull, MoreThanOrEqual } from 'typeorm';
import type { RedisClientType } from 'redis';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { SummaryService } from './summary.service';
import { SummaryHistory } from './summary-history.entity';

const DAILY_LIMIT = 5;

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

  private todayUTCStart(): Date {
    const now = new Date();
    return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  }

  private countTodayGenerations(userId: number): Promise<number> {
    return this.summaryHistoryRepo.count({
      where: {
        userId,
        reportType: 'on_demand',
        windowStart: Not(IsNull()),
        createdAt: MoreThanOrEqual(this.todayUTCStart()),
      },
    });
  }

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

  @Get('usage')
  async getUsage(@Req() req: any) {
    const userId: number = req.user.userId;
    const usedToday = await this.countTodayGenerations(userId);
    return { usedToday, limitPerDay: DAILY_LIMIT };
  }

  @Post()
  async generateSummary(
    @Body() body: { text?: string; date?: string; logs?: any[] },
    @Req() req: any,
  ) {
    const userId: number = req.user.userId;
    const reportDate = SummaryController.extractDate(body);
    this.logger.log(`[generateSummary] userId=${userId} reportDate=${reportDate}`);

    const usedToday = await this.countTodayGenerations(userId);

    if (usedToday >= DAILY_LIMIT) {
      throw new ForbiddenException({
        message: `Daily generation limit reached (${usedToday}/${DAILY_LIMIT}). Resets at midnight UTC.`,
        usedToday,
        limitPerDay: DAILY_LIMIT,
      });
    }

    const windowStart =
      reportDate === 'today'
        ? this.todayUTCStart()
        : new Date(`${reportDate}T00:00:00.000Z`);

    if (!(await this.acquireSummaryLock(userId, reportDate))) {
      await new Promise((resolve) => setTimeout(resolve, 1000));
      throw new ConflictException(
        'Summary generation already in progress — retry shortly.',
      );
    }

    let grpcResponse: any;
    try {
      this.logger.log(`[generateSummary] calling gRPC analyzeData userId=${userId}`);
      const requestData = JSON.stringify({ type: 'brief', date: reportDate });
      grpcResponse = await this.summaryService.analyzeData(requestData, userId);
      this.logger.log(
        `[generateSummary] gRPC response keys=${Object.keys(grpcResponse ?? {}).join(',')}`,
      );
    } catch (err) {
      this.logger.error(
        `[generateSummary] gRPC failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      await this.releaseSummaryLock(userId, reportDate);
      throw err;
    }

    const reportJson = grpcResponse.report_json ?? grpcResponse.reportJson ?? null;

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
      summary: report.summary ?? '',
      report,
      hasCritical,
      usedToday: usedToday + 1,
      limitPerDay: DAILY_LIMIT,
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
