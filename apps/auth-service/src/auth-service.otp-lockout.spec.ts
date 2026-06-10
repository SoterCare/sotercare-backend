import { AuthServiceService } from './auth-service.service';

/**
 * Covers the H7 per-email OTP lockout: after OTP_MAX_ATTEMPTS wrong codes the
 * account is locked and verification short-circuits to false even for the
 * correct code, until the lock is cleared.
 */
describe('AuthServiceService OTP lockout', () => {
  function makeService() {
    const store = new Map<string, string>();
    const redis: any = {
      get: jest.fn(async (k: string) => store.get(k) ?? null),
      set: jest.fn(async (k: string, v: string) => {
        store.set(k, v);
      }),
      del: jest.fn(async (k: string) => {
        store.delete(k);
      }),
      incr: jest.fn(async (k: string) => {
        const n = (Number(store.get(k)) || 0) + 1;
        store.set(k, String(n));
        return n;
      }),
      expire: jest.fn(async () => {}),
    };
    const userRepo: any = {};
    return { service: new AuthServiceService(userRepo, redis), store };
  }

  beforeAll(() => {
    process.env.OTP_MAX_ATTEMPTS = '3';
  });
  afterAll(() => {
    delete process.env.OTP_MAX_ATTEMPTS;
  });

  it('verifies a correct login OTP and clears failures', async () => {
    const { service, store } = makeService();
    store.set('login:a@b.com', '123456');
    await expect(service.verifyLoginOtp('a@b.com', '123456')).resolves.toBe(
      true,
    );
  });

  it('locks out after too many wrong attempts and then rejects the correct code', async () => {
    const { service, store } = makeService();
    store.set('login:c@d.com', '111111');

    // 3 wrong attempts trip the lockout.
    await service.verifyLoginOtp('c@d.com', '000000');
    await service.verifyLoginOtp('c@d.com', '000000');
    await service.verifyLoginOtp('c@d.com', '000000');

    expect(store.get('otp_lock:c@d.com')).toBeDefined();

    // Even the correct code is now rejected while locked.
    await expect(service.verifyLoginOtp('c@d.com', '111111')).resolves.toBe(
      false,
    );
  });
});
