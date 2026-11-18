/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-return */
/**
 * AR-6 / AR-8 against real PostgreSQL with a fake push provider (Expo is never
 * contacted). Covers the token lifecycle, attempt creation for the current
 * owner only, the sender's pre-send re-checks, retries, provider/receipt
 * outcomes (no "delivered" state, provider acceptance never acknowledges an
 * alert), multi-instance claiming, and the escalation guard.
 * SKIPPED unless TEST_DATABASE_URL is set; refuses non-"test" databases.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { DataSource } from 'typeorm';
import {
  Alert,
  AlertAction,
  AlertEpisode,
  Device,
  DeviceEvent,
  DeviceOwnership,
  DeviceStatus,
  DeviceType,
  NotificationAttempt,
  PushToken,
  RecordingSession,
  SyncHistory,
  Vital,
} from '../database/entities';
import { IotDevice } from '../iot-device/iot-device.entity';
import { OwnershipService } from '../ownership/ownership.service';
import { AlertEventsPublisher } from '../realtime/alert-events.publisher';
import { AlertDispatchService } from '../alerts/alert-dispatch.service';
import { FakePushProvider } from '../../test/support/fake-push-provider';
import { EscalationService } from './escalation.service';
import { NotificationAttemptsService } from './notification-attempts.service';
import { NotificationSenderService } from './notification-sender.service';
import { PushTokensService } from './push-tokens.service';

const url = process.env.TEST_DATABASE_URL;
const describePg = url ? describe : describe.skip;
const ENTITIES = [
  Device,
  IotDevice,
  Vital,
  Alert,
  AlertAction,
  AlertEpisode,
  DeviceEvent,
  DeviceStatus,
  RecordingSession,
  SyncHistory,
  DeviceOwnership,
  PushToken,
  NotificationAttempt,
];
const ALICE = 1;
const BOB = 2;
const INSTALL_A = '0b5f7c1e-3a2d-4e6f-8a9b-1c2d3e4f5a6b';
const INSTALL_B = '9c8b7a6f-5e4d-4c3b-8a2f-1e0d9c8b7a6f';
const tok = (s: string) => `ExponentPushToken[${s}]`;

describePg('push notifications (AR-6 / AR-8, real PostgreSQL)', () => {
  let ds: DataSource;
  let ownership: OwnershipService;
  let publisher: AlertEventsPublisher;
  let tokens: PushTokensService;
  let attempts: NotificationAttemptsService;
  let provider: FakePushProvider;
  let sender: NotificationSenderService;
  const saved = { ...process.env };

  beforeAll(async () => {
    const dbName = new URL(url as string).pathname.replace('/', '');
    if (!/test/i.test(dbName))
      throw new Error(
        `Refusing to drop schema of non-test database "${dbName}"`,
      );
    ds = new DataSource({
      type: 'postgres',
      url,
      entities: ENTITIES,
      synchronize: true,
      dropSchema: true,
    });
    await ds.initialize();
  });

  afterAll(async () => {
    process.env = saved;
    await ds?.destroy();
  });

  beforeEach(async () => {
    process.env = { ...saved };
    await ds.query(
      'TRUNCATE notification_attempts, push_tokens, device_events, alert_actions, alert_episodes, alerts, device_ownerships, devices CASCADE',
    );
    await ds.getRepository(Device).insert({
      id: 'dev-a',
      userId: ALICE,
      name: 'a',
      type: DeviceType.HUB,
      lastSeenAt: new Date(),
      lastSyncSlot: 'iot_live',
      syncSource: 'iot_claim',
    });
    await ds.getRepository(DeviceOwnership).insert({
      deviceId: 'dev-a',
      userId: ALICE,
      startedAt: new Date(Date.now() - 3_600_000),
      endedAt: null,
      startReason: 'claim',
      endReason: null,
    });
    ownership = new OwnershipService(ds.getRepository(DeviceOwnership));
    publisher = new AlertEventsPublisher(
      { emitToUser: jest.fn() } as any,
      ownership,
    );
    tokens = new PushTokensService(ds);
    attempts = new NotificationAttemptsService(ds, publisher);
    provider = new FakePushProvider();
    sender = new NotificationSenderService(ds, publisher, provider);
  });

  const register = (
    userId: number,
    token: string,
    installationId = INSTALL_A,
  ) =>
    tokens.register(userId, {
      token,
      platform: 'android',
      installationId,
      permission: 'granted',
    });
  const alert = async (
    id: string,
    type = 'fall',
    over: Record<string, unknown> = {},
  ) => {
    await ds.query(
      `INSERT INTO alerts (id, "deviceId", type, title, timestamp, "syncSlot", "dispatchState", "dispatchedAt", "createdAt")
       VALUES ($1, 'dev-a', $2, 'x', $3, 'iot_live', 'dispatched', $4, $5)`,
      [
        id,
        type,
        over.timestamp ?? new Date(),
        over.dispatchedAt ?? new Date(),
        over.createdAt ?? new Date(),
      ],
    );
    const [row] = await ds.query(
      `SELECT id, "deviceId", type, "createdAt", timestamp FROM alerts WHERE id = $1`,
      [id],
    );
    return row;
  };
  const attemptRows = (): Promise<any[]> =>
    ds.query(`SELECT id, "alertId", "userId", "pushTokenId", state, "attemptCount", "providerError", "expoTicketId",
                     "nextAttemptAt", "receiptCheckAfter", "escalationLevel"
              FROM notification_attempts ORDER BY id`);

  describe('push tokens', () => {
    it('registers a token once and refreshes it on re-registration', async () => {
      const first = await register(ALICE, tok('a1'));
      const again = await register(ALICE, tok('a1'));
      expect(again.id).toBe(first.id);
      expect(await tokens.status(ALICE)).toEqual({ activeTokens: 1 });
    });

    it('replaces the previous token of the same installation', async () => {
      await register(ALICE, tok('a1'));
      await register(ALICE, tok('a2'));
      const rows = await ds.query(
        `SELECT token, "revokedReason" FROM push_tokens ORDER BY id`,
      );
      expect(rows).toEqual([
        { token: tok('a1'), revokedReason: 'replaced' },
        { token: tok('a2'), revokedReason: null },
      ]);
    });

    it('reassigns a token registered by another user (shared phone) away from the previous user', async () => {
      await register(ALICE, tok('shared'));
      await register(BOB, tok('shared'), INSTALL_B);
      expect(await tokens.status(ALICE)).toEqual({ activeTokens: 0 });
      expect(await tokens.status(BOB)).toEqual({ activeTokens: 1 });
    });

    it('revokes only the caller’s tokens for an installation', async () => {
      await register(ALICE, tok('a1'));
      await register(BOB, tok('b1'));
      expect(await tokens.revokeInstallation(ALICE, INSTALL_A)).toEqual({
        revoked: 1,
      });
      expect(await tokens.status(BOB)).toEqual({ activeTokens: 1 });
      expect(await tokens.revokeInstallation(ALICE, INSTALL_A)).toEqual({
        revoked: 0,
      });
    });

    it('lists active tokens with the token masked', async () => {
      await register(ALICE, tok('abcdefghijklmnop'));
      const list = await tokens.listActive(ALICE);
      expect(list).toHaveLength(1);
      expect(JSON.stringify(list)).not.toContain('abcdefghijklmnop');
    });
  });

  describe('attempts and sending', () => {
    it('creates one attempt per active token of the current owner, and notes owners without a phone', async () => {
      await register(ALICE, tok('a1'));
      await register(ALICE, tok('a2'), INSTALL_B);
      await register(BOB, tok('b1'));
      const a = await alert('fall_1');
      await attempts.enqueue([a]);
      await attempts.enqueue([a]); // idempotent
      expect((await attemptRows()).map((r: any) => r.userId)).toEqual([
        ALICE,
        ALICE,
      ]);

      await tokens.revokeInstallation(ALICE, INSTALL_A);
      await tokens.revokeInstallation(ALICE, INSTALL_B);
      const b = await alert('fall_2');
      await attempts.enqueue([b]);
      const [note] = await ds.query(
        `SELECT "dispatchNote" FROM alerts WHERE id = 'fall_2'`,
      );
      expect(note.dispatchNote).toBe('no_active_tokens');
    });

    it('creates no attempt for an alert from before the current owner’s period', async () => {
      await register(ALICE, tok('a1'));
      const old = await alert('fall_old', 'fall', {
        createdAt: new Date(Date.now() - 2 * 3_600_000),
      });
      await attempts.enqueue([old]);
      expect(await attemptRows()).toEqual([]);
    });

    it('sends a minimal message: no measurements, only alertId and attemptId as data', async () => {
      await register(ALICE, tok('a1'));
      await attempts.enqueue([await alert('fall_1')]);
      await sender.sendDue();
      expect(provider.sent).toHaveLength(1);
      const [m] = provider.sent;
      const [row] = await attemptRows();
      expect(m).toEqual({
        to: tok('a1'),
        title: 'Possible fall detected',
        body: 'Tap to view and respond.',
        data: { alertId: 'fall_1', attemptId: Number(row.id) },
        priority: 'high',
        channelId: 'critical-alerts',
        sound: 'default',
        ttl: 3600,
      });
      expect(row).toMatchObject({
        state: 'provider_accepted',
        expoTicketId: 'ticket-1',
        attemptCount: 1,
      });
      expect(new Date(row.receiptCheckAfter).getTime()).toBeGreaterThan(
        Date.now() + 14 * 60_000,
      );
    });

    it('labels a late alert as delayed and uses the normal channel for moisture', async () => {
      await register(ALICE, tok('a1'));
      await attempts.enqueue([
        await alert('moisture_1', 'moisture', {
          timestamp: new Date(Date.now() - 20 * 60_000),
        }),
      ]);
      await sender.sendDue();
      expect(provider.sent[0]).toMatchObject({
        title: 'Moisture detected',
        body: 'Detected 20 min ago (delayed). Tap to respond.',
        channelId: 'alerts',
      });
    });

    it.each([
      [
        'acknowledged',
        `UPDATE alerts SET "acknowledgedAt" = now(), "acknowledgedByUserId" = 1, "ackAction" = 'attended'`,
      ],
      [
        'token_revoked',
        `UPDATE push_tokens SET "revokedAt" = now(), "revokedReason" = 'logout'`,
      ],
      [
        'owner_changed',
        `UPDATE device_ownerships SET "endedAt" = now(), "endReason" = 'unclaim'`,
      ],
    ])(
      'cancels instead of sending when the state changed before sending: %s',
      async (reason, sql) => {
        await register(ALICE, tok('a1'));
        await attempts.enqueue([await alert('fall_1')]);
        await ds.query(sql);
        await sender.sendDue();
        expect(provider.sent).toEqual([]);
        expect(await attemptRows()).toEqual([
          expect.objectContaining({
            state: 'cancelled',
            providerError: reason,
          }),
        ]);
      },
    );

    it('cancels when the token now belongs to another user', async () => {
      await register(ALICE, tok('shared'));
      await attempts.enqueue([await alert('fall_1')]);
      await register(BOB, tok('shared'), INSTALL_B);
      await sender.sendDue();
      expect(provider.sent).toEqual([]);
      expect((await attemptRows())[0]).toMatchObject({
        state: 'cancelled',
        providerError: 'token_revoked',
      });
    });

    it('keeps retrying a provider outage with capped backoff for the push lifetime (1 h), then fails', async () => {
      await register(ALICE, tok('a1'));
      await attempts.enqueue([await alert('fall_1')]);
      provider.failWith = new Error('ECONNRESET');
      const t0 = Date.now();
      const waits: number[] = [];
      let at = t0;
      for (let i = 0; i < 7; i++) {
        await sender.sendDue(new Date(at));
        const [r] = await attemptRows();
        expect(r.state).toBe('queued'); // a 10-minute outage is not a give-up
        waits.push(
          Math.round((new Date(r.nextAttemptAt).getTime() - at) / 1000),
        );
        at = new Date(r.nextAttemptAt).getTime();
      }
      expect(waits).toEqual([5, 15, 30, 60, 120, 120, 120]);
      provider.failWith = null; // provider recovers
      await sender.sendDue(new Date(at));
      expect((await attemptRows())[0]).toMatchObject({
        state: 'provider_accepted',
        attemptCount: 8,
      });
    });

    it('fails an attempt when its next retry would fall outside the push lifetime', async () => {
      await register(ALICE, tok('a1'));
      await attempts.enqueue([await alert('fall_1')]);
      provider.failWith = new Error('ECONNRESET');
      await sender.sendDue(new Date(Date.now() + 3_598_000)); // 2 s before the 1 h lifetime ends; first backoff is 5 s
      expect((await attemptRows())[0]).toMatchObject({
        state: 'failed',
        providerError: 'Error: ECONNRESET',
      });
    });

    it('expires a queued attempt that waited longer than the push lifetime (e.g. push was switched off)', async () => {
      await register(ALICE, tok('a1'));
      await attempts.enqueue([await alert('fall_1')]);
      await ds.query(
        `UPDATE notification_attempts SET "createdAt" = now() - interval '2 hours'`,
      );
      await ds.query(
        `UPDATE alerts SET timestamp = now() - interval '2 hours'`,
      );
      await sender.sendDue();
      expect(provider.sent).toEqual([]);
      expect((await attemptRows())[0]).toMatchObject({
        state: 'cancelled',
        providerError: 'expired',
      });
    });

    it('revokes a token the provider reports as DeviceNotRegistered', async () => {
      await register(ALICE, tok('gone'));
      await attempts.enqueue([await alert('fall_1')]);
      provider.ticketFor = () => ({
        status: 'error',
        message: 'not registered',
        details: { error: 'DeviceNotRegistered' },
      });
      await sender.sendDue();
      expect((await attemptRows())[0]).toMatchObject({
        state: 'provider_rejected',
        providerError: 'DeviceNotRegistered',
      });
      expect(await tokens.status(ALICE)).toEqual({ activeTokens: 0 });
    });

    it('sends each attempt once when two instances run the sender concurrently', async () => {
      for (let i = 0; i < 5; i++)
        await register(
          ALICE,
          tok(`t${i}`),
          `0b5f7c1e-3a2d-4e6f-8a9b-1c2d3e4f5a6${i}`,
        );
      await attempts.enqueue([await alert('fall_1')]);
      const other = new NotificationSenderService(ds, publisher, provider);
      await Promise.all([sender.sendDue(), other.sendDue()]);
      expect(provider.sent.map((m) => m.to).sort()).toEqual(
        [0, 1, 2, 3, 4].map((i) => tok(`t${i}`)),
      );
    });

    it('requeues attempts stuck in sending after a crash', async () => {
      await register(ALICE, tok('a1'));
      await attempts.enqueue([await alert('fall_1')]);
      await ds.query(
        `UPDATE notification_attempts SET state = 'sending', "updatedAt" = now() - interval '3 minutes'`,
      );
      await sender.sendDue();
      expect((await attemptRows())[0]).toMatchObject({
        state: 'provider_accepted',
      });
    });

    it('records receipts without ever acknowledging the alert or claiming delivery', async () => {
      await register(ALICE, tok('a1'));
      await register(ALICE, tok('a2'), INSTALL_B);
      await register(ALICE, tok('a3'), '11111111-2222-4333-8444-555555555555');
      await attempts.enqueue([await alert('fall_1')]);
      await sender.sendDue();
      provider.receipts = {
        'ticket-1': { status: 'ok' },
        'ticket-2': {
          status: 'error',
          message: 'gone',
          details: { error: 'DeviceNotRegistered' },
        },
      }; // ticket-3: no receipt yet
      const later = new Date(Date.now() + 16 * 60_000);
      await sender.pollReceipts(later);
      await sender.pollReceipts(new Date(Date.now() + 25 * 3_600_000));
      const states = (await attemptRows()).map((r: any) => r.state);
      expect(states).toEqual([
        'receipt_ok',
        'receipt_error',
        'receipt_unknown',
      ]);
      expect(await tokens.status(ALICE)).toEqual({ activeTokens: 2 });
      const [a] = await ds.query(
        `SELECT "acknowledgedAt", "isAttended" FROM alerts`,
      );
      expect(a).toEqual({ acknowledgedAt: null, isAttended: false });
    });

    it('queues attempts when the dispatcher announces a new alert', async () => {
      await register(ALICE, tok('a1'));
      const dispatch = new AlertDispatchService(ds, publisher, attempts);
      await ds.query(
        `INSERT INTO alerts (id, "deviceId", type, title, timestamp, "syncSlot") VALUES ('fall_d', 'dev-a', 'fall', 'x', now(), 'iot_live')`,
      );
      await dispatch.kick(['fall_d']);
      expect(await attemptRows()).toEqual([
        expect.objectContaining({ alertId: 'fall_d', state: 'queued' }),
      ]);
    });
  });

  describe('escalation (AR-8)', () => {
    const approvedPolicy = () => {
      const p = JSON.parse(
        fs.readFileSync(
          path.resolve(process.cwd(), 'config/alert-policy.v1.json'),
          'utf8',
        ),
      );
      p.status = 'approved';
      const file = path.join(
        fs.mkdtempSync(path.join(os.tmpdir(), 'policy-')),
        'alert-policy.json',
      );
      fs.writeFileSync(file, JSON.stringify(p));
      return file;
    };
    const unacked = async () => {
      await register(ALICE, tok('a1'));
      await alert('fall_e', 'fall', {
        dispatchedAt: new Date(Date.now() - 130_000),
      });
    };
    const escalated = async () =>
      (
        await ds.query(
          `SELECT count(*)::int n FROM alert_actions WHERE action = 'escalated'`,
        )
      )[0].n;

    it('is blocked while the policy is not approved, even with ESCALATION_ENABLED=true', async () => {
      process.env.ESCALATION_ENABLED = 'true';
      await unacked();
      expect(await new EscalationService(ds, publisher, attempts).tick()).toBe(
        0,
      );
      expect([await attemptRows(), await escalated()]).toEqual([[], 0]);
    });

    it('is blocked by default with an approved policy', async () => {
      process.env.ALERT_POLICY_PATH = approvedPolicy();
      await unacked();
      expect(await new EscalationService(ds, publisher, attempts).tick()).toBe(
        0,
      );
    });

    it('when allowed, re-notifies the same owner once per schedule step and stops on acknowledgement', async () => {
      process.env.ALERT_POLICY_PATH = approvedPolicy();
      process.env.ESCALATION_ENABLED = 'true';
      await unacked();
      const esc = new EscalationService(ds, publisher, attempts);
      expect(await esc.tick()).toBe(1);
      expect(await esc.tick()).toBe(0); // next step is due at 300 s
      expect(await attemptRows()).toEqual([
        expect.objectContaining({ userId: ALICE, escalationLevel: 1 }),
      ]);
      expect(await escalated()).toBe(1);
      await ds.query(
        `UPDATE alerts SET "acknowledgedAt" = now(), "dispatchedAt" = now() - interval '20 minutes'`,
      );
      expect(await esc.tick()).toBe(0);
    });
  });
});
