import { DataSource } from 'typeorm';
import { CONTROL_MIGRATIONS, TENANT_MIGRATIONS } from '../../migrations';
import type { Clock } from '../core/clock';
import { TenantContext } from '../core/context';
import { ApiError } from '../core/errors';
import {
  CONTROL_ENTITIES,
  TenantEntity,
  TenantStatus,
} from './control.entities';

export const RECORD_TTL_MS = 60_000;
export const MAX_CONNECTIONS = 5;

export interface TenantRecord {
  tenantId: string;
  status: TenantStatus;
  // Local / dev: connection URL (stored in control `db_endpoint`).
  dbUrl: string;
  schemaVersion?: number;
  migrationStatus?: string;
}

export interface TenantLookup {
  find(tenantId: string): Promise<TenantRecord | null>;
}

export type TenantDataSource = Pick<DataSource, 'query' | 'destroy'>;
export type DataSourceFactory = (
  rec: TenantRecord,
) => Promise<TenantDataSource>;

export class CrossTenantAccess extends Error {
  constructor() {
    super('A second tenant was requested inside one TenantContext');
    this.name = 'CrossTenantAccess';
  }
}

export class TenantRegistry {
  private readonly records = new Map<
    string,
    { rec: TenantRecord; at: number }
  >();
  private readonly pools = new Map<string, Promise<TenantDataSource>>();

  constructor(
    private readonly lookup: TenantLookup,
    private readonly factory: DataSourceFactory,
    private readonly clock: Clock,
  ) {}

  async forTenant(tenantId: string): Promise<TenantDataSource> {
    // No code path holds two tenants: a second tenant in one context is a bug.
    const current = tryContext();
    if (current && current.tenantId !== tenantId) throw new CrossTenantAccess();

    const rec = await this.record(tenantId);
    if (rec.status === 'closed') {
      throw new ApiError(403, 'tenant_closed', 'Tenant is closed');
    }
    let pool = this.pools.get(tenantId);
    if (!pool) {
      pool = this.factory(rec);
      this.pools.set(tenantId, pool);
      pool.catch(() => this.pools.delete(tenantId));
    }
    return pool;
  }

  async invalidate(tenantId: string): Promise<void> {
    this.records.delete(tenantId);
    const pool = this.pools.get(tenantId);
    this.pools.delete(tenantId);
    if (pool) await (await pool).destroy();
  }

  async closeAll(): Promise<void> {
    await Promise.all([...this.pools.keys()].map((id) => this.invalidate(id)));
  }

  private async record(tenantId: string): Promise<TenantRecord> {
    const now = this.clock.now().getTime();
    const hit = this.records.get(tenantId);
    if (hit && now - hit.at < RECORD_TTL_MS) return hit.rec;
    const rec = await this.lookup.find(tenantId);
    if (!rec) throw new ApiError(404, 'tenant_not_found', 'Unknown tenant');
    this.records.set(tenantId, { rec, at: now });
    return rec;
  }
}

function tryContext() {
  try {
    return TenantContext.get();
  } catch {
    return null;
  }
}

// One pool per tenant: max 5 connections, idle connections close after 60 s.
export async function createTenantDataSource(
  rec: TenantRecord,
): Promise<DataSource> {
  const ds = new DataSource({
    type: 'postgres',
    url: rec.dbUrl,
    synchronize: false,
    extra: { max: MAX_CONNECTIONS, idleTimeoutMillis: RECORD_TTL_MS },
  });
  return ds.initialize();
}

// Migration connection: expand migrations, one transaction each, lock_timeout 5 s.
export async function createMigrationDataSource(
  rec: TenantRecord,
): Promise<DataSource> {
  const ds = new DataSource({
    type: 'postgres',
    url: rec.dbUrl,
    synchronize: false,
    migrations: TENANT_MIGRATIONS,
    migrationsTransactionMode: 'each',
    extra: { max: 1, options: '-c lock_timeout=5000' },
  });
  return ds.initialize();
}

export async function createControlDataSource(
  url: string,
): Promise<DataSource> {
  const ds = new DataSource({
    type: 'postgres',
    url,
    synchronize: false,
    entities: CONTROL_ENTITIES,
    migrations: CONTROL_MIGRATIONS,
    migrationsRun: true,
    extra: { max: MAX_CONNECTIONS },
  });
  return ds.initialize();
}

export interface MigrationStore {
  listRunnable(): Promise<TenantRecord[]>;
  setMigration(
    tenantId: string,
    migrationStatus: string,
    schemaVersion?: number,
  ): Promise<void>;
}

export class ControlTenantStore implements TenantLookup, MigrationStore {
  constructor(private readonly control: DataSource) {}

  private get repo() {
    return this.control.getRepository(TenantEntity);
  }

  private toRecord(e: TenantEntity): TenantRecord {
    return {
      tenantId: e.tenantId,
      status: e.status,
      dbUrl: e.dbEndpoint ?? '',
      schemaVersion: e.schemaVersion,
      migrationStatus: e.migrationStatus,
    };
  }

  async find(tenantId: string): Promise<TenantRecord | null> {
    const e = await this.repo.findOneBy({ tenantId });
    return e ? this.toRecord(e) : null;
  }

  async upsert(rec: TenantRecord): Promise<void> {
    await this.repo.upsert(
      { tenantId: rec.tenantId, status: rec.status, dbEndpoint: rec.dbUrl },
      ['tenantId'],
    );
  }

  async listRunnable(): Promise<TenantRecord[]> {
    const all = await this.repo.find({ order: { tenantId: 'ASC' } });
    return all
      .filter((e) => e.status !== 'closed')
      .map((e) => this.toRecord(e));
  }

  async setMigration(
    tenantId: string,
    migrationStatus: string,
    schemaVersion?: number,
  ): Promise<void> {
    await this.repo.update(
      { tenantId },
      schemaVersion === undefined
        ? { migrationStatus }
        : { migrationStatus, schemaVersion },
    );
  }
}
