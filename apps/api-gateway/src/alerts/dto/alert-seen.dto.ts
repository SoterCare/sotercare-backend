import { IsIn, IsInt, IsOptional, Min } from 'class-validator';

/** Mirrors contracts/v1/alert_seen.request.schema.json. */
export class AlertSeenDto {
  @IsIn(['push_foreground', 'push_opened', 'in_app'])
  source: 'push_foreground' | 'push_opened' | 'in_app';

  @IsOptional()
  @IsInt()
  @Min(1)
  notificationAttemptId?: number;
}
