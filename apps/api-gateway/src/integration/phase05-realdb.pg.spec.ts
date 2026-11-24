/* eslint-disable @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unused-vars */
/**
 * Phase 0.5 real-PostgreSQL verification: services, HTTP and Socket.IO wired
 * to a real database through real TypeORM (no in-memory fakes). The only stub
 * is the health-service gRPC client, which records the user_id each telemetry
 * batch is attributed to.
 *
 * SKIPPED unless TEST_DATABASE_URL is set. DROPS the schema; refuses to run
 * unless the database name contains "test". Run Postgres suites in band:
 *
 *   TEST_DATABASE_URL=postgres://postgres:<pw>@127.0.0.1:55432/sotercare_test \
 *     npx jest --runInBand apps/api-gateway/src/integration/phase05-realdb.pg.spec.ts
 */
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { Test } from '@nestjs/testing';
import { getDataSourceToken, TypeOrmModule } from '@nestjs/typeorm';
import { execFile } from 'child_process';
import * as fs from 'fs';
import * as jwt from 'jsonwebtoken';
import * as os from 'os';
import * as path from 'path';
import { of } from 'rxjs';
import { io, Socket as ClientSocket } from 'socket.io-client';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { AlertsController } from '../alerts/alerts.controller';
import { AlertDispatchService } from '../alerts/alert-dispatch.service';
import { InternalAlertsController } from '../alerts/internal-alerts.controller';
import { AlertEventsPublisher } from '../realtime/alert-events.publisher';
import { UserSocketRegistry } from '../realtime/user-socket.registry';
import { DeviceEventService } from '../realtime/device-event.service';
import { NotificationsController } from '../notifications/notifications.controller';
import { NotificationAttemptsService } from '../notifications/notification-attempts.service';
import { PushTokensService } from '../notifications/push-tokens.service';
import { PipelineStatusService } from '../alerts/pipeline-status.service';
import { NotificationSenderService } from '../notifications/notification-sender.service';
import { FakePushProvider } from '../../test/support/fake-push-provider';
import { AlertsService } from '../alerts/alerts.service';
import { JwtStrategy } from '../auth/jwt.strategy';
import { HttpExceptionFilter } from '../common/filters/http-exception.filter';
import { ResponseInterceptor } from '../common/interceptors/response.interceptor';
import { DashboardController } from '../dashboard/dashboard.controller';
import { DashboardService } from '../dashboard/dashboard.service';
import {
  Alert,
  AlertAction,
  AlertEpisode,
  AlertType,
  Device,
  DeviceEvent,
  DeviceOwnership,
  DeviceStatus,
  NotificationAttempt,
  PushToken,
  RecordingSession,
  SyncHistory,
  Vital,
} from '../database/entities';
import { DevicesController } from '../devices/devices.controller';
import { DevicesService } from '../devices/devices.service';
import { IotDeviceController } from '../iot-device/iot-device.controller';
import { IotDevice } from '../iot-device/iot-device.entity';
import { IotDeviceService } from '../iot-device/iot-device.service';
import { OwnershipService } from '../ownership/ownership.service';
import { RealtimeGateway } from '../realtime/realtime.gateway';
import { SyncController } from '../sync/sync.controller';
import { SyncService } from '../sync/sync.service';
import { TimelineController } from '../timeline/timeline.controller';
import { TimelineService } from '../timeline/timeline.service';
import { configStub, syncBatch } from '../../test/support/phase0-fixtures';

const url = process.env.TEST_DATABASE_URL;
const describePg = url ? describe : describe.skip;

const ALICE = 1;
const BOB = 2;
const KEY = {
  'dev-alice': 'synthetic-key-alice',
  'dev-bob': 'synthetic-key-bob',
  'dev-free': 'synthetic-key-free',
};
const today = new Date().toISOString().slice(0, 10);
const hourOf = (h: number, m = 0) =>
  new Date(
    `${today}T${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:00.000Z`,
  );
const token = (userId: number) =>
  jwt.sign(
    {
      userId: String(userId),
      sub: userId,
      email: `u${userId}@example.invalid`,
      name: `U${userId}`,
    },
    process.env.JWT_SECRET as string,
    { expiresIn: '10m' },
  );
const auth = (userId: number) => ({ Authorization: `Bearer ${token(userId)}` });
const nowSec = () => Math.floor(Date.now() / 1000);
const INTERNAL_TOKEN = 'synthetic-internal-token-'.padEnd(48, 'x');

