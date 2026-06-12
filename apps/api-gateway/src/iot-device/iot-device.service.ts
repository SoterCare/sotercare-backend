import {
  BadRequestException,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { randomBytes, scrypt as scryptCb, timingSafeEqual } from 'crypto';
import { promisify } from 'util';
import { Repository } from 'typeorm';
import { IotDevice } from './iot-device.entity';
import { Device, DeviceType } from '../database/entities';

// Async scrypt — the sync variant blocks the whole event loop ~50-100ms per
// verification, which stalls every other request under concurrent device syncs.
const scrypt = promisify(scryptCb) as (
  password: string,
  salt: string,
  keylen: number,
) => Promise<Buffer>;

// Debounce repeat writes (lastSeen bumps) and repeat scrypt verifications from
// chatty devices that sync every few seconds.
const WRITE_DEBOUNCE_MS = 60_000;
const KEY_VERIFY_CACHE_TTL_MS = 60_000;
const KEY_VERIFY_CACHE_MAX = 1000;

@Injectable()
export class IotDeviceService {
  private readonly claimOnlineTtlSeconds: number;
  private readonly claimRequireOnline: boolean;
  // deviceId -> verified (rawKey, storedHash) pair; entries expire after TTL.
  private readonly keyVerifyCache = new Map<
    string,
    { rawKey: string; hash: string; expires: number }
  >();

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
      // Skip the write when nothing meaningful changed within the debounce
      // window — this runs on every device sync batch.
      const ownerChanged = existing.userId !== ownerId;
      const lastSeenStale =
        !existing.lastSeenAt ||
        now.getTime() - existing.lastSeenAt.getTime() > WRITE_DEBOUNCE_MS;
      if (ownerChanged || lastSeenStale) {
        await this.deviceRepository.update(
          { id: deviceId },
          {
            userId: ownerId,
            lastSeenAt: now,
            lastSyncSlot: existing.lastSyncSlot || 'iot_live',
            syncSource: existing.syncSource || 'iot_claim',
          },
        );
      }
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

  private async hashDeviceKey(rawDeviceKey: string): Promise<string> {
    const salt = randomBytes(16).toString('hex');
    const hash = (await scrypt(rawDeviceKey, salt, 64)).toString('hex');
    return `${salt}:${hash}`;
  }

  private async verifyDeviceKey(
    rawDeviceKey: string,
    hashedValue: string,
  ): Promise<boolean> {
    const [salt, storedHash] = hashedValue.split(':');
    if (!salt || !storedHash) {
      return false;
    }

    const inputHash = await scrypt(rawDeviceKey, salt, 64);
    const storedBuffer = Buffer.from(storedHash, 'hex');
    if (storedBuffer.length !== inputHash.length) {
      return false;
    }

    return timingSafeEqual(storedBuffer, inputHash);
  }

  /**
   * verifyDeviceKey with a short-TTL cache so a device syncing every few
   * seconds doesn't pay the ~100ms scrypt cost on every batch. Cache hits
   * require the exact same (rawKey, storedHash) pair that previously verified.
   */
  private async verifyDeviceKeyCached(
    deviceId: string,
    rawDeviceKey: string,
    hashedValue: string,
  ): Promise<boolean> {
    const now = Date.now();
    const cached = this.keyVerifyCache.get(deviceId);
    if (
      cached &&
      cached.expires > now &&
      cached.rawKey === rawDeviceKey &&
      cached.hash === hashedValue
    ) {
      return true;
    }

    const ok = await this.verifyDeviceKey(rawDeviceKey, hashedValue);
    if (ok) {
      if (this.keyVerifyCache.size >= KEY_VERIFY_CACHE_MAX) {
        this.keyVerifyCache.clear();
      }
      this.keyVerifyCache.set(deviceId, {
        rawKey: rawDeviceKey,
        hash: hashedValue,
        expires: now + KEY_VERIFY_CACHE_TTL_MS,
      });
    }
    return ok;
  }

  async registerDevice(deviceId: string, rawDeviceKey: string) {
    const existing = await this.iotDeviceRepository.findOne({
      where: { deviceId },
    });

    const now = new Date();

    if (existing) {
      existing.deviceKeyHash = await this.hashDeviceKey(rawDeviceKey);
      existing.lastSeen = now;
      await this.iotDeviceRepository.save(existing);
      this.keyVerifyCache.delete(deviceId);
      return {
        created: false,
        deviceId,
      };
    }

    const created = this.iotDeviceRepository.create({
      deviceId,
      deviceKeyHash: await this.hashDeviceKey(rawDeviceKey),
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

  async unclaimDevice(userId: number, deviceId: string) {
    const device = await this.iotDeviceRepository.findOne({
      where: { deviceId },
    });

    if (!device) {
      throw new NotFoundException('Device is not registered');
    }

    if (!device.isPaired || !device.ownerId) {
      throw new BadRequestException('Device is already unclaimed');
    }

    if (device.ownerId !== userId) {
      throw new BadRequestException('Device is claimed by another user');
    }

    device.ownerId = null;
    device.isPaired = false;
    await this.iotDeviceRepository.save(device);

    return {
      device_id: device.deviceId,
      owner_id: null,
      is_paired: false,
      unclaimed_at: new Date().toISOString(),
    };
  }

  async authenticateAndResolveOwner(deviceId: string, rawDeviceKey: string) {
    const device = await this.iotDeviceRepository.findOne({
      where: { deviceId },
    });

    if (!device) {
      throw new UnauthorizedException('Device is not registered');
    }

    if (
      !(await this.verifyDeviceKeyCached(
        deviceId,
        rawDeviceKey,
        device.deviceKeyHash,
      ))
    ) {
      throw new UnauthorizedException('Invalid Raspberry device key');
    }

    // lastSeen powers the online/offline TTL check — a 60s-debounced single
    // UPDATE is plenty, instead of a full save() on every sync batch.
    const now = new Date();
    if (
      !device.lastSeen ||
      now.getTime() - device.lastSeen.getTime() > WRITE_DEBOUNCE_MS
    ) {
      await this.iotDeviceRepository.update({ deviceId }, { lastSeen: now });
    }

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
