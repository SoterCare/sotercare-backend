import { Test, TestingModule } from '@nestjs/testing';
import { HealthServiceController } from './health-service.controller';
import { HealthServiceService } from './health-service.service';

describe('HealthServiceController', () => {
  let healthServiceController: HealthServiceController;
  let healthService: {
    syncLogs: jest.Mock;
    getLogDates: jest.Mock;
    getLogsByDateRange: jest.Mock;
  };

  beforeEach(async () => {
    healthService = {
      syncLogs: jest.fn(),
      getLogDates: jest.fn(),
      getLogsByDateRange: jest.fn(),
    };

    const app: TestingModule = await Test.createTestingModule({
      controllers: [HealthServiceController],
      providers: [
        {
          provide: HealthServiceService,
          useValue: healthService,
        },
      ],
    }).compile();

    healthServiceController = app.get<HealthServiceController>(
      HealthServiceController,
    );
  });

  describe('syncLogs', () => {
    it('should map user_id and forward logs to service', async () => {
      healthService.syncLogs.mockResolvedValue({
        success: true,
        message: 'Logs synced successfully',
        syncedCount: 1,
      });

      const payload = {
        user_id: 7,
        logs: [{ timestamp: Date.now(), heart_rate: 72 }],
      };

      const result = await healthServiceController.syncLogs(payload);

      expect(healthService.syncLogs).toHaveBeenCalledWith(7, payload.logs);
      expect(result).toEqual({
        success: true,
        message: 'Logs synced successfully',
        syncedCount: 1,
      });
    });
  });

  describe('getLogDates', () => {
    it('should return wrapped dates from service', async () => {
      healthService.getLogDates.mockResolvedValue(['2026-03-15']);

      const result = await healthServiceController.getLogDates({ user_id: 7 });

      expect(healthService.getLogDates).toHaveBeenCalledWith(7);
      expect(result).toEqual({ dates: ['2026-03-15'] });
    });
  });

  describe('getLogsByDateRange', () => {
    it('should return wrapped logs from service', async () => {
      const logs = [{ id: 1, timestamp: Date.now() }];
      healthService.getLogsByDateRange.mockResolvedValue(logs);

      const payload = {
        user_id: 7,
        start_date: '2026-03-15T00:00:00.000Z',
        end_date: '2026-03-15T23:59:59.999Z',
      };

      const result = await healthServiceController.getLogsByDateRange(payload);

      expect(healthService.getLogsByDateRange).toHaveBeenCalledWith(
        7,
        payload.start_date,
        payload.end_date,
      );
      expect(result).toEqual({ logs });
    });
  });
});
