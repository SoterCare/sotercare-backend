import {
  BadRequestException,
  ForbiddenException,
  HttpException,
  Injectable,
  InternalServerErrorException,
  Logger,
} from '@nestjs/common';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import { DataSource, EntityManager, In, IsNull, Repository } from 'typeorm';
import {
  Alert,
  Device,
  DeviceOwnership,
  DeviceStatus,
  RecordingSession,
  SyncHistory,
  Vital,
} from '../database/entities';
import { IotDevice } from '../iot-device/iot-device.entity';
import { OwnershipService } from '../ownership/ownership.service';
import { SyncBatchDto } from './dto/sync-batch.dto';

@Injectable()
export class SyncService {
  private readonly logger = new Logger(SyncService.name);

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    @InjectRepository(SyncHistory)
    private readonly syncHistoryRepository: Repository<SyncHistory>,
    private readonly ownershipService: OwnershipService,
  ) {}

  async processRaspberryPiSync(userId: number, payload: SyncBatchDto) {
    const syncedAt = new Date(payload.syncedAt);
    if (Number.isNaN(syncedAt.getTime())) {
      throw new BadRequestException('Invalid syncedAt timestamp');
    }

    const receivedAt = new Date();
    // Scoped by caller so one user's batch can never short-circuit another's.
    const idempotencyKey = `${userId}_${payload.source}_${payload.slot}_${payload.syncedAt}`;
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
          // GAP-001: verify (and, for brand-new ids, establish) ownership of
          // every device the batch touches BEFORE writing anything else.
          await this.assertBatchOwnership(manager, userId, payload, deviceRows);
          if (deviceRows.length > 0) {
            // Every listed device is now verified as the caller's, so this
            // upsert only refreshes metadata; it can no longer move ownership.
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
      if (error instanceof HttpException) {
        throw error;
      }
      this.logger.error(
        'Failed to process sync batch',
        error instanceof Error ? error.stack : String(error),
      );
      throw new InternalServerErrorException('Failed to process sync batch', {
        cause: error,
      });
    }
  }

  /**
   * A sync batch may only touch devices the caller owns. Ownership is
   * established through /devices/claim (IoT registry) or, for an id unknown to
   * both registries, by creating it here. Existing owners are never
   * overwritten: new rows are inserted with ON CONFLICT DO NOTHING and every
   * referenced row is then re-read under a row lock, so two concurrent batches
   * racing for the same new id cannot both win.
   */
  private async assertBatchOwnership(
    manager: EntityManager,
    userId: number,
    payload: SyncBatchDto,
    deviceRows: Array<Partial<Device> & { id: string }>,
  ) {
    const referenced = new Set<string>([
      ...deviceRows.map((device) => device.id),
      ...(payload.deviceStatuses ?? []).map((status) => status.deviceId),
      ...(payload.latestVitals ?? []).map((vital) => vital.deviceId),
      ...(payload.recentAlerts ?? []).map((alert) => alert.deviceId),
      ...(payload.recordingSessions ?? []).map((session) => session.deviceId),
    ]);
    if (referenced.size === 0) {
      return;
    }
    const deviceIds = [...referenced];

    const registered = await manager.find(IotDevice, {
      where: { deviceId: In(deviceIds) },
    });
    if (registered.some((device) => device.ownerId !== userId)) {
      throw new ForbiddenException(
        'Sync batch references a device that is not owned by the caller',
      );
    }

    const created = new Set<string>();
    if (deviceRows.length > 0) {
      const inserted = await manager
        .createQueryBuilder()
        .insert()
        .into(Device)
        .values(deviceRows)
        .orIgnore()
        .returning(['id'])
        .execute();
      for (const row of (inserted.raw ?? []) as { id: string }[]) {
        created.add(row.id);
      }
    }

    // Lock in a deterministic order so concurrent batches over overlapping
    // devices queue instead of deadlocking.
    const rows = await manager.find(Device, {
      where: { id: In(deviceIds) },
      order: { id: 'ASC' },
      lock: { mode: 'pessimistic_write' },
    });
    const owned = new Set(
      rows.filter((row) => row.userId === userId).map((row) => row.id),
    );
    if (deviceIds.some((deviceId) => !owned.has(deviceId))) {
      throw new ForbiddenException(
        'Sync batch references a device that is not owned by the caller',
      );
    }

    // PH0-07: a device created by this batch starts the caller's ownership
    // period now; an existing device must already be in a current period.
    for (const deviceId of deviceIds) {
      if (created.has(deviceId)) {
        await this.ownershipService.openInterval(
          manager,
          deviceId,
          userId,
          'sync_create',
        );
        continue;
      }
      const period = await manager.findOne(DeviceOwnership, {
        where: { deviceId, userId, endedAt: IsNull() },
      });
      if (!period) {
        throw new ForbiddenException(
          'Sync batch references a device without a current ownership period',
        );
      }
    }

    const recordingIds = (payload.recordingSessions ?? []).map(
      (session) => session.recordingId,
    );
    if (recordingIds.length > 0) {
      const existing = await manager.find(RecordingSession, {
        where: { recordingId: In(recordingIds) },
      });
      if (existing.some((session) => !owned.has(session.deviceId))) {
        throw new ForbiddenException(
          'Sync batch references a recording session owned by another user',
        );
      }
    }
  }
}
