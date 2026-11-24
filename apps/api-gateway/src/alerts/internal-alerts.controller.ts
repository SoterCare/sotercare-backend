import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Post,
  UseGuards,
} from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import { InternalServiceGuard } from '../common/guards/internal-service.guard';
import { AlertDispatchService } from './alert-dispatch.service';
import { AlertReadyDto } from './dto/alert-ready.dto';
import { PipelineStatusService } from './pipeline-status.service';

/**
 * AR-1: service-to-service webhook (Python Safety Guard → api-gateway). Not
 * behind the user JWT guard; authenticated by InternalServiceGuard instead.
 * Its only effect is an idempotent dispatch claim of already-persisted rows,
 * limited to the named device, so a replayed request cannot create data.
 */
@ApiExcludeController()
@Controller('alerts/internal')
@UseGuards(InternalServiceGuard)
export class InternalAlertsController {
  constructor(
    private readonly alertDispatch: AlertDispatchService,
    private readonly pipelineStatus: PipelineStatusService,
  ) {}

  @Post('alert-ready')
  @HttpCode(202)
  async alertReady(@Body() body: AlertReadyDto) {
    const claimed = await this.alertDispatch.kick(body.alertIds, body.deviceId);
    return { accepted: true, claimed };
  }

  /** Workstream I: counts and ages for operators (no patient data). */
  @Get('pipeline-status')
  async status() {
    return { success: true, data: await this.pipelineStatus.snapshot() };
  }

  /** Workstream I: one gateway event, end to end, by its stable event id. */
  @Get('trace/:eventId')
  async trace(@Param('eventId') eventId: string) {
    return { success: true, data: await this.pipelineStatus.trace(eventId) };
  }
}
