import { ApiPropertyOptional } from '@nestjs/swagger';

export class QueryDateOptionsDto {
  @ApiPropertyOptional({ example: 'dev_001' })
  deviceId: string;

  @ApiPropertyOptional({ example: 'day', enum: ['day', 'week', 'month'] })
  period: 'day' | 'week' | 'month';
}
