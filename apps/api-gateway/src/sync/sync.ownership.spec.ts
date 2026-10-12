/* eslint-disable @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-return */
/**
 * Phase 0 / GAP-001 (LV-02): POST /sync/raspberry-pi must never transfer an
 * existing device to another authenticated user, nor write data into a device
 * the caller does not own.
 */
import { ForbiddenException } from '@nestjs/common';
import {
  Alert,
  Device,
  DeviceOwnership,
  DeviceStatus,
  RecordingSession,
  SyncHistory,
  Vital,
} from '../database/entities';
import {
  ALICE,
  BOB,
  createPhase0Db,
  syncBatch,
} from '../../test/support/phase0-fixtures';
import { SyncService } from './sync.service';
import { OwnershipService } from '../ownership/ownership.service';

function setup() {
  const db = createPhase0Db();
  const service = new SyncService(
    db.dataSource() as any,
    db.repository(SyncHistory) as any,
    new OwnershipService(db.repository(DeviceOwnership) as any),
  );
  return { db, service };
}

const ownerOf = (db: ReturnType<typeof createPhase0Db>, id: string) =>
  db.rows(Device).find((d) => d.id === id)?.userId;

describe('SyncService ownership (GAP-001)', () => {
  it('accepts a batch for a device the caller already owns', async () => {
    const { db, service } = setup();
    const result = await service.processRaspberryPiSync(
      ALICE,
      syncBatch({
        devices: [
          { id: 'dev-alice', name: 'Alice thigh band', type: 'thigh_band' },
        ],
        latestVitals: [
          {
            deviceId: 'dev-alice',
            timestamp: '2026-03-12T08:00:01.500Z',
            temperature: 36.7,
          },
        ],
      }),
    );
    expect(result.success).toBe(true);
    expect(ownerOf(db, 'dev-alice')).toBe(ALICE);
    expect(
      db.rows(Vital).filter((v) => v.deviceId === 'dev-alice'),
    ).toHaveLength(2);
  });

  it('still creates a brand-new device id that no one owns or has registered', async () => {
    const { db, service } = setup();
    await service.processRaspberryPiSync(
      ALICE,
      syncBatch({ devices: [{ id: 'dev-new', name: 'New hub', type: 'hub' }] }),
    );
    expect(ownerOf(db, 'dev-new')).toBe(ALICE);
  });

  it('rejects a batch that lists a device owned by another user and leaves ownership unchanged', async () => {
    const { db, service } = setup();
    await expect(
      service.processRaspberryPiSync(
        ALICE,
        syncBatch({
          devices: [{ id: 'dev-bob', name: 'stolen', type: 'hub' }],
        }),
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(ownerOf(db, 'dev-bob')).toBe(BOB);
    expect(db.rows(SyncHistory)).toHaveLength(0);
  });

  it('rejects listing a registered-but-unclaimed device (must go through /devices/claim)', async () => {
    const { db, service } = setup();
    await expect(
      service.processRaspberryPiSync(
        ALICE,
        syncBatch({
          devices: [{ id: 'dev-free', name: 'squat', type: 'hub' }],
        }),
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(db.rows(Device).find((d) => d.id === 'dev-free')).toBeUndefined();
  });

  it.each([
    [
      'latestVitals',
      {
        latestVitals: [
          {
            deviceId: 'dev-bob',
            timestamp: '2026-03-12T08:00:03.000Z',
            temperature: 20,
          },
        ],
      },
    ],
    [
      'recentAlerts',
      {
        recentAlerts: [
          {
            id: 'fake_alert',
            deviceId: 'dev-bob',
            type: 'fall',
            title: 'x',
            timestamp: '2026-03-12T08:00:03.000Z',
          },
        ],
      },
    ],
    [
      'deviceStatuses',
      { deviceStatuses: [{ deviceId: 'dev-bob', battery: 1 }] },
    ],
    [
      'recordingSessions',
      {
        recordingSessions: [
          {
            recordingId: 'rec-x',
            deviceId: 'dev-bob',
            createdAt: '2026-03-12T08:00:03.000Z',
          },
        ],
      },
    ],
  ])(
    'rejects %s written into a device the caller does not own',
    async (_name, part) => {
      const { db, service } = setup();
      const before = {
        vitals: db.rows(Vital).length,
        alerts: db.rows(Alert).length,
        statuses: db.rows(DeviceStatus).length,
        recordings: db.rows(RecordingSession).length,
      };
      await expect(
        service.processRaspberryPiSync(ALICE, syncBatch(part)),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect({
        vitals: db.rows(Vital).length,
        alerts: db.rows(Alert).length,
        statuses: db.rows(DeviceStatus).length,
        recordings: db.rows(RecordingSession).length,
      }).toEqual(before);
    },
  );

  it('rejects re-pointing an existing recording session that belongs to another user', async () => {
    const { db, service } = setup();
    await expect(
      service.processRaspberryPiSync(
        ALICE,
        syncBatch({
          recordingSessions: [
            {
              recordingId: 'rec-bob-1',
              deviceId: 'dev-alice',
              createdAt: '2026-03-12T08:00:03.000Z',
            },
          ],
        }),
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(
      db.rows(RecordingSession).find((r) => r.recordingId === 'rec-bob-1')
        ?.deviceId,
    ).toBe('dev-bob');
  });

  it('lets exactly one of two concurrent first-time syncs of the same new device win', async () => {
    const { db, service } = setup();
    const results = await Promise.allSettled([
      service.processRaspberryPiSync(
        ALICE,
        syncBatch({
          slot: 'a',
          devices: [{ id: 'dev-race', name: 'a', type: 'hub' }],
        }),
      ),
      service.processRaspberryPiSync(
        BOB,
        syncBatch({
          slot: 'b',
          devices: [{ id: 'dev-race', name: 'b', type: 'hub' }],
        }),
      ),
    ]);
    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0].reason).toBeInstanceOf(ForbiddenException);
    const winner = results[0].status === 'fulfilled' ? ALICE : BOB;
    expect(ownerOf(db, 'dev-race')).toBe(winner);
  });

  it('does not let another user pre-empt a batch through a shared idempotency key', async () => {
    const { service } = setup();
    const shared = {
      source: 'raspberry_pi_gateway',
      slot: 'slot_08',
      syncedAt: '2026-03-12T08:00:02.000Z',
    };
    await service.processRaspberryPiSync(
      BOB,
      syncBatch({
        ...shared,
        devices: [{ id: 'dev-bob', name: 'b', type: 'hub' }],
      }),
    );
    const result = await service.processRaspberryPiSync(
      ALICE,
      syncBatch({
        ...shared,
        devices: [{ id: 'dev-alice', name: 'a', type: 'hub' }],
      }),
    );
    expect(result.note).toBeUndefined();
    expect(result.upserted.devices).toBe(1);
  });
});
