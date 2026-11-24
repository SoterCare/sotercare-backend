import { createHash } from 'crypto';
import { requireJwtSecret } from './jwt-secret';

// Placeholder that stands in for the scrubbed public fallback. Its sha256 is in the
// denylist, so the refusal path is tested without reading git history (CI clones shallow).
function publicFallback(): string {
  return 'REMOVED-OLD-PUBLIC-FALLBACK';
}

describe('requireJwtSecret', () => {
  const strong = 'x'.repeat(48);

  it('requires JWT_SECRET to be set', () => {
    expect(() => requireJwtSecret({})).toThrow(
      'JWT_SECRET environment variable must be set',
    );
  });

  it('refuses the publicly known fallback secret in every environment', () => {
    const value = publicFallback();
    expect(createHash('sha256').update(value).digest('hex')).toHaveLength(64);
    for (const NODE_ENV of ['production', 'development', 'test']) {
      expect(() => requireJwtSecret({ JWT_SECRET: value, NODE_ENV })).toThrow(
        /publicly known/,
      );
    }
  });

  it('refuses a short secret in production only', () => {
    expect(() =>
      requireJwtSecret({ JWT_SECRET: 'short-secret', NODE_ENV: 'production' }),
    ).toThrow(/at least 32/);
    expect(
      requireJwtSecret({ JWT_SECRET: 'short-secret', NODE_ENV: 'development' }),
    ).toBe('short-secret');
  });

  it('accepts a strong secret in production', () => {
    expect(
      requireJwtSecret({ JWT_SECRET: strong, NODE_ENV: 'production' }),
    ).toBe(strong);
  });
});
