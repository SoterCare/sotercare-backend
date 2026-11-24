import { createHash } from 'node:crypto';
import {
  CallHandler,
  ExecutionContext,
  Inject,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import { Observable, of } from 'rxjs';
import { tap } from 'rxjs/operators';
import { CLOCK } from './clock';
import type { Clock } from './clock';
import { TenantContext } from './context';
import { ApiError } from './errors';

const TTL_MS = 24 * 3600_000;
const GUARDED = ['POST', 'PUT', 'PATCH', 'DELETE'];

export interface StoredIdempotency {
  bodyHash: string;
  response: unknown;
  expiresAt: number;
}

// Production store is the tenant DB table idempotency_keys (migration in Task 2).
export interface IdempotencyStore {
  get(scopeKey: string): Promise<StoredIdempotency | undefined>;
  put(scopeKey: string, row: StoredIdempotency): Promise<void>;
}
export const IDEMPOTENCY_STORE = Symbol('IDEMPOTENCY_STORE');

export class InMemoryIdempotencyStore implements IdempotencyStore {
  private rows = new Map<string, StoredIdempotency>();
  get(k: string): Promise<StoredIdempotency | undefined> {
    return Promise.resolve(this.rows.get(k));
  }
  put(k: string, row: StoredIdempotency): Promise<void> {
    this.rows.set(k, row);
    return Promise.resolve();
  }
}

interface IdempotentRequest {
  method: string;
  url?: string;
  body?: unknown;
  headers?: Record<string, string | undefined>;
  route?: { path?: string };
}

@Injectable()
export class IdempotencyInterceptor implements NestInterceptor {
  constructor(
    @Inject(IDEMPOTENCY_STORE) private readonly store: IdempotencyStore,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async intercept(
    context: ExecutionContext,
    next: CallHandler,
  ): Promise<Observable<unknown>> {
    const req = context.switchToHttp().getRequest<IdempotentRequest>();
    const key = req.headers?.['idempotency-key'];
    if (!key || !GUARDED.includes(req.method)) return next.handle();

    const { tenantId, actor } = TenantContext.get();
    const route = req.route?.path ?? req.url ?? '';
    const scopeKey = [tenantId, actor, req.method, route, key].join('|');
    const bodyHash = createHash('sha256')
      .update(JSON.stringify(req.body ?? null))
      .digest('hex');
    const now = this.clock.now().getTime();

    const hit = await this.store.get(scopeKey);
    if (hit && hit.expiresAt > now) {
      if (hit.bodyHash !== bodyHash) {
        throw new ApiError(
          409,
          'idempotency_conflict',
          'Idempotency-Key reused with a different body',
        );
      }
      return of(hit.response);
    }
    return next.handle().pipe(
      tap((response) => {
        void this.store.put(scopeKey, {
          bodyHash,
          response,
          expiresAt: now + TTL_MS,
        });
      }),
    );
  }
}
