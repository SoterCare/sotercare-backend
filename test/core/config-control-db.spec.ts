import { loadConfig } from '../../src/core/config';

describe('control DB url config', () => {
  const env = (e: Record<string, string>) => e as unknown as NodeJS.ProcessEnv;

  it('prefers CONTROL_DB_URL', () => {
    expect(
      loadConfig(env({ CONTROL_DB_URL: 'a', CONTROL_DATABASE_URL: 'b' }))
        .controlDatabaseUrl,
    ).toBe('a');
  });

  it('falls back to CONTROL_DATABASE_URL', () => {
    expect(
      loadConfig(env({ CONTROL_DATABASE_URL: 'b' })).controlDatabaseUrl,
    ).toBe('b');
  });
});
