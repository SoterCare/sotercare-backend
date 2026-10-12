/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-return */
/**
 * AR-6 / AR-7 unit checks:
 *  - request DTOs accept/reject exactly what the v1 JSON Schemas do;
 *  - the Expo provider at its HTTP boundary (fetch is mocked here; Expo is
 *    never contacted by tests);
 *  - the provider factory defaults to a dry run.
 */
import Ajv2020 from 'ajv/dist/2020';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import * as fs from 'fs';
import * as path from 'path';
import { AlertSeenDto } from '../alerts/dto/alert-seen.dto';
import { RegisterPushTokenDto } from './dto/register-push-token.dto';
import {
  DryRunPushProvider,
  ExpoHttpPushProvider,
  PushMessage,
  createPushProvider,
} from './push-provider';
import { maskToken } from './push-tokens.service';

const ROOT = path.resolve(__dirname, '../../../../contracts/v1');
const json = (rel: string) =>
  JSON.parse(fs.readFileSync(path.join(ROOT, rel), 'utf8'));
const ajv = new Ajv2020({ strict: true });

/** Same rules as the strict controller pipe (whitelist + forbidNonWhitelisted). */
async function dtoAccepts(cls: any, body: unknown) {
  if (typeof body !== 'object' || body === null || Array.isArray(body))
    return false;
  const errors = await validate(plainToInstance(cls, body), {
    whitelist: true,
    forbidNonWhitelisted: true,
  });
  return errors.length === 0;
}

describe('push request DTOs match the v1 contracts', () => {
  const token = json('fixtures/valid/push_token_register.request.json');
  const tokenSchema = ajv.compile(
    json('push_token_register.request.schema.json'),
  );
  it.each([
    ['fixture', token],
    [
      'invalid fixture',
      json('fixtures/invalid/push_token_register.bad_token.json'),
    ],
    ['Expo prefix', { ...token, token: 'ExpoPushToken[abc_DEF-123]' }],
    [
      'ios provisional',
      { ...token, platform: 'ios', permission: 'provisional' },
    ],
    [
      'no optional fields',
      {
        token: token.token,
        platform: 'android',
        installationId: token.installationId,
      },
    ],
    ['web platform', { ...token, platform: 'web' }],
    ['short installation id', { ...token, installationId: 'abc' }],
    ['denied permission', { ...token, permission: 'denied' }],
    ['long app version', { ...token, appVersion: 'v'.repeat(33) }],
    ['extra field', { ...token, userId: 7 }],
    ['token with space', { ...token, token: 'ExponentPushToken[a b]' }],
  ])('push token register: %s', async (_name, body) => {
    expect(await dtoAccepts(RegisterPushTokenDto, body)).toBe(
      tokenSchema(body),
    );
  });

  const seenSchema = ajv.compile(json('alert_seen.request.schema.json'));
  it.each([
    ['fixture', json('fixtures/valid/alert_seen.request.json')],
    ['in_app', { source: 'in_app' }],
    ['foreground', { source: 'push_foreground', notificationAttemptId: 1 }],
    ['ack smuggled in', { source: 'push_opened', status: 'attended' }],
    ['attempt 0', { source: 'push_opened', notificationAttemptId: 0 }],
    [
      'fractional attempt',
      { source: 'push_opened', notificationAttemptId: 1.5 },
    ],
    ['unknown source', { source: 'sms' }],
    ['missing source', {}],
  ])('alert seen: %s', async (_name, body) => {
    expect(await dtoAccepts(AlertSeenDto, body)).toBe(seenSchema(body));
  });
});

describe('Expo push provider (HTTP boundary mocked)', () => {
  const message = (i: number): PushMessage => ({
    to: `ExponentPushToken[t${i}]`,
    title: 'Help call',
    body: 'Tap to view and respond.',
    data: { alertId: `a${i}`, attemptId: i },
    priority: 'high',
    channelId: 'critical-alerts',
    sound: 'default',
    ttl: 3600,
  });
  const ok = (body: unknown) =>
    Promise.resolve({
      ok: true,
      status: 200,
      json: () => Promise.resolve(body),
    } as Response);

  it('posts chunks of 100 to the send endpoint with a bearer token only when configured', async () => {
    const fetchMock = jest.fn((_url: string, init: RequestInit) => {
      const n = (JSON.parse(init.body as string) as unknown[]).length;
      return ok({
        data: Array.from({ length: n }, (_, i) => ({
          status: 'ok',
          id: `id${i}`,
        })),
      });
    });
    const tickets = await new ExpoHttpPushProvider(
      'secret-value',
      fetchMock as any,
    ).send(Array.from({ length: 150 }, (_, i) => message(i + 1)));
    expect(tickets).toHaveLength(150);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://exp.host/--/api/v2/push/send');
    expect((init.headers as Record<string, string>).Authorization).toBe(
      'Bearer secret-value',
    );
    await new ExpoHttpPushProvider(undefined, fetchMock as any).send([
      message(1),
    ]);
    expect(
      (fetchMock.mock.calls[2][1].headers as Record<string, string>)
        .Authorization,
    ).toBeUndefined();
  });

  it('throws (retryable) on HTTP errors and on a ticket count mismatch', async () => {
    const http500 = jest.fn(() =>
      Promise.resolve({ ok: false, status: 500 } as Response),
    );
    await expect(
      new ExpoHttpPushProvider(undefined, http500 as any).send([message(1)]),
    ).rejects.toThrow('HTTP 500');
    const short = jest.fn(() => ok({ data: [] }));
    await expect(
      new ExpoHttpPushProvider(undefined, short as any).send([message(1)]),
    ).rejects.toThrow('ticket count');
  });

  it('reads receipts by id', async () => {
    const fetchMock = jest.fn(() => ok({ data: { r1: { status: 'ok' } } }));
    expect(
      await new ExpoHttpPushProvider(undefined, fetchMock as any).getReceipts([
        'r1',
        'r2',
      ]),
    ).toEqual({ r1: { status: 'ok' } });
    expect((fetchMock.mock.calls[0] as any)[0]).toBe(
      'https://exp.host/--/api/v2/push/getReceipts',
    );
  });

  it('defaults to a dry run unless PUSH_PROVIDER=expo', async () => {
    expect(createPushProvider({})).toBeInstanceOf(DryRunPushProvider);
    expect(createPushProvider({ PUSH_PROVIDER: 'expo' })).toBeInstanceOf(
      ExpoHttpPushProvider,
    );
    const [ticket] = await new DryRunPushProvider().send([message(1)]);
    expect(ticket.status).toBe('ok');
  });

  it('masks tokens for listing', () => {
    expect(maskToken('ExponentPushToken[abcdefghijklmnop]')).toBe(
      'ExponentPushToken[abcd…mnop]',
    );
    expect(maskToken('ExpoPushToken[short]')).toBe('ExpoPushToken[…]');
  });
});
