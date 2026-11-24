import {
  IsIn,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
} from 'class-validator';

/** Request body for registering a push token. */
export class RegisterPushTokenDto {
  @IsString()
  @MaxLength(255)
  @Matches(/^Expo(nent)?PushToken\[[A-Za-z0-9_-]+\]$/)
  token: string;

  @IsIn(['ios', 'android'])
  platform: 'ios' | 'android';

  @IsString()
  @Matches(/^[0-9a-fA-F-]{16,64}$/)
  installationId: string;

  @IsOptional()
  @IsString()
  @MaxLength(32)
  appVersion?: string;

  @IsOptional()
  @IsIn(['granted', 'provisional'])
  permission?: 'granted' | 'provisional';
}
