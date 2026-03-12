import { ApiPropertyOptional } from '@nestjs/swagger';

export class QueryTimelineEventsDto {
  @ApiPropertyOptional({ example: 'dev_001' })
  deviceId: string;

  @ApiPropertyOptional({ example: 'day', enum: ['day', 'week', 'month'] })
  period: 'day' | 'week' | 'month';

  @ApiPropertyOptional({ example: '2026-03-12' })
  date: string;

  @ApiPropertyOptional({ example: 'all', enum: ['all', 'movement', 'fall', 'urine', 'temperature', 'moisture'] })
  filter?: 'all' | 'movement' | 'fall' | 'urine' | 'temperature' | 'moisture';
}
