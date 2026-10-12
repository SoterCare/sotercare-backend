/* eslint-disable @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access */
/**
 * Phase 0 Postgres-backed regression tests (DB-level concurrency + TypeORM
 * undefined-where behaviour). SKIPPED unless TEST_DATABASE_URL is set.
 *
 * SAFETY: the schema is dropped and recreated. The test refuses to run unless
 * the database name contains "test". Never point it at a real database.
 *
 *   TEST_DATABASE_URL=postgres://postgres:postgres@localhost:5433/sotercare_test \
 *     npx jest apps/api-gateway/src/integration/phase0-ownership.pg.spec.ts
 */
import { DataSource } from 'typeorm';
import {
  Alert,
  Device,
  DeviceOwnership,
  DeviceStatus,
  DeviceType,
  RecordingSession,
  SyncHistory,
  Vital,
} from '../database/entities';
import { DashboardService } from '../dashboard/dashboard.service';
import { IotDevice } from '../iot-device/iot-device.entity';
import { IotDeviceService } from '../iot-device/iot-device.service';
import { OwnershipService } from '../ownership/ownership.service';
import { SyncService } from '../sync/sync.service';
import { configStub, syncBatch } from '../../test/support/phase0-fixtures';

const url = process.env.TEST_DATABASE_URL;
const describePg = url ? describe : describe.skip;

describePg('Phase 0 against PostgreSQL', () => {
  let ds: DataSource;

  beforeAll(async () => {
    const dbName = new URL(url as string).pathname.replace('/', '');
    if (!/test/i.test(dbName)) {
      throw new Error(
        `Refusing to drop schema of non-test database "${dbName}"`,
      );
    }
    ds = new DataSource({
      type: 'postgres',
      url,
      entities: [
        Device,
        IotDevice,
        Vital,
        Alert,
        DeviceStatus,
        RecordingSession,
        SyncHistory,
        DeviceOwnership,
      ],
      synchronize: true,
      dropSchema: true,
      invalidWhereValuesBehavior: { undefined: 'throw' },
    });
    await ds.initialize();
  });

  afterAll(async () => {
    await ds?.destroy();
  });

  beforeEach(async () => {
    await ds.query(
      'TRUNCATE alerts, vitals, device_statuses, recording_sessions, sync_history, devices, iot_devices, device_ownerships CASCADE',
    );
    await ds.getRepository(IotDevice).save({
      deviceId: 'dev-free',
      deviceKeyHash: 'x:y',
      ownerId: null,
      isPaired: false,
      lastSeen: new Date(),
    });
  });

  it('allows exactly one winner among 20 concurrent claims', async () => {
    const service = new IotDeviceService(
      configStub(),
      ds.getRepository(IotDevice),
      ds.getRepository(Device),
      ds,
      new OwnershipService(ds.getRepository(DeviceOwnership)),
    );
    const users = Array.from({ length: 20 }, (_, i) => i + 1);
    const results = await Promise.allSettled(
      users.map((u) => service.claimDevice(u, 'dev-free')),
    );
    const winners = results.filter((r) => r.status === 'fulfilled');
    expect(winners).toHaveLength(1);
    const owner = (winners[0] as PromiseFulfilledResult<any>).value.owner_id;
    expect(
      (
        await ds
          .getRepository(IotDevice)
          .findOneByOrFail({ deviceId: 'dev-free' })
      ).ownerId,
    ).toBe(owner);
    expect(
      (await ds.getRepository(Device).findOneByOrFail({ id: 'dev-free' }))
        .userId,
    ).toBe(owner);
  });

  it('allows exactly one owner among concurrent first-time syncs of a new device', async () => {
    const service = new SyncService(
      ds,
      ds.getRepository(SyncHistory),
      new OwnershipService(ds.getRepository(DeviceOwnership)),
    );
    const users = Array.from({ length: 10 }, (_, i) => i + 1);
    const results = await Promise.allSettled(
      users.map((u) =>
        service.processRaspberryPiSync(
          u,
          syncBatch({
            slot: `s${u}`,
            devices: [{ id: 'dev-race', name: 'n', type: DeviceType.HUB }],
          }),
        ),
      ),
    );
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(
      results
        .filter((r) => r.status === 'rejected')
        .every((r) => r.reason?.status === 403),
    ).toBe(true);
  });

  it('throws instead of widening a find() with an undefined where value', async () => {
    await expect(
      ds.getRepository(Vital).findOne({ where: { deviceId: undefined } }),
    ).rejects.toThrow(/Undefined value/i);
    const dashboard = new DashboardService(
      ds.getRepository(Device),
      ds.getRepository(Vital),
      new OwnershipService(ds.getRepository(DeviceOwnership)),
    );
    await expect(
      dashboard.getLatestVitals(1, undefined as any),
    ).rejects.toMatchObject({ status: 400 });
  });
});
