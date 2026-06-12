import { ApiProperty } from '@nestjs/swagger';

export class QueryTimelineVitalsDto {
  @ApiProperty({ example: 'dev_001' })
  deviceId: string;

  @ApiProperty({ example: 'temp', enum: ['temp', 'roomTemp', 'moisture', 'gait'] })
  metric: 'temp' | 'roomTemp' | 'moisture' | 'gait';

  @ApiProperty({ example: 'day', enum: ['day', 'week', 'month', 'custom'] })
  period: 'day' | 'week' | 'month' | 'custom';

  @ApiProperty({ example: '2026-03-12', required: false })
  date?: string;

  @ApiProperty({ example: '2026-03-01', required: false })
  startDate?: string;

  @ApiProperty({ example: '2026-03-15', required: false })
  endDate?: string;

  @ApiProperty({ example: 330, required: false, description: 'Device timezone offset in minutes (-getTimezoneOffset())' })
  tzOffsetMinutes?: number;
}
