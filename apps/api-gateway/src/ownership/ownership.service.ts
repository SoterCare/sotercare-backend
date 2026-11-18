import { ConflictException, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { EntityManager, IsNull, Repository } from 'typeorm';
import { DeviceOwnership } from '../database/entities';

/**
 * Ownership periods (PH0-07). A caller may read a device's history only for
 * the time they hold the device's open ownership interval; previous owners'
 * periods are not visible to a new owner. Writes happen inside the caller's
 * transaction so the interval changes atomically with the claim/unclaim.
 */
@Injectable()
export class OwnershipService {
  constructor(
    @InjectRepository(DeviceOwnership)
    private readonly ownershipRepository: Repository<DeviceOwnership>,
  ) {}

  /** Start of the caller's open interval for the device, or null. */
  async currentWindow(userId: number, deviceId: string): Promise<Date | null> {
    const open = await this.ownershipRepository.findOne({
      where: { deviceId, userId, endedAt: IsNull() },
    });
    return open ? open.startedAt : null;
  }

  /** deviceId -> start of the caller's open interval, for every device. */
  async currentWindows(userId: number): Promise<Map<string, Date>> {
    const open = await this.ownershipRepository.find({
      where: { userId, endedAt: IsNull() },
    });
    return new Map(open.map((row) => [row.deviceId, row.startedAt]));
  }

  async currentOwnership(
    deviceId: string,
  ): Promise<{ userId: number; since: Date } | null> {
    const open = await this.ownershipRepository.findOne({
      where: { deviceId, endedAt: IsNull() },
    });
    return open ? { userId: open.userId, since: open.startedAt } : null;
  }

  /** Idempotent for the same user; a different current owner is a conflict. */
  async openInterval(
    manager: EntityManager,
    deviceId: string,
    userId: number,
    reason: string,
  ): Promise<void> {
    const open = await manager.findOne(DeviceOwnership, {
      where: { deviceId, endedAt: IsNull() },
    });
    if (open) {
      if (open.userId === userId) return;
      throw new ConflictException('Device already has a current owner');
    }
    await manager.insert(DeviceOwnership, {
      deviceId,
      userId,
      startedAt: new Date(),
      endedAt: null,
      startReason: reason,
      endReason: null,
    });
  }

  async closeInterval(
    manager: EntityManager,
    deviceId: string,
    userId: number,
    reason: string,
  ): Promise<void> {
    await manager.update(
      DeviceOwnership,
      { deviceId, userId, endedAt: IsNull() },
      { endedAt: new Date(), endReason: reason },
    );
  }
}
