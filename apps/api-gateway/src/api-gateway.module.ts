import { Module } from '@nestjs/common';
import { ClientsModule, Transport } from '@nestjs/microservices';
import { credentials } from '@grpc/grpc-js';
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
        useFactory: (configService: ConfigService) => {
          let url = configService.get<string>('AUTH_SERVICE_URL', 'localhost:50051');
          url = url.replace(/^https?:\/\//, ''); // Strip protocol
          if (url.includes('onrender.com') && !url.includes(':')) {
            url = `${url}:443`; // Default to 443 for render if port missing
          }
          console.log('Connecting to AUTH_SERVICE at:', url);
          return {
            transport: Transport.GRPC,
            options: {
              url,
              package: 'auth',
              protoPath: join(__dirname, '../../../libs/common/src/proto/auth.proto'),
              credentials: url.includes('onrender.com') || url.endsWith(':443') ? credentials.createSsl() : undefined,
            },
          };
        },
        inject: [ConfigService],
      },
      {
        name: 'SUMMARY_SERVICE',
        imports: [ConfigModule],
        useFactory: (configService: ConfigService) => {
          let url = configService.get<string>('SUMMARY_SERVICE_URL', 'localhost:50053');
          url = url.replace(/^https?:\/\//, ''); // Strip protocol
          if (url.includes('onrender.com') && !url.includes(':')) {
            url = `${url}:443`;
          }
          console.log('Connecting to SUMMARY_SERVICE at:', url);
          return {
            transport: Transport.GRPC,
            options: {
              url,
              package: 'summary',
              protoPath: join(__dirname, '../../../libs/common/src/proto/summary.proto'),
              credentials: url.includes('onrender.com') || url.endsWith(':443') ? credentials.createSsl() : undefined,
            },
          };
        },
        inject: [ConfigService],
      },
    ]),
  ],
  controllers: [ApiGatewayController, AuthController, SummaryController],
  providers: [ApiGatewayService],
})
export class ApiGatewayModule { }
