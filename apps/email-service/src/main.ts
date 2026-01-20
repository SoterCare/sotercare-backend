import * as crypto from 'crypto';
// Polyfill for TypeORM/NestJS requiring global crypto
(global as any).crypto = crypto;

import { NestFactory } from '@nestjs/core';
import { MicroserviceOptions, Transport } from '@nestjs/microservices';
import { join } from 'path';
import { EmailServiceModule } from './email-service.module';

async function bootstrap() {
  const app = await NestFactory.createMicroservice<MicroserviceOptions>(
    EmailServiceModule,
    {
      transport: Transport.GRPC,
      options: {
        url: process.env.EMAIL_GRPC_URL || '0.0.0.0:50052',
        package: 'email',
        protoPath: join(__dirname, '../../../libs/common/src/proto/email.proto'),
      },
    },
  );
  await app.listen();
}
bootstrap();
