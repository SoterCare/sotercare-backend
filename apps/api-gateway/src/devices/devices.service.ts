import { Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Device, DeviceStatus } from '../database/entities';

@Injectable()
export class DevicesService {
  private readonly onlineTtlSeconds: number;

  constructor(
    private readonly configService: ConfigService,
    @InjectRepository(Device)
    private readonly deviceRepository: Repository<Device>,
    @InjectRepository(DeviceStatus)
    private readonly deviceStatusRepository: Repository<DeviceStatus>,
  ) {
    this.onlineTtlSeconds = Number(
      this.configService.get('DEVICE_ONLINE_TTL_SECONDS', 120),
    );
  }

  async getDevices(userId: number, includeStatus: boolean, minimal = false) {
    const devices = await this.deviceRepository.find({
      where: { userId },
      order: { updatedAt: 'DESC' },
    });

    // Minimal view never uses statuses — skip the status query entirely.
    if (minimal) {
      return {
        devices: devices.map((device) => ({
          id: device.id,
          name: device.name,
        })),
      };
    }

    // One DISTINCT ON query for the latest status of every device, instead of
    // a findOne per device (N+1). Served by the (deviceId, receivedAt) index.
    const statusByDevice = new Map<string, DeviceStatus>();
    if (includeStatus && devices.length > 0) {
      const latestStatuses = await this.deviceStatusRepository
        .createQueryBuilder('s')
        .distinctOn(['s.deviceId'])
        .where('s.deviceId IN (:...deviceIds)', {
          deviceIds: devices.map((d) => d.id),
        })
        .orderBy('s.deviceId', 'ASC')
        .addOrderBy('s.receivedAt', 'DESC')
        .getMany();
      for (const status of latestStatuses) {
        statusByDevice.set(status.deviceId, status);
      }
    }

    const mappedDevices = devices.map((device) => {
      const latestStatus = statusByDevice.get(device.id) ?? null;
      return {
        id: device.id,
        name: device.name,
        type: device.type,
        status: this.inferStatus(device.lastSeenAt),
        lastSeenAt: device.lastSeenAt?.getTime() ?? null,
        statusInferred: true,
        statusSource: device.syncSource,
        latestStatus: latestStatus
          ? {
              battery: latestStatus.battery,
              signalRssi: latestStatus.signalRssi,
              connectedAt: latestStatus.connectedAt?.getTime() ?? null,
              bands: latestStatus.bands,
              receivedAt: latestStatus.receivedAt.getTime(),
            }
          : undefined,
      };
    });

    return {
      devices: mappedDevices,
    };
  }

  /** Lightweight EXISTS used by profile — avoids fetching device rows for a boolean. */
  async hasAnyDevice(userId: number): Promise<boolean> {
    return this.deviceRepository.exists({ where: { userId } });
  }

  async getDeviceStatus(userId: number, deviceId: string) {
    const device = await this.deviceRepository.findOne({
      where: { id: deviceId, userId },
    });

    if (!device) {
      throw new NotFoundException(
        'Device not found or does not belong to user',
      );
    }

    const latestStatus = await this.deviceStatusRepository.findOne({
      where: { deviceId },
      order: { receivedAt: 'DESC' },
    });

    return {
      deviceId: device.id,
      status: this.inferStatus(device.lastSeenAt),
      statusInferred: true,
      statusSource: device.syncSource,
      battery: latestStatus?.battery ?? null,
      signalRssi: latestStatus?.signalRssi ?? null,
      connectedAt: latestStatus?.connectedAt?.getTime() ?? null,
      lastSeenAt: device.lastSeenAt?.getTime() ?? null,
      bands: latestStatus?.bands ?? [],
    };
  }

  inferStatus(lastSeenAt: Date) {
    const elapsedSeconds = (Date.now() - lastSeenAt.getTime()) / 1000;
    return elapsedSeconds <= this.onlineTtlSeconds ? 'online' : 'offline';
  }
}
