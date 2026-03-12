import { Controller, Get, Query, UseGuards } from '@nestjs/common';
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
}
