import { HttpException } from '@nestjs/common';
import { AuthThrottleGuard } from './auth-throttle.guard';

/**
 * Covers the H7 per-IP rate limiter on /auth/*.
 */
describe('AuthThrottleGuard', () => {
  const ctxFor = (ip: string) =>
    ({
      switchToHttp: () => ({
        getRequest: () => ({ ip, headers: {}, socket: {} }),
      }),
    }) as any;

  function makeGuard(limit: number) {
    process.env.AUTH_THROTTLE_LIMIT = String(limit);
    const counts = new Map<string, number>();
    const redis: any = {
      incr: jest.fn(async (k: string) => {
        const n = (counts.get(k) ?? 0) + 1;
        counts.set(k, n);
        return n;
      }),
      expire: jest.fn(async () => {}),
    };
    return { guard: new AuthThrottleGuard(redis), redis };
  }

  afterEach(() => {
    delete process.env.AUTH_THROTTLE_LIMIT;
  });

  it('allows requests up to the limit', async () => {
    const { guard } = makeGuard(2);
    await expect(guard.canActivate(ctxFor('1.1.1.1'))).resolves.toBe(true);
    await expect(guard.canActivate(ctxFor('1.1.1.1'))).resolves.toBe(true);
  });

  it('throws 429 once the limit is exceeded', async () => {
    const { guard } = makeGuard(2);
    await guard.canActivate(ctxFor('2.2.2.2'));
    await guard.canActivate(ctxFor('2.2.2.2'));
    await expect(guard.canActivate(ctxFor('2.2.2.2'))).rejects.toBeInstanceOf(
      HttpException,
    );
  });

  it('tracks counters per IP independently', async () => {
    const { guard } = makeGuard(1);
    await expect(guard.canActivate(ctxFor('3.3.3.3'))).resolves.toBe(true);
    // Different IP still allowed.
    await expect(guard.canActivate(ctxFor('4.4.4.4'))).resolves.toBe(true);
  });

  it('fails open when Redis errors', async () => {
    process.env.AUTH_THROTTLE_LIMIT = '1';
    const redis: any = {
      incr: jest.fn(async () => {
        throw new Error('redis down');
      }),
      expire: jest.fn(),
    };
    const guard = new AuthThrottleGuard(redis);
    await expect(guard.canActivate(ctxFor('5.5.5.5'))).resolves.toBe(true);
  });
});
