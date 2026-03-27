import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { Alert, Device } from '../database/entities';

@Injectable()
export class AlertsService {
  constructor(
    @InjectRepository(Alert)
    private readonly alertRepository: Repository<Alert>,
    @InjectRepository(Device)
    private readonly deviceRepository: Repository<Device>,
  ) {}

  async getRecentAlerts(userId: number, deviceId?: string, limit = 20) {
    let deviceIds: string[] = [];

    if (deviceId) {
      const device = await this.deviceRepository.findOne({
        where: { id: deviceId, userId },
      });

      if (!device) {
        throw new NotFoundException(
          'Device not found or does not belong to user',
        );
      }

      deviceIds = [deviceId];
    } else {
      const devices = await this.deviceRepository.find({ where: { userId } });
      deviceIds = devices.map((device) => device.id);
    }

    if (deviceIds.length === 0) {
      return { alerts: [], total: 0 };
    }

    const alerts = await this.alertRepository.find({
      where: {
        deviceId: In(deviceIds),
        isDismissed: false,
        isAttended: false,
      },
      order: { timestamp: 'DESC' },
      take: limit,
    });

    return {
      alerts: alerts.map((alert) => ({
        id: alert.id,
        type: alert.type,
        title: alert.title,
        timestamp: alert.timestamp,
        deviceId: alert.deviceId,
      })),
      total: alerts.length,
    };
  }

  async getAttendedAlerts(userId: number, deviceId?: string, limit = 50) {
    let deviceIds: string[] = [];

    if (deviceId) {
      const device = await this.deviceRepository.findOne({
        where: { id: deviceId, userId },
      });
      if (!device) {
        throw new NotFoundException('Device not found or does not belong to user');
      }
      deviceIds = [deviceId];
    } else {
      const devices = await this.deviceRepository.find({ where: { userId } });
      deviceIds = devices.map((d) => d.id);
    }

    if (deviceIds.length === 0) {
      return { alerts: [], total: 0 };
    }

    const alerts = await this.alertRepository.find({
      where: {
        deviceId: In(deviceIds),
        isAttended: true,
      },
      order: { timestamp: 'DESC' },
      take: limit,
    });

    return {
      alerts: alerts.map((alert) => ({
        id: alert.id,
        type: alert.type,
        title: alert.title,
        timestamp: alert.timestamp,
        deviceId: alert.deviceId,
        attendedAt: alert.timestamp,
      })),
      total: alerts.length,
    };
  }

  async resolveAlert(userId: number, alertId: string, resolution: 'attended' | 'false-alarm') {
    const alert = await this.alertRepository.findOne({
      where: { id: alertId },
      relations: ['device'],
    });

    if (!alert || alert.device.userId !== userId) {
      throw new NotFoundException('Alert not found or access denied');
    }

    if (resolution === 'attended') {
      alert.isAttended = true;
      // Attended = valid alert acknowledged. Remove from feed but NOT recycle bin.
    } else {
      alert.isFalseAlarm = true;
      // False alarm = dismissed to recycle bin.
      alert.isDismissed = true;
      alert.dismissedAt = new Date();
    }

    await this.alertRepository.save(alert);
    return { id: alert.id, status: resolution };
  }
}
