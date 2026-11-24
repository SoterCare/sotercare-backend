import { Body, Controller, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { SyncBatchDto } from './dto/sync-batch.dto';
import { SyncService } from './sync.service';

@ApiTags('sync')
@ApiBearerAuth()
@Controller('sync')
@UseGuards(JwtAuthGuard)
export class SyncController {
  constructor(private readonly syncService: SyncService) {}

  @Post('raspberry-pi')
  @ApiOperation({
    summary: 'Ingest synced Raspberry Pi gateway data via mobile app',
  })
  @ApiBody({ type: SyncBatchDto })
  async syncRaspberryPi(
    @CurrentUser() user: { userId: number },
    @Body() body: SyncBatchDto,
  ) {
    return this.syncService.processRaspberryPiSync(user.userId, body);
  }
}
