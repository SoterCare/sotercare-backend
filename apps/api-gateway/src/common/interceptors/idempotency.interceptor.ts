import {
  Injectable,
  NestInterceptor,
  ExecutionContext,
  CallHandler,
  Inject,
  ConflictException,
  Logger,
} from '@nestjs/common';
import { Observable, of, from, throwError } from 'rxjs';
import { catchError, mergeMap } from 'rxjs/operators';
import type { RedisClientType } from 'redis';

// Mutating HTTP methods covered by idempotency keys.
const GUARDED_METHODS = ['POST', 'PUT', 'PATCH'];
// How long a completed response is replayed for a reused key.
const RESPONSE_CACHE_TTL_SECONDS = 86400;
// Backstop TTL for the in-flight lock (released explicitly on completion).
const LOCK_TTL_SECONDS = 30;
// When a duplicate arrives while the original is still running, poll the
// response cache briefly before giving up with a 409.
const LOCK_POLL_ATTEMPTS = 3;
const LOCK_POLL_INTERVAL_MS = 300;

@Injectable()
export class IdempotencyInterceptor implements NestInterceptor {
  private readonly logger = new Logger(IdempotencyInterceptor.name);

  constructor(
    @Inject('REDIS_CLIENT') private readonly redisClient: RedisClientType,
  ) {}

  async intercept(
    context: ExecutionContext,
    next: CallHandler,
  ): Promise<Observable<unknown>> {
    const request = context.switchToHttp().getRequest<{
      method: string;
      headers: Record<string, string | undefined>;
    }>();
    const method = request.method;

    // Only checking idempotency for mutation requests
    if (!GUARDED_METHODS.includes(method)) {
      return next.handle();
    }

    const idempotencyKey = request.headers['idempotency-key'];
    if (!idempotencyKey) {
      // If no key provided, just process normally (or throw error if strict)
      return next.handle();
    }

    const key = `idempotency:${idempotencyKey}`;
    const lockKey = `${key}:lock`;

    // 1. Replay the cached response if this key already completed.
    const cachedResponse = await this.readCachedResponse(key);
    if (cachedResponse !== undefined) {
      this.logger.debug(`Returning cached response for key: ${idempotencyKey}`);
      return of(cachedResponse);
    }

    // 2. In-flight lock so concurrent duplicates don't run the handler twice.
    // null means Redis was unreachable — fail open (no idempotency).
    let lockAcquired: boolean | null = null;
    try {
      const result = await this.redisClient.set(lockKey, '1', {
        NX: true,
        EX: LOCK_TTL_SECONDS,
      });
      lockAcquired = result !== null;
    } catch (err) {
      this.logger.error(
        `Redis error acquiring lock (continuing without idempotency): ${err}`,
      );
    }

    if (lockAcquired === false) {
      // The original request is still in flight: wait briefly for its response.
      for (let attempt = 0; attempt < LOCK_POLL_ATTEMPTS; attempt++) {
        await new Promise((resolve) =>
          setTimeout(resolve, LOCK_POLL_INTERVAL_MS),
        );
        const polled = await this.readCachedResponse(key);
        if (polled !== undefined) {
          this.logger.debug(
            `Returning cached response for key: ${idempotencyKey} (after lock wait)`,
          );
          return of(polled);
        }
      }
      throw new ConflictException('Duplicate request already in progress');
    }

    const holdsLock = lockAcquired === true;

    // 3. Process request, cache the result (awaited), then release the lock.
    // On handler error, release the lock so retries aren't blocked for 30s.
    return next.handle().pipe(
      mergeMap((response) =>
        from(
          this.cacheResponseAndReleaseLock(key, lockKey, response, holdsLock),
        ),
      ),
      catchError((err: unknown) =>
        from(this.releaseLock(lockKey, holdsLock)).pipe(
          mergeMap(() => throwError(() => err)),
        ),
      ),
    );
  }

  /** Returns undefined when there is no cached response or Redis is unavailable. */
  private async readCachedResponse(key: string): Promise<unknown> {
    try {
      const cached = await this.redisClient.get(key);
      if (cached) {
        return JSON.parse(cached);
      }
    } catch (err) {
      this.logger.error(
        `Redis error reading cached response (continuing): ${err}`,
      );
    }
    return undefined;
  }

  private async cacheResponseAndReleaseLock(
    key: string,
    lockKey: string,
    response: unknown,
    holdsLock: boolean,
  ): Promise<unknown> {
    try {
      // Cache for 24 hours (86400 seconds)
      await this.redisClient.set(key, JSON.stringify(response), {
        EX: RESPONSE_CACHE_TTL_SECONDS,
      });
    } catch (err) {
      this.logger.error(`Failed to cache response (continuing): ${err}`);
    }
    await this.releaseLock(lockKey, holdsLock);
    return response;
  }

  private async releaseLock(
    lockKey: string,
    holdsLock: boolean,
  ): Promise<void> {
    if (!holdsLock) {
      return;
    }
    try {
      await this.redisClient.del(lockKey);
    } catch (err) {
      this.logger.error(
        `Failed to release idempotency lock (expires via TTL): ${err}`,
      );
    }
  }
}
