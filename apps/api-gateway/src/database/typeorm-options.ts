import { ConfigService } from '@nestjs/config';
import { TypeOrmModuleOptions } from '@nestjs/typeorm';
import { ALL_MIGRATIONS } from './migrations';

export function buildTypeOrmOptions(
  configService: ConfigService,
): TypeOrmModuleOptions {
  // Prefer a managed connection string (Neon/Supabase/Koyeb Postgres) so the
  // data lives outside the ephemeral container. SSL is required by those
  // providers; auto-enable it whenever a URL is set (or DB_SSL=true).
  const databaseUrl = configService.get<string>('DATABASE_URL');
  const useSsl =
    !!databaseUrl || configService.get('DB_SSL', 'false') === 'true';
  return {
    type: 'postgres',
    ...(databaseUrl
      ? { url: databaseUrl }
      : {
          host: configService.get<string>('DB_HOST', '127.0.0.1'),
          port: Number(configService.get<string>('DB_PORT', '5432')),
          username: configService.get<string>('DB_USER', 'postgres'),
          password: configService.get<string>('DB_PASS', 'postgres'),
          database: configService.get<string>('DB_NAME', 'auth_db'),
        }),
    ...(useSsl ? { ssl: { rejectUnauthorized: false } } : {}),
    // Bound the pg pool and individual statements so one slow query
    // can't monopolize the gateway's database access.
    extra: { max: 20, statement_timeout: 10000 },
    autoLoadEntities: true,
    // C3: auto-schema-sync only outside production. In prod, schema is
    // managed by migrations so TypeORM can't drop/retype columns under us.
    synchronize: process.env.NODE_ENV !== 'production',
    // GAP-002: TypeORM silently drops `undefined` keys from find `where`
    // objects, widening a scoped query to every tenant. Throw instead.
    invalidWhereValuesBehavior: { undefined: 'throw' },
    // AR-0: production schema changes ship as explicit migrations. They run on
    // boot only when RUN_MIGRATIONS_ON_BOOT=true (or via `npm run migration:run`).
    migrations: ALL_MIGRATIONS,
    migrationsTableName: 'typeorm_migrations',
    migrationsTransactionMode: 'each',
    migrationsRun: configService.get('RUN_MIGRATIONS_ON_BOOT') === 'true',
  };
}
