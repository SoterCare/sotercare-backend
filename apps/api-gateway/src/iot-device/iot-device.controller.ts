import {
  BadRequestException,
  Body,
  Controller,
  Headers,
  Post,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { ClaimDeviceDto } from './dto/claim-device.dto';
import { RegisterDeviceDto } from './dto/register-device.dto';
import { IotDeviceService } from './iot-device.service';

@ApiTags('devices')
@Controller('devices')
export class IotDeviceController {
  constructor(private readonly iotDeviceService: IotDeviceService) {}

  @Post('claim')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Claim IoT device via scanned QR device_id' })
  @ApiBody({ type: ClaimDeviceDto })
  async claimDevice(
    @CurrentUser() user: { userId: number },
    @Body() body: ClaimDeviceDto,
  ) {
    return {
      success: true,
      data: await this.iotDeviceService.claimDevice(
        user.userId,
        body.device_id,
      ),
    };
  }

  @Post('unclaim')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Unclaim IoT device from current user' })
  @ApiBody({ type: ClaimDeviceDto })
  async unclaimDevice(
    @CurrentUser() user: { userId: number },
    @Body() body: ClaimDeviceDto,
  ) {
    return {
      success: true,
      data: await this.iotDeviceService.unclaimDevice(
        user.userId,
        body.device_id,
      ),
    };
  }

  @Post('register')
  @ApiOperation({
    summary: 'Register IoT device with device key (bootstrap/admin)',
  })
  @ApiBody({ type: RegisterDeviceDto })
  async registerDevice(
    @Body() body: RegisterDeviceDto,
    @Headers('x-admin-key') adminKey?: string,
  ) {
    const bootstrapKey = process.env.DEVICE_BOOTSTRAP_KEY;
    if (bootstrapKey && adminKey !== bootstrapKey) {
      throw new BadRequestException('Invalid bootstrap key');
    }

    return {
      success: true,
      data: await this.iotDeviceService.registerDevice(
        body.device_id,
        body.device_key,
      ),
    };
  }
}