describePg('Phase 0.5 — real PostgreSQL', () => {
  let app: INestApplication;
  let ds: DataSource;
  let iot: IotDeviceService;
  let baseUrl: string;
  const syncLogs = jest.fn((_req: any) =>
    of({ success: true, message: 'ok', synced_count: 1 }),
  );
  const sockets: ClientSocket[] = [];

  beforeAll(async () => {
    process.env.INTERNAL_SERVICE_TOKEN = INTERNAL_TOKEN;
    process.env.ALERT_DISPATCH_SWEEP_MS = '200';
    const dbName = new URL(url as string).pathname.replace('/', '');
    if (!/test/i.test(dbName))
      throw new Error(
        `Refusing to drop schema of non-test database "${dbName}"`,
      );
    const entities = [
      Device,
      IotDevice,
      Vital,
      Alert,
      DeviceStatus,
      RecordingSession,
      SyncHistory,
      DeviceOwnership,
      AlertAction,
      AlertEpisode,
      DeviceEvent,
      PushToken,
      NotificationAttempt,
    ];
    const moduleRef = await Test.createTestingModule({
      imports: [
        TypeOrmModule.forRoot({
          type: 'postgres',
          url,
          entities,
          synchronize: true,
          dropSchema: true,
          invalidWhereValuesBehavior: { undefined: 'throw' },
          extra: { max: 20 },
        }),
        TypeOrmModule.forFeature(entities),
        PassportModule,
        JwtModule.register({ secret: process.env.JWT_SECRET }),
      ],
      controllers: [
        SyncController,
        DashboardController,
        TimelineController,
        AlertsController,
        DevicesController,
        IotDeviceController,
        InternalAlertsController,
        NotificationsController,
      ],
      providers: [
        JwtStrategy,
        SyncService,
        DashboardService,
        TimelineService,
        AlertsService,
        DevicesService,
        IotDeviceService,
        RealtimeGateway,
        OwnershipService,
        UserSocketRegistry,
        AlertEventsPublisher,
        AlertDispatchService,
        DeviceEventService,
        PushTokensService,
        NotificationAttemptsService,
        PipelineStatusService,
        { provide: ConfigService, useValue: configStub() },
        {
          provide: 'HEALTH_SERVICE',
          useValue: { getService: () => ({ syncLogs }) },
        },
      ],
    }).compile();
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({ transform: true, forbidUnknownValues: false }),
    );
    app.useGlobalFilters(new HttpExceptionFilter());
    app.useGlobalInterceptors(new ResponseInterceptor());
    await app.listen(0, '127.0.0.1');
    baseUrl = (await app.getUrl()).replace('[::1]', '127.0.0.1');
    ds = app.get(getDataSourceToken());
    iot = app.get(IotDeviceService);
  }, 60_000);

  afterAll(async () => {
    sockets.forEach((s) => s.disconnect());
    await app?.close();
  });

  beforeEach(async () => {
    syncLogs.mockClear();
    sockets.splice(0).forEach((s) => s.disconnect());
    await ds.query(
      'TRUNCATE notification_attempts, push_tokens, device_events, alert_actions, alert_episodes, alerts, vitals, device_statuses, recording_sessions, sync_history, devices, iot_devices, device_ownerships CASCADE',
    );
    for (const [deviceId, key] of Object.entries(KEY))
      await iot.registerDevice(deviceId, key);
    await iot.claimDevice(ALICE, 'dev-alice');
    await iot.claimDevice(BOB, 'dev-bob');
    // Same hour, different tenants: a leak would pull Bob's 39.9 into Alice's average.
    await ds.getRepository(Vital).insert([
      {
        deviceId: 'dev-alice',
        timestamp: hourOf(1, 5),
        temperature: 36.0,
        roomTemperature: 24,
        moisture: 3,
        gaitAnalysis: 'walking',
        thighnodeStatus: null,
        syncSlot: 'iot_live',
      },
      {
        deviceId: 'dev-alice',
        timestamp: hourOf(1, 35),
        temperature: 37.0,
        roomTemperature: 24,
        moisture: 4,
        gaitAnalysis: 'walking',
        thighnodeStatus: null,
        syncSlot: 'iot_live',
      },
      {
        deviceId: 'dev-bob',
        timestamp: hourOf(1, 20),
        temperature: 39.9,
        roomTemperature: 30,
        moisture: 88,
        gaitAnalysis: 'sitting idle',
        thighnodeStatus: null,
        syncSlot: 'iot_live',
      },
    ]);
    const alert = (
      id: string,
      deviceId: string,
      type: AlertType,
      attended = false,
    ) => ({
      id,
      deviceId,
      type,
      title: type,
      timestamp: hourOf(2),
      isDismissed: false,
      isAttended: attended,
      isFalseAlarm: false,
      dismissedAt: null,
      syncSlot: 'iot_live',
      // Historical fixtures, as the AR-5 migration marks pre-existing rows.
      dispatchState: 'skipped' as const,
    });
    await ds
      .getRepository(Alert)
      .insert([
        alert('fall_alice_1', 'dev-alice', AlertType.FALL, true),
        alert('fall_bob_1', 'dev-bob', AlertType.FALL, true),
        alert('fall_bob_2', 'dev-bob', AlertType.FALL),
        alert('fall_bob_3', 'dev-bob', AlertType.FALL),
      ]);
  });

  const server = () => app.getHttpServer();
  const count = async (sql: string, params: any[] = []) =>
    Number((await ds.query(sql, params))[0].n);

  // ── A. ownership writes ──────────────────────────────────────────────────
  describe('sync ownership and rollback', () => {
    it('rolls back a batch whose new-device insert precedes the failed ownership check', async () => {
      await request(server())
        .post('/sync/raspberry-pi')
        .set(auth(ALICE))
        .send(
          syncBatch({
            devices: [{ id: 'dev-new-x', name: 'n', type: 'hub' }],
            latestVitals: [
              {
                deviceId: 'dev-new-x',
                timestamp: new Date().toISOString(),
                temperature: 36,
              },
            ],
            recentAlerts: [
              {
                id: 'planted',
                deviceId: 'dev-bob',
                type: 'fall',
                title: 'x',
                timestamp: new Date().toISOString(),
              },
            ],
          }),
        )
        .expect(403);
      expect(
        await count(`SELECT count(*) n FROM devices WHERE id = 'dev-new-x'`),
      ).toBe(0);
      expect(
        await count(
          `SELECT count(*) n FROM vitals WHERE "deviceId" = 'dev-new-x'`,
        ),
      ).toBe(0);
      expect(
        await count(`SELECT count(*) n FROM alerts WHERE id = 'planted'`),
      ).toBe(0);
      expect(await count(`SELECT count(*) n FROM sync_history`)).toBe(0);
      expect(
        (await ds.query(`SELECT "userId" FROM devices WHERE id = 'dev-bob'`))[0]
          .userId,
      ).toBe(BOB);
    });

    it("refuses to re-point another user's recording session", async () => {
      await request(server())
        .post('/sync/raspberry-pi')
        .set(auth(BOB))
        .send(
          syncBatch({
            slot: 'b',
            recordingSessions: [
              {
                recordingId: 'rec-b',
                deviceId: 'dev-bob',
                createdAt: new Date().toISOString(),
              },
            ],
          }),
        )
        .expect(201);
      await request(server())
        .post('/sync/raspberry-pi')
        .set(auth(ALICE))
        .send(
          syncBatch({
            slot: 'a',
            recordingSessions: [
              {
                recordingId: 'rec-b',
                deviceId: 'dev-alice',
                createdAt: new Date().toISOString(),
              },
            ],
          }),
        )
        .expect(403);
      expect(
        (
          await ds.query(
            `SELECT "deviceId" FROM recording_sessions WHERE "recordingId" = 'rec-b'`,
          )
        )[0].deviceId,
      ).toBe('dev-bob');
    });

    it('serialises 30 concurrent same-owner batches over overlapping devices without deadlock', async () => {
      await iot.registerDevice('dev-a2', 'synthetic-key-a2');
      await iot.claimDevice(ALICE, 'dev-a2');
      const results = await Promise.allSettled(
        Array.from({ length: 30 }, (_, i) =>
          request(server())
            .post('/sync/raspberry-pi')
            .set(auth(ALICE))
            .send(
              syncBatch({
                slot: `s${i}`,
                devices: (i % 2
                  ? ['dev-alice', 'dev-a2']
                  : ['dev-a2', 'dev-alice']
                ).map((id) => ({ id, name: id, type: 'hub' })),
                latestVitals: [
                  {
                    deviceId: 'dev-alice',
                    timestamp: new Date(Date.now() - i * 1000).toISOString(),
                    temperature: 36.5,
                  },
                ],
              }),
            ),
        ),
      );
      const statuses = results.map((r) =>
        r.status === 'fulfilled' ? r.value.status : 'rejected',
      );
      expect(statuses.filter((s) => s !== 201)).toEqual([]);
    }, 60_000);
  });

  describe('claim / unclaim under concurrency', () => {
    it('never yields two owners when an unclaim races claims from ten other users', async () => {
      const users = Array.from({ length: 10 }, (_, i) => 100 + i);
      const [unclaim, ...claims] = await Promise.all([
        iot.unclaimDevice(ALICE, 'dev-alice').then(() => 'released'),
        ...users.map((u) =>
          iot.claimDevice(u, 'dev-alice').then(
            () => u,
            () => null,
          ),
        ),
      ]);
      expect(unclaim).toBe('released');
      const winners = claims.filter((c) => c !== null);
      expect(winners.length).toBeLessThanOrEqual(1);
      const row = (
        await ds.query(
          `SELECT i."ownerId" io, d."userId" du FROM iot_devices i LEFT JOIN devices d ON d.id = i."deviceId" WHERE i."deviceId" = 'dev-alice'`,
        )
      )[0];
      if (winners.length === 1) {
        expect([row.io, row.du]).toEqual([winners[0], winners[0]]);
      } else {
        expect(row.io).toBeNull();
        expect(row.du).toBe(0);
      }
    });
  });

  // ── B. reads after unclaim and cross-tenant reads (real SQL) ─────────────
  describe('authorization on real queries', () => {
    it('isolates timeline aggregates per tenant (query-builder SQL)', async () => {
      const vitals = await request(server())
        .get(
          `/timeline/vitals?deviceId=dev-alice&metric=temp&period=day&date=${today}&tzOffsetMinutes=0`,
        )
        .set(auth(ALICE))
        .expect(200);
      const values =
        JSON.stringify(vitals.body).match(/"value":(\d+(\.\d+)?)/g) ?? [];
      expect(values).toEqual(['"value":36.5']);
      const stats = await request(server())
        .get(
          `/timeline/stats?deviceId=dev-alice&period=day&date=${today}&tzOffsetMinutes=0`,
        )
        .set(auth(ALICE))
        .expect(200);
      expect(JSON.stringify(stats.body)).toContain('"falls":1');
      const options = await request(server())
        .get(
          '/timeline/date-options?deviceId=dev-alice&period=day&tzOffsetMinutes=0',
        )
        .set(auth(ALICE))
        .expect(200);
      expect(JSON.stringify(options.body)).toContain(today.replace(/-/g, '/'));
      const events = await request(server())
        .get(
          `/timeline/events?deviceId=dev-alice&period=day&date=${today}&tzOffsetMinutes=0`,
        )
        .set(auth(ALICE))
        .expect(200);
      expect(JSON.stringify(events.body)).toContain('fall_alice_1');
      expect(JSON.stringify(events.body)).not.toContain('bob');
    });

    it.each(['vitals?metric=temp&', 'events?', 'stats?', 'date-options?'])(
      'rejects /timeline/%s without deviceId (400) and with a foreign deviceId (404)',
      async (q) => {
        await request(server())
          .get(`/timeline/${q}period=day&date=${today}`)
          .set(auth(ALICE))
          .expect(400);
        await request(server())
          .get(`/timeline/${q}period=day&date=${today}&deviceId=dev-bob`)
          .set(auth(ALICE))
          .expect(404);
      },
    );

    it("rejects /dashboard/vitals/latest without deviceId and never returns another tenant's row", async () => {
      const res = await request(server())
        .get('/dashboard/vitals/latest')
        .set(auth(ALICE))
        .expect(400);
      expect(JSON.stringify(res.body)).not.toContain('39.9');
      const own = await request(server())
        .get('/dashboard/vitals/latest?deviceId=dev-alice')
        .set(auth(ALICE))
        .expect(200);
      expect(JSON.stringify(own.body)).toContain('"temperature":37');
    });

    it('revokes every read path for the former owner after unclaim', async () => {
      await request(server())
        .post('/devices/unclaim')
        .set(auth(ALICE))
        .send({ device_id: 'dev-alice' })
        .expect(201);
      expect(
        JSON.stringify(
          (await request(server()).get('/devices').set(auth(ALICE)).expect(200))
            .body,
        ),
      ).not.toContain('dev-alice');
      await request(server())
        .get('/dashboard/vitals/latest?deviceId=dev-alice')
        .set(auth(ALICE))
        .expect(404);
      await request(server())
        .get(
          `/timeline/vitals?deviceId=dev-alice&metric=temp&period=day&date=${today}`,
        )
        .set(auth(ALICE))
        .expect(404);
      await request(server())
        .get('/devices/dev-alice/status')
        .set(auth(ALICE))
        .expect(404);
      expect(
        JSON.stringify(
          (
            await request(server())
              .get('/alerts/attended')
              .set(auth(ALICE))
              .expect(200)
          ).body,
        ),
      ).not.toContain('fall_alice_1');
      await request(server())
        .patch('/alerts/fall_alice_1/attend')
        .set(auth(ALICE))
        .expect(404);
    });

    it('excludes an unclaimed device from the AI-nurse alert context (exact SQL from nurse_agent.py)', async () => {
      const py = fs.readFileSync(
        path.resolve(
          __dirname,
          '../../../ai-summary-service/src/core/nurse_agent.py',
        ),
        'utf8',
      );
      const sql = /"""\s*(SELECT a\.title[\s\S]*?LIMIT\s+5)\s*"""/
        .exec(py)![1]
        .replaceAll('%s', '$1');
      await ds.query(`UPDATE alerts SET timestamp = now() - interval '1 hour'`);
      expect((await ds.query(sql, [ALICE])).length).toBe(1);
      await iot.unclaimDevice(ALICE, 'dev-alice');
      expect((await ds.query(sql, [ALICE])).length).toBe(0);
      expect((await ds.query(sql, [BOB])).length).toBe(3);
    });

    it('fails closed (throws) on an undefined where value through the real driver', async () => {
      await expect(
        ds.getRepository(Vital).find({ where: { deviceId: undefined } }),
      ).rejects.toThrow(/Undefined value/i);
    });
  });

  // ── C. real Socket.IO ingestion vs ownership change ─────────────────────
  describe('Socket.IO /realtime ingestion and revocation', () => {
    const connect = (opts: any = {}) =>
      new Promise<ClientSocket>((resolve, reject) => {
        const s = io(`${baseUrl}/realtime`, {
          transports: ['websocket'],
          forceNew: true,
          reconnection: false,
          ...opts,
        });
        sockets.push(s);
        s.once('connect', () => resolve(s));
        s.once('connect_error', reject);
      });
    const batch = () => ({
      logs: [
        {
          temp: 36.4,
          ambientTemp: 24,
          moisture: 2,
          gait_label: 'walking',
          sos_trigger: false,
          fall_alert: false,
          unix_timestamp: nowSec() + 1, // postdates claims made within the current second
        },
      ],
    });
    const send = (s: ClientSocket) =>
      new Promise<{ ok: boolean; ack?: any; error?: any }>((resolve) => {
        const onException = (error: any) => resolve({ ok: false, error });
        s.once('exception', onException);
        s.timeout(3000).emit('device_data', batch(), (err: any, ack: any) => {
          s.off('exception', onException);
          resolve(
            err ? { ok: false, error: 'timeout' } : { ok: !!ack?.success, ack },
          );
        });
      });

    it('routes to the owner, stops at unclaim, and follows a re-claim on the same socket', async () => {
      const device = await connect();
      const authAck = await device.timeout(3000).emitWithAck('device_auth', {
        device_id: 'dev-alice',
        device_key: KEY['dev-alice'],
        timestamp: Date.now(),
      });
      expect(authAck).toMatchObject({ success: true, owner_id: ALICE });

      const alice = await connect({ auth: { token: token(ALICE) } });
      const bob = await connect({ auth: { token: token(BOB) } });
      const seen = { alice: 0, bob: 0 };
      alice.on('device.logs.ingested', () => (seen.alice += 1));
      bob.on('device.logs.ingested', () => (seen.bob += 1));

      const first = await send(device);
      expect(first.ok).toBe(true);
      await new Promise((r) => setTimeout(r, 200));
      expect(seen).toEqual({ alice: 1, bob: 0 });
      expect(syncLogs).toHaveBeenLastCalledWith(
        expect.objectContaining({ user_id: ALICE }),
      );

      await request(server())
        .post('/devices/unclaim')
        .set(auth(ALICE))
        .send({ device_id: 'dev-alice' })
        .expect(201);
      const vitalsBefore = await count(
        `SELECT count(*) n FROM vitals WHERE "deviceId" = 'dev-alice'`,
      );
      const calls = syncLogs.mock.calls.length;
      const afterUnclaim = await send(device);
      expect(afterUnclaim.ok).toBe(false);
      expect(JSON.stringify(afterUnclaim.error)).toContain(
        'Device not claimed',
      );
      await new Promise((r) => setTimeout(r, 200));
      expect(seen.alice).toBe(1);
      expect(syncLogs.mock.calls.length).toBe(calls);
      expect(
        await count(
          `SELECT count(*) n FROM vitals WHERE "deviceId" = 'dev-alice'`,
        ),
      ).toBe(vitalsBefore);

      await request(server())
        .post('/devices/claim')
        .set(auth(BOB))
        .send({ device_id: 'dev-alice' })
        .expect(201);
      expect((await send(device)).ok).toBe(true);
      await new Promise((r) => setTimeout(r, 200));
      expect(seen).toEqual({ alice: 1, bob: 1 });
      expect(syncLogs).toHaveBeenLastCalledWith(
        expect.objectContaining({ user_id: BOB }),
      );
    }, 30_000);

    it('delivers nothing to the former owner for batches sent after the unclaim completes, while streaming', async () => {
      const device = await connect();
      await device.timeout(3000).emitWithAck('device_auth', {
        device_id: 'dev-alice',
        device_key: KEY['dev-alice'],
        timestamp: Date.now(),
      });
      const alice = await connect({ auth: { token: token(ALICE) } });
      let aliceAfter = 0;
      let unclaimedAt = Infinity;
      alice.on('device.logs.ingested', () => {
        if (Date.now() > unclaimedAt + 50) aliceAfter += 1;
      });

      // Keep streaming until 5 batches have been sent strictly after the unclaim completed.
      const before: boolean[] = [];
      const after: boolean[] = [];
      const stream = (async () => {
        while (after.length < 5) {
          const sentAfterUnclaim = Date.now() > unclaimedAt;
          const { ok } = await send(device);
          (sentAfterUnclaim ? after : before).push(ok);
          if (before.length > 500) throw new Error('unclaim never completed');
        }
      })();
      await new Promise((r) => setTimeout(r, 150));
      await iot.unclaimDevice(ALICE, 'dev-alice');
      unclaimedAt = Date.now();
      await stream;
      await new Promise((r) => setTimeout(r, 200));

      expect(before.some((ok) => ok)).toBe(true); // batches landed while Alice owned the device
      expect(after).toEqual([false, false, false, false, false]); // every batch sent after unclaim refused
      expect(aliceAfter).toBe(0);
      const attributed = syncLogs.mock.calls.map((c) => c[0].user_id);
      expect(attributed.every((u) => u === ALICE)).toBe(true);
    }, 30_000);
    it('does not attribute a gateway replay of pre-transfer readings to the new owner (PH0-07)', async () => {
      const device = await connect();
      await device.timeout(3000).emitWithAck('device_auth', {
        device_id: 'dev-alice',
        device_key: KEY['dev-alice'],
        timestamp: Date.now(),
      });
      const bob = await connect({ auth: { token: token(BOB) } });
      let bobEvents = 0;
      bob.on('device.logs.ingested', () => (bobEvents += 1));
      await iot.unclaimDevice(ALICE, 'dev-alice');
      await iot.claimDevice(BOB, 'dev-alice');
      const vitalsBefore = await count(
        `SELECT count(*) n FROM vitals WHERE "deviceId" = 'dev-alice'`,
      );
      const ack: any = await device.timeout(3000).emitWithAck('device_data', {
        logs: [{ temp: 36.2, moisture: 2, unix_timestamp: nowSec() - 120 }],
      });
      await new Promise((r) => setTimeout(r, 200));
      expect(ack).toMatchObject({ success: true, dropped_before_ownership: 1 });
      expect(bobEvents).toBe(0);
      expect(syncLogs).not.toHaveBeenCalledWith(
        expect.objectContaining({ user_id: BOB }),
      );
      expect(
        await count(
          `SELECT count(*) n FROM vitals WHERE "deviceId" = 'dev-alice'`,
        ),
      ).toBe(vitalsBefore);
    }, 30_000);
  });

  // ── D. ownership-period isolation (PH0-07) ─────────────────────────────
  // Phase 0.5 recorded these as `it.failing` (known gap). Phase 1 enforces
  // ownership periods, so they now run as ordinary regression tests.
  describe('ownership-period isolation after a valid transfer (PH0-07)', () => {
    const transferAliceDeviceToBob = async () => {
      await request(server())
        .post('/devices/unclaim')
        .set(auth(ALICE))
        .send({ device_id: 'dev-alice' })
        .expect(201);
      await request(server())
        .post('/devices/claim')
        .set(auth(BOB))
        .send({ device_id: 'dev-alice' })
        .expect(201);
    };

    it('new owner must not see the previous owner readings in /timeline/vitals', async () => {
      await transferAliceDeviceToBob();
      const res = await request(server())
        .get(
          `/timeline/vitals?deviceId=dev-alice&metric=temp&period=day&date=${today}`,
        )
        .set(auth(BOB))
        .expect(200);
      expect(JSON.stringify(res.body)).not.toMatch(/"value":\d/);
    });

    it('new owner must not receive the previous owner last reading from /dashboard/vitals/latest', async () => {
      await transferAliceDeviceToBob();
      const res = await request(server())
        .get('/dashboard/vitals/latest?deviceId=dev-alice')
        .set(auth(BOB))
        .expect(200);
      expect(res.body.data).toBeNull();
    });

    it('new owner must not see the previous owner alerts in /timeline/events', async () => {
      await transferAliceDeviceToBob();
      const res = await request(server())
        .get(`/timeline/events?deviceId=dev-alice&period=day&date=${today}`)
        .set(auth(BOB))
        .expect(200);
      expect(JSON.stringify(res.body)).not.toContain('fall_alice_1');
    });

    it('AI-nurse alert context must not include the previous owner alerts', async () => {
      const py = fs.readFileSync(
        path.resolve(
          __dirname,
          '../../../ai-summary-service/src/core/nurse_agent.py',
        ),
        'utf8',
      );
      const sql = /"""\s*(SELECT a\.title[\s\S]*?LIMIT\s+5)\s*"""/
        .exec(py)![1]
        .replaceAll('%s', '$1');
      await ds.query(`UPDATE alerts SET timestamp = now() - interval '1 hour'`);
      await transferAliceDeviceToBob();
      const titles = (await ds.query(sql, [BOB])).length;
      expect(titles).toBe(3); // Bob's own three, not Alice's
    });
    it('leaves exactly one open ownership period after concurrent claims', async () => {
      await iot.unclaimDevice(ALICE, 'dev-alice');
      await Promise.allSettled(
        Array.from({ length: 10 }, (_, i) =>
          iot.claimDevice(200 + i, 'dev-alice'),
        ),
      );
      const open = await count(
        `SELECT count(*) n FROM device_ownerships WHERE "deviceId" = 'dev-alice' AND "endedAt" IS NULL`,
      );
      const closed = await count(
        `SELECT count(*) n FROM device_ownerships WHERE "deviceId" = 'dev-alice' AND "endedAt" IS NOT NULL`,
      );
      expect(open).toBe(1);
      expect(closed).toBe(1); // Alice's period is kept, not deleted
    });

    it('quarantines legacy rows recorded before the current period (fail closed, nothing deleted)', async () => {
      // A row ingested before Alice's period began (e.g. pre-migration) with the newest reading time.
      await ds.query(
        `INSERT INTO vitals ("deviceId", timestamp, temperature, "roomTemperature", moisture, "gaitAnalysis", "syncSlot", "createdAt")
         VALUES ('dev-alice', now(), 41.0, 20, 1, 'legacy', 'iot_live', now() - interval '2 days')`,
      );
      const res = await request(server())
        .get('/dashboard/vitals/latest?deviceId=dev-alice')
        .set(auth(ALICE))
        .expect(200);
      expect(JSON.stringify(res.body)).not.toContain('41');
      expect(
        await count(
          `SELECT count(*) n FROM vitals WHERE "gaitAnalysis" = 'legacy'`,
        ),
      ).toBe(1);
    });
  });
  // ── E. real-time alert delivery (AR-1 / AR-2 / AR-5) ──────────────────
  describe('real-time alert delivery (AR-1, AR-2, AR-5)', () => {
    const connectAs = (userId?: number) =>
      new Promise<ClientSocket>((resolve, reject) => {
        const s = io(`${baseUrl}/realtime`, {
          transports: ['websocket'],
          forceNew: true,
          reconnection: false,
          ...(userId ? { auth: { token: token(userId) } } : {}),
        });
        sockets.push(s);
        s.once('connect', () => resolve(s));
        s.once('connect_error', reject);
      });
    const collect = (s: ClientSocket, event: string) => {
      const got: any[] = [];
      s.on(event, (p: any) => got.push(p));
      return got;
    };
    const settle = (ms = 700) => new Promise((r) => setTimeout(r, ms));
    const insertRaw = (id: string, deviceId: string) =>
      ds.query(
        `INSERT INTO alerts (id, "deviceId", type, title, timestamp, "isDismissed", "isAttended", "isFalseAlarm", "syncSlot", "createdAt")
         VALUES ($1, $2, 'temperature', 'High Temp', now(), false, false, false, 'realtime', now())`,
        [id, deviceId],
      );

    it('delivers a fall from device ingest to the owner exactly once and to no one else', async () => {
      const alice = await connectAs(ALICE);
      const bob = await connectAs(BOB);
      const aliceNew = collect(alice, 'alert.new');
      const bobNew = collect(bob, 'alert.new');
      const device = await connectAs();
      await device.timeout(3000).emitWithAck('device_auth', {
        device_id: 'dev-alice',
        device_key: KEY['dev-alice'],
        timestamp: Date.now(),
      });
      const frame = {
        logs: [
          {
            temp: 36.5,
            moisture: 1,
            fall_alert: true,
            sos_trigger: false,
            unix_timestamp: nowSec() + 1,
          },
        ],
      };
      await device.timeout(3000).emitWithAck('device_data', frame);
      await device.timeout(3000).emitWithAck('device_data', frame); // duplicate frame
      await settle();
      expect(aliceNew).toHaveLength(1);
      expect(aliceNew[0]).toMatchObject({
        type: 'fall',
        deviceId: 'dev-alice',
        severity: 'critical',
      });
      expect(bobNew).toHaveLength(0);
      expect(
        await count(
          `SELECT count(*) n FROM alerts WHERE "deviceId" = 'dev-alice' AND type = 'fall' AND "dispatchState" = 'dispatched'`,
        ),
      ).toBe(1);
    }, 30_000);

    it('accepts a durable fall device_event, converges with the legacy frame, and notifies the owner once (AR-9)', async () => {
      const alice = await connectAs(ALICE);
      const bob = await connectAs(BOB);
      const aliceNew = collect(alice, 'alert.new');
      const bobNew = collect(bob, 'alert.new');
      const device = await connectAs();
      await device.timeout(3000).emitWithAck('device_auth', {
        device_id: 'dev-alice',
        device_key: KEY['dev-alice'],
        timestamp: Date.now(),
      });
      const detectedSec = nowSec() + 1; // postdates the claim made within the current second
      const ev = {
        schema: 'sotercare.device_event.v1',
        event_id: '0b5f7c1e-3a2d-4e6f-8a9b-1c2d3e4f5a6b',
        type: 'fall',
        device_id: 'dev-alice',
        detected_at: detectedSec * 1000 + 250,
        seq: 1,
        attempt: 1,
        source: 'udp',
      };
      const ack = await device.timeout(5000).emitWithAck('device_event', ev);
      expect(ack).toMatchObject({
        accepted: true,
        success: true,
        event_id: ev.event_id,
        alert_id: `fall_dev-alice_${detectedSec * 1000}`,
        duplicate: false,
      });
      // Gateway retry after a lost ack, and the legacy boolean for the same frame.
      expect(
        await device
          .timeout(5000)
          .emitWithAck('device_event', { ...ev, attempt: 2 }),
      ).toMatchObject({ duplicate: true, alert_id: ack.alert_id });
      await device.timeout(3000).emitWithAck('device_data', {
        logs: [
          {
            temp: 36.5,
            moisture: 1,
            fall_alert: true,
            sos_trigger: false,
            unix_timestamp: detectedSec,
          },
        ],
      });
      await settle();
      expect(aliceNew).toEqual([
        expect.objectContaining({
          id: ack.alert_id,
          type: 'fall',
          severity: 'critical',
          eventId: ev.event_id,
        }),
      ]);
      expect(bobNew).toHaveLength(0);
      // Seeded fixture alerts are 'skipped'; exactly one live fall row exists.
      expect(
        await count(
          `SELECT count(*) n FROM alerts WHERE "deviceId" = 'dev-alice' AND type = 'fall' AND "dispatchState" <> 'skipped'`,
        ),
      ).toBe(1);
      expect(
        await count(
          `SELECT count(*) n FROM device_events WHERE "deviceId" = 'dev-alice'`,
        ),
      ).toBe(1);
    }, 30_000);

    it('acks device_event from an unauthenticated socket as retryable, never as success (AR-9)', async () => {
      const device = await connectAs();
      const ack = await device
        .timeout(3000)
        .emitWithAck('device_event', { schema: 'sotercare.device_event.v1' });
      expect(ack).toMatchObject({
        accepted: false,
        success: false,
        retryable: true,
        reason: 'not_authenticated',
      });
    });

    it('gives internal callers a pipeline snapshot and a per-event trace without secrets or payloads (Workstream I)', async () => {
      await request(server())
        .get('/alerts/internal/pipeline-status')
        .set(auth(ALICE))
        .expect(401);
      const device = await connectAs();
      await device.timeout(3000).emitWithAck('device_auth', {
        device_id: 'dev-alice',
        device_key: KEY['dev-alice'],
        timestamp: Date.now(),
      });
      const ev = {
        schema: 'sotercare.device_event.v1',
        event_id: '5d4c3b2a-1f0e-4d9c-8b7a-6f5e4d3c2b1a',
        type: 'fall',
        device_id: 'dev-alice',
        detected_at: (nowSec() + 1) * 1000,
        seq: 1,
        attempt: 1,
      };
      await device.timeout(5000).emitWithAck('device_event', ev);
      await device
        .timeout(5000)
        .emitWithAck('device_event', { ...ev, attempt: 2 }); // duplicate
      await settle();

      const res = await request(server())
        .get('/alerts/internal/pipeline-status')
        .set('X-Internal-Token', INTERNAL_TOKEN)
        .expect(200);
      const s = res.body.data;
      expect(s.alerts).toEqual(
        expect.objectContaining({
          pendingDispatch: 0,
          unacknowledgedCritical: expect.any(Number),
        }),
      );
      expect(s.alerts).toHaveProperty('oldestPendingAgeMs');
      expect(s.alerts.ackLatencyMs).toEqual(
        expect.objectContaining({ n: expect.any(Number) }),
      );
      expect(s.deviceEvents.last24h).toEqual(
        expect.objectContaining({ accepted: 1, quarantined: 0 }),
      );
      expect(s.deviceEvents.sinceProcessStart.duplicate).toBeGreaterThanOrEqual(
        1,
      );
      expect(s.deviceEvents.ingestLagMs).toEqual(
        expect.objectContaining({ p50: expect.any(Number) }),
      );
      expect(s.notifications).toEqual(
        expect.objectContaining({
          queued: expect.any(Number),
          last24hByState: expect.any(Object),
        }),
      );

      await request(server())
        .get(`/alerts/internal/trace/${ev.event_id}`)
        .expect(401);
      const trace = await request(server())
        .get(`/alerts/internal/trace/${ev.event_id}`)
        .set('X-Internal-Token', INTERNAL_TOKEN)
        .expect(200);
      expect(trace.body.data.event).toMatchObject({
        eventId: ev.event_id,
        deviceId: 'dev-alice',
        type: 'fall',
        quarantined: false,
      });
      expect(trace.body.data.alert).toMatchObject({
        id: `fall_dev-alice_${ev.detected_at}`,
        dispatchState: 'dispatched',
      });
      expect(Array.isArray(trace.body.data.attempts)).toBe(true);
      expect(Array.isArray(trace.body.data.actions)).toBe(true);
      expect(JSON.stringify(trace.body)).not.toMatch(
        /payload|PushToken\[|device_key/,
      );
      await request(server())
        .get('/alerts/internal/trace/00000000-0000-4000-8000-000000000000')
        .set('X-Internal-Token', INTERNAL_TOKEN)
        .expect(404);
    });

    it('authenticates the internal webhook and never trusts a user JWT for it', async () => {
      await request(server())
        .post('/alerts/internal/alert-ready')
        .set(auth(ALICE))
        .send({ deviceId: 'dev-alice' })
        .expect(401);
      await request(server())
        .post('/alerts/internal/alert-ready')
        .set('X-Internal-Token', 'wrong')
        .send({ deviceId: 'dev-alice' })
        .expect(401);
      await request(server())
        .post('/alerts/internal/alert-ready')
        .set('X-Internal-Token', INTERNAL_TOKEN)
        .send({ deviceId: 'dev-alice', alertIds: [] })
        .expect(202);
    });

    it('delivers a Safety-Guard-written alert once via the webhook; repeated webhooks do not duplicate it', async () => {
      const alice = await connectAs(ALICE);
      const got = collect(alice, 'alert.new');
      await insertRaw('temperature_dev-alice_sg1', 'dev-alice');
      for (let i = 0; i < 3; i++) {
        await request(server())
          .post('/alerts/internal/alert-ready')
          .set('X-Internal-Token', INTERNAL_TOKEN)
          .send({
            deviceId: 'dev-alice',
            alertIds: ['temperature_dev-alice_sg1'],
          })
          .expect(202);
      }
      await settle();
      expect(got.map((a) => a.id)).toEqual(['temperature_dev-alice_sg1']);
    });

    it('delivers a pending alert through the sweep when no producer kicks it (crash between insert and emit)', async () => {
      const alice = await connectAs(ALICE);
      const got = collect(alice, 'alert.new');
      await insertRaw('temperature_dev-alice_orphan', 'dev-alice');
      await settle(1500);
      expect(got.map((a) => a.id)).toEqual(['temperature_dev-alice_orphan']);
    });

    it('does not emit an alert to the owner of a different device named in the webhook', async () => {
      const bob = await connectAs(BOB);
      const got = collect(bob, 'alert.new');
      await insertRaw('temperature_dev-alice_x', 'dev-alice');
      await request(server())
        .post('/alerts/internal/alert-ready')
        .set('X-Internal-Token', INTERNAL_TOKEN)
        .send({ deviceId: 'dev-bob', alertIds: ['temperature_dev-alice_x'] })
        .expect(202);
      await settle();
      expect(got).toHaveLength(0);
    });

    it('registers, lists (masked), reports and revokes push tokens per user (AR-6)', async () => {
      const body = {
        token: 'ExponentPushToken[abcdefghijklmnopqrst]',
        platform: 'android',
        installationId: '0b5f7c1e-3a2d-4e6f-8a9b-1c2d3e4f5a6b',
        appVersion: '1.4.0',
        permission: 'granted',
      };
      await request(server())
        .post('/notifications/push-tokens')
        .send(body)
        .expect(401);
      await request(server())
        .post('/notifications/push-tokens')
        .set(auth(ALICE))
        .send({ ...body, token: 'not-a-token' })
        .expect(400);
      await request(server())
        .post('/notifications/push-tokens')
        .set(auth(ALICE))
        .send({ ...body, extra: 1 })
        .expect(400);
      const created = await request(server())
        .post('/notifications/push-tokens')
        .set(auth(ALICE))
        .send(body)
        .expect(201);
      expect(created.body.data).toEqual({
        id: expect.any(String),
        registeredAt: expect.any(String),
      });
      const status = await request(server())
        .get('/notifications/status')
        .set(auth(ALICE))
        .expect(200);
      expect(status.body.data).toEqual({ activeTokens: 1 });
      const list = await request(server())
        .get('/notifications/push-tokens')
        .set(auth(ALICE))
        .expect(200);
      expect(JSON.stringify(list.body)).not.toContain('abcdefghijklmnopqrst');
      const bobDel = await request(server())
        .delete(`/notifications/push-tokens/${body.installationId}`)
        .set(auth(BOB))
        .expect(200);
      expect(bobDel.body.data).toEqual({ revoked: 0 });
      const del = await request(server())
        .delete(`/notifications/push-tokens/${body.installationId}`)
        .set(auth(ALICE))
        .expect(200);
      expect(del.body.data).toEqual({ revoked: 1 });
    });

    it('records "seen" from a push without acknowledging, for the owner only (AR-7)', async () => {
      await request(server())
        .post('/notifications/push-tokens')
        .set(auth(ALICE))
        .send({
          token: 'ExponentPushToken[seenseenseenseen]',
          platform: 'ios',
          installationId: '9c8b7a6f-5e4d-4c3b-8a2f-1e0d9c8b7a6f',
        })
        .expect(201);
      await insertRaw('temperature_dev-alice_seen', 'dev-alice');
      await settle(800); // dispatcher sweep queues the push attempt
      const [attempt] = await ds.query(
        `SELECT id FROM notification_attempts WHERE "alertId" = 'temperature_dev-alice_seen'`,
      );
      expect(attempt).toBeDefined();
      const url = '/alerts/temperature_dev-alice_seen/seen';
      await request(server())
        .post(url)
        .set(auth(BOB))
        .send({ source: 'push_opened' })
        .expect(404);
      await request(server())
        .post(url)
        .set(auth(ALICE))
        .send({ source: 'push_opened', status: 'attended' })
        .expect(400);
      await request(server())
        .post(url)
        .set(auth(ALICE))
        .send({
          source: 'push_opened',
          notificationAttemptId: Number(attempt.id),
        })
        .expect(200);
      const [action] = await ds.query(
        `SELECT action, source, reason, "notificationAttemptId" FROM alert_actions WHERE "alertId" = 'temperature_dev-alice_seen'`,
      );
      expect(action).toEqual({
        action: 'opened_from_push',
        source: 'push',
        reason: 'push_opened',
        notificationAttemptId: String(attempt.id),
      });
      const [a] = await ds.query(
        `SELECT "acknowledgedAt", "isAttended" FROM alerts WHERE id = 'temperature_dev-alice_seen'`,
      );
      expect(a).toEqual({ acknowledgedAt: null, isAttended: false });
      const [n] = await ds.query(
        `SELECT "openedAt" FROM notification_attempts WHERE id = $1`,
        [attempt.id],
      );
      expect(n.openedAt).not.toBeNull();
    });

    it('lets exactly one of two concurrent acknowledgements win and audits both (AR-4)', async () => {
      await insertRaw('temperature_dev-alice_race', 'dev-alice');
      const url = (action: string) =>
        `/alerts/temperature_dev-alice_race/${action}`;
      const [a, b] = await Promise.all([
        request(server())
          .patch(url('attend'))
          .set(auth(ALICE))
          .set('X-Client', 'web'),
        request(server())
          .patch(url('false-alarm'))
          .set(auth(ALICE))
          .set('X-Client', 'mobile'),
      ]);
      expect([a.status, b.status].sort()).toEqual([200, 409]);
      const [row] = await ds.query(
        `SELECT "ackAction", "acknowledgedAt" FROM alerts WHERE id = 'temperature_dev-alice_race'`,
      );
      const winner = a.status === 200 ? 'attended' : 'false_alarm';
      expect(row.ackAction).toBe(winner);
      const actions: any[] = await ds.query(
        `SELECT action, source FROM alert_actions WHERE "alertId" = 'temperature_dev-alice_race' ORDER BY id`,
      );
      expect(actions.map((x) => x.action).sort()).toEqual(
        ['ack_rejected_already_acknowledged', winner].sort(),
      );
      expect(
        actions.every((x) => x.source === 'web' || x.source === 'mobile'),
      ).toBe(true);
    });

    it('broadcasts alert.updated (and the legacy alias) on acknowledgement to the owner only', async () => {
      const alice = await connectAs(ALICE);
      const bob = await connectAs(BOB);
      const updated = collect(alice, 'alert.updated');
      const legacy = collect(alice, 'alert.attended');
      const bobUpdated = collect(bob, 'alert.updated');
      await insertRaw('temperature_dev-alice_ack', 'dev-alice');
      await request(server())
        .patch('/alerts/temperature_dev-alice_ack/attend')
        .set(auth(ALICE))
        .expect(200);
      await settle();
      expect(updated).toEqual([
        expect.objectContaining({
          id: 'temperature_dev-alice_ack',
          status: 'attended',
          actorUserId: ALICE,
        }),
      ]);
      expect(legacy).toHaveLength(1);
      expect(bobUpdated).toHaveLength(0);
    });

    it('lets a client that was offline reconcile from the durable alert list', async () => {
      await insertRaw('temperature_dev-alice_offline', 'dev-alice');
      await settle(800); // dispatched while nobody was connected
      const res = await request(server())
        .get('/alerts/recent')
        .set(auth(ALICE))
        .expect(200);
      expect(JSON.stringify(res.body)).toContain(
        'temperature_dev-alice_offline',
      );
    });

    /**
     * Cross-repo E2E (AR-9 + AR-10): the real gateway outbox CLI
     * (thigh-node-n-edge-gateway/edge-gateway/tools/outbox_cli.py, SQLite) talks
     * to this server over Socket.IO. Skipped unless E2E_GATEWAY_PYTHON (a Python
     * with python-socketio) and E2E_GATEWAY_CLI are set. Synthetic device/key.
     */
    const e2e =
      process.env.E2E_GATEWAY_PYTHON && process.env.E2E_GATEWAY_CLI
        ? it
        : it.skip;
    /** One gateway outbox (SQLite file) driven through the real CLI. Each call is a new process. */
    const gatewayHarness = () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'outbox-e2e-'));
      const outbox = path.join(dir, 'outbox.db');
      // Async spawn: the Nest server under test runs in this process.
      const cli = (...args: string[]) =>
        new Promise<{ code: number; lines: any[] }>((resolve) => {
          execFile(
            process.env.E2E_GATEWAY_PYTHON as string,
            ['-I', process.env.E2E_GATEWAY_CLI as string, ...args],
            {
              env: { ...process.env, SOTERCARE_DEVICE_KEY: KEY['dev-alice'] },
              timeout: 60_000,
            },
            (error, stdout) => {
              const lines = stdout
                .split('\n')
                .filter((l) => l.trim().startsWith('{'))
                .map((l) => JSON.parse(l));
              resolve({
                code: error ? Number((error as any).code ?? 1) : 0,
                lines,
              });
            },
          );
        });
      return {
        dir,
        outbox,
        cli,
        record: (type: 'fall' | 'sos', detectedAtMs: number) =>
          cli(
            'record',
            '--type',
            type,
            '--device-id',
            'dev-alice',
            '--detected-at-ms',
            String(detectedAtMs),
            '--outbox',
            outbox,
          ),
        status: () => cli('status', '--outbox', outbox),
        flush: (maxSeconds: number, url = baseUrl) =>
          cli(
            'flush',
            '--url',
            url,
            '--device-id',
            'dev-alice',
            '--outbox',
            outbox,
            '--timeout',
            '5',
            '--max-seconds',
            String(maxSeconds),
          ),
        snapshot: (to: string) => {
          fs.mkdirSync(to, { recursive: true });
          for (const f of fs.readdirSync(dir))
            if (f.startsWith('outbox.db'))
              fs.copyFileSync(path.join(dir, f), path.join(to, f));
        },
        restore: (from: string) => {
          for (const f of fs.readdirSync(dir))
            if (f.startsWith('outbox.db')) fs.rmSync(path.join(dir, f));
          for (const f of fs.readdirSync(from))
            fs.copyFileSync(path.join(from, f), path.join(dir, f));
        },
        cleanup: () => fs.rmSync(dir, { recursive: true, force: true }),
      };
    };

    e2e(
      'gateway outbox -> backend -> owner: survives a disabled backend and a lost ack, notifies once',
      async () => {
        const { dir, cli, flush, snapshot, restore, outbox, cleanup } =
          gatewayHarness();

        const detectedSec = nowSec() + 1; // postdates the claim made within the current second
        const rec = await cli(
          'record',
          '--type',
          'fall',
          '--device-id',
          'dev-alice',
          '--detected-at-ms',
          String(detectedSec * 1000 + 40),
          '--outbox',
          outbox,
        );
        expect(rec.code).toBe(0);
        const alertId = `fall_dev-alice_${detectedSec * 1000}`;

        // 1. Backend switched off: the gateway keeps the event; nothing is written.
        process.env.DEVICE_EVENTS_ENABLED = 'false';
        try {
          const off = await flush(3);
          expect(off.code).toBe(3);
          // The CLI reports a retry as e.g. `not accepted: disabled`.
          expect(
            off.lines.some(
              (l) => l.outcome === 'retry' && /disabled/.test(String(l.reason)),
            ),
          ).toBe(true);
        } finally {
          delete process.env.DEVICE_EVENTS_ENABLED;
        }
        expect(await count(`SELECT count(*) n FROM device_events`)).toBe(0);

        // 2. Backend on: delivered once, to the owner only.
        const alice = await connectAs(ALICE);
        const bob = await connectAs(BOB);
        const aliceNew = collect(alice, 'alert.new');
        const bobNew = collect(bob, 'alert.new');
        snapshot(path.join(dir, 'before-ack'));
        const on = await flush(20);
        expect(on.code).toBe(0);
        expect(on.lines.find((l) => l.outcome)).toMatchObject({
          outcome: 'acked',
          alert_id: alertId,
        });

        // 3. Gateway crashed after sending but before persisting the ack.
        restore(path.join(dir, 'before-ack'));
        const again = await flush(20);
        expect(again.code).toBe(0);
        expect(again.lines.find((l) => l.outcome)).toMatchObject({
          outcome: 'acked',
          alert_id: alertId,
        });

        await settle();
        expect(aliceNew).toEqual([
          expect.objectContaining({
            id: alertId,
            type: 'fall',
            severity: 'critical',
          }),
        ]);
        expect(bobNew).toHaveLength(0);
        expect(
          await count(
            `SELECT count(*) n FROM device_events WHERE "deviceId" = 'dev-alice'`,
          ),
        ).toBe(1);
        expect(
          await count(`SELECT count(*) n FROM alerts WHERE id = $1`, [alertId]),
        ).toBe(1);
        // 4. The durable list has it for any client that was offline.
        const res = await request(server())
          .get('/alerts/recent')
          .set(auth(ALICE))
          .expect(200);
        expect(JSON.stringify(res.body)).toContain(alertId);
        cleanup();
      },
      120_000,
    );

    /**
     * Workstream J required scenario, steps 1-16. The wearable/firmware hop is
     * NOT exercised: step 1 is simulated at the gateway outbox boundary (the
     * CLI records exactly what the pipeline hook records). Step 14 uses a test
     * provider; it proves submission bookkeeping, not delivery to a phone.
     */
    e2e(
      'Workstream J: fall -> outbox -> outage -> restart -> retry -> duplicate -> one alert -> push -> acknowledgement',
      async () => {
        const gw = gatewayHarness();
        const sec = nowSec() + 1; // postdates the claim made within the current second
        const fallId = `fall_dev-alice_${sec * 1000}`;
        const sosId = `sos_dev-alice_${(sec + 5) * 1000}`;
        // Caregiver phones: Alice (owner) and Bob (not authorised for dev-alice).
        for (const [user, token, installationId] of [
          [
            ALICE,
            'ExponentPushToken[alicephone0001]',
            '0b5f7c1e-3a2d-4e6f-8a9b-1c2d3e4f5a6b',
          ],
          [
            BOB,
            'ExponentPushToken[bobphone000001]',
            '9c8b7a6f-5e4d-4c3b-8a2f-1e0d9c8b7a6f',
          ],
        ] as const) {
          await request(server())
            .post('/notifications/push-tokens')
            .set(auth(user))
            .send({ token, platform: 'android', installationId })
            .expect(201);
        }

        // 1-3. Fall reaches the gateway, gets a stable event id and is persisted. A
        // second event (SOS) makes this a multi-event backlog.
        expect((await gw.record('fall', sec * 1000 + 40)).code).toBe(0);
        expect((await gw.record('sos', (sec + 5) * 1000 + 10)).code).toBe(0);
        const recorded = (await gw.status()).lines[0];
        expect(recorded).toMatchObject({ pending: 2 });

        // 4. Cloud unreachable (nothing listens on port 9): connect failure, events kept.
        expect((await gw.flush(3, 'http://127.0.0.1:9')).code).toBe(1);
        // 5. Gateway restart: a new process reopens the same SQLite outbox.
        expect((await gw.status()).lines[0]).toMatchObject({ pending: 2 });

        // 6-8. Connectivity restored: the original events are retried and accepted.
        const alice = await connectAs(ALICE);
        const bob = await connectAs(BOB);
        const aliceNew = collect(alice, 'alert.new');
        const aliceUpdated = collect(alice, 'alert.updated');
        const bobAll = [
          ...collect(bob, 'alert.new'),
          ...collect(bob, 'alert.updated'),
        ];
        gw.snapshot(path.join(gw.dir, 'before-ack'));
        const first = await gw.flush(20);
        expect(first.code).toBe(0);
        const acked = first.lines.filter((l) => l.outcome === 'acked');
        expect(acked.map((l) => l.alert_id).sort()).toEqual(
          [fallId, sosId].sort(),
        );
        const eventIds = acked.map((l) => l.event_id).sort();

        // 9-10. The acks are lost (gateway state rolled back): same events resent, recognised as duplicates.
        gw.restore(path.join(gw.dir, 'before-ack'));
        const again = await gw.flush(20);
        expect(again.code).toBe(0);
        expect(
          again.lines
            .filter((l) => l.outcome === 'acked')
            .map((l) => l.event_id)
            .sort(),
        ).toEqual(eventIds);

        // 11. Exactly one logical fall alert (and one SOS) for these events.
        expect(
          await count(
            `SELECT count(*) n FROM device_events WHERE "deviceId" = 'dev-alice'`,
          ),
        ).toBe(2);
        expect(
          await count(`SELECT count(*) n FROM alerts WHERE id = $1`, [fallId]),
        ).toBe(1);
        await settle();
        expect(aliceNew.filter((a) => a.id === fallId)).toHaveLength(1);

        // 12-13. Only the authorised caregiver's phone has queued attempts.
        const attempts: any[] = await ds.query(
          `SELECT n.id, n."userId", n.state FROM notification_attempts n WHERE n."alertId" = $1`,
          [fallId],
        );
        expect(attempts).toEqual([
          expect.objectContaining({ userId: ALICE, state: 'queued' }),
        ]);

        // 14. A test provider records the submission (not proof of delivery).
        const provider = new FakePushProvider();
        const sender = new NotificationSenderService(
          ds,
          app.get(AlertEventsPublisher),
          provider,
        );
        await sender.sendDue();
        expect(provider.sent.filter((m) => m.data.alertId === fallId)).toEqual([
          expect.objectContaining({
            to: 'ExponentPushToken[alicephone0001]',
            title: 'Possible fall detected',
            data: { alertId: fallId, attemptId: Number(attempts[0].id) },
          }),
        ]);
        expect(provider.sent.some((m) => m.to.includes('bobphone'))).toBe(
          false,
        );

        // 15. The caregiver acknowledges through the authorised API (Bob cannot).
        await request(server())
          .patch(`/alerts/${fallId}/attend`)
          .set(auth(BOB))
          .expect(404);
        await request(server())
          .patch(`/alerts/${fallId}/attend`)
          .set(auth(ALICE))
          .set('X-Client', 'mobile')
          .expect(200);

        // 16. Persisted, audited and synchronised to the owner's client.
        const [row] = await ds.query(
          `SELECT "acknowledgedAt", "acknowledgedByUserId", "ackAction" FROM alerts WHERE id = $1`,
          [fallId],
        );
        expect(row).toMatchObject({
          acknowledgedByUserId: ALICE,
          ackAction: 'attended',
        });
        expect(row.acknowledgedAt).not.toBeNull();
        expect(
          await count(
            `SELECT count(*) n FROM alert_actions WHERE "alertId" = $1 AND action = 'attended' AND source = 'mobile'`,
            [fallId],
          ),
        ).toBe(1);
        await settle();
        expect(aliceUpdated).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ id: fallId, status: 'attended' }),
          ]),
        );
        expect(bobAll).toHaveLength(0);
        gw.cleanup();
      },
      180_000,
    );
  });
});
