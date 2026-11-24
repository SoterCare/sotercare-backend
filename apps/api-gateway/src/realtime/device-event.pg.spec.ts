/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-return */
/**
 * AR-9 against real PostgreSQL (design tests UT-13, IT-08, IT-09): durable
 * gateway safety events are acknowledged only after commit, are idempotent per
 * (device, event_id), converge with the legacy boolean path on the same alert
 * id, and are quarantined (recorded, no alert) when no current owner may see
 * them. The service never throws: every outcome is a contract-valid ack.
 * SKIPPED unless TEST_DATABASE_URL is set; refuses non-"test" databases.
 */
import Ajv2020 from 'ajv/dist/2020';
import * as fs from 'fs';
import * as path from 'path';
import { DataSource } from 'typeorm';
import {
  Alert,
  AlertAction,
  AlertEpisode,
  AlertType,
  Device,
  DeviceEvent,
  DeviceOwnership,
  DeviceStatus,
  DeviceType,
  RecordingSession,
  SyncHistory,
  Vital,
} from '../database/entities';
import { IotDevice } from '../iot-device/iot-device.entity';
import { OwnershipService } from '../ownership/ownership.service';
import { DeviceEventService } from './device-event.service';

const url = process.env.TEST_DATABASE_URL;
const describePg = url ? describe : describe.skip;
const ENTITIES = [
  Device,
  IotDevice,
  Vital,
  Alert,
  AlertAction,
  AlertEpisode,
  DeviceEvent,
  DeviceStatus,
  RecordingSession,
  SyncHistory,
  DeviceOwnership,
];
const CONTRACTS = path.resolve(__dirname, '../../../../contracts/v1');
// Compiled lazily so the suite skips cleanly when no database is configured.
const loadAckSchema = () =>
  new Ajv2020({ strict: true }).compile(
    JSON.parse(
      fs.readFileSync(
        path.join(CONTRACTS, 'device_event_ack.schema.json'),
        'utf8',
      ),
    ),
  );
let ackSchema: ReturnType<typeof loadAckSchema> = (() =>
  false) as unknown as ReturnType<typeof loadAckSchema>;

const DEV = 'dev-e';
const E1 = '3f1c2a9e-6b1d-4c4f-9a2e-1b2c3d4e5f60';
const E2 = '7a6b5c4d-3e2f-4a1b-8c9d-0e1f2a3b4c5d';
const sec = (ms: number) => Math.floor(ms / 1000) * 1000;

function event(over: Record<string, unknown> = {}) {
  return {
    schema: 'sotercare.device_event.v1',
    event_id: E1,
    type: 'fall',
    device_id: DEV,
    node_mac: null,
    detected_at: Date.now() - 5_000,
    seq: 1,
    boot_id: 'boot-1',
    clock_synced: true,
    attempt: 1,
    source: 'udp',
    ...over,
  };
}

