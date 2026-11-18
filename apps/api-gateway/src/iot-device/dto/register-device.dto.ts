import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsString } from 'class-validator';

export class RegisterDeviceDto {
  @ApiProperty({ example: 'GW-9921' })
  @IsString()
  @IsNotEmpty()
  device_id: string;

  @ApiProperty({ example: 'raw-device-secret' })
  @IsString()
  @IsNotEmpty()
  device_key: string;
}
