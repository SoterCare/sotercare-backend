// Polyfill for crypto in Node 18 for TypeORM/NestJS
global.crypto = require('crypto');

import { NestFactory } from '@nestjs/core';
import { Transport, MicroserviceOptions } from '@nestjs/microservices';
import { JoinColumn } from 'typeorm';
import { join } from 'path';
import { HealthServiceModule } from './health-service.module';

async function bootstrap() {
  const app = await NestFactory.createMicroservice<MicroserviceOptions>(HealthServiceModule, {
    transport: Transport.GRPC,
    options: {
      package: 'health',
      protoPath: join(__dirname, '../../../libs/common/src/proto/health.proto'),
      url: process.env.HEALTH_GRPC_URL || '0.0.0.0:50054',
    },
  });
  await app.listen();
  console.log('Health Service is running on ' + (process.env.HEALTH_GRPC_URL || '0.0.0.0:50054'));
}
bootstrap();
