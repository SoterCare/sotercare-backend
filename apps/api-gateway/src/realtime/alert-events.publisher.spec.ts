/* eslint-disable @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-member-access */
/**
 * AR-2: alert events are routed to the CURRENT owner resolved at send time
 * (I-4), and never for an alert recorded before that owner's period (PH0-07).
 */
import { DeviceOwnership } from '../database/entities';
import { OwnershipService } from '../ownership/ownership.service';
import { InMemoryDb } from '../../test/support/in-memory-db';
import { AlertEventsPublisher } from './alert-events.publisher';

const SINCE = new Date('2026-03-12T00:00:00.000Z');

function setup(legacy = 'true') {
  const db = new InMemoryDb().define(DeviceOwnership, { primaryKey: 'id', autoIncrement: true });
  db.seed(DeviceOwnership, [
    { deviceId: 'dev-a', userId: 7, startedAt: SINCE, endedAt: null, startReason: 'claim', endReason: null },
  ]);
  const registry = { emitToUser: jest.fn() };
  process.env.EMIT_LEGACY_ALERT_EVENTS = legacy;
  const publisher = new AlertEventsPublisher(registry as any, new OwnershipService(db.repository(DeviceOwnership) as any));
  return { registry, publisher };
}

const alert = (over: Record<string, unknown> = {}) => ({
  id: 'fall_dev-a_1773302400000',
  deviceId: 'dev-a',
  type: 'fall',
  title: 'Fall Detected',
  timestamp: new Date('2026-03-12T08:00:00.000Z'),
  createdAt: new Date('2026-03-12T08:00:01.000Z'),
  eventId: null,
  ...over,
});

describe('AlertEventsPublisher (AR-2)', () => {
  it('emits alert.new to the current owner with the canonical payload', async () => {
    const { registry, publisher } = setup();
    const sent = await publisher.publishNew([alert()], new Date('2026-03-12T08:00:05.000Z'));
    expect(sent).toBe(1);
    expect(registry.emitToUser).toHaveBeenCalledWith(7, 'alert.new', {
      id: 'fall_dev-a_1773302400000',
      type: 'fall',
      title: 'Fall Detected',
      timestamp: 1773302400000,
      deviceId: 'dev-a',
      severity: 'critical',
      eventId: null,
      late: false,
    });
  });

  it('marks an alert detected more than 15 minutes before emission as late', async () => {
    const { registry, publisher } = setup();
    await publisher.publishNew([alert()], new Date('2026-03-12T08:20:00.000Z'));
    expect(registry.emitToUser.mock.calls[0][2].late).toBe(true);
  });

  it('emits nothing for an unowned device or an alert recorded before the owner period', async () => {
    const { registry, publisher } = setup();
    expect(await publisher.publishNew([alert({ deviceId: 'dev-unowned' })])).toBe(0);
    expect(await publisher.publishNew([alert({ createdAt: new Date('2026-03-11T23:00:00.000Z') })])).toBe(0);
    expect(registry.emitToUser).not.toHaveBeenCalled();
  });

  it('emits alert.updated plus the legacy event names while the shim is on', async () => {
    const { registry, publisher } = setup('true');
    await publisher.publishUpdated(alert(), 'attended', 7, new Date(5000));
    expect(registry.emitToUser).toHaveBeenCalledWith(7, 'alert.updated', {
      id: 'fall_dev-a_1773302400000', deviceId: 'dev-a', status: 'attended', at: 5000, actorUserId: 7,
    });
    expect(registry.emitToUser).toHaveBeenCalledWith(7, 'alert.attended', {
      id: 'fall_dev-a_1773302400000', deviceId: 'dev-a', attendedAt: 5000,
    });
    await publisher.publishUpdated(alert(), 'false_alarm', 7, new Date(6000));
    expect(registry.emitToUser).toHaveBeenCalledWith(7, 'alert.dismissed', {
      id: 'fall_dev-a_1773302400000', deviceId: 'dev-a',
    });
  });

  it('emits only alert.updated when the legacy shim is off', async () => {
    const { registry, publisher } = setup('false');
    await publisher.publishUpdated(alert(), 'attended', 7, new Date(5000));
    expect(registry.emitToUser.mock.calls.map((c) => c[1])).toEqual(['alert.updated']);
  });
});
