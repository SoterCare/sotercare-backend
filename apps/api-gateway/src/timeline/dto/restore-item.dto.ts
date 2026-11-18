import { ApiProperty } from '@nestjs/swagger';

export class RestoreTimelineItemDto {
  @ApiProperty({ example: 'al_1001' })
  id: string;
}
