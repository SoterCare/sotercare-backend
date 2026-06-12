/* eslint-disable @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-return */
import { TimelineService } from './timeline.service';

const deviceRepository = {
  findOne: jest.fn().mockResolvedValue({ id: 'dev_001', userId: 1 }),
  find: jest.fn().mockResolvedValue([{ id: 'dev_001', userId: 1 }]),
};

const vitalRepository = {
  find: jest.fn(),
  createQueryBuilder: jest.fn(),
};

const alertRepository = {
  find: jest.fn(),
  findOne: jest.fn(),
  save: jest.fn(),
  createQueryBuilder: jest.fn(),
};

function mockQueryBuilder(rawRows: unknown[]) {
  const qb: any = {
    select: jest.fn().mockReturnThis(),
    addSelect: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    andWhere: jest.fn().mockReturnThis(),
    groupBy: jest.fn().mockReturnThis(),
    orderBy: jest.fn().mockReturnThis(),
    getRawMany: jest.fn().mockResolvedValue(rawRows),
  };
  return qb;
}

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
    // The hourly AVG now happens in SQL; the DB returns one row per bucket.
    // Hour 00 contains readings 36.5 and 37.5 -> AVG = 37 (pg returns strings).
    vitalRepository.createQueryBuilder.mockReturnValue(
      mockQueryBuilder([
        { bucket: new Date('2026-03-12T00:00:00.000Z'), value: '37' },
      ]),
    );

    const result = await service.getVitalsTimeline(1, {
      deviceId: 'dev_001',
      metric: 'temp',
      period: 'day',
      date: '2026-03-12',
    });

    expect(result.points[0]).toEqual({ xLabel: '00:00', value: 37 });
    expect(result.points).toHaveLength(24);
    // Hours without data are present but null-valued.
    expect(result.points[1]).toEqual({ xLabel: '01:00', value: null });
  });

  it('counts alert stats per type in SQL', async () => {
    alertRepository.createQueryBuilder.mockReturnValue(
      mockQueryBuilder([
        { type: 'fall', count: '2' },
        { type: 'moisture', count: '5' },
      ]),
    );

    const result = await service.getStats(1, {
      deviceId: 'dev_001',
      period: 'day',
      date: '2026-03-12',
    } as any);

    expect(result).toEqual({
      movements: 0,
      falls: 2,
      urine: 0,
      temperature: 0,
      moisture: 5,
      helpCalls: 0,
    });
  });

  it('returns distinct date options from SQL', async () => {
    vitalRepository.createQueryBuilder.mockReturnValue(
      mockQueryBuilder([{ date: '2026/03/12' }, { date: '2026/03/11' }]),
    );

    const result = await service.getDateOptions(1, {
      deviceId: 'dev_001',
    } as any);

    expect(result).toEqual({ options: ['2026/03/12', '2026/03/11'] });
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
