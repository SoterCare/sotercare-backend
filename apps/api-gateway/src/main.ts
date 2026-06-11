import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { ApiGatewayModule } from './api-gateway.module';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';

import { json, urlencoded } from 'express';
import compression from 'compression';
import { HttpExceptionFilter } from './common/filters/http-exception.filter';
import { ResponseInterceptor } from './common/interceptors/response.interceptor';

async function bootstrap() {
  const app = await NestFactory.create(ApiGatewayModule);
  app.use(json({ limit: '50mb' }));
  app.use(urlencoded({ extended: true, limit: '50mb' }));
  app.use(compression());

  // H4: enable CORS (configurable via CORS_ORIGIN, comma-separated; defaults to
  // permissive so existing native-app clients keep working).
  const corsOrigin = process.env.CORS_ORIGIN;
  app.enableCors({
    origin: corsOrigin ? corsOrigin.split(',').map((o) => o.trim()) : true,
    credentials: true,
  });

  // H4: enforce validation on DTOs that declare class-validator decorators and
  // transform incoming payloads to their declared types. whitelist is left OFF
  // intentionally: several DTOs are documented with @ApiProperty only (no
  // validators yet), and whitelist would strip their unvalidated fields.
  app.useGlobalPipes(
    new ValidationPipe({
      transform: true,
      forbidUnknownValues: false,
    }),
  );

  app.useGlobalFilters(new HttpExceptionFilter());
  app.useGlobalInterceptors(new ResponseInterceptor());

  const config = new DocumentBuilder()
    .setTitle('SoterCare Backend API')
    .setDescription('NestJS cloud backend for synced elderly care monitoring data')
    .setVersion('1.0')
    .addTag('auth')
    .addTag('sync')
    .addTag('devices')
    .addTag('dashboard')
    .addTag('alerts')
    .addTag('timeline')
    .addBearerAuth() // Enable Bearer Auth button
    .build();
  const document = SwaggerModule.createDocument(app, config);
  SwaggerModule.setup('api', app, document);

  await app.listen(process.env.PORT || 3000, '0.0.0.0');
}
bootstrap();
