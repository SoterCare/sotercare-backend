/**
 * AR-0 + PH0-07 migration tests against real PostgreSQL. SKIPPED unless
 * TEST_DATABASE_URL is set; refuses non-"test" databases (drops the schema).
 * Run with --runInBand together with the other *.pg.spec.ts suites.
 */
import { DataSource, DataSourceOptions } from 'typeorm';
import {
  Alert,
  Device,
  DeviceOwnership,
  DeviceStatus,
  DeviceType,
  RecordingSession,
  SyncHistory,
  Vital,
} from './entities';
import { IotDevice } from '../iot-device/iot-device.entity';
import { ALL_MIGRATIONS } from './migrations';

const url = process.env.TEST_DATABASE_URL;
const describePg = url ? describe : describe.skip;

const BASE = [
  Device,
  IotDevice,
  Vital,
  Alert,
  DeviceStatus,
  RecordingSession,
  SyncHistory,
];

function options(extra: Partial<DataSourceOptions>): DataSourceOptions {
  return { type: 'postgres', url, ...extra } as DataSourceOptions;
}

// Builds the schema from the current entities, then removes the Phase 1
// additions so the migrations run against a faithful pre-Phase-1 shape
// (unless `keepPhase1` emulates a dev DB that `synchronize` already updated).
async function seedBaseSchema(entities: any[], keepPhase1 = false) {
  const ds = new DataSource(
    options({ entities, synchronize: true, dropSchema: true }),
  );
  await ds.initialize();
  if (!keepPhase1) {
    await ds.query(
      `ALTER TABLE alerts DROP CONSTRAINT IF EXISTS chk_alerts_dispatch_state`,
    );
    await ds.query(
      `ALTER TABLE alerts DROP COLUMN IF EXISTS "dispatchState", DROP COLUMN IF EXISTS "dispatchedAt", DROP COLUMN IF EXISTS "dispatchNote"`,
    );
  }
  const device = (id: string, userId: number) => ({
    id,
    userId,
    name: id,
    type: DeviceType.HUB,
    lastSeenAt: new Date(),
    lastSyncSlot: 'iot_live',
    syncSource: 'iot_claim',
  });
  await ds
    .getRepository(Device)
    .insert([device('dev-a', 1), device('dev-free', 0), device('dev-sync', 2)]);
  await ds.getRepository(IotDevice).insert([
    {
      deviceId: 'dev-a',
      deviceKeyHash: 'x:y',
      ownerId: 1,
      isPaired: true,
      lastSeen: new Date(),
    },
    {
      deviceId: 'dev-free',
      deviceKeyHash: 'x:y',
      ownerId: null,
      isPaired: false,
      lastSeen: new Date(),
    },
  ]);
  await ds.query(
    `INSERT INTO alerts (id, "deviceId", type, title, timestamp, "isDismissed", "isAttended", "isFalseAlarm", "syncSlot")
     VALUES ('fall_dev-a_old', 'dev-a', 'fall', 'Fall', now() - interval '1 day', false, false, false, 'iot_live')`,
  );
  await ds.destroy();
}

async function migrate(entities: any[]) {
  const ds = new DataSource(
    options({
      entities,
      migrations: ALL_MIGRATIONS,
      migrationsTableName: 'typeorm_migrations',
      migrationsTransactionMode: 'each',
    }),
  );
  await ds.initialize();
  await ds.runMigrations();
  return ds;
}

