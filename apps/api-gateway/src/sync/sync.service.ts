import {
  BadRequestException,
  Injectable,
  InternalServerErrorException,
} from '@nestjs/common';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import {
  Alert,
  Device,
  DeviceStatus,
  RecordingSession,
  SyncHistory,
  Vital,
} from '../database/entities';
import { SyncBatchDto } from './dto/sync-batch.dto';

@Injectable()
export class SyncService {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    @InjectRepository(SyncHistory)
    private readonly syncHistoryRepository: Repository<SyncHistory>,
  ) {}

  async processRaspberryPiSync(userId: number, payload: SyncBatchDto) {
    const syncedAt = new Date(payload.syncedAt);
    if (Number.isNaN(syncedAt.getTime())) {
      throw new BadRequestException('Invalid syncedAt timestamp');
    }

    const receivedAt = new Date();
    const idempotencyKey = `${payload.source}_${payload.slot}_${payload.syncedAt}`;
    const existingSync = await this.syncHistoryRepository.findOne({
      where: { idempotencyKey },
    });

    if (existingSync) {
      return {
        success: true,
        receivedAt: existingSync.receivedAt.toISOString(),
        upserted: {
          devices: 0,
          statuses: 0,
          vitals: 0,
          alerts: 0,
          recordings: 0,
        },
        note: 'Duplicate sync batch — already processed',
      };
    }

    try {
      const upserted = await this.dataSource.transaction(async (manager) => {
        const deviceRepository = manager.getRepository(Device);
        const statusRepository = manager.getRepository(DeviceStatus);
        const vitalRepository = manager.getRepository(Vital);
        const alertRepository = manager.getRepository(Alert);
        const recordingRepository = manager.getRepository(RecordingSession);
        const historyRepository = manager.getRepository(SyncHistory);

        let devices = 0;
        let statuses = 0;
        let vitals = 0;
        let alerts = 0;
        let recordings = 0;

        for (const device of payload.devices ?? []) {
          await deviceRepository.save(
            deviceRepository.create({
              id: device.id,
              userId,
              name: device.name,
              type: device.type,
              lastSeenAt: syncedAt,
              lastSyncSlot: payload.slot,
              syncSource: 'mobile_sync',
            }),
          );
          devices += 1;
        }

        for (const status of payload.deviceStatuses ?? []) {
          await statusRepository.save(
            statusRepository.create({
              deviceId: status.deviceId,
              battery: status.battery ?? null,
              signalRssi: status.signalRssi ?? null,
              connectedAt: status.connectedAt
                ? new Date(status.connectedAt)
                : null,
              bands: status.bands ?? [],
              receivedAt,
            }),
          );
          statuses += 1;
        }

        for (const vital of payload.latestVitals ?? []) {
          const vitalTimestamp = new Date(vital.timestamp);
          const existingVital = await vitalRepository.findOne({
            where: { deviceId: vital.deviceId, timestamp: vitalTimestamp },
          });

          if (existingVital) {
            continue;
          }

          await vitalRepository.save(
            vitalRepository.create({
              deviceId: vital.deviceId,
              timestamp: vitalTimestamp,
              temperature: vital.temperature ?? null,
              roomTemperature: vital.roomTemperature ?? null,
              moisture: vital.moisture ?? null,
              gaitAnalysis: vital.gaitAnalysis ?? null,
              syncSlot: payload.slot,
            }),
          );
          vitals += 1;
        }

        for (const alert of payload.recentAlerts ?? []) {
          const existingAlert = await alertRepository.findOne({
            where: { id: alert.id },
          });

          const incomingTimestamp = new Date(alert.timestamp);
          if (
            existingAlert &&
            existingAlert.deviceId === alert.deviceId &&
            existingAlert.type === alert.type &&
            existingAlert.title === alert.title &&
            existingAlert.timestamp.getTime() === incomingTimestamp.getTime() &&
            existingAlert.syncSlot === payload.slot
          ) {
            continue;
          }

          await alertRepository.save(
            alertRepository.create({
              id: alert.id,
              deviceId: alert.deviceId,
              type: alert.type,
              title: alert.title,
              timestamp: incomingTimestamp,
              syncSlot: payload.slot,
              isDismissed: existingAlert?.isDismissed ?? false,
              dismissedAt: existingAlert?.dismissedAt ?? null,
            }),
          );
          alerts += 1;
        }

        for (const session of payload.recordingSessions ?? []) {
          const existingSession = await recordingRepository.findOne({
            where: { recordingId: session.recordingId },
          });
          const createdAt = new Date(session.createdAt);

          if (
            existingSession &&
            existingSession.deviceId === session.deviceId &&
            existingSession.createdAt.getTime() === createdAt.getTime() &&
            existingSession.syncedAt.getTime() === syncedAt.getTime()
          ) {
            continue;
          }

          await recordingRepository.save(
            recordingRepository.create({
              recordingId: session.recordingId,
              deviceId: session.deviceId,
              createdAt,
              syncedAt,
            }),
          );
          recordings += 1;
        }

        const upsertSummary = { devices, statuses, vitals, alerts, recordings };
        await historyRepository.save(
          historyRepository.create({
            userId,
            source: payload.source,
            slot: payload.slot,
            syncedAt,
            gatewayHost: payload.gatewayHost,
            receivedAt,
            upsertSummary,
            idempotencyKey,
          }),
        );

        return upsertSummary;
      });

      return {
        success: true,
        receivedAt: receivedAt.toISOString(),
        upserted,
      };
    } catch {
      throw new InternalServerErrorException('Failed to process sync batch');
    }
  }
}
