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
    const device = await this.deviceRepository.findOne({
      where: { id: deviceId, userId },
    });

    if (!device) {
      throw new NotFoundException(
        'Device not found or does not belong to user',
      );
    }

    const latestVital = await this.vitalRepository.findOne({
      where: { deviceId },
      order: { timestamp: 'DESC' },
    });

    if (!latestVital) {
      return null;
    }

    return {
      deviceId,
      timestamp: latestVital.timestamp,
      temperature: latestVital.temperature,
      roomTemperature: latestVital.roomTemperature,
      moisture: latestVital.moisture,
      gaitAnalysis: latestVital.gaitAnalysis,
    };
  }
}