describePg('migrations (real PostgreSQL)', () => {
  beforeAll(() => {
    const dbName = new URL(url as string).pathname.replace('/', '');
    if (!/test/i.test(dbName))
      throw new Error(
        `Refusing to drop schema of non-test database "${dbName}"`,
      );
  });

  it('applies to an existing (pre-Phase-1) schema and backfills fail-closed intervals', async () => {
    await seedBaseSchema(BASE);
    const before = Date.now();
    const ds = await migrate(BASE);
    try {
      const rows: {
        deviceId: string;
        userId: number;
        startedAt: string;
        endedAt: string | null;
        startReason: string;
      }[] = await ds.query(
        `SELECT "deviceId", "userId", "startedAt", "endedAt", "startReason" FROM device_ownerships ORDER BY "deviceId"`,
      );
      expect(
        rows.map((r) => [r.deviceId, r.userId, r.endedAt, r.startReason]),
      ).toEqual([
        ['dev-a', 1, null, 'backfill_migration'],
        ['dev-sync', 2, null, 'backfill_migration'],
      ]);
      // Fail closed: intervals start at migration time, so legacy history is not attributed.
      for (const r of rows)
        expect(new Date(r.startedAt).getTime()).toBeGreaterThanOrEqual(
          before - 5_000,
        );
      const idx: { indexname: string }[] = await ds.query(
        `SELECT indexname FROM pg_indexes WHERE tablename = 'device_ownerships'`,
      );
      expect(idx.map((i) => i.indexname)).toEqual(
        expect.arrayContaining([
          'ux_device_ownerships_open',
          'ix_device_ownerships_lookup',
        ]),
      );
    } finally {
      await ds.destroy();
    }
  });

  it('is idempotent over a synchronize-created table and when re-run', async () => {
    await seedBaseSchema([...BASE, DeviceOwnership], true);
    const ds = await migrate([...BASE, DeviceOwnership]);
    try {
      expect(await ds.showMigrations()).toBe(false); // nothing pending
      const runner = ds.createQueryRunner();
      await new ALL_MIGRATIONS[0]().up(runner); // re-apply the body directly
      await runner.release();
      const open: { n: number }[] = await ds.query(
        `SELECT count(*)::int n FROM device_ownerships WHERE "endedAt" IS NULL AND "deviceId" = 'dev-a'`,
      );
      expect(open[0].n).toBe(1);
    } finally {
      await ds.destroy();
    }
  });

  it('allows at most one open interval per device', async () => {
    await seedBaseSchema(BASE);
    const ds = await migrate(BASE);
    try {
      await expect(
        ds.query(
          `INSERT INTO device_ownerships ("deviceId","userId","startedAt","startReason") VALUES ('dev-a', 9, now(), 'claim')`,
        ),
      ).rejects.toThrow(/ux_device_ownerships_open/);
    } finally {
      await ds.destroy();
    }
  });

  it('marks pre-existing alerts as already handled and new alerts as pending (AR-5)', async () => {
    await seedBaseSchema(BASE);
    const ds = await migrate(BASE);
    try {
      await ds.query(
        `INSERT INTO alerts (id, "deviceId", type, title, timestamp, "isDismissed", "isAttended", "isFalseAlarm", "syncSlot")
         VALUES ('fall_dev-a_new', 'dev-a', 'fall', 'Fall', now(), false, false, false, 'iot_live')`,
      );
      const rows: any[] = await ds.query(
        `SELECT id, "dispatchState" FROM alerts ORDER BY id`,
      );
      expect(rows).toEqual([
        { id: 'fall_dev-a_new', dispatchState: 'pending' },
        { id: 'fall_dev-a_old', dispatchState: 'skipped' },
      ]);
    } finally {
      await ds.destroy();
    }
  });

  it('creates device_events with per-device event idempotency and a unique alert eventId (AR-9)', async () => {
    await seedBaseSchema(BASE);
    const ds = await migrate(BASE);
    try {
      const ev = `INSERT INTO device_events ("deviceId","eventId",type,"detectedAt",payload)
                  VALUES ($1, '3f1c2a9e-6b1d-4c4f-9a2e-1b2c3d4e5f60', $2, now(), '{}')`;
      await ds.query(ev, ['dev-a', 'fall']);
      await expect(ds.query(ev, ['dev-a', 'fall'])).rejects.toThrow(
        /uq_device_events_device_event/,
      );
      await ds.query(ev, ['dev-sync', 'sos']); // same id from another device is a different event
      await expect(ds.query(ev, ['dev-free', 'temp'])).rejects.toThrow(
        /chk_device_events_type/,
      );
      const id = '3f1c2a9e-6b1d-4c4f-9a2e-1b2c3d4e5f60';
      await ds.query(
        `UPDATE alerts SET "eventId" = $1 WHERE id = 'fall_dev-a_old'`,
        [id],
      );
      await ds.query(
        `INSERT INTO alerts (id, "deviceId", type, title, timestamp, "syncSlot") VALUES ('x', 'dev-a', 'fall', 'Fall', now(), 'iot_event')`,
      );
      await expect(
        ds.query(`UPDATE alerts SET "eventId" = $1 WHERE id = 'x'`, [id]),
      ).rejects.toThrow(/uq_alerts_event_id/);
    } finally {
      await ds.destroy();
    }
  });

  it('reverts every migration cleanly', async () => {
    await seedBaseSchema(BASE);
    const ds = await migrate(BASE);
    try {
      for (let i = 0; i < ALL_MIGRATIONS.length; i++)
        await ds.undoLastMigration();
      const t: any[] = await ds.query(
        `SELECT to_regclass('public.device_ownerships') AS a, to_regclass('public.device_events') AS b,
                to_regclass('public.push_tokens') AS c, to_regclass('public.notification_attempts') AS d`,
      );
      expect(t[0]).toEqual({ a: null, b: null, c: null, d: null });
      const col: { n: number }[] = await ds.query(
        `SELECT count(*)::int n FROM information_schema.columns WHERE table_name = 'alerts' AND column_name = 'dispatchState'`,
      );
      expect(col[0].n).toBe(0);
    } finally {
      await ds.destroy();
    }
  });
});