describePg('device_event ingest (AR-9, real PostgreSQL)', () => {
  beforeAll(() => {
    ackSchema = loadAckSchema();
  });
  let ds: DataSource;
  let kick: jest.Mock;
  let svc: DeviceEventService;
  const saved = { ...process.env };

  beforeAll(async () => {
    const dbName = new URL(url as string).pathname.replace('/', '');
    if (!/test/i.test(dbName))
      throw new Error(
        `Refusing to drop schema of non-test database "${dbName}"`,
      );
    ds = new DataSource({
      type: 'postgres',
      url,
      entities: ENTITIES,
      synchronize: true,
      dropSchema: true,
    });
    await ds.initialize();
  });

  afterAll(async () => {
    process.env = saved;
    await ds?.destroy();
  });

  beforeEach(async () => {
    process.env = { ...saved, DEVICE_EVENT_LOCK_TIMEOUT_MS: '300' };
    delete process.env.DEVICE_EVENTS_ENABLED;
    await ds.query(
      'TRUNCATE device_events, alert_actions, alert_episodes, alerts, device_ownerships, devices CASCADE',
    );
    await ds.getRepository(Device).insert({
      id: DEV,
      userId: 1,
      name: 'e',
      type: DeviceType.HUB,
      lastSeenAt: new Date(),
      lastSyncSlot: 'iot_live',
      syncSource: 'iot_claim',
    });
    await ds.getRepository(DeviceOwnership).insert({
      deviceId: DEV,
      userId: 1,
      startedAt: new Date(Date.now() - 3_600_000),
      endedAt: null,
      startReason: 'claim',
      endReason: null,
    });
    kick = jest.fn().mockResolvedValue(1);
    svc = new DeviceEventService(
      ds,
      new OwnershipService(ds.getRepository(DeviceOwnership)),
      { kick } as any,
    );
  });

  /** Every ack must satisfy the v1 contract. */
  async function ingest(body: unknown, socketDevice: string | null = DEV) {
    const ack = await svc.ingest(socketDevice ?? undefined, body);
    expect(ackSchema(ack)).toBe(true);
    return ack as any;
  }
  const rows = async () => ({
    events: await ds.query(
      `SELECT "eventId", "alertId", quarantined, "clockSuspect" FROM device_events`,
    ),
    alerts: await ds.query(
      `SELECT id, type, title, "syncSlot", "eventId", "dispatchState", timestamp FROM alerts`,
    ),
  });

  it('accepts a fall after commit with the legacy-compatible alert id and kicks the dispatcher', async () => {
    const e = event();
    const ack = await ingest(e);
    const id = `fall_${DEV}_${sec(e.detected_at)}`;
    expect(ack).toMatchObject({
      accepted: true,
      success: true,
      event_id: E1,
      alert_id: id,
      duplicate: false,
      quarantined: false,
    });
    const { events, alerts } = await rows();
    expect(events).toEqual([
      { eventId: E1, alertId: id, quarantined: false, clockSuspect: false },
    ]);
    expect(alerts).toEqual([
      expect.objectContaining({
        id,
        type: AlertType.FALL,
        title: 'Fall Detected',
        syncSlot: 'iot_event',
        eventId: E1,
        dispatchState: 'pending',
      }),
    ]);
    expect(kick).toHaveBeenCalledWith([id]);
  });

  it('maps sos to a help_call with the sos_ prefix', async () => {
    const e = event({ type: 'sos' });
    const ack = await ingest(e);
    expect(ack.alert_id).toBe(`sos_${DEV}_${sec(e.detected_at)}`);
    expect((await rows()).alerts[0]).toMatchObject({
      type: AlertType.HELP_CALL,
      title: 'Help Call',
    });
  });

  it('acks five retries of the same event as duplicates of one event and one alert', async () => {
    const e = event();
    const first = await ingest(e);
    for (let attempt = 2; attempt <= 6; attempt++) {
      expect(await ingest({ ...e, attempt })).toMatchObject({
        accepted: true,
        duplicate: true,
        alert_id: first.alert_id,
      });
    }
    const { events, alerts } = await rows();
    expect([events.length, alerts.length]).toEqual([1, 1]);
    expect(kick).toHaveBeenCalledTimes(1);
  });

  it('adopts the alert the legacy boolean path already wrote for the same second', async () => {
    const e = event();
    const legacyId = `fall_${DEV}_${sec(e.detected_at)}`;
    await ds.query(
      `INSERT INTO alerts (id, "deviceId", type, title, timestamp, "syncSlot", "dispatchState") VALUES ($1, $2, 'fall', 'Fall Detected', $3, 'iot_live', 'dispatched')`,
      [legacyId, DEV, new Date(sec(e.detected_at))],
    );
    const ack = await ingest(e);
    expect(ack).toMatchObject({
      accepted: true,
      alert_id: legacyId,
      duplicate: false,
    });
    const { alerts } = await rows();
    expect(alerts).toEqual([
      expect.objectContaining({
        id: legacyId,
        eventId: E1,
        dispatchState: 'dispatched',
      }),
    ]);
    expect(kick).not.toHaveBeenCalled(); // the legacy path already announced it
  });

  it('accepts an event detected 20 minutes ago and marks the clock suspect', async () => {
    const e = event({ detected_at: Date.now() - 20 * 60_000 });
    const ack = await ingest(e);
    expect(ack.alert_id).toBe(`fall_${DEV}_${sec(e.detected_at)}`);
    expect((await rows()).events[0].clockSuspect).toBe(true);
  });

  it('uses server time and an _evt_ id when the gateway clock is 10 minutes in the future', async () => {
    const before = Date.now();
    const ack = await ingest(event({ detected_at: Date.now() + 10 * 60_000 }));
    expect(ack.alert_id).toBe(`fall_${DEV}_evt_${E1}`);
    const { events, alerts } = await rows();
    expect(events[0].clockSuspect).toBe(true);
    expect(new Date(alerts[0].timestamp).getTime()).toBeGreaterThanOrEqual(
      before - 1000,
    );
    expect(new Date(alerts[0].timestamp).getTime()).toBeLessThanOrEqual(
      Date.now() + 1000,
    );
  });

  it('gives a second distinct event in the same second its own _evt_ alert', async () => {
    const t = sec(Date.now() - 5_000) + 100;
    await ingest(event({ detected_at: t }));
    const ack = await ingest(
      event({ event_id: E2, detected_at: t + 300, seq: 2 }),
    );
    expect(ack).toMatchObject({
      accepted: true,
      duplicate: false,
      alert_id: `fall_${DEV}_evt_${E2}`,
    });
    expect((await rows()).alerts).toHaveLength(2);
  });

  it('rejects a reused event_id with different content as event_conflict without changing anything', async () => {
    await ingest(event());
    const ack = await ingest(event({ type: 'sos' }));
    expect(ack).toMatchObject({
      accepted: false,
      retryable: false,
      reason: 'event_conflict',
      event_id: E1,
    });
    expect((await rows()).alerts).toHaveLength(1);
  });

  it.each([
    [
      'invalid payload',
      { ...event(), type: 'temperature' },
      DEV,
      { retryable: false, reason: 'invalid_payload' },
    ],
    [
      'device mismatch',
      event({ device_id: 'someone-else' }),
      DEV,
      { retryable: false, reason: 'device_mismatch' },
    ],
    [
      'unauthenticated socket',
      event(),
      null,
      { retryable: true, reason: 'not_authenticated' },
    ],
  ])(
    'refuses %s with a contract ack and writes nothing',
    async (_name, body, socketDevice, expected) => {
      expect(await ingest(body, socketDevice)).toMatchObject({
        accepted: false,
        success: false,
        ...expected,
      });
      const { events, alerts } = await rows();
      expect([events.length, alerts.length]).toEqual([0, 0]);
    },
  );

  it('acks disabled (retryable) when DEVICE_EVENTS_ENABLED=false so the gateway keeps the event', async () => {
    process.env.DEVICE_EVENTS_ENABLED = 'false';
    expect(await ingest(event())).toMatchObject({
      accepted: false,
      retryable: true,
      reason: 'disabled',
    });
    expect((await rows()).events).toHaveLength(0);
  });

  it('quarantines an event from an unclaimed device: recorded, no alert, nobody notified', async () => {
    await ds.query(
      `UPDATE device_ownerships SET "endedAt" = now(), "endReason" = 'unclaim'`,
    );
    const e = event();
    const ack = await ingest(e);
    expect(ack).toMatchObject({
      accepted: true,
      alert_id: null,
      quarantined: true,
      duplicate: false,
    });
    const { events, alerts } = await rows();
    expect(events).toEqual([
      expect.objectContaining({ alertId: null, quarantined: true }),
    ]);
    expect(alerts).toHaveLength(0);
    expect(kick).not.toHaveBeenCalled();
    expect(await ingest({ ...e, attempt: 2 })).toMatchObject({
      duplicate: true,
      quarantined: true,
      alert_id: null,
    });
  });

  it('quarantines an event detected before the current owner’s period began', async () => {
    const ack = await ingest(
      event({ detected_at: Date.now() - 2 * 3_600_000 }),
    );
    expect(ack).toMatchObject({
      accepted: true,
      alert_id: null,
      quarantined: true,
    });
    expect((await rows()).alerts).toHaveLength(0);
  });

  it('IT-08: acks retryable internal_error and leaves no rows when the lock cannot be taken, then succeeds on retry', async () => {
    const holder = ds.createQueryRunner();
    await holder.connect();
    await holder.query(`SELECT pg_advisory_lock(hashtext($1))`, [
      `alert:${DEV}:fall`,
    ]);
    const e = event();
    try {
      expect(await ingest(e)).toMatchObject({
        accepted: false,
        retryable: true,
        reason: 'internal_error',
        event_id: E1,
      });
      const { events, alerts } = await rows();
      expect([events.length, alerts.length]).toEqual([0, 0]);
    } finally {
      await holder.query(`SELECT pg_advisory_unlock(hashtext($1))`, [
        `alert:${DEV}:fall`,
      ]);
      await holder.release();
    }
    expect(await ingest({ ...e, attempt: 2 })).toMatchObject({
      accepted: true,
      duplicate: false,
    });
    const { events, alerts } = await rows();
    expect([events.length, alerts.length]).toEqual([1, 1]);
  });

  it('IT-09: concurrent copies of one event yield one event, one alert and the same alert id', async () => {
    const e = event();
    const other = new DeviceEventService(
      ds,
      new OwnershipService(ds.getRepository(DeviceOwnership)),
      { kick } as any,
    );
    const [a, b] = await Promise.all([
      svc.ingest(DEV, e),
      other.ingest(DEV, { ...e, attempt: 2 }),
    ]);
    expect([a.accepted, b.accepted]).toEqual([true, true]);
    expect((a as any).alert_id).toBe((b as any).alert_id);
    const { events, alerts } = await rows();
    expect([events.length, alerts.length]).toEqual([1, 1]);
  });
});
