import { ApiPropertyOptional } from '@nestjs/swagger';

export class QueryTimelineStatsDto {
  @ApiPropertyOptional({ example: 'dev_001' })
  deviceId: string;

  @ApiPropertyOptional({ example: 'day', enum: ['day', 'week', 'month', 'custom'] })
  period: 'day' | 'week' | 'month' | 'custom';

  @ApiPropertyOptional({ example: '2026-03-12' })
  date?: string;

  @ApiPropertyOptional({ example: '2026-03' })
  month?: string;

  @ApiPropertyOptional({ example: '2026-03-01' })
  startDate?: string;

  @ApiPropertyOptional({ example: '2026-03-15' })
  endDate?: string;

  @ApiPropertyOptional({ example: 330, description: 'Device timezone offset in minutes (-getTimezoneOffset())' })
  tzOffsetMinutes?: number;
}
