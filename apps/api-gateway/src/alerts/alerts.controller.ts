import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  Patch,
  Param,
  Post,
  Query,
  UseGuards,
  UsePipes,
  ValidationPipe,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiQuery,
  ApiTags,
} from '@nestjs/swagger';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { AlertsService } from './alerts.service';
import { sourceOf } from '../common/client-source';
import { QueryAlertsDto } from './dto/query-alerts.dto';
import { AlertSeenDto } from './dto/alert-seen.dto';

@ApiTags('alerts')
@ApiBearerAuth()
@Controller('alerts')
@UseGuards(JwtAuthGuard)
export class AlertsController {
  constructor(private readonly alertsService: AlertsService) {}

  @Get('recent')
  @ApiOperation({ summary: 'Get recent non-dismissed synced alerts' })
  @ApiQuery({ name: 'deviceId', required: false, type: String })
  @ApiQuery({ name: 'limit', required: false, type: Number })
  async getRecentAlerts(
    @CurrentUser() user: { userId: number },
    @Query() query: QueryAlertsDto,
  ) {
    const limit = Number(query.limit ?? 20);

    return {
      success: true,
      data: await this.alertsService.getRecentAlerts(
        user.userId,
        query.deviceId,
        limit,
      ),
    };
  }

  @Get('attended')
  @ApiOperation({ summary: 'Get alerts the user has confirmed and attended to' })
  @ApiQuery({ name: 'deviceId', required: false, type: String })
  @ApiQuery({ name: 'limit', required: false, type: Number })
  async getAttendedAlerts(
    @CurrentUser() user: { userId: number },
    @Query() query: QueryAlertsDto,
  ) {
    const limit = Number(query.limit ?? 50);

    return {
      success: true,
      data: await this.alertsService.getAttendedAlerts(
        user.userId,
        query.deviceId,
        limit,
      ),
    };
  }

  @Patch(':id/attend')
  @ApiOperation({ summary: 'Mark an alert as attended (confirmed valid)' })
  async attendAlert(
    @CurrentUser() user: { userId: number },
    @Param('id') id: string,
    @Headers('x-client') client?: string,
  ) {
    return {
      success: true,
      data: await this.alertsService.resolveAlert(
        user.userId,
        id,
        'attended',
        sourceOf(client),
      ),
    };
  }

  @Post(':id/seen')
  @HttpCode(200)
  @UsePipes(
    new ValidationPipe({
      transform: true,
      whitelist: true,
      forbidNonWhitelisted: true,
    }),
  )
  @ApiOperation({
    summary: 'Report that a push was shown or opened (never acknowledges)',
  })
  async markSeen(
    @CurrentUser() user: { userId: number },
    @Param('id') id: string,
    @Body() body: AlertSeenDto,
    @Headers('x-client') client?: string,
  ) {
    return {
      success: true,
      data: await this.alertsService.markSeen(
        user.userId,
        id,
        body,
        sourceOf(client),
      ),
    };
  }

  @Patch(':id/false-alarm')
  @ApiOperation({ summary: 'Mark an alert as a false alarm (and dismiss it)' })
  async falseAlarm(
    @CurrentUser() user: { userId: number },
    @Param('id') id: string,
    @Headers('x-client') client?: string,
  ) {
    return {
      success: true,
      data: await this.alertsService.resolveAlert(
        user.userId,
        id,
        'false-alarm',
        sourceOf(client),
      ),
    };
  }
}
