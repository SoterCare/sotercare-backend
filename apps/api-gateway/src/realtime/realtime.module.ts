import { Global, Module } from '@nestjs/common';
import { ClientsModule, Transport } from '@nestjs/microservices';
import { TypeOrmModule } from '@nestjs/typeorm';
import { join } from 'path';
import { Alert, Vital } from '../database/entities';
import { RealtimeGateway } from './realtime.gateway';
import { VitalSyncService } from './vital-sync.service';
import { AlertWriterService } from './alert-writer.service';

@Global()
@Module({
  imports: [
    TypeOrmModule.forFeature([Vital, Alert]),
    ClientsModule.register([
      {
        name: 'HEALTH_SERVICE',
        transport: Transport.GRPC,
        options: {
          url: process.env.HEALTH_SERVICE_URL || 'localhost:50054',
          package: 'health',
          protoPath: join(__dirname, '../../../../libs/common/src/proto/health.proto'),
          loader: { keepCase: true, defaults: true, json: true, arrays: true },
          maxReceiveMessageLength: 100 * 1024 * 1024,
          maxSendMessageLength: 100 * 1024 * 1024,
        },
      },
    ]),
  ],
  providers: [RealtimeGateway, VitalSyncService, AlertWriterService],
  exports: [RealtimeGateway, VitalSyncService, AlertWriterService],
})
export class RealtimeModule {}
