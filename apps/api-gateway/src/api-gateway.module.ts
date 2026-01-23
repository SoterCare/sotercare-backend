import { Module } from '@nestjs/common';
import { ClientsModule, Transport } from '@nestjs/microservices';
import { join } from 'path';
import { ApiGatewayController } from './api-gateway.controller';
import { ApiGatewayService } from './api-gateway.service';
import { AuthController } from './auth.controller';
import { SummaryController } from './summary.controller';
import { RedisModule } from './redis.module';

@Module({
  imports: [
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
    ]),
  ],
  controllers: [ApiGatewayController, AuthController, SummaryController],
  providers: [ApiGatewayService],
})
export class ApiGatewayModule { }
