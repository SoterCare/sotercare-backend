import { Global, Module } from '@nestjs/common';
import { CLOCK, SystemClock } from './clock';
import {
  IDEMPOTENCY_STORE,
  IdempotencyInterceptor,
  InMemoryIdempotencyStore,
} from './idempotency';

@Global()
@Module({
  providers: [
    { provide: CLOCK, useClass: SystemClock },
    { provide: IDEMPOTENCY_STORE, useClass: InMemoryIdempotencyStore },
    IdempotencyInterceptor,
  ],
  exports: [CLOCK, IDEMPOTENCY_STORE, IdempotencyInterceptor],
})
export class CoreModule {}
