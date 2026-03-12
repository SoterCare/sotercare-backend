import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiQuery,
  ApiTags,
} from '@nestjs/swagger';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { DashboardService } from './dashboard.service';

@ApiTags('dashboard')
@ApiBearerAuth()
@Controller('dashboard')
@UseGuards(JwtAuthGuard)
export class DashboardController {
  constructor(private readonly dashboardService: DashboardService) {}

  @Get('vitals/latest')
  @ApiOperation({ summary: 'Get latest synced vitals for a device' })
  @ApiQuery({ name: 'deviceId', required: true, type: String })
  async getLatestVitals(
    @CurrentUser() user: { userId: number },
    @Query('deviceId') deviceId: string,
  ) {
    const data = await this.dashboardService.getLatestVitals(user.userId, deviceId);

    if (!data) {
      return {
        success: true,
        data: null,
        message: 'No vitals data available. Waiting for device sync.',
      };
    }

    return {
      success: true,
      data,
    };
  }
}
