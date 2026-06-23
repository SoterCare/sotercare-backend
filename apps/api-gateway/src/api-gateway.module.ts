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
import { RealtimeModule } from './realtime/realtime.module';
import { NurseModule } from './nurse/nurse.module';

// Keepalive pings keep the long-lived gRPC channels from silently dying behind
// NATs/load balancers, so the first call after an idle period doesn't stall on
// a dead connection.
const GRPC_CHANNEL_OPTIONS = {
  'grpc.keepalive_time_ms': 30000,
  'grpc.keepalive_timeout_ms': 5000,
  'grpc.http2.min_time_between_pings_ms': 10000,
  'grpc.keepalive_permit_without_calls': 1,
};

// H2: never fall back to a public hard-coded secret. Fail fast at boot so a
// missing JWT_SECRET can't silently make every token forgeable.
function requireJwtSecret(): string {
  const secret = process.env.JWT_SECRET;
  if (!secret) {
    throw new Error('JWT_SECRET environment variable must be set');
  }
  return secret;
}

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: '.env',
    }),
    TypeOrmModule.forRootAsync({
      imports: [ConfigModule],
      useFactory: (configService: ConfigService) => {
        // Prefer a managed connection string (Neon/Supabase/Koyeb Postgres) so the
        // data lives outside the ephemeral container. SSL is required by those
        // providers; auto-enable it whenever a URL is set (or DB_SSL=true).
        const databaseUrl = configService.get<string>('DATABASE_URL');
        const useSsl =
          !!databaseUrl || configService.get('DB_SSL', 'false') === 'true';
        return {
          type: 'postgres',
          ...(databaseUrl
            ? { url: databaseUrl }
            : {
                host: configService.get<string>('DB_HOST', '127.0.0.1'),
                port: Number(configService.get<string>('DB_PORT', '5432')),
                username: configService.get<string>('DB_USER', 'postgres'),
                password: configService.get<string>('DB_PASS', 'postgres'),
                database: configService.get<string>('DB_NAME', 'auth_db'),
              }),
          ...(useSsl ? { ssl: { rejectUnauthorized: false } } : {}),
          // Bound the pg pool and individual statements so one slow query
          // can't monopolize the gateway's database access.
          extra: { max: 20, statement_timeout: 10000 },
          autoLoadEntities: true,
          // C3: auto-schema-sync only outside production. In prod, schema is
          // managed by migrations so TypeORM can't drop/retype columns under us.
          synchronize: process.env.NODE_ENV !== 'production',
        };
      },
      inject: [ConfigService],
    }),
    PassportModule,
    JwtModule.register({
      secret: requireJwtSecret(),
    }),
    RedisModule,
    IotDeviceModule,
    SyncModule,
    DevicesModule,
    DashboardModule,
    AlertsModule,
    TimelineModule,
    RealtimeModule,
    NurseModule,
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
