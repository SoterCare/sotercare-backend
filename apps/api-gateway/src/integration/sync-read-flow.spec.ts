/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-argument */
import { ConfigService } from '@nestjs/config';
import { FindOperator } from 'typeorm';
import { DashboardService } from '../dashboard/dashboard.service';
import { DevicesService } from '../devices/devices.service';
import { SyncService } from '../sync/sync.service';

// Equality plus the FindOperators the services use (MoreThanOrEqual, IsNull).
function matchesValue(currentValue: unknown, value: unknown): boolean {
  if (value instanceof FindOperator) {
    const op = value as FindOperator<any>;
    const cmp = (v: any) => (v instanceof Date ? v.getTime() : v);
    if (op.type === 'moreThanOrEqual') return cmp(currentValue) >= cmp(op.value);
    if (op.type === 'isNull') return currentValue === null || currentValue === undefined;
    throw new Error(`unsupported operator ${op.type}`);
  }
  if (currentValue instanceof Date && value instanceof Date) {
    return currentValue.getTime() === value.getTime();
  }
  return currentValue === value;
}

class MemoryRepository<T extends Record<string, any>> {
  private items: T[] = [];
  private autoId = 1;

  constructor(private readonly primaryKey: keyof T) {}

  create(payload: Partial<T>): T {
    return payload as T;
  }

  save(entity: T): T {
    // Mirrors the DB DEFAULT now() of CreateDateColumn.
    if (entity.createdAt === undefined) {
      (entity as Record<string, any>).createdAt = new Date();
    }
    const key = entity[this.primaryKey];
    const existingIndex = this.items.findIndex(
      (item) => item[this.primaryKey] === key,
    );

    if ((key === undefined || key === null) && this.primaryKey === 'id') {
      entity[this.primaryKey] = this.autoId as T[keyof T];
      this.autoId += 1;
      this.items.push(entity);
      return entity;
    }

    if (existingIndex >= 0) {
      this.items[existingIndex] = { ...this.items[existingIndex], ...entity };
      return this.items[existingIndex];
    }

    this.items.push(entity);
    return entity;
  }

  findOne(options: {
    where: Partial<T>;
    order?: Record<string, 'ASC' | 'DESC'>;
  }): T | null {
    let results = this.items.filter((item) =>
      Object.entries(options.where).every(([key, value]) =>
        matchesValue(item[key as keyof T] as unknown, value),
      ),
    );

    if (options.order) {
      const [[orderKey, orderDirection]] = Object.entries(options.order);
      results = results.sort((left, right) => {
        const leftValue = left[orderKey as keyof T] as any;
        const rightValue = right[orderKey as keyof T] as any;
        const leftComparable =
          leftValue instanceof Date ? leftValue.getTime() : leftValue;
        const rightComparable =
          rightValue instanceof Date ? rightValue.getTime() : rightValue;
        return orderDirection === 'DESC'
          ? rightComparable - leftComparable
          : leftComparable - rightComparable;
      });
    }

    return results[0] ?? null;
  }

  find(options?: {
    where?: Partial<T>;
    order?: Record<string, 'ASC' | 'DESC'>;
  }): T[] {
    let results = [...this.items];

    if (options?.where) {
      results = results.filter((item) =>
        Object.entries(options.where ?? {}).every(
          ([key, value]) => matchesValue(item[key as keyof T], value),
        ),
      );
    }

    if (options?.order) {
      const [[orderKey, orderDirection]] = Object.entries(options.order);
      results = results.sort((left, right) => {
        const leftValue = left[orderKey as keyof T] as any;
        const rightValue = right[orderKey as keyof T] as any;
        const leftComparable =
          leftValue instanceof Date ? leftValue.getTime() : leftValue;
        const rightComparable =
          rightValue instanceof Date ? rightValue.getTime() : rightValue;
        return orderDirection === 'DESC'
          ? rightComparable - leftComparable
          : leftComparable - rightComparable;
      });
    }

    return results;
  }

  // Supports DevicesService's latest-status-per-device DISTINCT ON query.
  createQueryBuilder() {
    const state: { deviceIds?: string[] } = {};
    const qb: any = {
      distinctOn: () => qb,
      where: (_expr: string, params: { deviceIds: string[] }) => {
        state.deviceIds = params.deviceIds;
        return qb;
      },
      orderBy: () => qb,
      addOrderBy: () => qb,
      getMany: () => {
        const latest = new Map<string, T>();
        for (const item of this.items) {
          if (!state.deviceIds?.includes(item.deviceId)) continue;
          const current = latest.get(item.deviceId);
          if (
            !current ||
            (item.receivedAt as Date) > (current.receivedAt as Date)
          ) {
            latest.set(item.deviceId, item);
          }
        }
        return Promise.resolve([...latest.values()]);
      },
    };
    return qb;
  }
}

