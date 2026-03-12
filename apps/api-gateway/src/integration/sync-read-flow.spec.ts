/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-argument */
import { ConfigService } from '@nestjs/config';
import { DashboardService } from '../dashboard/dashboard.service';
import { DevicesService } from '../devices/devices.service';
import { SyncService } from '../sync/sync.service';

class MemoryRepository<T extends Record<string, any>> {
  private items: T[] = [];
  private autoId = 1;

  constructor(private readonly primaryKey: keyof T) {}

  create(payload: Partial<T>): T {
    return payload as T;
  }

  save(entity: T): T {
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
      Object.entries(options.where).every(([key, value]) => {
        const currentValue = item[key as keyof T] as unknown;
        if (currentValue instanceof Date && value instanceof Date) {
          return currentValue.getTime() === value.getTime();
        }
        return currentValue === value;
      }),
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
          ([key, value]) => item[key as keyof T] === value,
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

    const dataSource = {
      transaction: (callback: any) =>
        callback({
          getRepository: (entity: any) => repositories.get(entity.name),
        }),
    };

    const syncService = new SyncService(
      dataSource as any,
      syncHistoryRepository as any,
    );
    const devicesService = new DevicesService(
      { get: () => 120 } as unknown as ConfigService,
      deviceRepository as any,
      statusRepository as any,
    );
    const dashboardService = new DashboardService(
      deviceRepository as any,
      vitalRepository as any,
    );

    await syncService.processRaspberryPiSync(1, {
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

    const devices = await devicesService.getDevices(1, true);
    const latestVitals = await dashboardService.getLatestVitals(1, 'dev_001');

    expect(devices.devices[0].id).toBe('dev_001');
    expect(devices.devices[0]?.latestStatus?.battery).toBe(82);
    expect(latestVitals?.temperature).toBe(30.4);
  });
});
