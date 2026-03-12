import { ConfigService } from '@nestjs/config';
import { DevicesService } from './devices.service';

describe('DevicesService', () => {
  const configService = {
    get: jest.fn().mockReturnValue(120),
  } as unknown as ConfigService;

  const service = new DevicesService(configService, {} as any, {} as any);

  it('infers online for recently seen devices', () => {
    const recent = new Date(Date.now() - 10_000);
    expect(service.inferStatus(recent)).toBe('online');
  });

  it('infers offline for stale devices', () => {
    const stale = new Date(Date.now() - 300_000);
    expect(service.inferStatus(stale)).toBe('offline');
  });
});
