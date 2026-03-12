/* eslint-disable @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-return */
import { TimelineService } from './timeline.service';

const deviceRepository = {
  findOne: jest.fn().mockResolvedValue({ id: 'dev_001', userId: 1 }),
  find: jest.fn().mockResolvedValue([{ id: 'dev_001', userId: 1 }]),
};

const vitalRepository = {
  find: jest.fn(),
};

const alertRepository = {
  find: jest.fn(),
  findOne: jest.fn(),
  save: jest.fn(),
};

describe('TimelineService', () => {
  let service: TimelineService;

  beforeEach(() => {
    jest.clearAllMocks();
    service = new TimelineService(
      deviceRepository as any,
      vitalRepository as any,
      alertRepository as any,
    );
  });

  it('aggregates day vitals into hourly points', async () => {
    vitalRepository.find.mockResolvedValue([
      {
        timestamp: new Date('2026-03-12T00:15:00Z'),
        temperature: 36.5,
        roomTemperature: 29.9,
        moisture: 3,
        gaitAnalysis: 'N/A',
      },
      {
        timestamp: new Date('2026-03-12T00:45:00Z'),
        temperature: 37.5,
        roomTemperature: 30.1,
        moisture: 5,
        gaitAnalysis: 'N/A',
      },
    ]);

    const result = await service.getVitalsTimeline(1, {
      deviceId: 'dev_001',
      metric: 'temp',
      period: 'day',
      date: '2026-03-12',
    });

    expect(result.points[0]).toEqual({ xLabel: '00:00', value: 37 });
    expect(result.points).toHaveLength(24);
  });

  it('restores and dismisses timeline items', async () => {
    const alert = {
      id: 'al_1001',
      deviceId: 'dev_001',
      isDismissed: true,
      dismissedAt: new Date('2026-03-12T09:12:00Z'),
    };
    alertRepository.findOne.mockResolvedValue(alert);
    alertRepository.save.mockImplementation((value: any) => value);

    await expect(service.restore(1, { id: 'al_1001' })).resolves.toEqual({
      restoredId: 'al_1001',
    });
    expect(alert.isDismissed).toBe(false);
    expect(alert.dismissedAt).toBeNull();

    await expect(service.dismiss(1, { id: 'al_1001' })).resolves.toEqual({
      dismissedId: 'al_1001',
    });
    expect(alert.isDismissed).toBe(true);
    expect(alert.dismissedAt).toBeInstanceOf(Date);
  });
});
