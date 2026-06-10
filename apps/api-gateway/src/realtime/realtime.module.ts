import { Global, Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Alert, Vital } from '../database/entities';
import { RealtimeGateway } from './realtime.gateway';
import { VitalSyncService } from './vital-sync.service';
import { AlertWriterService } from './alert-writer.service';

@Global()
@Module({
  imports: [TypeOrmModule.forFeature([Vital, Alert])],
  providers: [RealtimeGateway, VitalSyncService, AlertWriterService],
  exports: [RealtimeGateway, VitalSyncService, AlertWriterService],
})
export class RealtimeModule {}
