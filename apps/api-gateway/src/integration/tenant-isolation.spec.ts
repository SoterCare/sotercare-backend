/* eslint-disable @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access */
/**
 * Phase 0 / GAP-002 (LV-04): every device-scoped read must be limited to
 * devices owned by the authenticated user, and a missing deviceId must be
 * rejected rather than silently widening the query to every tenant.
 *
 * The in-memory repositories reproduce TypeORM 0.3's default of IGNORING
 * undefined values in `where`, which is exactly how the leak happened.
 */
import { BadRequestException, NotFoundException } from '@nestjs/common';
import {
  Alert,
  Device,
  DeviceOwnership,
  DeviceStatus,
  Vital,
} from '../database/entities';
import { OwnershipService } from '../ownership/ownership.service';
import { AlertsService } from '../alerts/alerts.service';
import { DashboardService } from '../dashboard/dashboard.service';
import { DevicesService } from '../devices/devices.service';
import { TimelineService } from '../timeline/timeline.service';
import {
  ALICE,
  configStub,
  createPhase0Db,
} from '../../test/support/phase0-fixtures';

function setup() {
  const db = createPhase0Db();
  const devices = db.repository(Device) as any;
  const vitals = db.repository(Vital) as any;
  const alerts = db.repository(Alert) as any;
  const ownership = new OwnershipService(db.repository(DeviceOwnership) as any);
  return {
    db,
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

const day = { period: 'day' as const, date: '2026-03-12' };

describe('Tenant isolation (GAP-002)', () => {
  describe('GET /dashboard/vitals/latest', () => {
    it.each([
      ['missing', undefined],
      ['empty', ''],
    ])(
      "rejects a %s deviceId instead of returning another tenant's vitals",
      async (_label, deviceId) => {
        const { dashboard } = setup();
        await expect(
          dashboard.getLatestVitals(ALICE, deviceId as any),
        ).rejects.toBeInstanceOf(BadRequestException);
      },
    );

    it('returns 404 for a device owned by someone else', async () => {
      const { dashboard } = setup();
      await expect(
        dashboard.getLatestVitals(ALICE, 'dev-bob'),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it("returns only the caller's own reading", async () => {
      const { dashboard } = setup();
      const result = await dashboard.getLatestVitals(ALICE, 'dev-alice');
      expect(result).toMatchObject({
        deviceId: 'dev-alice',
        temperature: 36.6,
      });
    });
  });

  describe('timeline', () => {
    it("rejects /timeline/events without a deviceId instead of listing every tenant's alerts", async () => {
      const { timeline } = setup();
      await expect(
        timeline.getEvents(ALICE, { ...day } as any),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it("rejects /timeline/events for another tenant's device", async () => {
      const { timeline } = setup();
      await expect(
        timeline.getEvents(ALICE, { ...day, deviceId: 'dev-bob' }),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it.each(['getVitalsTimeline', 'getStats', 'getDateOptions'] as const)(
      'rejects %s without a deviceId before touching the vitals table',
      async (method) => {
        const { timeline } = setup();
        await expect(
          (timeline as any)[method](ALICE, { ...day, metric: 'temp' }),
        ).rejects.toBeInstanceOf(BadRequestException);
      },
    );

    it.each(['restore', 'dismiss'] as const)(
      "refuses to %s another tenant's alert",
      async (method) => {
        const { timeline, db } = setup();
        await expect(
          timeline[method](ALICE, { id: 'fall_dev-bob_1' }),
        ).rejects.toBeInstanceOf(NotFoundException);
        expect(
          db.rows(Alert).find((a) => a.id === 'fall_dev-bob_1')?.isDismissed,
        ).toBe(false);
      },
    );

    it("lists only the caller's dismissed items", async () => {
      const { timeline, db } = setup();
      for (const row of db.rows(Alert)) row.isDismissed = true;
      const result: any = await timeline.getDismissed(ALICE);
      const ids = JSON.stringify(result);
      expect(ids).toContain('fall_dev-alice_1');
      expect(ids).not.toContain('dev-bob');
    });
  });

  describe('alerts', () => {
    it("lists only the caller's alerts when no deviceId is given", async () => {
      const { alerts } = setup();
      const result = await alerts.getRecentAlerts(ALICE);
      expect(result.alerts.map((a) => a.deviceId)).toEqual(['dev-alice']);
    });

    it("rejects recent alerts for another tenant's device", async () => {
      const { alerts } = setup();
      await expect(
        alerts.getRecentAlerts(ALICE, 'dev-bob'),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('excludes other tenants from attended alerts', async () => {
      const { alerts } = setup();
      const result = await alerts.getAttendedAlerts(ALICE);
      expect(result.alerts).toHaveLength(0);
    });

    it("refuses to resolve another tenant's alert and leaves it untouched", async () => {
      const { alerts, db } = setup();
      await expect(
        alerts.resolveAlert(ALICE, 'fall_dev-bob_1', 'false-alarm'),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(
        db.rows(Alert).find((a) => a.id === 'fall_dev-bob_1')?.isFalseAlarm,
      ).toBe(false);
    });
  });

  describe('devices', () => {
    it("lists only the caller's devices", async () => {
      const { devices } = setup();
      const result = await devices.getDevices(ALICE, false);
      expect(result.devices.map((d) => d.id)).toEqual(['dev-alice']);
    });

    it("refuses device status for another tenant's device", async () => {
      const { devices } = setup();
      await expect(
        devices.getDeviceStatus(ALICE, 'dev-bob'),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });
});
