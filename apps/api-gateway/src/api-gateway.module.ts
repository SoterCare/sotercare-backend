import { Module } from '@nestjs/common';
import { ClientsModule, Transport } from '@nestjs/microservices';
import { PassportModule } from '@nestjs/passport';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { join } from 'path';
import { ApiGatewayController } from './api-gateway.controller';
import { ApiGatewayService } from './api-gateway.service';
import { AuthController } from './auth.controller';
import { UserController } from './user.controller';
import { SummaryController } from './summary.controller';
import { HealthController } from './health.controller';
import { ReportsController } from './reports.controller';
import { RedisModule } from './redis.module';
import { JwtStrategy } from './auth/jwt.strategy';
import { AlertsModule } from './alerts/alerts.module';
import { DashboardModule } from './dashboard/dashboard.module';
import { DevicesModule } from './devices/devices.module';
import { SyncModule } from './sync/sync.module';
import { TimelineModule } from './timeline/timeline.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: '.env',
    }),
    TypeOrmModule.forRootAsync({
      imports: [ConfigModule],
      useFactory: (configService: ConfigService) => ({
        type: 'postgres',
        host: configService.get('DB_HOST', '127.0.0.1'),
        port: Number(configService.get('DB_PORT', 5432)),
        username: configService.get('DB_USER', 'postgres'),
        password: configService.get('DB_PASS', 'postgres'),
        database: configService.get('DB_NAME', 'auth_db'),
        autoLoadEntities: true,
        synchronize: true,
      }),
      inject: [ConfigService],
    }),
    PassportModule,
    RedisModule,
    SyncModule,
    DevicesModule,
    DashboardModule,
    AlertsModule,
    TimelineModule,
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
        name: 'SUMMARY_SERVICE',
        transport: Transport.GRPC,
        options: {
          url: process.env.SUMMARY_SERVICE_URL || 'localhost:50053',
          package: 'summary',
          protoPath: join(__dirname, '../../../libs/common/src/proto/summary.proto'),
          loader: {
            keepCase: true,
            defaults: true,
            json: true,
            arrays: true,
          },
          // Set to 100 MB for large log payloads
          maxReceiveMessageLength: 100 * 1024 * 1024,
          maxSendMessageLength: 100 * 1024 * 1024,
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
    SummaryController,
    HealthController,
    ReportsController,
  ],
  providers: [ApiGatewayService, JwtStrategy],
})
export class ApiGatewayModule {}
