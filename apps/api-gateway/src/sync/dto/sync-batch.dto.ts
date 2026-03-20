import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { AlertType } from '../../database/entities';
import { DeviceType } from '../../database/entities/device.entity';

export class SyncDeviceDto {
  @ApiProperty({ example: 'dev_001' })
  id: string;

  @ApiProperty({ example: 'Device 01' })
  name: string;

  @ApiProperty({ enum: DeviceType, example: DeviceType.THIGH_BAND })
  type: DeviceType;
}

export class SyncBandDto {
  @ApiProperty({ example: 'Thigh Band' })
  name: string;

  @ApiProperty({ example: 'online' })
  status: string;
}

export class SyncDeviceStatusDto {
  @ApiProperty({ example: 'dev_001' })
  deviceId: string;

  @ApiPropertyOptional({ example: 82 })
  battery?: number;

  @ApiPropertyOptional({ example: -63 })
  signalRssi?: number;

  @ApiPropertyOptional({ example: '2026-03-12T07:15:00Z' })
  connectedAt?: string;

  @ApiProperty({ type: [SyncBandDto] })
  bands: SyncBandDto[];
}

export class SyncVitalDto {
  @ApiProperty({ example: 'dev_001' })
  deviceId: string;

  @ApiProperty({ example: '2026-03-12T07:25:00Z' })
  timestamp: string;

  @ApiPropertyOptional({ example: 30.4 })
  temperature?: number;

  @ApiPropertyOptional({ example: 29.9 })
  roomTemperature?: number;

  @ApiPropertyOptional({ example: 3 })
  moisture?: number;

  @ApiPropertyOptional({ example: 'N/A' })
  gaitAnalysis?: string;

  @ApiPropertyOptional({ example: 'ble' })
  thighnodeStatus?: string;
}

export class SyncAlertDto {
  @ApiProperty({ example: 'al_1001' })
  id: string;

  @ApiProperty({ example: 'dev_001' })
  deviceId: string;

  @ApiProperty({ enum: AlertType, example: AlertType.MOVEMENT })
  type: AlertType;

  @ApiProperty({ example: 'Movement Detected' })
  title: string;

  @ApiProperty({ example: '2026-03-12T07:24:00Z' })
  timestamp: string;
}

export class SyncRecordingSessionDto {
  @ApiProperty({ example: 'sotercare_recording_20260308_195017' })
  recordingId: string;

  @ApiProperty({ example: 'dev_001' })
  deviceId: string;

  @ApiProperty({ example: '2026-03-08T19:50:17.000Z' })
  createdAt: string;
}

export class SyncBatchDto {
  @ApiProperty({ example: 'raspberry_pi_gateway' })
  source: string;

  @ApiProperty({ example: '2026-03-12T08:00:02.000Z' })
  syncedAt: string;

  @ApiProperty({ example: 'slot_08' })
  slot: string;

  @ApiProperty({ example: 'raspberrypi.local' })
  gatewayHost: string;

  @ApiProperty({ type: [SyncDeviceDto] })
  devices: SyncDeviceDto[];

  @ApiProperty({ type: [SyncDeviceStatusDto] })
  deviceStatuses: SyncDeviceStatusDto[];

  @ApiProperty({ type: [SyncVitalDto] })
  latestVitals: SyncVitalDto[];

  @ApiProperty({ type: [SyncAlertDto] })
  recentAlerts: SyncAlertDto[];

  @ApiProperty({ type: [SyncRecordingSessionDto] })
  recordingSessions: SyncRecordingSessionDto[];
}
