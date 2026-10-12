import {
  BadRequestException,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import { randomBytes, scrypt as scryptCb, timingSafeEqual } from 'crypto';
import { promisify } from 'util';
import { DataSource, IsNull, Repository } from 'typeorm';
import { IotDevice } from './iot-device.entity';
import { Device, DeviceType } from '../database/entities';
import { OwnershipService } from '../ownership/ownership.service';

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

/**
 * devices.userId value for a dashboard row whose IoT device has no owner.
 * User ids are serial and start at 1, so no account can match it; every read
 * path filters on devices.userId, so writing it revokes access everywhere.
 */
export const UNOWNED_USER_ID = 0;

// Long-lived gateway sockets re-check ownership per batch through this cache.
// Claim/unclaim invalidate it immediately in this process; the TTL bounds
// staleness when another instance changed ownership.
const OWNER_CACHE_TTL_MS = 5_000;

@Injectable()
export class IotDeviceService {
  private readonly claimOnlineTtlSeconds: number;
  private readonly claimRequireOnline: boolean;
  // deviceId -> verified (rawKey, storedHash) pair; entries expire after TTL.
  private readonly keyVerifyCache = new Map<
    string,
    { rawKey: string; hash: string; expires: number }
  >();
  private readonly ownerCache = new Map<
    string,
    { ownership: { ownerId: number; since: Date } | null; expires: number }
  >();

  constructor(
    private readonly configService: ConfigService,
    @InjectRepository(IotDevice)
    private readonly iotDeviceRepository: Repository<IotDevice>,
    @InjectRepository(Device)
    private readonly deviceRepository: Repository<Device>,
    @InjectDataSource()
    private readonly dataSource: DataSource,
    private readonly ownershipService: OwnershipService,
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

    // GAP-001: atomic check-and-set. Only an unowned device can change hands;
    // a concurrent claimant's UPDATE matches zero rows instead of overwriting.
    // PH0-07: the ownership interval opens in the same transaction.
    await this.dataSource.transaction(async (manager) => {
      const claimed = await manager.update(
        IotDevice,
        { deviceId, ownerId: IsNull() },
        { ownerId: userId, isPaired: true },
      );
      if (!claimed.affected) {
        const current = await manager.findOne(IotDevice, {
          where: { deviceId },
        });
        if (current?.ownerId !== userId) {
          throw new BadRequestException(
            'Device is already claimed by another user',
          );
        }
        if (!current.isPaired) {
          await manager.update(
            IotDevice,
            { deviceId, ownerId: userId },
            { isPaired: true },
          );
        }
      }
      await this.ownershipService.openInterval(
        manager,
        deviceId,
        userId,
        'claim',
      );
    });
    this.ownerCache.delete(deviceId);
    await this.ensureDashboardDeviceRow(userId, deviceId);

    return {
      device_id: deviceId,
      owner_id: userId,
      is_paired: true,
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

    await this.dataSource.transaction(async (manager) => {
      const released = await manager.update(
        IotDevice,
        { deviceId, ownerId: userId },
        { ownerId: null, isPaired: false },
      );
      if (!released.affected) {
        throw new BadRequestException('Device is claimed by another user');
      }
      // PH0-07: close the ownership period in the same transaction.
      await this.ownershipService.closeInterval(
        manager,
        deviceId,
        userId,
        'unclaim',
      );
      // Revoke the dashboard association too, otherwise the previous owner
      // keeps reading the device through every devices.userId-scoped query.
      await manager.update(
        Device,
        { id: deviceId, userId },
        { userId: UNOWNED_USER_ID },
      );
    });
    this.ownerCache.delete(deviceId);

    return {
      device_id: deviceId,
      owner_id: null,
      is_paired: false,
      unclaimed_at: new Date().toISOString(),
    };
  }

  /**
   * Current owner of a claimed device and the start of their ownership
   * period, or null when unclaimed/unregistered or when the registry and the
   * ownership periods disagree (fail closed). Used to revoke already-
   * authenticated gateway sockets and to refuse data observed before the
   * current owner's period (PH0-07).
   */
  async resolveCurrentOwnership(
    deviceId: string,
  ): Promise<{ ownerId: number; since: Date } | null> {
    const now = Date.now();
    const cached = this.ownerCache.get(deviceId);
    if (cached && cached.expires > now) {
      return cached.ownership;
    }
    const device = await this.iotDeviceRepository.findOne({
      where: { deviceId },
    });
    const ownerId = device?.isPaired && device.ownerId ? device.ownerId : null;
    const period = ownerId
      ? await this.ownershipService.currentOwnership(deviceId)
      : null;
    const ownership =
      ownerId && period && period.userId === ownerId
        ? { ownerId, since: period.since }
        : null;
    this.ownerCache.set(deviceId, {
      ownership,
      expires: now + OWNER_CACHE_TTL_MS,
    });
    return ownership;
  }

  async resolveCurrentOwner(deviceId: string): Promise<number | null> {
    return (await this.resolveCurrentOwnership(deviceId))?.ownerId ?? null;
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
