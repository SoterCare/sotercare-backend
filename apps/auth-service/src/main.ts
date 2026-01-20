import { NestFactory } from '@nestjs/core';
import { MicroserviceOptions, Transport } from '@nestjs/microservices';
import { join } from 'path';
import { AuthServiceModule } from './auth-service.module';

async function bootstrap() {
  const app = await NestFactory.createMicroservice<MicroserviceOptions>(
    AuthServiceModule,
    {
      transport: Transport.GRPC,
      options: {
        url: `0.0.0.0:${process.env.PORT || 50051}`,
        package: 'auth',
        protoPath: join(__dirname, '../../../libs/common/src/proto/auth.proto'),
      },
    },
  );
  await app.listen();
}
bootstrap();
