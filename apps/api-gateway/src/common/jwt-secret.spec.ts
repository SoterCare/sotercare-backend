import { createHash } from 'crypto';
import { execSync } from 'child_process';
import { requireJwtSecret } from './jwt-secret';

// The publicly known fallback is read from git history at test time so the
// literal never has to be written into source again.
function publicFallback(): string {
  const blob = execSync(
    'git show 486c8e6:apps/api-gateway/src/realtime/realtime.module.ts',
    { encoding: 'utf8' },
  );
  return /JWT_SECRET \|\| '([^']*)'/.exec(blob)![1];
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
