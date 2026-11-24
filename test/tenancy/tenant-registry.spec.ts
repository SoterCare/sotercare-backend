import { FakeClock } from '../../src/core/clock';
import { TenantContext } from '../../src/core/context';
import { TenantDb } from '../../src/tenancy/tenant-db';
import {
  CrossTenantAccess,
  TenantDataSource,
  TenantRecord,
  TenantRegistry,
} from '../../src/tenancy/tenant-registry';

function rec(tenantId: string): TenantRecord {
  return { tenantId, status: 'active', dbUrl: `pg://${tenantId}` };
}

function setup() {
  const clock = new FakeClock();
  const records = new Map<string, TenantRecord>([
    ['t_a', rec('t_a')],
    ['t_b', rec('t_b')],
  ]);
  let lookups = 0;
  const created: string[] = [];
  const destroyed: string[] = [];
  const registry = new TenantRegistry(
    {
      find: (id) => {
        lookups++;
        return Promise.resolve(records.get(id) ?? null);
      },
    },
    (r) => {
      created.push(r.tenantId);
      const ds: TenantDataSource = {
        query: () => Promise.resolve([] as never),
        destroy: () => {
          destroyed.push(r.tenantId);
          return Promise.resolve();
        },
      };
      return Promise.resolve(ds);
    },
    clock,
  );
  return {
    clock,
    records,
    registry,
    created,
    destroyed,
    lookups: () => lookups,
  };
}

const ctx = (tenantId: string) => ({ tenantId, actor: 'u', requestId: 'r' });

describe('TenantRegistry', () => {
  it('gives each tenant its own pool and reuses it', async () => {
    const s = setup();
    const a1 = await s.registry.forTenant('t_a');
    const a2 = await s.registry.forTenant('t_a');
    const b = await s.registry.forTenant('t_b');
    expect(a1).toBe(a2);
    expect(b).not.toBe(a1);
    expect(s.created).toEqual(['t_a', 't_b']);
  });

  it('caches the tenant record for 60 s on the injected clock', async () => {
    const s = setup();
    await s.registry.forTenant('t_a');
    await s.registry.forTenant('t_a');
    expect(s.lookups()).toBe(1);
    s.clock.advance(61_000);
    await s.registry.forTenant('t_a');
    expect(s.lookups()).toBe(2);
  });

  it('invalidate closes the pool and forces a fresh lookup', async () => {
    const s = setup();
    await s.registry.forTenant('t_a');
    await s.registry.invalidate('t_a');
    expect(s.destroyed).toEqual(['t_a']);
    await s.registry.forTenant('t_a');
    expect(s.created).toEqual(['t_a', 't_a']);
  });

  it('rejects unknown and closed tenants', async () => {
    const s = setup();
    await expect(s.registry.forTenant('t_x')).rejects.toMatchObject({
      code: 'tenant_not_found',
    });
    s.records.set('t_c', { ...rec('t_c'), status: 'closed' });
    await expect(s.registry.forTenant('t_c')).rejects.toMatchObject({
      code: 'tenant_closed',
    });
  });

  it('refuses a second tenant inside one TenantContext', async () => {
    const s = setup();
    await TenantContext.run(ctx('t_a'), async () => {
      await s.registry.forTenant('t_a');
      await expect(s.registry.forTenant('t_b')).rejects.toBeInstanceOf(
        CrossTenantAccess,
      );
    });
  });
});

describe('TenantDb', () => {
  it('throws outside TenantContext', async () => {
    const s = setup();
    await expect(new TenantDb(s.registry).get()).rejects.toMatchObject({
      name: 'NoTenantContext',
    });
  });

  it('returns the context tenant pool', async () => {
    const s = setup();
    const db = new TenantDb(s.registry);
    const ds = await TenantContext.run(ctx('t_b'), () => db.get());
    expect(ds).toBe(await s.registry.forTenant('t_b'));
  });
});
