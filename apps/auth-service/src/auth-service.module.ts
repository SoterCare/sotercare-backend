import { Module } from '@nestjs/common';
import { ClientsModule, Transport } from '@nestjs/microservices';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';
import { join } from 'path';
import { createClient } from 'redis';
import { AuthServiceController } from './auth-service.controller';
import { AuthServiceService } from './auth-service.service';
import { User } from './user.entity';
import { requireJwtSecret } from './jwt-secret';

@Module({
  imports: [
    JwtModule.register({
      global: true,
      secret: requireJwtSecret(),
      // H5: tokens were valid for 90 days with no revocation. Default to a short
      // lifetime, overridable via JWT_EXPIRES_IN (e.g. '7d', '12h'). Cast because
      // @nestjs/jwt types expiresIn as the `ms` StringValue template, not string.
      signOptions: { expiresIn: (process.env.JWT_EXPIRES_IN || '7d') as any },
    }),
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: '.env',
    }),
    TypeOrmModule.forRootAsync({
      imports: [ConfigModule],
      useFactory: (configService: ConfigService) => {
        // Prefer a managed connection string so data persists outside the
        // ephemeral container; SSL auto-enables for managed URLs (or DB_SSL=true).
        const databaseUrl = configService.get<string>('DATABASE_URL');
        const useSsl =
          !!databaseUrl || configService.get('DB_SSL', 'false') === 'true';
        console.log(
          `[AuthService] Connecting to DB via ${databaseUrl ? 'DATABASE_URL' : configService.get('DB_HOST', '127.0.0.1')} (ssl=${useSsl})`,
        );
        return {
          type: 'postgres',
          ...(databaseUrl
            ? { url: databaseUrl }
            : {
                host: configService.get<string>('DB_HOST', '127.0.0.1'),
                port: Number(configService.get<string>('DB_PORT', '5432')),
                username: configService.get<string>('DB_USER', 'postgres'),
                password: configService.get<string>('DB_PASS', 'postgres'),
                database: configService.get<string>('DB_NAME', 'auth_db'),
              }),
          ...(useSsl ? { ssl: { rejectUnauthorized: false } } : {}),
          entities: [User],
          // C3: auto-create tables only outside production; prod uses migrations.
          synchronize: process.env.NODE_ENV !== 'production',
        };
      },
      inject: [ConfigService],
    }),
    TypeOrmModule.forFeature([User]),
    ClientsModule.register([
      {
        name: 'EMAIL_SERVICE',
        transport: Transport.GRPC,
        options: {
          url: process.env.EMAIL_SERVICE_URL || 'localhost:50052',
          package: 'email',
          protoPath: join(__dirname, '../../../libs/common/src/proto/email.proto'),
        },
      },
    ]),
  ],
  controllers: [AuthServiceController],
  providers: [
    AuthServiceService,
    {
      provide: 'REDIS_CLIENT',
      useFactory: async (configService: ConfigService) => {
        // Prefer REDIS_URL (managed Redis); fall back to host/port for local.
        const redisUrl = configService.get<string>('REDIS_URL');
        const url =
          redisUrl ||
          `redis://${configService.get('REDIS_HOST', '127.0.0.1')}:${configService.get('REDIS_PORT', 6379)}`;
        const client = createClient({ url });
        client.on('error', (err) => console.error('Redis Client Error', err));
        client.on('connect', () => console.log('Redis Client Connected'));
        await client.connect();
        return client;
      },
      inject: [ConfigService],
    },
  ],
  exports: ['REDIS_CLIENT'],
})
export class AuthServiceModule { }
