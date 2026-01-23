import { Injectable, NestInterceptor, ExecutionContext, CallHandler, Inject, HttpException, HttpStatus } from '@nestjs/common';
import { Observable, of } from 'rxjs';
import { tap } from 'rxjs/operators';
import type { RedisClientType } from 'redis';

@Injectable()
export class IdempotencyInterceptor implements NestInterceptor {
    constructor(
        @Inject('REDIS_CLIENT') private readonly redisClient: RedisClientType
    ) { }

    async intercept(context: ExecutionContext, next: CallHandler): Promise<Observable<any>> {
        const request = context.switchToHttp().getRequest();
        const method = request.method;

        // Only checking idempotency for mutation requests
        if (method !== 'POST' && method !== 'PUT') {
            return next.handle();
        }

        const idempotencyKey = request.headers['idempotency-key'];
        if (!idempotencyKey) {
            // If no key provided, just process normally (or throw error if strict)
            return next.handle();
        }

        const key = `idempotency:${idempotencyKey}`;

        try {
            // 1. Check if key exists
            const cachedResponse = await this.redisClient.get(key);
            if (cachedResponse) {
                console.log(`[Idempotency] returning cached response for key: ${idempotencyKey}`);
                return of(JSON.parse(cachedResponse));
            }
        } catch (err) {
            console.error('[Idempotency] Redis Error:', err);
            // On redis error, you might choose to fail or proceed. proceeding for resilience.
        }

        // 2. Process request & Cache result
        return next.handle().pipe(
            tap(async (response) => {
                try {
                    // Cache for 24 hours (86400 seconds)
                    await this.redisClient.set(key, JSON.stringify(response), { EX: 86400 });
                } catch (err) {
                    console.error('[Idempotency] Failed to cache response:', err);
                }
            }),
        );
    }
}
