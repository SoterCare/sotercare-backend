import { HealthServiceService } from './health-service.service';

/**
 * Covers the C1/M5 fixes: heart_rate/spo2/device_id are now mapped into the
 * persisted VitalSign rows, inserts are de-duplicated via orIgnore, and the
 * response uses the proto-correct `synced_count` field.
 */
describe('HealthServiceService.syncLogs', () => {
  function makeService() {
    const captured: { values?: any[] } = {};
    const qb: any = {
      insert: () => qb,
      into: () => qb,
      values: (v: any[]) => {
        captured.values = v;
        return qb;
      },
      orIgnore: jest.fn(() => qb),
      execute: jest.fn(async () => ({ identifiers: [{ id: 1 }] })),
    };
    const repo: any = { createQueryBuilder: () => qb };
    return { service: new HealthServiceService(repo), captured, qb };
  }

  it('maps heart_rate, spo2 and device_id (snake or camel) into the entity', async () => {
    const { service, captured } = makeService();

    await service.syncLogs(7, [
      {
        heart_rate: 88,
        spo2: 97,
        device_id: 'dev-1',
        temperature: 36.6,
        timestamp: 1_700_000_000_000,
      },
    ]);

    const row = captured.values![0];
    expect(row.userId).toBe(7);
    expect(row.deviceId).toBe('dev-1');
    expect(row.heartRate).toBe(88);
    expect(row.spo2).toBe(97);
  });

  it('accepts camelCase heartRate/deviceId aliases too', async () => {
    const { service, captured } = makeService();

    await service.syncLogs(1, [
      { heartRate: 60, spo2: 99, deviceId: 'd2', temperature: 36, timestamp: 1 },
    ]);

    const row = captured.values![0];
    expect(row.heartRate).toBe(60);
    expect(row.deviceId).toBe('d2');
  });

  it('de-duplicates via orIgnore and returns synced_count (not syncedCount)', async () => {
    const { service, qb } = makeService();

    const res = await service.syncLogs(1, [
      { temperature: 36, timestamp: 1 },
    ]);

    expect(qb.orIgnore).toHaveBeenCalled();
    expect(res).toHaveProperty('synced_count', 1);
    expect(res).not.toHaveProperty('syncedCount');
  });

  it('returns synced_count 0 for an empty batch', async () => {
    const { service } = makeService();
    const res = await service.syncLogs(1, []);
    expect(res.synced_count).toBe(0);
  });
});
