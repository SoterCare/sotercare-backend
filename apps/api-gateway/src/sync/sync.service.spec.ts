import { SyncService } from './sync.service';

describe('SyncService', () => {
  it('returns zero upserts for duplicate sync batches', async () => {
    const service = new SyncService(
      { transaction: jest.fn() } as any,
      {
        findOne: jest.fn().mockResolvedValue({
          receivedAt: new Date('2026-03-12T08:00:03.000Z'),
          upsertSummary: {
            devices: 2,
            statuses: 2,
            vitals: 20,
            alerts: 5,
            recordings: 1,
          },
        }),
      } as any,
    );

    const result = await service.processRaspberryPiSync(1, {
      source: 'raspberry_pi_gateway',
      syncedAt: '2026-03-12T08:00:02.000Z',
      slot: 'slot_08',
      gatewayHost: 'raspberrypi.local',
      devices: [],
      deviceStatuses: [],
      latestVitals: [],
      recentAlerts: [],
      recordingSessions: [],
    });

    expect(result).toEqual({
      success: true,
      receivedAt: '2026-03-12T08:00:03.000Z',
      upserted: {
        devices: 0,
        statuses: 0,
        vitals: 0,
        alerts: 0,
        recordings: 0,
      },
      note: 'Duplicate sync batch — already processed',
    });
  });
});
