import {
  CanActivate,
  ExecutionContext,
  Injectable,
  Logger,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { createHash, timingSafeEqual } from 'crypto';

const digest = (value: string) => createHash('sha256').update(value).digest();

/**
 * AR-1: service-to-service authentication for internal routes (the Python
 * Safety Guard → api-gateway webhook). Fail closed: unconfigured → 503,
 * anything but the exact token → 401. Compared as SHA-256 digests with
 * timingSafeEqual, so neither content nor length leaks through timing.
 * Token values are never logged.
 */
@Injectable()
export class InternalServiceGuard implements CanActivate {
  private readonly logger = new Logger(InternalServiceGuard.name);
  private lastUnconfiguredLog = 0;

  canActivate(context: ExecutionContext): boolean {
    const expected = process.env.INTERNAL_SERVICE_TOKEN;
    if (!expected) {
      if (Date.now() - this.lastUnconfiguredLog > 60_000) {
        this.lastUnconfiguredLog = Date.now();
        this.logger.error(
          'INTERNAL_SERVICE_TOKEN is not configured; internal routes are disabled',
        );
      }
      throw new ServiceUnavailableException('internal_auth_not_configured');
    }
    const request = context
      .switchToHttp()
      .getRequest<{ headers: Record<string, unknown> }>();
    const provided = request.headers['x-internal-token'];
    if (
      typeof provided !== 'string' ||
      provided.length === 0 ||
      !timingSafeEqual(digest(provided), digest(expected))
    ) {
      throw new UnauthorizedException('invalid_internal_token');
    }
    return true;
  }
}
