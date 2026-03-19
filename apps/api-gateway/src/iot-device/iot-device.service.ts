import {
  BadRequestException,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { randomBytes, scryptSync, timingSafeEqual } from 'crypto';
import { Repository } from 'typeorm';
import { IotDevice } from './iot-device.entity';
import { Device, DeviceType } from '../database/entities';

@Injectable()
export class IotDeviceService {
  private readonly claimOnlineTtlSeconds: number;
  private readonly claimRequireOnline: boolean;

  constructor(
    private readonly configService: ConfigService,
    @InjectRepository(IotDevice)
    private readonly iotDeviceRepository: Repository<IotDevice>,
    @InjectRepository(Device)
    private readonly deviceRepository: Repository<Device>,
  ) {
    this.claimOnlineTtlSeconds = Number(
      this.configService.get('IOT_ONLINE_TTL_SECONDS', 300),
    );
    this.claimRequireOnline =
      String(this.configService.get('IOT_CLAIM_REQUIRE_ONLINE', 'true')) ===
      'true';
  }

  private async ensureDashboardDeviceRow(ownerId: number, deviceId: string) {
    const now = new Date();
    const existing = await this.deviceRepository.findOne({
      where: { id: deviceId },
    });

    if (existing) {
      existing.userId = ownerId;
      existing.lastSeenAt = now;
      existing.lastSyncSlot = existing.lastSyncSlot || 'iot_live';
      existing.syncSource = existing.syncSource || 'iot_claim';
      await this.deviceRepository.save(existing);
      return;
    }

    await this.deviceRepository.save(
      this.deviceRepository.create({
        id: deviceId,
        userId: ownerId,
        name: `IoT Device ${deviceId}`,
        type: DeviceType.HUB,
        lastSeenAt: now,
        lastSyncSlot: 'iot_live',
        syncSource: 'iot_claim',
      }),
    );
  }

  private hashDeviceKey(rawDeviceKey: string): string {
    const salt = randomBytes(16).toString('hex');
    const hash = scryptSync(rawDeviceKey, salt, 64).toString('hex');
    return `${salt}:${hash}`;
  }

  private verifyDeviceKey(rawDeviceKey: string, hashedValue: string): boolean {
    const [salt, storedHash] = hashedValue.split(':');
    if (!salt || !storedHash) {
      return false;
    }

    const inputHash = scryptSync(rawDeviceKey, salt, 64);
    const storedBuffer = Buffer.from(storedHash, 'hex');
    if (storedBuffer.length !== inputHash.length) {
      return false;
    }

    return timingSafeEqual(storedBuffer, inputHash);
  }

  async registerDevice(deviceId: string, rawDeviceKey: string) {
    const existing = await this.iotDeviceRepository.findOne({
      where: { deviceId },
    });

    const now = new Date();

    if (existing) {
      existing.deviceKeyHash = this.hashDeviceKey(rawDeviceKey);
      existing.lastSeen = now;
      await this.iotDeviceRepository.save(existing);
      return {
        created: false,
        deviceId,
      };
    }

    const created = this.iotDeviceRepository.create({
      deviceId,
      deviceKeyHash: this.hashDeviceKey(rawDeviceKey),
      ownerId: null,
      isPaired: false,
      lastSeen: now,
    });

    await this.iotDeviceRepository.save(created);

    return {
      created: true,
      deviceId,
    };
  }

  async claimDevice(userId: number, deviceId: string) {
    const device = await this.iotDeviceRepository.findOne({
      where: { deviceId },
    });

    if (!device) {
      throw new NotFoundException('Device is not registered');
    }

    if (device.isPaired && device.ownerId && device.ownerId !== userId) {
      throw new BadRequestException(
        'Device is already claimed by another user',
      );
    }

    if (this.claimRequireOnline) {
      if (!device.lastSeen) {
        throw new BadRequestException(
          'Device is offline and cannot be claimed',
        );
      }
      const elapsed = (Date.now() - device.lastSeen.getTime()) / 1000;
      if (elapsed > this.claimOnlineTtlSeconds) {
        throw new BadRequestException(
          'Device is offline and cannot be claimed',
        );
      }
    }

    device.ownerId = userId;
    device.isPaired = true;
    await this.iotDeviceRepository.save(device);
    await this.ensureDashboardDeviceRow(userId, device.deviceId);

    return {
      device_id: device.deviceId,
      owner_id: device.ownerId,
      is_paired: device.isPaired,
      claimed_at: new Date().toISOString(),
    };
  }

  async authenticateAndResolveOwner(deviceId: string, rawDeviceKey: string) {
    const device = await this.iotDeviceRepository.findOne({
      where: { deviceId },
    });

    if (!device) {
      throw new UnauthorizedException('Device is not registered');
    }

    if (!this.verifyDeviceKey(rawDeviceKey, device.deviceKeyHash)) {
      throw new UnauthorizedException('Invalid Raspberry device key');
    }

    device.lastSeen = new Date();
    await this.iotDeviceRepository.save(device);

    if (!device.isPaired || !device.ownerId) {
      throw new BadRequestException('Device not claimed');
    }

    await this.ensureDashboardDeviceRow(device.ownerId, device.deviceId);

    return {
      ownerId: device.ownerId,
      deviceId: device.deviceId,
    };
  }
}
