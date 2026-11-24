/* eslint-disable @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-return */
/**
 * Phase 0 HTTP-level regression suite: real controllers, JwtAuthGuard,
 * passport-jwt strategy, ValidationPipe, exception filter and response
 * interceptor (as wired in main.ts), backed by the in-memory repositories.
 * Synthetic users and devices only.
 */
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PassportModule } from '@nestjs/passport';
import { Test } from '@nestjs/testing';
import { getDataSourceToken, getRepositoryToken } from '@nestjs/typeorm';
import * as jwt from 'jsonwebtoken';
import request from 'supertest';
import { AlertsController } from '../alerts/alerts.controller';
import { AlertsService } from '../alerts/alerts.service';
import { JwtStrategy } from '../auth/jwt.strategy';
import { HttpExceptionFilter } from '../common/filters/http-exception.filter';
import { ResponseInterceptor } from '../common/interceptors/response.interceptor';
import { DashboardController } from '../dashboard/dashboard.controller';
import { DashboardService } from '../dashboard/dashboard.service';
import {
  Alert,
  Device,
  DeviceOwnership,
  DeviceStatus,
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
import { AlertEventsPublisher } from '../realtime/alert-events.publisher';
import { SyncController } from '../sync/sync.controller';
import { SyncService } from '../sync/sync.service';
import { TimelineController } from '../timeline/timeline.controller';
import { TimelineService } from '../timeline/timeline.service';
import {
  ALICE,
  BOB,
  configStub,
  createPhase0Db,
  syncBatch,
} from '../../test/support/phase0-fixtures';

const token = (userId: number) =>
  jwt.sign(
    {
      userId: String(userId),
      sub: userId,
      email: `user${userId}@example.invalid`,
      name: `User ${userId}`,
    },
    process.env.JWT_SECRET as string,
    { expiresIn: '5m' },
  );
const auth = (userId: number) => ({ Authorization: `Bearer ${token(userId)}` });

describe('Phase 0 security over HTTP', () => {
  let app: INestApplication;
  let db: ReturnType<typeof createPhase0Db>;

  beforeEach(async () => {
    db = createPhase0Db();
    const repo = (entity: any) => ({
      provide: getRepositoryToken(entity),
      useValue: db.repository(entity),
    });
    const moduleRef = await Test.createTestingModule({
      imports: [PassportModule],
      controllers: [
        SyncController,
        DashboardController,
        TimelineController,
        AlertsController,
        DevicesController,
        IotDeviceController,
      ],
      providers: [
        JwtStrategy,
        SyncService,
        DashboardService,
        TimelineService,
        AlertsService,
        DevicesService,
        IotDeviceService,
        OwnershipService,
        { provide: ConfigService, useValue: configStub() },
        { provide: getDataSourceToken(), useValue: db.dataSource() },
        { provide: RealtimeGateway, useValue: { emitToUser: jest.fn() } },
        {
          provide: AlertEventsPublisher,
          useValue: { publishNew: jest.fn(), publishUpdated: jest.fn() },
        },
        ...[
          Device,
          Vital,
          Alert,
          DeviceStatus,
          RecordingSession,
          SyncHistory,
          IotDevice,
          DeviceOwnership,
        ].map(repo),
      ],
    }).compile();

    app = moduleRef.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({ transform: true, forbidUnknownValues: false }),
    );
    app.useGlobalFilters(new HttpExceptionFilter());
    app.useGlobalInterceptors(new ResponseInterceptor());
    await app.init();
  });

  afterEach(async () => {
    await app.close();
  });

  const server = () => app.getHttpServer();
  const ownerOf = (id: string) =>
    db.rows(Device).find((d) => d.id === id)?.userId;

  it('requires a valid JWT on the protected routes', async () => {
    await request(server())
      .post('/sync/raspberry-pi')
      .send(syncBatch())
      .expect(401);
    await request(server())
      .get('/dashboard/vitals/latest?deviceId=dev-alice')
      .expect(401);
  });

  describe('device ownership (GAP-001)', () => {
    it("returns 403 and keeps the owner when a user syncs someone else's device", async () => {
      await request(server())
        .post('/sync/raspberry-pi')
        .set(auth(ALICE))
        .send(
          syncBatch({
            devices: [{ id: 'dev-bob', name: 'stolen', type: 'hub' }],
          }),
        )
        .expect(403);
      expect(ownerOf('dev-bob')).toBe(BOB);
      // ...and the attacker still cannot read the victim's data.
      await request(server())
        .get('/dashboard/vitals/latest?deviceId=dev-bob')
        .set(auth(ALICE))
        .expect(404);
    });

    it("accepts a sync for the caller's own device", async () => {
      await request(server())
        .post('/sync/raspberry-pi')
        .set(auth(ALICE))
        .send(
          syncBatch({
            devices: [{ id: 'dev-alice', name: 'mine', type: 'hub' }],
          }),
        )
        .expect(201);
    });

    it('lets exactly one of two concurrent claims succeed', async () => {
      const [a, b] = await Promise.all([
        request(server())
          .post('/devices/claim')
          .set(auth(ALICE))
          .send({ device_id: 'dev-free' }),
        request(server())
          .post('/devices/claim')
          .set(auth(BOB))
          .send({ device_id: 'dev-free' }),
      ]);
      expect([a.status, b.status].sort()).toEqual([201, 400]);
      const winner = a.status === 201 ? ALICE : BOB;
      expect(ownerOf('dev-free')).toBe(winner);
    });

    it('revokes reads for the previous owner after unclaim', async () => {
      await request(server())
        .post('/devices/unclaim')
        .set(auth(ALICE))
        .send({ device_id: 'dev-alice' })
        .expect(201);
      const devices = await request(server())
        .get('/devices')
        .set(auth(ALICE))
        .expect(200);
      expect(JSON.stringify(devices.body)).not.toContain('dev-alice');
      await request(server())
        .get('/dashboard/vitals/latest?deviceId=dev-alice')
        .set(auth(ALICE))
        .expect(404);
      const alerts = await request(server())
        .get('/alerts/recent')
        .set(auth(ALICE))
        .expect(200);
      expect(JSON.stringify(alerts.body)).not.toContain('dev-alice');
    });
  });

  describe('tenant isolation (GAP-002)', () => {
    it("returns 400, not another tenant's vitals, when deviceId is missing", async () => {
      const res = await request(server())
        .get('/dashboard/vitals/latest')
        .set(auth(ALICE))
        .expect(400);
      expect(JSON.stringify(res.body)).not.toContain('39.9');
    });

    it("returns 404 for another tenant's device and 200 for your own", async () => {
      await request(server())
        .get('/dashboard/vitals/latest?deviceId=dev-bob')
        .set(auth(ALICE))
        .expect(404);
      const own = await request(server())
        .get('/dashboard/vitals/latest?deviceId=dev-alice')
        .set(auth(ALICE))
        .expect(200);
      expect(JSON.stringify(own.body)).toContain('36.6');
    });

    it('returns 400 for timeline events without a deviceId', async () => {
      const res = await request(server())
        .get('/timeline/events?period=day&date=2026-03-12')
        .set(auth(ALICE))
        .expect(400);
      expect(JSON.stringify(res.body)).not.toContain('dev-bob');
    });

    it('scopes alert lists and alert actions to the caller', async () => {
      const recent = await request(server())
        .get('/alerts/recent')
        .set(auth(ALICE))
        .expect(200);
      expect(JSON.stringify(recent.body)).toContain('fall_dev-alice_1');
      expect(JSON.stringify(recent.body)).not.toContain('dev-bob');
      await request(server())
        .patch('/alerts/fall_dev-bob_1/false-alarm')
        .set(auth(ALICE))
        .expect(404);
      await request(server())
        .get('/devices/dev-bob/status')
        .set(auth(ALICE))
        .expect(404);
    });
  });
});