describe('Sync to read flow', () => {
  it('syncs data and exposes it through device and dashboard services', async () => {
    const deviceRepository = new MemoryRepository<any>('id');
    const statusRepository = new MemoryRepository<any>('id');
    const vitalRepository = new MemoryRepository<any>('id');
    const alertRepository = new MemoryRepository<any>('id');
    const recordingRepository = new MemoryRepository<any>('recordingId');
    const syncHistoryRepository = new MemoryRepository<any>('id');

    const repositories = new Map<any, any>([
      ['Device', deviceRepository],
      ['DeviceStatus', statusRepository],
      ['Vital', vitalRepository],
      ['Alert', alertRepository],
      ['RecordingSession', recordingRepository],
      ['SyncHistory', syncHistoryRepository],
    ]);

    // Mirrors the EntityManager surface the bulk-write sync service uses:
    // upsert / insert / insert-query-builder with ON CONFLICT DO NOTHING.
    const manager = {
      getRepository: (entity: any) => repositories.get(entity.name),
      // Ownership checks (GAP-001): find() with equality or In() filters.
      // The IoT registry is empty in this flow.
      find: (entity: any, options: any) => {
        const repo = repositories.get(entity.name);
        if (!repo) return Promise.resolve([]);
        const where = options?.where ?? {};
        const rows = repo.find().filter((item: any) =>
          Object.entries(where).every(([key, value]: [string, any]) =>
            value instanceof FindOperator
              ? (value.value as any[]).includes(item[key])
              : item[key] === value,
          ),
        );
        return Promise.resolve(rows);
      },
      upsert: (entity: any, rows: any[]) => {
        const repo = repositories.get(entity.name);
        rows.forEach((row: any) => repo.save({ ...row }));
        return Promise.resolve({});
      },
      insert: (entity: any, rowOrRows: any) => {
        const repo = repositories.get(entity.name);
        const rows = Array.isArray(rowOrRows) ? rowOrRows : [rowOrRows];
        rows.forEach((row: any) => repo.save({ ...row }));
        return Promise.resolve({});
      },
      createQueryBuilder: () => {
        const state: { entity?: any; rows?: any[] } = {};
        const qb: any = {
          insert: () => qb,
          into: (entity: any) => {
            state.entity = entity;
            return qb;
          },
          values: (rows: any[]) => {
            state.rows = rows;
            return qb;
          },
          orIgnore: () => qb,
          returning: () => qb,
          updateEntity: () => qb,
          execute: () => {
            const repo = repositories.get(state.entity.name);
            const inserted: any[] = [];
            for (const row of state.rows ?? []) {
              const conflict =
                state.entity.name === 'Vital'
                  ? repo.findOne({
                      where: {
                        deviceId: row.deviceId,
                        timestamp: row.timestamp,
                      },
                    })
                  : repo.findOne({ where: { id: row.id } });
              if (!conflict) {
                const saved = repo.save({ ...row });
                inserted.push({ id: saved.id ?? null });
              }
            }
            return Promise.resolve({ raw: inserted });
          },
        };
        return qb;
      },
    };

    const dataSource = {
      transaction: (callback: any) => callback(manager),
    };

    // Ownership periods (PH0-07) are covered by ownership-period.spec.ts and
    // the real-PostgreSQL suites; here a recording collaborator stands in.
    const periods = new Map<string, { userId: number; since: Date }>();
    const ownership = {
      openInterval: (_m: unknown, deviceId: string, userId: number) => {
        if (!periods.has(deviceId)) {
          periods.set(deviceId, { userId, since: new Date(0) });
        }
        return Promise.resolve();
      },
      currentWindow: (userId: number, deviceId: string) =>
        Promise.resolve(
          periods.get(deviceId)?.userId === userId
            ? periods.get(deviceId)!.since
            : null,
        ),
      currentWindows: (userId: number) =>
        Promise.resolve(
          new Map(
            [...periods]
              .filter(([, p]) => p.userId === userId)
              .map(([d, p]) => [d, p.since]),
          ),
        ),
    };

    const syncService = new SyncService(
      dataSource as any,
      syncHistoryRepository as any,
      ownership as any,
    );
    const devicesService = new DevicesService(
      { get: () => 120 } as unknown as ConfigService,
      deviceRepository as any,
      statusRepository as any,
      ownership as any,
    );
    const dashboardService = new DashboardService(
      deviceRepository as any,
      vitalRepository as any,
      ownership as any,
    );

    const result = await syncService.processRaspberryPiSync(1, {
      source: 'raspberry_pi_gateway',
      syncedAt: '2026-03-12T08:00:02.000Z',
      slot: 'slot_08',
      gatewayHost: 'raspberrypi.local',
      devices: [
        { id: 'dev_001', name: 'Device 01', type: 'thigh_band' as any },
      ],
      deviceStatuses: [
        {
          deviceId: 'dev_001',
          battery: 82,
          signalRssi: -63,
          connectedAt: '2026-03-12T07:15:00Z',
          bands: [{ name: 'Thigh Band', status: 'online' }],
        },
      ],
      latestVitals: [
        {
          deviceId: 'dev_001',
          timestamp: '2026-03-12T07:25:00Z',
          temperature: 30.4,
          roomTemperature: 29.9,
          moisture: 3,
          gaitAnalysis: 'N/A',
        },
      ],
      recentAlerts: [],
      recordingSessions: [],
    });

    expect(result.upserted).toEqual({
      devices: 1,
      statuses: 1,
      vitals: 1,
      alerts: 0,
      recordings: 0,
    });

    const devices = await devicesService.getDevices(1, true);
    const latestVitals = await dashboardService.getLatestVitals(1, 'dev_001');

    expect(devices.devices[0].id).toBe('dev_001');
    expect(devices.devices[0]?.latestStatus?.battery).toBe(82);
    expect(latestVitals?.temperature).toBe(30.4);
  });
});
