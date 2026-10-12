/* eslint-disable @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access */
/**
 * Phase 0 / GAP-001: device claim must be race-free, and unclaim must revoke
 * the previous owner's read access everywhere (devices.userId is the column
 * every read path — Node and the Python AI service — filters on).
 */
import { BadRequestException } from '@nestjs/common';
import { Device, DeviceOwnership, Vital } from '../database/entities';
import { DashboardService } from '../dashboard/dashboard.service';
import { DevicesService } from '../devices/devices.service';
import {
  ALICE,
  BOB,
  configStub,
  createPhase0Db,
} from '../../test/support/phase0-fixtures';
import { IotDevice } from './iot-device.entity';
import { IotDeviceService, UNOWNED_USER_ID } from './iot-device.service';
import { OwnershipService } from '../ownership/ownership.service';

function setup() {
  const db = createPhase0Db();
  const ownership = new OwnershipService(db.repository(DeviceOwnership) as any);
  const service = new IotDeviceService(
    configStub(),
    db.repository(IotDevice) as any,
    db.repository(Device) as any,
    db.dataSource() as any,
    ownership,
  );
  return { db, service, ownership };
}

const iot = (db: ReturnType<typeof createPhase0Db>, id: string) =>
  db.rows(IotDevice).find((d) => d.deviceId === id)!;
const dash = (db: ReturnType<typeof createPhase0Db>, id: string) =>
  db.rows(Device).find((d) => d.id === id);

describe('IotDeviceService ownership (GAP-001)', () => {
  it('claims an unowned, online device', async () => {
    const { db, service } = setup();
    const result = await service.claimDevice(ALICE, 'dev-free');
    expect(result.owner_id).toBe(ALICE);
    expect(iot(db, 'dev-free').ownerId).toBe(ALICE);
    expect(dash(db, 'dev-free')?.userId).toBe(ALICE);
  });

  it('refuses to claim a device owned by another user and leaves it untouched', async () => {
    const { db, service } = setup();
    await expect(service.claimDevice(ALICE, 'dev-bob')).rejects.toThrow(
      new BadRequestException('Device is already claimed by another user'),
    );
    expect(iot(db, 'dev-bob').ownerId).toBe(BOB);
    expect(dash(db, 'dev-bob')?.userId).toBe(BOB);
  });

  it('treats re-claiming your own device as idempotent', async () => {
    const { db, service } = setup();
    const result = await service.claimDevice(ALICE, 'dev-alice');
    expect(result.owner_id).toBe(ALICE);
    expect(iot(db, 'dev-alice').ownerId).toBe(ALICE);
  });

  it('lets exactly one of two concurrent claims of the same device succeed', async () => {
    const { db, service } = setup();
    const results = await Promise.allSettled([
      service.claimDevice(ALICE, 'dev-free'),
      service.claimDevice(BOB, 'dev-free'),
    ]);
    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    expect(fulfilled).toHaveLength(1);
    const winner = (fulfilled[0] as PromiseFulfilledResult<any>).value.owner_id;
    expect(iot(db, 'dev-free').ownerId).toBe(winner);
    expect(dash(db, 'dev-free')?.userId).toBe(winner);
  });

  it('revokes the previous owner on unclaim (dashboard row marked unowned)', async () => {
    const { db, service } = setup();
    await service.unclaimDevice(ALICE, 'dev-alice');
    expect(iot(db, 'dev-alice').ownerId).toBeNull();
    expect(dash(db, 'dev-alice')?.userId).toBe(UNOWNED_USER_ID);

    const devices = new DevicesService(
      configStub(),
      db.repository(Device) as any,
      {} as any,
      new OwnershipService(db.repository(DeviceOwnership) as any),
    );
    expect((await devices.getDevices(ALICE, false)).devices).toHaveLength(0);

    const dashboard = new DashboardService(
      db.repository(Device) as any,
      db.repository(Vital) as any,
      new OwnershipService(db.repository(DeviceOwnership) as any),
    );
    await expect(dashboard.getLatestVitals(ALICE, 'dev-alice')).rejects.toThrow(
      'Device not found or does not belong to user',
    );
  });

  it('refuses to unclaim a device owned by another user', async () => {
    const { db, service } = setup();
    await expect(
      service.unclaimDevice(ALICE, 'dev-bob'),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(iot(db, 'dev-bob').ownerId).toBe(BOB);
    expect(dash(db, 'dev-bob')?.userId).toBe(BOB);
  });

  it('hands a released device to the next claimant only', async () => {
    const { db, service } = setup();
    await service.unclaimDevice(ALICE, 'dev-alice');
    await service.claimDevice(BOB, 'dev-alice');
    expect(iot(db, 'dev-alice').ownerId).toBe(BOB);
    expect(dash(db, 'dev-alice')?.userId).toBe(BOB);
  });
});
