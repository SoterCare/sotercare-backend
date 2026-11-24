import { Module } from '@nestjs/common';
import { ClientsModule, Transport } from '@nestjs/microservices';
import { PassportModule } from '@nestjs/passport';
import { JwtModule } from '@nestjs/jwt';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { join } from 'path';
import { ApiGatewayController } from './api-gateway.controller';
import { ApiGatewayService } from './api-gateway.service';
import { AuthController } from './auth.controller';
import { UserController } from './user.controller';
import { HealthController } from './health.controller';
import { ReportsController } from './reports.controller';
import { RedisModule } from './redis.module';
import { JwtStrategy } from './auth/jwt.strategy';
import { AlertsModule } from './alerts/alerts.module';
import { DashboardModule } from './dashboard/dashboard.module';
import { DevicesModule } from './devices/devices.module';
import { SyncModule } from './sync/sync.module';
import { TimelineModule } from './timeline/timeline.module';
import { IotDeviceModule } from './iot-device/iot-device.module';
import { OwnershipModule } from './ownership/ownership.module';
import { RealtimeModule } from './realtime/realtime.module';
import { NotificationsModule } from './notifications/notifications.module';
import { buildTypeOrmOptions } from './database/typeorm-options';
import { requireJwtSecret } from './common/jwt-secret';

// Keepalive pings keep the long-lived gRPC channels from silently dying behind
// NATs/load balancers, so the first call after an idle period doesn't stall on
// a dead connection.
const GRPC_CHANNEL_OPTIONS = {
  'grpc.keepalive_time_ms': 30000,
  'grpc.keepalive_timeout_ms': 5000,
  'grpc.http2.min_time_between_pings_ms': 10000,
  'grpc.keepalive_permit_without_calls': 1,
};

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: '.env',
    }),
    TypeOrmModule.forRootAsync({
      imports: [ConfigModule],
      useFactory: buildTypeOrmOptions,
      inject: [ConfigService],
    }),
    PassportModule,
    JwtModule.register({
      secret: requireJwtSecret(),
    }),
    RedisModule,
    OwnershipModule,
    IotDeviceModule,
    SyncModule,
    DevicesModule,
    DashboardModule,
    AlertsModule,
    TimelineModule,
    RealtimeModule,
    NotificationsModule,
    ClientsModule.register([
      {
        name: 'AUTH_SERVICE',
        transport: Transport.GRPC,
        options: {
          url: process.env.AUTH_SERVICE_URL || 'localhost:50051',
          package: 'auth',
          protoPath: join(__dirname, '../../../libs/common/src/proto/auth.proto'),
          channelOptions: GRPC_CHANNEL_OPTIONS,
        },
      },
      {
        name: 'HEALTH_SERVICE',
        transport: Transport.GRPC,
        options: {
          url: process.env.HEALTH_SERVICE_URL || 'localhost:50054',
          package: 'health',
          protoPath: join(__dirname, '../../../libs/common/src/proto/health.proto'),
          loader: {
            keepCase: true,
            defaults: true,
            json: true,
            arrays: true,
          },
          // Set to 100 MB
          maxReceiveMessageLength: 100 * 1024 * 1024,
          maxSendMessageLength: 100 * 1024 * 1024,
          channelOptions: GRPC_CHANNEL_OPTIONS,
        },
      },
    ]),
  ],
  controllers: [
    ApiGatewayController,
    AuthController,
    UserController,
    HealthController,
    ReportsController,
  ],
  providers: [ApiGatewayService, JwtStrategy],
})
export class ApiGatewayModule {}
