import { Controller, Get, Param, Query, UseGuards } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiParam,
  ApiQuery,
  ApiTags,
} from '@nestjs/swagger';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { QueryDevicesDto } from './dto/query-devices.dto';
import { DevicesService } from './devices.service';

@ApiTags('devices')
@ApiBearerAuth()
@Controller('devices')
@UseGuards(JwtAuthGuard)
export class DevicesController {
  constructor(private readonly devicesService: DevicesService) {}

  @Get()
  @ApiOperation({ summary: 'Get user devices from synced cloud data' })
  @ApiQuery({ name: 'includeStatus', required: false, type: Boolean })
  @ApiQuery({ name: 'fields', required: false, type: String })
  async getDevices(
    @CurrentUser() user: { userId: number },
    @Query() query: QueryDevicesDto,
  ) {
    const includeStatus =
      query.includeStatus === true || query.includeStatus === 'true';
    const minimal = query.fields === 'minimal';

    return {
      data: await this.devicesService.getDevices(
        user.userId,
        includeStatus,
        minimal,
      ),
      success: true,
    };
  }

  @Get(':deviceId/status')
  @ApiOperation({
    summary:
      'Get inferred status and latest synced status snapshot for a device',
  })
  @ApiParam({ name: 'deviceId', type: String })
  async getDeviceStatus(
    @CurrentUser() user: { userId: number },
    @Param('deviceId') deviceId: string,
  ) {
    return {
      success: true,
      data: await this.devicesService.getDeviceStatus(user.userId, deviceId),
    };
  }
}
