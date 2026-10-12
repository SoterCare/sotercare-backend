/* eslint-disable @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-member-access */
import { buildTypeOrmOptions } from './typeorm-options';
import { ALL_MIGRATIONS } from './migrations';
import { configStub } from '../../test/support/phase0-fixtures';

describe('buildTypeOrmOptions', () => {
  it('fails closed on undefined where-values (GAP-002 defence in depth)', () => {
    const options: any = buildTypeOrmOptions(configStub());
    expect(options.invalidWhereValuesBehavior).toEqual({ undefined: 'throw' });
  });

  it('keeps the existing connection behaviour', () => {
    const withUrl: any = buildTypeOrmOptions(
      configStub({ DATABASE_URL: 'postgres://user@db.invalid:5432/app' }),
    );
    expect(withUrl).toMatchObject({
      type: 'postgres',
      url: 'postgres://user@db.invalid:5432/app',
      ssl: { rejectUnauthorized: false },
      autoLoadEntities: true,
      extra: { max: 20, statement_timeout: 10000 },
    });

    const discrete: any = buildTypeOrmOptions(
      configStub({ DB_HOST: 'pg.local' }),
    );
    expect(discrete).toMatchObject({
      host: 'pg.local',
      port: 5432,
      database: 'auth_db',
    });
    expect(discrete.ssl).toBeUndefined();
  });

  it('registers the explicit migration list and only runs it on boot when asked (AR-0)', () => {
    const off: any = buildTypeOrmOptions(configStub());
    expect(off.migrations).toBe(ALL_MIGRATIONS);
    expect(off.migrations.map((m: any) => m.name)).toContain('DeviceOwnerships1760500000001');
    expect(off.migrationsTableName).toBe('typeorm_migrations');
    expect(off.migrationsTransactionMode).toBe('each');
    expect(off.migrationsRun).toBe(false);
    const on: any = buildTypeOrmOptions(configStub({ RUN_MIGRATIONS_ON_BOOT: 'true' }));
    expect(on.migrationsRun).toBe(true);
  });
});
