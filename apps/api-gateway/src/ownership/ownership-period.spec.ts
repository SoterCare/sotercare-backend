/* eslint-disable @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-assignment */
/**
 * Phase 1 / PH0-07 at the service level (in-memory fake with TypeORM
 * semantics). After a valid transfer the new owner sees only data ingested
 * during their own interval; previous owners lose access; nothing is deleted.
 * The query-builder timeline paths are covered on real PostgreSQL
 * (phase05-realdb.pg.spec.ts).
 */
import { NotFoundException } from '@nestjs/common';
import { AlertsService } from '../alerts/alerts.service';
import { DashboardService } from '../dashboard/dashboard.service';
import {
  Alert,
  AlertType,
  Device,
  DeviceOwnership,
  DeviceStatus,
  Vital,
} from '../database/entities';
import { DevicesService } from '../devices/devices.service';
import { IotDevice } from '../iot-device/iot-device.entity';
import { IotDeviceService } from '../iot-device/iot-device.service';
import { TimelineService } from '../timeline/timeline.service';
import {
  ALICE,
  BOB,
  configStub,
  createPhase0Db,
} from '../../test/support/phase0-fixtures';
import { OwnershipService } from './ownership.service';

function setup() {
  const db = createPhase0Db();
  const ownership = new OwnershipService(db.repository(DeviceOwnership) as any);
  const devices = db.repository(Device) as any;
  const vitals = db.repository(Vital) as any;
  const alerts = db.repository(Alert) as any;
  return {
    db,
    ownership,
    iot: new IotDeviceService(
      configStub(),
      db.repository(IotDevice) as any,
      devices,
      db.dataSource() as any,
      ownership,
    ),
    dashboard: new DashboardService(devices, vitals, ownership),
    timeline: new TimelineService(devices, vitals, alerts, ownership),
    alerts: new AlertsService(
      alerts,
      devices,
      { publishNew: jest.fn(), publishUpdated: jest.fn() } as any,
      ownership,
      db.dataSource() as any,
    ),
    devices: new DevicesService(
      configStub(),
      devices,
      db.repository(DeviceStatus) as any,
      ownership,
    ),
  };
}

async function transferAliceDeviceToBob(s: ReturnType<typeof setup>) {
  await s.iot.unclaimDevice(ALICE, 'dev-alice');
  await s.iot.claimDevice(BOB, 'dev-alice');
}

describe('Ownership periods (PH0-07)', () => {
  it('claim opens and unclaim closes an interval atomically with the registry change', async () => {
    const s = setup();
    await s.iot.unclaimDevice(ALICE, 'dev-alice');
    expect(await s.ownership.currentWindow(ALICE, 'dev-alice')).toBeNull();
    const closed = s.db
      .rows(DeviceOwnership)
      .find((r) => r.deviceId === 'dev-alice' && r.userId === ALICE);
    expect(closed?.endReason).toBe('unclaim');
    await s.iot.claimDevice(BOB, 'dev-alice');
    expect(await s.ownership.currentWindow(BOB, 'dev-alice')).toBeInstanceOf(
      Date,
    );
    // history rows are kept, not deleted
    expect(s.db.rows(Alert).some((a) => a.id === 'fall_dev-alice_1')).toBe(
      true,
    );
  });

  it("new owner gets no reading from the previous owner's period on the dashboard", async () => {
    const s = setup();
    await transferAliceDeviceToBob(s);
    expect(await s.dashboard.getLatestVitals(BOB, 'dev-alice')).toBeNull();
  });

  it('new owner sees readings ingested after their claim', async () => {
    const s = setup();
    await transferAliceDeviceToBob(s);
    s.db.rows(Vital).push({
      id: 99,
      deviceId: 'dev-alice',
      timestamp: new Date(),
      temperature: 36.9,
      createdAt: new Date(Date.now() + 1000),
    });
    expect(await s.dashboard.getLatestVitals(BOB, 'dev-alice')).toMatchObject({
      temperature: 36.9,
    });
  });

  it("new owner does not see the previous owner's alerts (recent, attended, events, dismissed)", async () => {
    const s = setup();
    for (const a of s.db.rows(Alert))
      if (a.deviceId === 'dev-alice') a.isAttended = false;
    await transferAliceDeviceToBob(s);
    const recent = await s.alerts.getRecentAlerts(BOB);
    expect(recent.alerts.map((a) => a.id)).not.toContain('fall_dev-alice_1');
    const forDevice = await s.alerts.getRecentAlerts(BOB, 'dev-alice');
    expect(forDevice.alerts).toEqual([]);
    for (const a of s.db.rows(Alert))
      if (a.deviceId === 'dev-alice') a.isDismissed = true;
    expect(JSON.stringify(await s.timeline.getDismissed(BOB))).not.toContain(
      'fall_dev-alice_1',
    );
  });

  it("new owner cannot act on the previous owner's alerts", async () => {
    const s = setup();
    await transferAliceDeviceToBob(s);
    await expect(
      s.alerts.resolveAlert(BOB, 'fall_dev-alice_1', 'attended'),
    ).rejects.toBeInstanceOf(NotFoundException);
    await expect(
      s.timeline.dismiss(BOB, { id: 'fall_dev-alice_1' }),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(
      s.db.rows(Alert).find((a) => a.id === 'fall_dev-alice_1')?.isAttended,
    ).toBe(false);
  });

  it("new owner does not inherit the previous owner's device status snapshot", async () => {
    const s = setup();
    s.db.rows(DeviceStatus).push({
      id: 1,
      deviceId: 'dev-alice',
      battery: 11,
      signalRssi: -40,
      bands: [],
      receivedAt: new Date(Date.now() - 60_000),
    });
    await transferAliceDeviceToBob(s);
    const status = await s.devices.getDeviceStatus(BOB, 'dev-alice');
    expect(status.battery).toBeNull();
  });

  it('new alerts created after the transfer are visible to the new owner only', async () => {
    const s = setup();
    await transferAliceDeviceToBob(s);
    s.db.rows(Alert).push({
      id: 'fall_dev-alice_new',
      deviceId: 'dev-alice',
      type: AlertType.FALL,
      title: 'Fall',
      timestamp: new Date(),
      isDismissed: false,
      isAttended: false,
      isFalseAlarm: false,
      dismissedAt: null,
      syncSlot: 'iot_live',
      createdAt: new Date(Date.now() + 1000),
    });
    expect(
      (await s.alerts.getRecentAlerts(BOB, 'dev-alice')).alerts.map(
        (a) => a.id,
      ),
    ).toEqual(['fall_dev-alice_new']);
    await expect(
      s.alerts.getRecentAlerts(ALICE, 'dev-alice'),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});
