import { Body, Controller, Get, Headers, Patch, Param, Post, Query, UnauthorizedException, UseGuards } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiQuery,
  ApiTags,
} from '@nestjs/swagger';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { AlertsService } from './alerts.service';
import { QueryAlertsDto } from './dto/query-alerts.dto';

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
  ) {
    return {
      success: true,
      data: await this.alertsService.resolveAlert(user.userId, id, 'attended'),
    };
  }

  @Patch(':id/false-alarm')
  @ApiOperation({ summary: 'Mark an alert as a false alarm (and dismiss it)' })
  async falseAlarm(
    @CurrentUser() user: { userId: number },
    @Param('id') id: string,
  ) {
    return {
      success: true,
      data: await this.alertsService.resolveAlert(user.userId, id, 'false-alarm'),
    };
  }

  @Post('internal/alert-ready')
  async alertReady(
    @Body() body: { deviceId: string },
    @Headers('x-internal-token') token: string,
  ): Promise<void> {
    // H1: fail closed. This internal webhook has no other auth, so a missing
    // INTERNAL_SERVICE_TOKEN must disable it. (L1: removed the no-op @UseGuards().)
    const expectedToken = process.env.INTERNAL_SERVICE_TOKEN;
    if (!expectedToken) {
      throw new UnauthorizedException(
        'Internal endpoint disabled: INTERNAL_SERVICE_TOKEN is not configured',
      );
    }
    if (token !== expectedToken) {
      throw new UnauthorizedException('Invalid internal token');
    }
    await this.alertsService.pushLatestAlert(body.deviceId);
  }
}
