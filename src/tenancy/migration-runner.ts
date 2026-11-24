import { logger } from '../core/logging';
import {
  createMigrationDataSource,
  MigrationStore,
  TenantRecord,
} from './tenant-registry';

export const MAX_MIGRATION_FAILURES = 2;

export interface MigrationResult {
  migrated: string[];
  failed: string[];
  stopped: boolean;
}

type MigrateOne = (rec: TenantRecord) => Promise<number>;

// Applies the tenant migrations to one tenant; returns its schema version.
const migrateTenant: MigrateOne = async (rec) => {
  const ds = await createMigrationDataSource(rec);
  try {
    await ds.runMigrations({ transaction: 'each' });
    return ds.migrations.length;
  } finally {
    await ds.destroy();
  }
};

export class MigrationRunner {
  constructor(
    private readonly store: MigrationStore,
    private readonly migrateOne: MigrateOne = migrateTenant,
  ) {}

  // One tenant at a time; marks failures, carries on, stops after 2.
  async runAll(): Promise<MigrationResult> {
    const result: MigrationResult = {
      migrated: [],
      failed: [],
      stopped: false,
    };
    for (const rec of await this.store.listRunnable()) {
      try {
        const version = await this.migrateOne(rec);
        await this.store.setMigration(rec.tenantId, 'ok', version);
        result.migrated.push(rec.tenantId);
      } catch (e) {
        await this.store.setMigration(rec.tenantId, 'migration_failed');
        logger.error('migration_failed', {
          tenantId: rec.tenantId,
          reason: e instanceof Error ? e.name : 'unknown',
        });
        result.failed.push(rec.tenantId);
        if (result.failed.length >= MAX_MIGRATION_FAILURES) {
          result.stopped = true;
          break;
        }
      }
    }
    return result;
  }
}
