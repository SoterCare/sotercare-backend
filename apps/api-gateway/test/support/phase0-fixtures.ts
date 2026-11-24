/* eslint-disable @typescript-eslint/no-unsafe-return */
/**
 * Two-tenant fixture for Phase 0 security regression tests.
 * All identities and readings are synthetic — never production data.
 *
 *   user 1 ("alice") owns device  dev-alice  (registered in iot_devices, online)
 *   user 2 ("bob")   owns device  dev-bob    (registered in iot_devices, online)
 *   dev-free                       registered in iot_devices, unclaimed, online
 */
import {
  Alert,
  AlertAction,
  AlertType,
  Device,
  DeviceOwnership,
  DeviceStatus,
  DeviceType,
  RecordingSession,
  SyncHistory,
  Vital,
} from '../../src/database/entities';
import { IotDevice } from '../../src/iot-device/iot-device.entity';
import { InMemoryDb } from './in-memory-db';

export const ALICE = 1;
export const BOB = 2;
export const T0 = new Date('2026-03-12T08:00:00.000Z');
export const OWNED_SINCE = new Date(T0.getTime() - 24 * 3_600_000);

export function createPhase0Db(now = new Date()) {
  const db = new InMemoryDb()
    .define(Device, { primaryKey: 'id' })
    .define(IotDevice, { primaryKey: 'deviceId' })
    .define(DeviceOwnership, {
      primaryKey: 'id',
      autoIncrement: true,
      defaults: { createdAt: () => new Date() },
    })
    .define(Vital, {
      primaryKey: 'id',
      autoIncrement: true,
      defaults: { createdAt: () => new Date() },
      uniques: [['deviceId', 'timestamp']],
    })
    .define(Alert, {
      primaryKey: 'id',
      defaults: { createdAt: () => new Date() },
      relations: { device: { table: 'Device', fk: 'deviceId' } },
    })
    .define(DeviceStatus, { primaryKey: 'id', autoIncrement: true })
    .define(RecordingSession, { primaryKey: 'recordingId' })
    .define(AlertAction, {
      primaryKey: 'id',
      autoIncrement: true,
      defaults: { createdAt: () => new Date() },
    })
    .define(SyncHistory, {
      primaryKey: 'id',
      autoIncrement: true,
      uniques: [['idempotencyKey']],
    });

  const device = (id: string, userId: number) => ({
    id,
    userId,
    name: `Device ${id}`,
    type: DeviceType.HUB,
    lastSeenAt: now,
    lastSyncSlot: 'iot_live',
    syncSource: 'iot_claim',
    createdAt: T0,
    updatedAt: T0,
  });

  db.seed(Device, [device('dev-alice', ALICE), device('dev-bob', BOB)]);
  db.seed(IotDevice, [
    {
      deviceId: 'dev-alice',
      deviceKeyHash: 'x:y',
      ownerId: ALICE,
      isPaired: true,
      lastSeen: now,
    },
    {
      deviceId: 'dev-bob',
      deviceKeyHash: 'x:y',
      ownerId: BOB,
      isPaired: true,
      lastSeen: now,
    },
    {
      deviceId: 'dev-free',
      deviceKeyHash: 'x:y',
      ownerId: null,
      isPaired: false,
      lastSeen: now,
    },
  ]);
  // Ownership periods (PH0-07): both owners hold an open interval that began
  // before any fixture data, so existing expectations are unchanged.
  db.seed(DeviceOwnership, [
    {
      deviceId: 'dev-alice',
      userId: ALICE,
      startedAt: OWNED_SINCE,
      endedAt: null,
      startReason: 'claim',
      endReason: null,
    },
    {
      deviceId: 'dev-bob',
      userId: BOB,
      startedAt: OWNED_SINCE,
      endedAt: null,
      startReason: 'claim',
      endReason: null,
    },
  ]);
  db.seed(Vital, [
    {
      deviceId: 'dev-alice',
      timestamp: new Date(T0.getTime() + 1000),
      createdAt: new Date(T0.getTime() + 1000),
      temperature: 36.6,
      roomTemperature: 24,
      moisture: 3,
      gaitAnalysis: 'walking',
      thighnodeStatus: null,
      syncSlot: 'iot_live',
    },
    // Bob's reading is the newest row in the whole table: a cross-tenant leak returns it.
    {
      deviceId: 'dev-bob',
      timestamp: new Date(T0.getTime() + 9000),
      createdAt: new Date(T0.getTime() + 9000),
      temperature: 39.9,
      roomTemperature: 30,
      moisture: 88,
      gaitAnalysis: 'sitting idle',
      thighnodeStatus: null,
      syncSlot: 'iot_live',
    },
  ]);
  const alert = (id: string, deviceId: string, extra: Partial<Alert> = {}) => ({
    id,
    deviceId,
    type: AlertType.FALL,
    title: 'Fall Detected',
    timestamp: new Date(T0.getTime() + 5000),
    createdAt: new Date(T0.getTime() + 5000),
    isDismissed: false,
    isAttended: false,
    isFalseAlarm: false,
    dismissedAt: null,
    syncSlot: 'iot_live',
    acknowledgedAt: null,
    acknowledgedByUserId: null,
    ackAction: null,
    ...extra,
  });
  db.seed(Alert, [
    alert('fall_dev-alice_1', 'dev-alice'),
    alert('fall_dev-bob_1', 'dev-bob'),
    alert('fall_dev-bob_attended', 'dev-bob', { isAttended: true }),
  ]);
  db.seed(RecordingSession, [
    {
      recordingId: 'rec-bob-1',
      deviceId: 'dev-bob',
      createdAt: T0,
      syncedAt: T0,
    },
  ]);
  return db;
}

export function syncBatch(overrides: Record<string, any> = {}) {
  return {
    source: 'raspberry_pi_gateway',
    syncedAt: '2026-03-12T08:00:02.000Z',
    slot: 'slot_08',
    gatewayHost: 'raspberrypi.local',
    devices: [],
    deviceStatuses: [],
    latestVitals: [],
    recentAlerts: [],
    recordingSessions: [],
    ...overrides,
  } as any;
}

export const configStub = (values: Record<string, any> = {}) =>
  ({
    get: (key: string, fallback?: any) =>
      key in values ? values[key] : fallback,
  }) as any;
