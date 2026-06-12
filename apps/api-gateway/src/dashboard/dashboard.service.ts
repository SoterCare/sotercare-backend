import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Device, Vital } from '../database/entities';

@Injectable()
export class DashboardService {
  constructor(
    @InjectRepository(Device)
    private readonly deviceRepository: Repository<Device>,
    @InjectRepository(Vital)
    private readonly vitalRepository: Repository<Vital>,
  ) {}

  async getLatestVitals(userId: number, deviceId: string) {
    // The ownership check and the latest-vital read are independent — run them
    // in parallel and validate ownership before using the vital.
    const [device, latestVital] = await Promise.all([
      this.deviceRepository.findOne({ where: { id: deviceId, userId } }),
      this.vitalRepository.findOne({
        where: { deviceId },
        order: { timestamp: 'DESC' },
      }),
    ]);

    if (!device) {
      throw new NotFoundException(
        'Device not found or does not belong to user',
      );
    }

    if (!latestVital) {
      return null;
    }

    return {
      deviceId,
      timestamp: latestVital.timestamp.getTime(),
      temperature: latestVital.temperature,
      roomTemperature: latestVital.roomTemperature,
      moisture: latestVital.moisture,
      gaitAnalysis: latestVital.gaitAnalysis,
    };
  }
}
