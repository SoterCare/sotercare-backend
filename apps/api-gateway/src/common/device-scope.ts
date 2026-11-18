import { BadRequestException } from '@nestjs/common';

/**
 * GAP-002: a device-scoped read must name its device. TypeORM drops
 * `undefined` keys from `where`, so a missing deviceId would otherwise turn
 * "this user's device" into "any device" and leak other tenants' data.
 */
export function requireDeviceId(deviceId: unknown): string {
  if (typeof deviceId !== 'string' || deviceId.trim() === '') {
    throw new BadRequestException('deviceId is required');
  }
  return deviceId;
}
