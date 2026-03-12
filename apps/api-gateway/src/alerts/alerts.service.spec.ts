import { AlertsService } from './alerts.service';

describe('AlertsService', () => {
  it('returns empty alert list when the user has no devices', async () => {
    const service = new AlertsService(
      {} as any,
      {
        find: jest.fn().mockResolvedValue([]),
      } as any,
    );

    await expect(service.getRecentAlerts(1)).resolves.toEqual({
      alerts: [],
      total: 0,
    });
  });
});
