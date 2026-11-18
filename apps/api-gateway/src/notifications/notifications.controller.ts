import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  UseGuards,
  UsePipes,
  ValidationPipe,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RegisterPushTokenDto } from './dto/register-push-token.dto';
import { PushTokensService } from './push-tokens.service';

// Contract bodies are closed (additionalProperties: false).
const strictBody = new ValidationPipe({
  transform: true,
  whitelist: true,
  forbidNonWhitelisted: true,
});

@ApiTags('notifications')
@ApiBearerAuth()
@Controller('notifications')
@UseGuards(JwtAuthGuard)
export class NotificationsController {
  constructor(private readonly pushTokens: PushTokensService) {}

  @Post('push-tokens')
  @UsePipes(strictBody)
  @ApiOperation({ summary: 'Register this app installation for push alerts' })
  async register(
    @CurrentUser() user: { userId: number },
    @Body() body: RegisterPushTokenDto,
  ) {
    return {
      success: true,
      data: await this.pushTokens.register(user.userId, body),
    };
  }

  @Delete('push-tokens/:installationId')
  @ApiOperation({ summary: "Revoke the caller's tokens for an installation" })
  async revoke(
    @CurrentUser() user: { userId: number },
    @Param('installationId') installationId: string,
  ) {
    return {
      success: true,
      data: await this.pushTokens.revokeInstallation(
        user.userId,
        installationId,
      ),
    };
  }

  @Get('push-tokens')
  @ApiOperation({ summary: "List the caller's active push tokens (masked)" })
  async list(@CurrentUser() user: { userId: number }) {
    return {
      success: true,
      data: await this.pushTokens.listActive(user.userId),
    };
  }

  @Get('status')
  @ApiOperation({ summary: 'How many phones can receive push alerts' })
  async status(@CurrentUser() user: { userId: number }) {
    return { success: true, data: await this.pushTokens.status(user.userId) };
  }
}
