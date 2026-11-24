import { IsIn, IsInt, IsOptional, Min } from 'class-validator';

/** Request body for marking an alert seen. */
export class AlertSeenDto {
  @IsIn(['push_foreground', 'push_opened', 'in_app'])
  source: 'push_foreground' | 'push_opened' | 'in_app';

  @IsOptional()
  @IsInt()
  @Min(1)
  notificationAttemptId?: number;
}
