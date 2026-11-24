import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { HealthServiceController } from './health-service.controller';
import { HealthServiceService } from './health-service.service';
import { VitalSign } from './vital-sign.entity';

@Module({
  imports: [
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
          `[HealthService] Connecting to DB via ${databaseUrl ? 'DATABASE_URL' : configService.get('DB_HOST', '127.0.0.1')} (ssl=${useSsl})`,
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
          entities: [VitalSign],
          // C3: auto-create tables only outside production; prod uses migrations.
          synchronize: process.env.NODE_ENV !== 'production',
        };
      },
      inject: [ConfigService],
    }),
    TypeOrmModule.forFeature([VitalSign]),
  ],
  controllers: [HealthServiceController],
  providers: [HealthServiceService],
})
export class HealthServiceModule {}
