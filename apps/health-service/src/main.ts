import './polyfill';

import { NestFactory } from '@nestjs/core';
import { Transport, MicroserviceOptions } from '@nestjs/microservices';
import { join } from 'path';
import { HealthServiceModule } from './health-service.module';

async function bootstrap() {
  const app = await NestFactory.createMicroservice<MicroserviceOptions>(HealthServiceModule, {
    transport: Transport.GRPC,
    options: {
      package: 'health',
      protoPath: join(__dirname, '../../../libs/common/src/proto/health.proto'),
      url: process.env.HEALTH_GRPC_URL || '0.0.0.0:50054',
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
  });
  await app.listen();
  console.log('Health Service is running on ' + (process.env.HEALTH_GRPC_URL || '0.0.0.0:50054'));
}
bootstrap();
