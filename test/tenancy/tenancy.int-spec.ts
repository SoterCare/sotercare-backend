import { DataSource } from 'typeorm';
import { FakeClock } from '../../src/core/clock';
import { TenantContext } from '../../src/core/context';
import { MigrationRunner } from '../../src/tenancy/migration-runner';
import { TenantDb } from '../../src/tenancy/tenant-db';
import {
  ControlTenantStore,
  createControlDataSource,
  createTenantDataSource,
  TenantRegistry,
} from '../../src/tenancy/tenant-registry';

// Needs a local Postgres: TEST_PG_URL=postgres://postgres:pw@localhost:55433/postgres
const base = process.env.TEST_PG_URL;
const d = base ? describe : describe.skip;

function withDb(url: string, db: string): string {
  const u = new URL(url);
  u.pathname = `/${db}`;
  return u.toString();
}

d('tenancy (local Postgres)', () => {
  const suffix = Date.now().toString(36);
  const dbs = {
    control: `sc_ctl_${suffix}`,
    a: `sc_ta_${suffix}`,
    b: `sc_tb_${suffix}`,
  };
  let admin: DataSource;
  let control: DataSource;
  let registry: TenantRegistry;
  let store: ControlTenantStore;

  beforeAll(async () => {
    admin = new DataSource({ type: 'postgres', url: base });
    await admin.initialize();
    for (const n of Object.values(dbs)) {
      await admin.query(`CREATE DATABASE ${n}`);
    }
    control = await createControlDataSource(withDb(base!, dbs.control));
    store = new ControlTenantStore(control);
    await store.upsert({
      tenantId: 't_a',
      status: 'active',
      dbUrl: withDb(base!, dbs.a),
    });
    await store.upsert({
      tenantId: 't_b',
      status: 'active',
      dbUrl: withDb(base!, dbs.b),
    });
    const result = await new MigrationRunner(store).runAll();
    expect(result.failed).toEqual([]);
    registry = new TenantRegistry(
      store,
      createTenantDataSource,
      new FakeClock(),
    );
  });

  afterAll(async () => {
    await registry?.closeAll();
    await control?.destroy();
    for (const n of Object.values(dbs)) {
      await admin.query(`DROP DATABASE IF EXISTS ${n} WITH (FORCE)`);
    }
    await admin?.destroy();
  });

  const ctx = (tenantId: string) => ({ tenantId, actor: 'u', requestId: 'r' });
  const q = (tenantId: string, sql: string) =>
    TenantContext.run(ctx(tenantId), async () =>
      (await new TenantDb(registry).get()).query(sql),
    );

  it("second tenant has its own pool and cannot see the first tenant's rows", async () => {
    await q(
      't_a',
      `INSERT INTO core.idempotency_keys (scope_key, body_hash, response, expires_at) VALUES ('k1','h','{}', now())`,
    );
    const rowsA = await q('t_a', `SELECT * FROM core.idempotency_keys`);
    const rowsB = await q('t_b', `SELECT * FROM core.idempotency_keys`);
    expect(rowsA).toHaveLength(1);
    expect(rowsB).toHaveLength(0);
    expect(await registry.forTenant('t_a')).not.toBe(
      await registry.forTenant('t_b'),
    );
  });

  it('agents_rw has no rights on core or telemetry', async () => {
    const r = await q(
      't_a',
      `SELECT has_schema_privilege('agents_rw','core','USAGE') AS core,
              has_schema_privilege('agents_rw','telemetry','USAGE') AS tel,
              has_schema_privilege('agents_rw','agents','USAGE') AS agents`,
    );
    expect(r[0]).toEqual({ core: false, tel: false, agents: true });
  });

  it('re-running the runner is a no-op and records schemaVersion', async () => {
    const result = await new MigrationRunner(store).runAll();
    expect(result.failed).toEqual([]);
    expect((await store.find('t_a'))!.schemaVersion).toBe(1);
  });
});
