/* eslint-disable @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-member-access */
/**
 * AR-4: acknowledgement audit. First acknowledgement wins; a repeat of the
 * same action is idempotent; a conflicting action is a controlled 409; every
 * attempt (winning or not) is audited with actor, server time, previous and
 * new state and source. Foreign users are refused and nothing is written.
 */
import { ConflictException, NotFoundException } from '@nestjs/common';
import {
  Alert,
  AlertAction,
  Device,
  DeviceOwnership,
} from '../database/entities';
import { OwnershipService } from '../ownership/ownership.service';
import { ALICE, BOB, createPhase0Db } from '../../test/support/phase0-fixtures';
import { AlertsService } from './alerts.service';

function setup() {
  const db = createPhase0Db();
  const publisher = { publishNew: jest.fn(), publishUpdated: jest.fn() };
  const service = new AlertsService(
    db.repository(Alert) as any,
    db.repository(Device) as any,
    publisher as any,
    new OwnershipService(db.repository(DeviceOwnership) as any),
    db.dataSource() as any,
  );
  const actions = () =>
    db
      .rows(AlertAction)
      .filter((a) => a.alertId === 'fall_dev-alice_1') as AlertAction[];
  const alert = () =>
    db.rows(Alert).find((a) => a.id === 'fall_dev-alice_1')! as Alert;
  return { db, service, publisher, actions, alert };
}

describe('Alert acknowledgement audit (AR-4)', () => {
  it('records who acknowledged, when, the transition and the channel', async () => {
    const { service, actions, alert, publisher } = setup();
    const before = Date.now();
    const res = await service.resolveAlert(
      ALICE,
      'fall_dev-alice_1',
      'attended',
      'mobile',
    );
    expect(res).toMatchObject({
      id: 'fall_dev-alice_1',
      status: 'attended',
      alreadyAcknowledged: false,
      acknowledgedBy: { userId: ALICE },
    });
    expect(alert()).toMatchObject({
      isAttended: true,
      ackAction: 'attended',
      acknowledgedByUserId: ALICE,
    });
    expect(alert().acknowledgedAt!.getTime()).toBeGreaterThanOrEqual(before);
    expect(actions()).toEqual([
      expect.objectContaining({
        userId: ALICE,
        action: 'attended',
        source: 'mobile',
        previousState: 'active',
        newState: 'attended',
      }),
    ]);
    expect(publisher.publishUpdated).toHaveBeenCalledTimes(1);
  });

  it('treats a repeated identical acknowledgement as idempotent and audits the repeat', async () => {
    const { service, actions, publisher } = setup();
    await service.resolveAlert(ALICE, 'fall_dev-alice_1', 'attended', 'web');
    const again = await service.resolveAlert(
      ALICE,
      'fall_dev-alice_1',
      'attended',
      'mobile',
    );
    expect(again).toMatchObject({
      status: 'attended',
      alreadyAcknowledged: true,
    });
    expect(actions().map((a) => a.action)).toEqual([
      'attended',
      'ack_rejected_already_acknowledged',
    ]);
    expect(publisher.publishUpdated).toHaveBeenCalledTimes(1);
  });

  it('rejects a conflicting second decision with 409 and keeps the first one', async () => {
    const { service, actions, alert } = setup();
    await service.resolveAlert(ALICE, 'fall_dev-alice_1', 'attended', 'web');
    await expect(
      service.resolveAlert(ALICE, 'fall_dev-alice_1', 'false-alarm', 'mobile'),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(alert()).toMatchObject({
      ackAction: 'attended',
      isFalseAlarm: false,
    });
    expect(actions()).toHaveLength(2);
  });

  it('lets exactly one of two concurrent conflicting decisions win', async () => {
    const { service, alert } = setup();
    const results = await Promise.allSettled([
      service.resolveAlert(ALICE, 'fall_dev-alice_1', 'attended', 'web'),
      service.resolveAlert(ALICE, 'fall_dev-alice_1', 'false-alarm', 'mobile'),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(['attended', 'false_alarm']).toContain(alert().ackAction);
  });

  it('refuses a user outside the device scope and writes no audit row', async () => {
    const { service, actions } = setup();
    await expect(
      service.resolveAlert(BOB, 'fall_dev-alice_1', 'attended', 'web'),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(actions()).toHaveLength(0);
  });

  it('reports the recorded acknowledgement time for attended alerts', async () => {
    const { service } = setup();
    await service.resolveAlert(ALICE, 'fall_dev-alice_1', 'attended', 'web');
    const list = await service.getAttendedAlerts(ALICE);
    const item: any = list.alerts.find((a) => a.id === 'fall_dev-alice_1');
    expect(item.attendedAtSource).toBe('recorded');
    expect(item.attendedAt).toBeGreaterThan(item.timestamp);
  });
});
