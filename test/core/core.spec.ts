import type { ExecutionContext } from '@nestjs/common';
import { lastValueFrom, of } from 'rxjs';
import { FakeClock, SystemClock } from '../../src/core/clock';
import { NoTenantContext, TenantContext } from '../../src/core/context';
import { ApiError, toErrorEnvelope } from '../../src/core/errors';
import {
  IdempotencyInterceptor,
  InMemoryIdempotencyStore,
} from '../../src/core/idempotency';
import { newId, uuidv7 } from '../../src/core/ids';
import { redact, REDACT } from '../../src/core/logging';
import { loadConfig } from '../../src/core/config';

const ctx = { tenantId: 't1', actor: 'u1', requestId: 'r1' };

describe('TenantContext', () => {
  it('throws without tenant', () => {
    expect(() => TenantContext.get()).toThrow(NoTenantContext);
  });
  it('returns the context inside run, including across awaits', async () => {
    await TenantContext.run(ctx, async () => {
      await Promise.resolve();
      expect(TenantContext.get()).toEqual(ctx);
    });
    expect(() => TenantContext.get()).toThrow(NoTenantContext);
  });
});

describe('Clock', () => {
  it('FakeClock advances and SystemClock reads real time', () => {
    const c = new FakeClock(new Date('2026-11-24T00:00:00Z'));
    c.advance(90_000);
    expect(c.now().toISOString()).toBe('2026-11-24T00:01:30.000Z');
    expect(
      Math.abs(new SystemClock().now().getTime() - Date.now()),
    ).toBeLessThan(1000);
  });
});

describe('errors', () => {
  it('error envelope shape', () => {
    const e = new ApiError(409, 'assign_via_gateway', 'use the gateway', {
      a: 1,
    });
    expect(toErrorEnvelope(e)).toEqual({
      error: {
        code: 'assign_via_gateway',
        message: 'use the gateway',
        details: { a: 1 },
      },
    });
    expect(e.status).toBe(409);
  });
  it('unknown errors become a generic 500 envelope without the message', () => {
    expect(toErrorEnvelope(new Error('secret Anna'))).toEqual({
      error: {
        code: 'internal_error',
        message: 'Internal error',
        details: undefined,
      },
    });
  });
});

describe('logger redaction', () => {
  it('drops names and tokens, keeps ids', () => {
    const out = JSON.stringify(
      redact({
        displayName: 'Anna',
        alertId: 'a1',
        nested: { token: 'abc', residentId: 'r9' },
      }),
    );
    expect(out).not.toContain('Anna');
    expect(out).not.toContain('abc');
    expect(out).toContain('a1');
    expect(out).toContain('r9');
    expect(REDACT).toContain('residentName');
  });
});

describe('ids', () => {
  it('newId prefixes and uuidv7 is time-ordered v7', () => {
    expect(newId('al')).toMatch(/^al_[0-9a-f-]{36}$/);
    const a = uuidv7();
    expect(a).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });
});

describe('config', () => {
  it('parses env and rejects missing required values', () => {
    expect(
      loadConfig({
        NODE_ENV: 'test',
        AWS_REGION: 'ap-south-1',
      } as unknown as NodeJS.ProcessEnv).region,
    ).toBe('ap-south-1');
    expect(() =>
      loadConfig({ NODE_ENV: 'nope' } as unknown as NodeJS.ProcessEnv),
    ).toThrow();
  });
});

describe('IdempotencyInterceptor', () => {
  const mk = (body: unknown, key = 'k1', route = '/x') =>
    ({
      switchToHttp: () => ({
        getRequest: () => ({
          method: 'POST',
          headers: { 'idempotency-key': key },
          body,
          route: { path: route },
        }),
        getResponse: () => ({ statusCode: 201 }),
      }),
    }) as unknown as ExecutionContext;

  it('returns stored response for same key and body', async () => {
    const i = new IdempotencyInterceptor(
      new InMemoryIdempotencyStore(),
      new FakeClock(),
    );
    let calls = 0;
    const handler = { handle: () => (calls++, of({ n: calls })) };
    await TenantContext.run(ctx, async () => {
      const a = await lastValueFrom(await i.intercept(mk({ a: 1 }), handler));
      const b = await lastValueFrom(await i.intercept(mk({ a: 1 }), handler));
      expect(b).toEqual(a);
      expect(calls).toBe(1);
    });
  });
  it('409 idempotency_conflict on same key different body', async () => {
    const i = new IdempotencyInterceptor(
      new InMemoryIdempotencyStore(),
      new FakeClock(),
    );
    const handler = { handle: () => of({ ok: true }) };
    await TenantContext.run(ctx, async () => {
      await lastValueFrom(await i.intercept(mk({ a: 1 }), handler));
      await expect(i.intercept(mk({ a: 2 }), handler)).rejects.toMatchObject({
        status: 409,
        code: 'idempotency_conflict',
      });
    });
  });
  it('expires keys after 24 h using the injected clock', async () => {
    const clock = new FakeClock();
    const i = new IdempotencyInterceptor(new InMemoryIdempotencyStore(), clock);
    let calls = 0;
    const handler = { handle: () => (calls++, of({ n: calls })) };
    await TenantContext.run(ctx, async () => {
      await lastValueFrom(await i.intercept(mk({ a: 1 }), handler));
      clock.advance(24 * 3600_000 + 1);
      await lastValueFrom(await i.intercept(mk({ a: 1 }), handler));
      expect(calls).toBe(2);
    });
  });
  it('does not scope to another actor', async () => {
    const i = new IdempotencyInterceptor(
      new InMemoryIdempotencyStore(),
      new FakeClock(),
    );
    let calls = 0;
    const handler = { handle: () => (calls++, of({ n: calls })) };
    await TenantContext.run(ctx, async () => {
      await lastValueFrom(await i.intercept(mk({ a: 1 }), handler));
    });
    await TenantContext.run({ ...ctx, actor: 'u2' }, async () => {
      await lastValueFrom(await i.intercept(mk({ a: 1 }), handler));
    });
    expect(calls).toBe(2);
  });
});
