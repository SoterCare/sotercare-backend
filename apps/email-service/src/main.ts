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
        url: `0.0.0.0:${process.env.PORT || 50052}`,
        package: 'email',
        protoPath: join(__dirname, '../../../libs/common/src/proto/email.proto'),
      },
    },
  );
  await app.listen();
}
bootstrap();
