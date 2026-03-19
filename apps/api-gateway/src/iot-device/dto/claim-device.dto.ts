import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsString } from 'class-validator';

export class ClaimDeviceDto {
  @ApiProperty({ example: 'GW-9921' })
  @IsString()
  @IsNotEmpty()
  device_id: string;
}
