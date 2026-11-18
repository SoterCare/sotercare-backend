/* eslint-disable @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-return */
/**
 * AR-4: dismissing or restoring an alert from the timeline is a human action
 * on a safety record and leaves one append-only audit row, written in the
 * same transaction as the state change. Repeating an action is idempotent
 * and does not add a second row.
 */
import {
  Alert,
  AlertAction,
  Device,
  DeviceOwnership,
  Vital,
} from '../database/entities';
import { OwnershipService } from '../ownership/ownership.service';
import { ALICE, createPhase0Db } from '../../test/support/phase0-fixtures';
import { TimelineService } from './timeline.service';

function setup() {
  const db = createPhase0Db();
  const publishUpdated = jest.fn();
  const timeline = new TimelineService(
    db.repository(Device) as any,
    db.repository(Vital) as any,
    db.repository(Alert) as any,
    new OwnershipService(db.repository(DeviceOwnership) as any),
    { publishUpdated } as any,
  );
  return { db, timeline, publishUpdated };
}

describe('timeline dismiss/restore audit (AR-4)', () => {
  it('records who dismissed the alert, from where, and the state change', async () => {
    const { db, timeline } = setup();
    await expect(
      timeline.dismiss(ALICE, { id: 'fall_dev-alice_1' }, 'web'),
    ).resolves.toEqual({
      dismissedId: 'fall_dev-alice_1',
    });
    expect(db.rows(AlertAction)).toEqual([
      expect.objectContaining({
        alertId: 'fall_dev-alice_1',
        userId: ALICE,
        action: 'dismissed',
        source: 'web',
        previousState: 'active',
        newState: 'dismissed',
      }),
    ]);
    expect(
      db.rows(Alert).find((a) => a.id === 'fall_dev-alice_1')?.isDismissed,
    ).toBe(true);
  });

  it('does not add a second row or event when the alert is already dismissed', async () => {
    const { db, timeline, publishUpdated } = setup();
    await timeline.dismiss(ALICE, { id: 'fall_dev-alice_1' });
    await timeline.dismiss(ALICE, { id: 'fall_dev-alice_1' });
    expect(db.rows(AlertAction)).toHaveLength(1);
    expect(publishUpdated).toHaveBeenCalledTimes(1);
  });

  it('records the restore with source unknown when the client is not identified', async () => {
    const { db, timeline } = setup();
    await timeline.dismiss(ALICE, { id: 'fall_dev-alice_1' }, 'mobile');
    await timeline.restore(ALICE, { id: 'fall_dev-alice_1' });
    expect(
      db
        .rows(AlertAction)
        .map((r) => [r.action, r.source, r.previousState, r.newState]),
    ).toEqual([
      ['dismissed', 'mobile', 'active', 'dismissed'],
      ['restored', 'unknown', 'dismissed', 'active'],
    ]);
    expect(
      db.rows(Alert).find((a) => a.id === 'fall_dev-alice_1')?.dismissedAt,
    ).toBeNull();
  });
});
