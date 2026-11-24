import { MigrationRunner } from '../../src/tenancy/migration-runner';
import type { TenantRecord } from '../../src/tenancy/tenant-registry';

const rec = (tenantId: string): TenantRecord => ({
  tenantId,
  status: 'active',
  dbUrl: 'x',
});

describe('MigrationRunner', () => {
  it('marks failures, carries on, and stops after 2', async () => {
    const marks: [string, string, number | undefined][] = [];
    const runner = new MigrationRunner(
      {
        listRunnable: () =>
          Promise.resolve(['t1', 't2', 't3', 't4', 't5'].map(rec)),
        setMigration: (id, status, v) => {
          marks.push([id, status, v]);
          return Promise.resolve();
        },
      },
      (r) =>
        ['t2', 't3'].includes(r.tenantId)
          ? Promise.reject(new Error('boom'))
          : Promise.resolve(1),
    );
    const res = await runner.runAll();
    expect(res).toEqual({
      migrated: ['t1'],
      failed: ['t2', 't3'],
      stopped: true,
    });
    expect(marks).toContainEqual(['t2', 'migration_failed', undefined]);
    expect(marks.find((m) => m[0] === 't4')).toBeUndefined();
  });
});
