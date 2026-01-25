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
        const dbHost = configService.get('DB_HOST', '127.0.0.1');
        const dbPort = configService.get('DB_PORT', 5432);
        console.log(`[HealthService] Connecting to DB at ${dbHost}:${dbPort} (User: ${configService.get('DB_USER')})`);
        return {
          type: 'postgres',
          host: dbHost,
          port: dbPort,
          username: configService.get('DB_USER', 'postgres'),
          password: configService.get('DB_PASS', 'postgres'),
          database: configService.get('DB_NAME', 'auth_db'),
          entities: [VitalSign],
          synchronize: true,
        };
      },
      inject: [ConfigService],
    }),
    TypeOrmModule.forFeature([VitalSign]),
  ],
  controllers: [HealthServiceController],
  providers: [HealthServiceService],
})
export class HealthServiceModule { }
