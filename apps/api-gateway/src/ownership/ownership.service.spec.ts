/* eslint-disable @typescript-eslint/no-unsafe-argument */
/**
 * Phase 1 / PH0-07: ownership periods. Access to device-keyed history is
 * bounded by the caller's own ownership interval, never by "owns it now".
 */
import { ConflictException } from '@nestjs/common';
import { DeviceOwnership } from '../database/entities';
import { InMemoryDb } from '../../test/support/in-memory-db';
import { OwnershipService } from './ownership.service';

const H = 3_600_000;
const T = new Date('2026-03-12T08:00:00.000Z').getTime();

function setup() {
  const db = new InMemoryDb().define(DeviceOwnership, {
    primaryKey: 'id',
    autoIncrement: true,
  });
  db.seed(DeviceOwnership, [
    // Alice owned dev-1 for an hour, then Bob claimed it.
    {
      deviceId: 'dev-1',
      userId: 1,
      startedAt: new Date(T),
      endedAt: new Date(T + H),
      startReason: 'claim',
      endReason: 'unclaim',
    },
    {
      deviceId: 'dev-1',
      userId: 2,
      startedAt: new Date(T + 2 * H),
      endedAt: null,
      startReason: 'claim',
      endReason: null,
    },
    {
      deviceId: 'dev-2',
      userId: 1,
      startedAt: new Date(T),
      endedAt: null,
      startReason: 'claim',
      endReason: null,
    },
  ]);
  const service = new OwnershipService(db.repository(DeviceOwnership) as any);
  return { db, service };
}

describe('OwnershipService', () => {
  it("returns the start of the caller's open interval for a device", async () => {
    const { service } = setup();
    expect(await service.currentWindow(2, 'dev-1')).toEqual(
      new Date(T + 2 * H),
    );
    expect(await service.currentWindow(1, 'dev-2')).toEqual(new Date(T));
  });

  it('returns null for a closed (previous) interval or a device the caller never owned', async () => {
    const { service } = setup();
    expect(await service.currentWindow(1, 'dev-1')).toBeNull();
    expect(await service.currentWindow(3, 'dev-1')).toBeNull();
    expect(await service.currentWindow(2, 'dev-unknown')).toBeNull();
  });

  it('lists every open window of a user', async () => {
    const { service } = setup();
    const windows = await service.currentWindows(1);
    expect([...windows.entries()]).toEqual([['dev-2', new Date(T)]]);
  });

  it('resolves the current owner and since-when', async () => {
    const { service } = setup();
    expect(await service.currentOwnership('dev-1')).toEqual({
      userId: 2,
      since: new Date(T + 2 * H),
    });
    expect(await service.currentOwnership('dev-unknown')).toBeNull();
  });

  it('opens an interval idempotently for the same user and refuses a second owner', async () => {
    const { db, service } = setup();
    const tx = db.dataSource();
    await tx.transaction((m) =>
      service.openInterval(m as any, 'dev-3', 5, 'claim'),
    );
    await tx.transaction((m) =>
      service.openInterval(m as any, 'dev-3', 5, 'claim'),
    );
    expect(
      db.rows(DeviceOwnership).filter((r) => r.deviceId === 'dev-3'),
    ).toHaveLength(1);
    await expect(
      tx.transaction((m) =>
        service.openInterval(m as any, 'dev-3', 6, 'claim'),
      ),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it("closes only the caller's open interval", async () => {
    const { db, service } = setup();
    await db
      .dataSource()
      .transaction((m) =>
        service.closeInterval(m as any, 'dev-1', 1, 'unclaim'),
      );
    expect(await service.currentWindow(2, 'dev-1')).toEqual(
      new Date(T + 2 * H),
    );
    await db
      .dataSource()
      .transaction((m) =>
        service.closeInterval(m as any, 'dev-1', 2, 'unclaim'),
      );
    expect(await service.currentWindow(2, 'dev-1')).toBeNull();
    const closed = db.rows(DeviceOwnership).find((r) => r.userId === 2);
    expect(closed?.endReason).toBe('unclaim');
    expect(closed?.endedAt).toBeInstanceOf(Date);
  });
});
