import {
  BadRequestException,
  Injectable,
  InternalServerErrorException,
  Logger,
} from '@nestjs/common';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import { DataSource, EntityManager, Repository } from 'typeorm';
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
  private readonly logger = new Logger(SyncService.name);

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
      // Each entity group is written with ONE bulk statement instead of
      // per-row findOne/save round-trips (a 100-vital + 20-alert batch used
      // to issue ~260 sequential queries inside this transaction).
      const upserted = await this.dataSource.transaction(
        async (manager: EntityManager) => {
          const deviceRows = (payload.devices ?? []).map((device) => ({
            id: device.id,
            userId,
            name: device.name,
            type: device.type,
            lastSeenAt: syncedAt,
            lastSyncSlot: payload.slot,
            syncSource: 'mobile_sync',
          }));
          if (deviceRows.length > 0) {
            // Insert-or-update on id, overwriting the same fields the old
            // per-row save() wrote (userId/name/type/lastSeenAt/lastSyncSlot/
            // syncSource).
            await manager.upsert(Device, deviceRows, ['id']);
          }

          const statusRows = (payload.deviceStatuses ?? []).map((status) => ({
            deviceId: status.deviceId,
            battery: status.battery ?? null,
            signalRssi: status.signalRssi ?? null,
            connectedAt: status.connectedAt
              ? new Date(status.connectedAt)
              : null,
            bands: status.bands ?? [],
            receivedAt,
          }));
          if (statusRows.length > 0) {
            // Append-only table: plain bulk insert.
            await manager.insert(DeviceStatus, statusRows);
          }

          const vitalRows = (payload.latestVitals ?? []).map((vital) => ({
            deviceId: vital.deviceId,
            timestamp: new Date(vital.timestamp),
            temperature: vital.temperature ?? null,
            roomTemperature: vital.roomTemperature ?? null,
            moisture: vital.moisture ?? null,
            gaitAnalysis: vital.gaitAnalysis ?? null,
            thighnodeStatus: vital.thighnodeStatus ?? null,
            syncSlot: payload.slot,
          }));
          let vitals = 0;
          if (vitalRows.length > 0) {
            // The unique (deviceId,timestamp) index dedupes via ON CONFLICT
            // DO NOTHING; RETURNING reports only the rows actually inserted,
            // so the count keeps the old "new rows only" semantics.
            const vitalResult = await manager
              .createQueryBuilder()
              .insert()
              .into(Vital)
              .values(vitalRows)
              .orIgnore()
              .returning(['id'])
              .updateEntity(false)
              .execute();
            vitals = Array.isArray(vitalResult.raw)
              ? vitalResult.raw.length
              : vitalRows.length;
          }

          const alertRows = (payload.recentAlerts ?? []).map((alert) => ({
            id: alert.id,
            deviceId: alert.deviceId,
            type: alert.type,
            title: alert.title,
            timestamp: new Date(alert.timestamp),
            syncSlot: payload.slot,
            isDismissed: false,
            dismissedAt: null,
          }));
          let alerts = 0;
          if (alertRows.length > 0) {
            // Alert ids are deterministic, so an existing id is the same
            // alert: insert-or-ignore on the PK leaves stored rows (and their
            // dismissal state) untouched. Count-semantics note: re-synced
            // alerts whose fields changed are no longer updated nor counted
            // (the old per-row loop updated and counted them).
            const alertResult = await manager
              .createQueryBuilder()
              .insert()
              .into(Alert)
              .values(alertRows)
              .orIgnore()
              .returning(['id'])
              .updateEntity(false)
              .execute();
            alerts = Array.isArray(alertResult.raw)
              ? alertResult.raw.length
              : alertRows.length;
          }

          const recordingRows = (payload.recordingSessions ?? []).map(
            (session) => ({
              recordingId: session.recordingId,
              deviceId: session.deviceId,
              createdAt: new Date(session.createdAt),
              syncedAt,
            }),
          );
          if (recordingRows.length > 0) {
            // Insert-or-update on the PK, overwriting deviceId/createdAt/
            // syncedAt like the old save(). Count-semantics note: every row
            // in the batch is counted, whereas the old loop skipped rows that
            // were byte-identical to the stored session.
            await manager.upsert(RecordingSession, recordingRows, [
              'recordingId',
            ]);
          }

          const upsertSummary = {
            devices: deviceRows.length,
            statuses: statusRows.length,
            vitals,
            alerts,
            recordings: recordingRows.length,
          };

          await manager.insert(SyncHistory, {
            userId,
            source: payload.source,
            slot: payload.slot,
            syncedAt,
            gatewayHost: payload.gatewayHost,
            receivedAt,
            upsertSummary,
            idempotencyKey,
          });

          return upsertSummary;
        },
      );

      return {
        success: true,
        receivedAt: receivedAt.toISOString(),
        upserted,
      };
    } catch (error) {
      this.logger.error(
        'Failed to process sync batch',
        error instanceof Error ? error.stack : String(error),
      );
      throw new InternalServerErrorException('Failed to process sync batch', {
        cause: error,
      });
    }
  }
}
