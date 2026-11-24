/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access */
/**
 * AR-3 against real PostgreSQL: moisture episodes persisted with a partial
 * unique index so that restarts and concurrent processes still produce ONE
 * episode and ONE alert per sustained wet condition. SKIPPED unless
 * TEST_DATABASE_URL is set; refuses non-"test" databases. Run --runInBand.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { DataSource } from 'typeorm';
import {
  Alert,
  AlertAction,
  AlertEpisode,
  Device,
  DeviceOwnership,
  DeviceStatus,
  DeviceType,
  RecordingSession,
  SyncHistory,
  Vital,
} from '../database/entities';
import { IotDevice } from '../iot-device/iot-device.entity';
import { MoistureEpisodeService } from './moisture-episode.service';

const url = process.env.TEST_DATABASE_URL;
const describePg = url ? describe : describe.skip;
const ENTITIES = [
  Device,
  IotDevice,
  Vital,
  Alert,
  AlertAction,
  AlertEpisode,
  DeviceStatus,
  RecordingSession,
  SyncHistory,
  DeviceOwnership,
];
const T = Date.parse('2026-10-12T00:00:00.000Z');

const wet = (fromS: number, toS: number, value = 40) =>
  Array.from({ length: toS - fromS + 1 }, (_, i) => ({
    ts: T + (fromS + i) * 1000,
    moisture: value,
  }));

describePg('moisture episodes (AR-3, real PostgreSQL)', () => {
  let ds: DataSource;
  const savedPolicy = process.env.ALERT_POLICY_PATH;

  beforeAll(async () => {
    const dbName = new URL(url as string).pathname.replace('/', '');
    if (!/test/i.test(dbName))
      throw new Error(
        `Refusing to drop schema of non-test database "${dbName}"`,
      );
    // Same rule shape as the repository policy, shorter cooldown for the test.
    const policy = JSON.parse(
      fs.readFileSync(
        require.resolve('@sotercare/contracts/policy/default.alert-policy.v1.json'),
        'utf8',
      ),
    );
    policy.moisture.reopenCooldownSeconds = 300;
    const file = path.join(
      fs.mkdtempSync(path.join(os.tmpdir(), 'policy-')),
      'alert-policy.json',
    );
    fs.writeFileSync(file, JSON.stringify(policy));
    process.env.ALERT_POLICY_PATH = file;
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
    process.env.ALERT_POLICY_PATH = savedPolicy;
    await ds?.destroy();
  });

  beforeEach(async () => {
    await ds.query(
      'TRUNCATE alert_episodes, alert_actions, alerts, devices CASCADE',
    );
    await ds.getRepository(Device).insert({
      id: 'dev-m',
      userId: 1,
      name: 'm',
      type: DeviceType.HUB,
      lastSeenAt: new Date(),
      lastSyncSlot: 'iot_live',
      syncSource: 'iot_claim',
    });
  });

  const counts = async () => {
    const [{ a }] = await ds.query(
      `SELECT count(*)::int a FROM alerts WHERE type = 'moisture'`,
    );
    const [{ e }] = await ds.query(
      `SELECT count(*)::int e FROM alert_episodes`,
    );
    return { alerts: a as number, episodes: e as number };
  };

  it('turns one hour of continuous wetness into one episode and one alert', async () => {
    const svc = new MoistureEpisodeService(ds);
    const samples = wet(0, 3599);
    const created: string[] = [];
    for (let i = 0; i < samples.length; i += 100) {
      created.push(
        ...(await svc.process('dev-m', samples.slice(i, i + 100))).map(
          (a) => a.id,
        ),
      );
    }
    expect(created).toEqual([`moisture_dev-m_${T + 10_000}`]);
    expect(await counts()).toEqual({ alerts: 1, episodes: 1 });
    const [ep] = await ds.query(`SELECT state, "alertId" FROM alert_episodes`);
    expect(ep).toEqual({
      state: 'open',
      alertId: `moisture_dev-m_${T + 10_000}`,
    });
  });

  it('does not create a second alert after a process restart mid-episode', async () => {
    await new MoistureEpisodeService(ds).process('dev-m', wet(0, 60));
    const restarted = new MoistureEpisodeService(ds); // fresh in-memory state
    expect(await restarted.process('dev-m', wet(61, 600))).toEqual([]);
    expect(await counts()).toEqual({ alerts: 1, episodes: 1 });
  });

  it('creates one episode when two processes handle the same device concurrently', async () => {
    const a = new MoistureEpisodeService(ds);
    const b = new MoistureEpisodeService(ds);
    await Promise.all([
      a.process('dev-m', wet(0, 30)),
      b.process('dev-m', wet(0, 30)),
    ]);
    expect(await counts()).toEqual({ alerts: 1, episodes: 1 });
  });

  it('reopens within the cooldown without a new alert, and opens a new episode after it', async () => {
    const svc = new MoistureEpisodeService(ds);
    await svc.process('dev-m', [...wet(0, 20), ...wet(21, 150, 5)]); // open @10, closed @141
    expect((await ds.query(`SELECT state FROM alert_episodes`))[0].state).toBe(
      'closed',
    );
    expect(
      await svc.process('dev-m', [...wet(200, 220), ...wet(221, 400, 5)]),
    ).toEqual([]); // reopen, close @341
    expect(await counts()).toEqual({ alerts: 1, episodes: 1 });
    const later = await svc.process('dev-m', wet(700, 720)); // 359 s after close > 300 s cooldown
    expect(later.map((x) => x.id)).toEqual([`moisture_dev-m_${T + 710_000}`]);
    expect(await counts()).toEqual({ alerts: 2, episodes: 2 });
  });

  it('still alerts after a failed episode write, once the samples are resent', async () => {
    const svc = new MoistureEpisodeService(ds);
    const spy = jest
      .spyOn(ds, 'transaction')
      .mockRejectedValueOnce(new Error('db unavailable'));
    await expect(svc.process('dev-m', wet(0, 30))).rejects.toThrow(
      'db unavailable',
    );
    spy.mockRestore();
    // The gateway resends the batch (non-success ack), then keeps streaming.
    const created = await svc.process('dev-m', wet(0, 60));
    expect(created.map((a) => a.id)).toEqual([`moisture_dev-m_${T + 10_000}`]);
    expect(await counts()).toEqual({ alerts: 1, episodes: 1 });
  });

  it('closing an episode never acknowledges its alert', async () => {
    const svc = new MoistureEpisodeService(ds);
    await svc.process('dev-m', [...wet(0, 20), ...wet(21, 200, 5)]);
    const [alert] = await ds.query(
      `SELECT "isAttended", "acknowledgedAt", "episodeId" FROM alerts`,
    );
    expect(alert.isAttended).toBe(false);
    expect(alert.acknowledgedAt).toBeNull();
    expect(alert.episodeId).not.toBeNull();
  });
});
