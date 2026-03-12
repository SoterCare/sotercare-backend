import { ApiProperty } from '@nestjs/swagger';

export class QueryTimelineVitalsDto {
  @ApiProperty({ example: 'dev_001' })
  deviceId: string;

  @ApiProperty({ example: 'temp', enum: ['temp', 'roomTemp', 'moisture', 'gait'] })
  metric: 'temp' | 'roomTemp' | 'moisture' | 'gait';

  @ApiProperty({ example: 'day', enum: ['day', 'week', 'month'] })
  period: 'day' | 'week' | 'month';

  @ApiProperty({ example: '2026-03-12' })
  date: string;
}
