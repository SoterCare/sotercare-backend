import { Global, Module } from '@nestjs/common';
import { ClientsModule, Transport } from '@nestjs/microservices';
import { TypeOrmModule } from '@nestjs/typeorm';
import { JwtModule } from '@nestjs/jwt';
import { join } from 'path';
import { Alert, DeviceEvent, Vital } from '../database/entities';
import { IotDeviceModule } from '../iot-device/iot-device.module';
import { SyncModule } from '../sync/sync.module';
import { RealtimeGateway } from './realtime.gateway';
import { VitalSyncService } from './vital-sync.service';
import { UserSocketRegistry } from './user-socket.registry';
import { AlertEventsPublisher } from './alert-events.publisher';
import { AlertDispatchService } from '../alerts/alert-dispatch.service';
import { MoistureEpisodeService } from '../alert-policy/moisture-episode.service';
import { DeviceEventService } from './device-event.service';
import { NotificationAttemptsService } from '../notifications/notification-attempts.service';

@Global()
@Module({
  imports: [
    TypeOrmModule.forFeature([Vital, Alert, DeviceEvent]),
    // No hard-coded fallback: tokens are verified with process.env.JWT_SECRET
    // explicitly in RealtimeGateway, and the app refuses to boot without it.
    JwtModule.register({ secret: process.env.JWT_SECRET }),
    IotDeviceModule,
    SyncModule,
    ClientsModule.register([
      {
        name: 'HEALTH_SERVICE',
        transport: Transport.GRPC,
        options: {
          url: process.env.HEALTH_SERVICE_URL || 'localhost:50054',
          package: 'health',
          protoPath: join(__dirname, '../../../../libs/common/src/proto/health.proto'),
          loader: { keepCase: true, defaults: true, json: true, arrays: true },
          maxReceiveMessageLength: 100 * 1024 * 1024,
          maxSendMessageLength: 100 * 1024 * 1024,
        },
      },
    ]),
  ],
  providers: [
    RealtimeGateway,
    VitalSyncService,
    UserSocketRegistry,
    AlertEventsPublisher,
    AlertDispatchService,
    MoistureEpisodeService,
    DeviceEventService,
    NotificationAttemptsService,
  ],
  exports: [
    RealtimeGateway,
    VitalSyncService,
    UserSocketRegistry,
    AlertEventsPublisher,
    AlertDispatchService,
    NotificationAttemptsService,
    DeviceEventService,
  ],
})
export class RealtimeModule {}
