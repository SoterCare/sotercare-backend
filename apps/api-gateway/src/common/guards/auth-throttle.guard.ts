import {
  CanActivate,
  ExecutionContext,
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
} from '@nestjs/common';
import type { RedisClientType } from 'redis';

/**
 * H7: lightweight per-IP rate limiter for the public /auth endpoints, backed by
 * the shared Redis client (no extra dependency). Caps how many auth requests a
 * single IP can make per window to blunt OTP brute-force and email-bombing.
 *
 * Tunables: AUTH_THROTTLE_LIMIT (default 10) requests per AUTH_THROTTLE_TTL
 * (default 60s). Fails open on Redis errors so a cache blip can't lock out auth.
 */
@Injectable()
export class AuthThrottleGuard implements CanActivate {
  private readonly ttlSeconds = Number(process.env.AUTH_THROTTLE_TTL || 60);
  private readonly limit = Number(process.env.AUTH_THROTTLE_LIMIT || 10);

  constructor(
    @Inject('REDIS_CLIENT') private readonly redisClient: RedisClientType,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest();
    const forwarded = request.headers?.['x-forwarded-for'];
    const ip =
      (Array.isArray(forwarded) ? forwarded[0] : forwarded) ||
      request.ip ||
      request.socket?.remoteAddress ||
      'unknown';

    const key = `auth_throttle:${String(ip).split(',')[0].trim()}`;

    try {
      const count = await this.redisClient.incr(key);
      if (count === 1) {
        await this.redisClient.expire(key, this.ttlSeconds);
      }
      if (count > this.limit) {
        throw new HttpException(
          'Too many requests. Please slow down and try again shortly.',
          HttpStatus.TOO_MANY_REQUESTS,
        );
      }
    } catch (err) {
      if (err instanceof HttpException) {
        throw err;
      }
      // Redis unavailable — don't block auth on infra hiccups.
      return true;
    }

    return true;
  }
}
