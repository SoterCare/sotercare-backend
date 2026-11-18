import { ApiProperty } from '@nestjs/swagger';

export class DismissTimelineItemDto {
  @ApiProperty({ example: 'al_1001' })
  id: string;
}
