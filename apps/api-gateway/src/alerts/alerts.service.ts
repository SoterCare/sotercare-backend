import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { Alert, Device } from '../database/entities';
import { RealtimeGateway } from '../realtime/realtime.gateway';

@Injectable()
export class AlertsService {
  private readonly logger = new Logger(AlertsService.name);

  constructor(
    @InjectRepository(Alert)
    private readonly alertRepository: Repository<Alert>,
    @InjectRepository(Device)
    private readonly deviceRepository: Repository<Device>,
    private readonly realtimeGateway: RealtimeGateway,
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

  async pushLatestAlert(deviceId: string): Promise<void> {
    // 1. Find the device to get its owner userId
    const device = await this.deviceRepository.findOne({ where: { id: deviceId } });
    if (!device) {
      this.logger.warn(`pushLatestAlert: device ${deviceId} not found`);
      return;
    }

    // 2. Get the latest undismissed alert for this device
    const alert = await this.alertRepository.findOne({
      where: { deviceId, isDismissed: false },
      order: { timestamp: 'DESC' },
    });
    if (!alert) return;

    // 3. Emit via the realtime gateway
    this.realtimeGateway.emitToUser(device.userId, 'alert.new', {
      id: alert.id,
      type: alert.type,
      title: alert.title,
      timestamp: alert.timestamp,
      deviceId: alert.deviceId,
    });
  }
}
