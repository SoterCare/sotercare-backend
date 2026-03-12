import { ApiPropertyOptional } from '@nestjs/swagger';

export class QueryDevicesDto {
  @ApiPropertyOptional({ example: true, default: false })
  includeStatus?: boolean | string;

  @ApiPropertyOptional({ example: 'minimal' })
  fields?: string;
}
