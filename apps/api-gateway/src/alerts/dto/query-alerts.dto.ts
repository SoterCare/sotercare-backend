import { ApiPropertyOptional } from '@nestjs/swagger';

export class QueryAlertsDto {
  @ApiPropertyOptional({ example: 'dev_001' })
  deviceId?: string;

  @ApiPropertyOptional({ example: 20, default: 20 })
  limit?: number | string;
}
