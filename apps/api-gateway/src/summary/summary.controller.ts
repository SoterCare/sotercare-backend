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
import { Repository, MoreThanOrEqual } from 'typeorm';
import type { RedisClientType } from 'redis';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { SummaryService } from './summary.service';
import { SummaryHistory } from './summary-history.entity';
import { prepareLogs } from './log-sampler';

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

  /**
   * Per-user-per-day lock so concurrent first requests can't both run the
   * (multi-second, costly) LLM call. Fails open: Redis trouble means no lock,
   * not a broken endpoint.
   */
  private async acquireSummaryLock(userId: number): Promise<boolean> {
    const day = new Date().toISOString().slice(0, 10);
    try {
      const result = await this.redisClient.set(
        `summary:lock:${userId}:${day}`,
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

  private async releaseSummaryLock(userId: number): Promise<void> {
    const day = new Date().toISOString().slice(0, 10);
    try {
      await this.redisClient.del(`summary:lock:${userId}:${day}`);
    } catch {
      // Lock has a TTL; failing to release is harmless.
    }
  }

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

    if (!(await this.acquireSummaryLock(userId))) {
      // Another request is mid-generation; give it a moment, then serve its
      // result if it landed — otherwise tell the client to retry.
      await new Promise((resolve) => setTimeout(resolve, 1000));
      const raced = await this.summaryHistoryRepo.findOne({
        where: { userId, createdAt: MoreThanOrEqual(todayStart) },
        order: { createdAt: 'DESC' },
      });
      if (raced?.summary) {
        return {
          cached: true,
          report: JSON.parse(raced.summary),
          recommendations: raced.recommendations?.split('\n') ?? [],
          hasCritical: raced.hasCritical,
        };
      }
      throw new ConflictException(
        'Summary generation already in progress — retry shortly.',
      );
    }

    let grpcResponse: any;
    try {
      const sampledLogs = prepareLogs(body.logs ?? [], 200);
      grpcResponse = await this.summaryService.analyzeData(
        JSON.stringify(sampledLogs),
        userId,
      );
    } catch (err) {
      await this.releaseSummaryLock(userId);
      throw err;
    }

    const reportJson =
      grpcResponse.report_json ?? grpcResponse.reportJson ?? null;

    // L8: don't silently hand back an empty report. If the AI engine returned
    // nothing (e.g. proto stubs missing or generation failed), surface a 502 so
    // the client can distinguish "no data" from "engine error".
    if (!reportJson) {
      await this.releaseSummaryLock(userId);
      throw new BadGatewayException(
        'Summary engine returned no report. Please retry shortly.',
      );
    }

    let report: any;
    try {
      report = JSON.parse(reportJson);
    } catch {
      await this.releaseSummaryLock(userId);
      throw new BadGatewayException(
        'Summary engine returned a malformed report.',
      );
    }

    const recommendations: string[] =
      grpcResponse.recommendations ?? report.recommendations ?? [];
    const hasCritical: boolean =
      grpcResponse.has_critical ?? grpcResponse.hasCritical ?? false;

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
    const result = await this.summaryService.queryPrescription(
      userId,
      body.question,
    );
    return { success: result.success, answer: result.answer };
  }
}
