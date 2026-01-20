import { NestFactory } from '@nestjs/core';
import { MicroserviceOptions, Transport } from '@nestjs/microservices';
import { join } from 'path';
import { EmailServiceModule } from './email-service.module';

async function bootstrap() {
  const port = process.env.PORT ? Number(process.env.PORT) : 50052;
  console.log(`Starting Email Service on 0.0.0.0:${port}`);

  const app = await NestFactory.createMicroservice<MicroserviceOptions>(
    EmailServiceModule,
    {
      transport: Transport.GRPC,
      options: {
        url: `0.0.0.0:${port}`,
        package: 'email',
        protoPath: join(__dirname, '../../../libs/common/src/proto/email.proto'),
      },
    },
  );
  await app.listen();
  console.log(`Email Service is listening on 0.0.0.0:${port}`);
}
bootstrap();
