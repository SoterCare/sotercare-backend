import { Module } from '@nestjs/common';
import { ClientsModule, Transport } from '@nestjs/microservices';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { join } from 'path';
import { createClient } from 'redis';
import { AuthServiceController } from './auth-service.controller';
import { AuthServiceService } from './auth-service.service';
import { User } from './user.entity';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: '.env',
    }),
    TypeOrmModule.forRootAsync({
      imports: [ConfigModule],
      useFactory: (configService: ConfigService) => ({
        type: 'postgres',
        host: configService.get('DB_HOST', 'localhost'),
        port: configService.get<number>('DB_PORT', 5432),
        username: configService.get('DB_USER', 'postgres'),
        password: configService.get('DB_PASS', 'postgres'),
        database: configService.get('DB_NAME', 'auth_db'),
        entities: [User],
        synchronize: true, // Auto-create tables (dev only)
      }),
      inject: [ConfigService],
    }),
    TypeOrmModule.forFeature([User]),
    ClientsModule.registerAsync([
      {
        name: 'EMAIL_SERVICE',
        imports: [ConfigModule],
        useFactory: (configService: ConfigService) => ({
          transport: Transport.GRPC,
          options: {
            url: configService.get<string>('EMAIL_SERVICE_URL', 'localhost:50052'),
            package: 'email',
            protoPath: join(__dirname, '../../../libs/common/src/proto/email.proto'),
          },
        }),
        inject: [ConfigService],
      },
    ]),
  ],
  controllers: [AuthServiceController],
  providers: [
    AuthServiceService,
    {
      provide: 'REDIS_CLIENT',
      useFactory: async (configService: ConfigService) => {
        const client = createClient({
          url: `redis://${configService.get('REDIS_HOST', 'localhost')}:${configService.get('REDIS_PORT', 6379)}`
        });
        await client.connect();
        return client;
      },
      inject: [ConfigService],
    },
  ],
  exports: ['REDIS_CLIENT'],
})
export class AuthServiceModule { }
