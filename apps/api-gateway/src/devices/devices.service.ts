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

    const mappedDevices = await Promise.all(
      devices.map(async (device) => {
        const inferredStatus = this.inferStatus(device.lastSeenAt);
        const latestStatus = includeStatus
          ? await this.deviceStatusRepository.findOne({
              where: { deviceId: device.id },
              order: { receivedAt: 'DESC' },
            })
          : null;

        if (minimal) {
          return {
            id: device.id,
            name: device.name,
          };
        }

        return {
          id: device.id,
          name: device.name,
          type: device.type,
          status: inferredStatus,
          lastSeenAt: device.lastSeenAt,
          statusInferred: true,
          statusSource: device.syncSource,
          latestStatus: latestStatus
            ? {
                battery: latestStatus.battery,
                signalRssi: latestStatus.signalRssi,
                connectedAt: latestStatus.connectedAt,
                bands: latestStatus.bands,
                receivedAt: latestStatus.receivedAt,
              }
            : undefined,
        };
      }),
    );

    return {
      devices: mappedDevices,
    };
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
      connectedAt: latestStatus?.connectedAt ?? null,
      lastSeenAt: device.lastSeenAt,
      bands: latestStatus?.bands ?? [],
    };
  }

  inferStatus(lastSeenAt: Date) {
    const elapsedSeconds = (Date.now() - lastSeenAt.getTime()) / 1000;
    return elapsedSeconds <= this.onlineTtlSeconds ? 'online' : 'offline';
  }
}
