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
import { Repository, Not, IsNull, Between } from 'typeorm';
import type { RedisClientType } from 'redis';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { SummaryService } from './summary.service';
import { SummaryHistory } from './summary-history.entity';

const DAILY_LIMIT = 5;
const COOLDOWN_MS = 30 * 60 * 1000; // 30 minutes

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

  private todayBounds() {
    const now = new Date();
    const todayStart = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
    );
    const tomorrowStart = new Date(todayStart.getTime() + 86_400_000);
    return { now, todayStart, tomorrowStart };
  }

  private async fetchTodayOnDemandRows(userId: number) {
    const { now, todayStart, tomorrowStart } = this.todayBounds();
    const rows = await this.summaryHistoryRepo.find({
      where: {
        userId,
        reportType: 'on_demand',
        windowStart: Not(IsNull()),
        createdAt: Between(todayStart, tomorrowStart),
      },
      order: { createdAt: 'DESC' },
    });
    return { rows, now, tomorrowStart };
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
    const { rows, now, tomorrowStart } = await this.fetchTodayOnDemandRows(userId);

    const usedToday = rows.length;
    const lastCreatedAt = rows[0]?.createdAt ?? null;
    const msSinceLast = lastCreatedAt
      ? now.getTime() - new Date(lastCreatedAt).getTime()
      : Infinity;
    const cooldownMs = Math.max(0, COOLDOWN_MS - msSinceLast);

    return {
      usedToday,
      limitPerDay: DAILY_LIMIT,
      nextAvailableAt:
        cooldownMs > 0
          ? new Date(now.getTime() + cooldownMs).toISOString()
          : usedToday >= DAILY_LIMIT
            ? tomorrowStart.toISOString()
            : null,
      cooldownSeconds: cooldownMs > 0 ? Math.ceil(cooldownMs / 1000) : 0,
    };
  }

  @Post()
  async generateSummary(
    @Body() body: { text?: string; date?: string; logs?: any[] },
    @Req() req: any,
  ) {
    const userId: number = req.user.userId;
    const reportDate = SummaryController.extractDate(body);
    this.logger.log(`[generateSummary] userId=${userId} reportDate=${reportDate}`);

    const { rows, now, tomorrowStart } = await this.fetchTodayOnDemandRows(userId);

    const usedToday = rows.length;
    const lastRow = rows[0] ?? null;
    const msSinceLast = lastRow
      ? now.getTime() - new Date(lastRow.createdAt).getTime()
      : Infinity;
    const cooldownMs = Math.max(0, COOLDOWN_MS - msSinceLast);
    const nextAvailableAt =
      cooldownMs > 0 ? new Date(now.getTime() + cooldownMs).toISOString() : null;
    const cooldownSeconds = cooldownMs > 0 ? Math.ceil(cooldownMs / 1000) : 0;

    // Within 30-min cooldown — return last result without calling the LLM.
    if (cooldownMs > 0 && lastRow?.summary) {
      let lastReport: any = null;
      try {
        lastReport = JSON.parse(lastRow.summary);
      } catch {}
      this.logger.log(
        `[generateSummary] cooldown active (${cooldownSeconds}s) for userId=${userId}`,
      );
      return {
        cached: true,
        summary: lastReport?.summary ?? '',
        report: lastReport,
        hasCritical: lastRow.hasCritical,
        usedToday,
        limitPerDay: DAILY_LIMIT,
        nextAvailableAt,
        cooldownSeconds,
      };
    }

    // Daily limit exhausted — resets at UTC midnight.
    if (usedToday >= DAILY_LIMIT) {
      throw new ForbiddenException({
        message: `Daily generation limit reached (${usedToday}/${DAILY_LIMIT}). Resets at midnight UTC.`,
        usedToday,
        limitPerDay: DAILY_LIMIT,
        nextAvailableAt: tomorrowStart.toISOString(),
        cooldownSeconds: Math.ceil((tomorrowStart.getTime() - now.getTime()) / 1000),
      });
    }

    const windowStart =
      reportDate === 'today'
        ? (() => {
            const d = new Date();
            d.setUTCHours(0, 0, 0, 0);
            return d;
          })()
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
      cached: false,
      summary: report.summary ?? '',
      report,
      hasCritical,
      usedToday: usedToday + 1,
      limitPerDay: DAILY_LIMIT,
      nextAvailableAt: new Date(now.getTime() + COOLDOWN_MS).toISOString(),
      cooldownSeconds: Math.ceil(COOLDOWN_MS / 1000),
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
