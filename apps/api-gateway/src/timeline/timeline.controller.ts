import {
  Body,
  Controller,
  Get,
  Headers,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiOperation, ApiTags } from '@nestjs/swagger';
import { sourceOf } from '../common/client-source';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { DismissTimelineItemDto } from './dto/dismiss-item.dto';
import { QueryDateOptionsDto } from './dto/query-date-options.dto';
import { QueryTimelineEventsDto } from './dto/query-events.dto';
import { QueryTimelineStatsDto } from './dto/query-stats.dto';
import { QueryTimelineVitalsDto } from './dto/query-vitals.dto';
import { RestoreTimelineItemDto } from './dto/restore-item.dto';
import { TimelineService } from './timeline.service';

@ApiTags('timeline')
@ApiBearerAuth()
@Controller('timeline')
@UseGuards(JwtAuthGuard)
export class TimelineController {
  constructor(private readonly timelineService: TimelineService) {}

  @Get('vitals')
  @ApiOperation({ summary: 'Get aggregated synced vitals timeline points' })
  async getVitals(
    @CurrentUser() user: { userId: number },
    @Query() query: QueryTimelineVitalsDto,
  ) {
    return {
      success: true,
      data: await this.timelineService.getVitalsTimeline(user.userId, query),
    };
  }

  @Get('events')
  @ApiOperation({ summary: 'Get timeline events from synced alerts' })
  async getEvents(
    @CurrentUser() user: { userId: number },
    @Query() query: QueryTimelineEventsDto,
  ) {
    return {
      success: true,
      data: await this.timelineService.getEvents(user.userId, query),
    };
  }

  @Get('stats')
  @ApiOperation({ summary: 'Get aggregate alert counts for a period' })
  async getStats(
    @CurrentUser() user: { userId: number },
    @Query() query: QueryTimelineStatsDto,
  ) {
    return {
      success: true,
      data: await this.timelineService.getStats(user.userId, query),
    };
  }

  @Get('date-options')
  @ApiOperation({ summary: 'Get dates with available synced vitals data' })
  async getDateOptions(
    @CurrentUser() user: { userId: number },
    @Query() query: QueryDateOptionsDto,
  ) {
    return {
      success: true,
      data: await this.timelineService.getDateOptions(user.userId, query),
    };
  }

  @Get('dismissed')
  @ApiOperation({ summary: 'Get dismissed alerts for recycle-bin style view' })
  async getDismissed(@CurrentUser() user: { userId: number }) {
    return {
      success: true,
      data: await this.timelineService.getDismissed(user.userId),
    };
  }

  @Post('restore')
  @ApiOperation({ summary: 'Restore a dismissed alert' })
  @ApiBody({ type: RestoreTimelineItemDto })
  async restore(
    @CurrentUser() user: { userId: number },
    @Body() body: RestoreTimelineItemDto,
    @Headers('x-client') client?: string,
  ) {
    return {
      success: true,
      data: await this.timelineService.restore(
        user.userId,
        body,
        sourceOf(client),
      ),
    };
  }

  @Post('dismiss')
  @ApiOperation({ summary: 'Dismiss an active alert' })
  @ApiBody({ type: DismissTimelineItemDto })
  async dismiss(
    @CurrentUser() user: { userId: number },
    @Body() body: DismissTimelineItemDto,
    @Headers('x-client') client?: string,
  ) {
    return {
      success: true,
      data: await this.timelineService.dismiss(
        user.userId,
        body,
        sourceOf(client),
      ),
    };
  }
}
