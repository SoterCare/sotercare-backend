import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { MoreThanOrEqual, Repository } from 'typeorm';
import { Device, Vital } from '../database/entities';
import { requireDeviceId } from '../common/device-scope';
import { OwnershipService } from '../ownership/ownership.service';

@Injectable()
export class DashboardService {
  constructor(
    @InjectRepository(Device)
    private readonly deviceRepository: Repository<Device>,
    @InjectRepository(Vital)
    private readonly vitalRepository: Repository<Vital>,
    private readonly ownershipService: OwnershipService,
  ) {}

  async getLatestVitals(userId: number, deviceId: string) {
    requireDeviceId(deviceId);
    // Ownership first: the vitals table is only read for a device the caller owns.
    const device = await this.deviceRepository.findOne({
      where: { id: deviceId, userId },
    });

    // PH0-07: only readings ingested during the caller's ownership period.
    const since = device
      ? await this.ownershipService.currentWindow(userId, deviceId)
      : null;

    if (!device || !since) {
      throw new NotFoundException(
        'Device not found or does not belong to user',
      );
    }

    const latestVital = await this.vitalRepository.findOne({
      where: { deviceId, createdAt: MoreThanOrEqual(since) },
      order: { timestamp: 'DESC' },
    });

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
