import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import {
  Alert,
  Device,
  DeviceStatus,
  RecordingSession,
  SyncHistory,
  Vital,
} from '../database/entities';
import { SyncController } from './sync.controller';
import { SyncService } from './sync.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      Alert,
      Device,
      DeviceStatus,
      RecordingSession,
      SyncHistory,
      Vital,
    ]),
  ],
  controllers: [SyncController],
  providers: [SyncService],
  exports: [SyncService],
})
export class SyncModule {}
