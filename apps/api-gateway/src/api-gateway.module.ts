import { Module } from '@nestjs/common';
import { ClientsModule, Transport } from '@nestjs/microservices';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { join } from 'path';
import { ApiGatewayController } from './api-gateway.controller';
import { ApiGatewayService } from './api-gateway.service';
import { AuthController } from './auth.controller';
import { SummaryController } from './summary.controller';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    ClientsModule.registerAsync([
      {
        name: 'AUTH_SERVICE',
        imports: [ConfigModule],
        useFactory: (configService: ConfigService) => ({
          transport: Transport.GRPC,
          options: {
            url: configService.get<string>('AUTH_SERVICE_URL', 'localhost:50051'),
            package: 'auth',
            protoPath: join(__dirname, '../../../libs/common/src/proto/auth.proto'),
          },
        }),
        inject: [ConfigService],
      },
      {
        name: 'SUMMARY_SERVICE',
        imports: [ConfigModule],
        useFactory: (configService: ConfigService) => ({
          transport: Transport.GRPC,
          options: {
            url: configService.get<string>('SUMMARY_SERVICE_URL', 'localhost:50053'),
            package: 'summary',
            protoPath: join(__dirname, '../../../libs/common/src/proto/summary.proto'),
          },
        }),
        inject: [ConfigService],
      },
    ]),
  ],
  controllers: [ApiGatewayController, AuthController, SummaryController],
  providers: [ApiGatewayService],
})
export class ApiGatewayModule { }
