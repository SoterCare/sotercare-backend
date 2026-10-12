import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { NotificationAttempt, PushToken } from '../database/entities';
import { EscalationService } from './escalation.service';
import { NotificationSenderService } from './notification-sender.service';
import { NotificationsController } from './notifications.controller';
import { PUSH_PROVIDER, createPushProvider } from './push-provider';
import { PushTokensService } from './push-tokens.service';

/**
 * AR-6 / AR-8. NotificationAttemptsService and AlertEventsPublisher come from
 * the global RealtimeModule (the dispatcher creates attempts). Sending runs
 * only with PUSH_ENABLED=true; PUSH_PROVIDER=expo selects Expo, otherwise a
 * dry run. Escalation needs an approved policy AND ESCALATION_ENABLED=true.
 */
@Module({
  imports: [TypeOrmModule.forFeature([PushToken, NotificationAttempt])],
  controllers: [NotificationsController],
  providers: [
    PushTokensService,
    NotificationSenderService,
    EscalationService,
    { provide: PUSH_PROVIDER, useFactory: () => createPushProvider() },
  ],
})
export class NotificationsModule {}
