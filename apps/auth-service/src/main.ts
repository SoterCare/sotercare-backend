import { NestFactory } from '@nestjs/core';
import { MicroserviceOptions, Transport } from '@nestjs/microservices';
import { join } from 'path';
import { AuthServiceModule } from './auth-service.module';

async function bootstrap() {
  const port = process.env.PORT ? Number(process.env.PORT) : 50051;
  console.log(`Starting Auth Service on 0.0.0.0:${port}`);

  const app = await NestFactory.createMicroservice<MicroserviceOptions>(
    AuthServiceModule,
    {
      transport: Transport.GRPC,
      options: {
        url: `0.0.0.0:${port}`,
        package: 'auth',
        protoPath: join(__dirname, '../../../libs/common/src/proto/auth.proto'),
      },
    },
  );
  await app.listen();
  console.log(`Auth Service is listening on 0.0.0.0:${port}`);
}
bootstrap();
