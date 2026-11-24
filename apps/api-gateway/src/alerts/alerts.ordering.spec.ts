/* eslint-disable @typescript-eslint/no-unsafe-argument */
/**
 * AR-3: /alerts/recent orders by severity first, so a fall is never pushed out
 * of the limit window by a burst of lower-severity alerts.
 */
import {
  Alert,
  AlertType,
  Device,
  DeviceOwnership,
} from '../database/entities';
import { OwnershipService } from '../ownership/ownership.service';
import { ALICE, T0, createPhase0Db } from '../../test/support/phase0-fixtures';
import { AlertsService } from './alerts.service';

describe('recent alerts ordering (AR-3)', () => {
  it('returns the fall first even when 25 newer moisture alerts exist', async () => {
    const db = createPhase0Db();
    for (let i = 0; i < 25; i++) {
      db.rows(Alert).push({
        id: `moisture_dev-alice_${i}`,
        deviceId: 'dev-alice',
        type: AlertType.MOISTURE,
        title: 'Moisture',
        timestamp: new Date(T0.getTime() + 60_000 + i * 1000),
        createdAt: new Date(T0.getTime() + 60_000 + i * 1000),
        isDismissed: false,
        isAttended: false,
        isFalseAlarm: false,
        dismissedAt: null,
        syncSlot: 'iot_live',
      });
    }
    const service = new AlertsService(
      db.repository(Alert) as any,
      db.repository(Device) as any,
      { publishNew: jest.fn(), publishUpdated: jest.fn() } as any,
      new OwnershipService(db.repository(DeviceOwnership) as any),
      db.dataSource() as any,
    );
    const { alerts } = await service.getRecentAlerts(ALICE, undefined, 20);
    expect(alerts).toHaveLength(20);
    expect(alerts[0]).toMatchObject({
      id: 'fall_dev-alice_1',
      severity: 'critical',
    });
    expect(alerts[1].severity).toBe('normal');
  });
});
