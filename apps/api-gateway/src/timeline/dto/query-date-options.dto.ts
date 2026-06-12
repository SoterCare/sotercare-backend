import { ApiPropertyOptional } from '@nestjs/swagger';

export class QueryDateOptionsDto {
  @ApiPropertyOptional({ example: 'dev_001' })
  deviceId: string;

  @ApiPropertyOptional({ example: 'day', enum: ['day', 'week', 'month'] })
  period: 'day' | 'week' | 'month';

  @ApiPropertyOptional({ example: 330, description: 'Device timezone offset in minutes (-getTimezoneOffset())' })
  tzOffsetMinutes?: number;
}
