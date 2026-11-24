import {
  ExecutionContext,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { InternalServiceGuard } from './internal-service.guard';

const ctx = (headers: Record<string, unknown>) =>
  ({
    switchToHttp: () => ({ getRequest: () => ({ headers }) }),
  }) as unknown as ExecutionContext;

describe('InternalServiceGuard (AR-1)', () => {
  const guard = new InternalServiceGuard();
  const TOKEN = 'i'.repeat(48);
  const saved = process.env.INTERNAL_SERVICE_TOKEN;
  afterEach(() => {
    process.env.INTERNAL_SERVICE_TOKEN = saved;
  });

  it('fails closed with 503 when INTERNAL_SERVICE_TOKEN is not configured', () => {
    delete process.env.INTERNAL_SERVICE_TOKEN;
    expect(() =>
      guard.canActivate(ctx({ 'x-internal-token': 'anything' })),
    ).toThrow(ServiceUnavailableException);
  });

  it('rejects a missing, empty, repeated or wrong token with 401', () => {
    process.env.INTERNAL_SERVICE_TOKEN = TOKEN;
    for (const headers of [
      {},
      { 'x-internal-token': '' },
      { 'x-internal-token': [TOKEN, TOKEN] },
      { 'x-internal-token': 'wrong' },
      { 'x-internal-token': TOKEN + 'x' },
    ]) {
      expect(() => guard.canActivate(ctx(headers))).toThrow(
        UnauthorizedException,
      );
    }
  });

  it('accepts the configured token', () => {
    process.env.INTERNAL_SERVICE_TOKEN = TOKEN;
    expect(guard.canActivate(ctx({ 'x-internal-token': TOKEN }))).toBe(true);
  });
});
