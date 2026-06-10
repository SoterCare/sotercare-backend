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
import { SummaryModule } from './summary/summary.module';

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
          autoLoadEntities: true,
          synchronize: true,
        };
      },
      inject: [ConfigService],
    }),
    PassportModule,
    JwtModule.register({
      secret: process.env.JWT_SECRET || 'REMOVED-OLD-PUBLIC-FALLBACK',
    }),
    RedisModule,
    IotDeviceModule,
    SyncModule,
    DevicesModule,
    DashboardModule,
    AlertsModule,
    TimelineModule,
    RealtimeModule,
    SummaryModule,
    ClientsModule.register([
      {
        name: 'AUTH_SERVICE',
        transport: Transport.GRPC,
        options: {
          url: process.env.AUTH_SERVICE_URL || 'localhost:50051',
          package: 'auth',
          protoPath: join(__dirname, '../../../libs/common/src/proto/auth.proto'),
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
