import './polyfill';
import { NestFactory } from '@nestjs/core';
import { MicroserviceOptions, Transport } from '@nestjs/microservices';
import { join } from 'path';
import { EmailServiceModule } from './email-service.module';

async function bootstrap() {
  const grpcUrl = process.env.EMAIL_GRPC_URL || '0.0.0.0:50052';
  if (!process.env.EMAIL_GRPC_URL) {
    console.warn(
      `[EmailService] EMAIL_GRPC_URL not set, using default: ${grpcUrl}`,
    );
  }
  const app = await NestFactory.createMicroservice<MicroserviceOptions>(
    EmailServiceModule,
    {
      transport: Transport.GRPC,
      options: {
        url: grpcUrl,
        package: 'email',
        protoPath: join(
          __dirname,
          '../../../libs/common/src/proto/email.proto',
        ),
      },
    },
  );
  await app.listen();
}
bootstrap();
