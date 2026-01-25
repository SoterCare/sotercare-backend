import { Module } from '@nestjs/common';
import { ClientsModule, Transport } from '@nestjs/microservices';
import { PassportModule } from '@nestjs/passport'; // Import PassportModule
import { join } from 'path';
import { ApiGatewayController } from './api-gateway.controller';
import { ApiGatewayService } from './api-gateway.service';
import { AuthController } from './auth.controller';
import { UserController } from './user.controller';
import { SummaryController } from './summary.controller';
import { HealthController } from './health.controller';
import { RedisModule } from './redis.module';
import { JwtStrategy } from './auth/jwt.strategy'; // Import JwtStrategy

@Module({
  imports: [
    PassportModule, // Register PassportModule
    RedisModule,
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
  controllers: [ApiGatewayController, AuthController, UserController, SummaryController, HealthController],
  providers: [ApiGatewayService, JwtStrategy], // Add JwtStrategy
})
export class ApiGatewayModule { }
