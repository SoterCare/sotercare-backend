import { AsyncLocalStorage } from 'node:async_hooks';

export interface TenantCtx {
  tenantId: string;
  actor: string;
  requestId: string;
}

export class NoTenantContext extends Error {
  constructor() {
    super('No TenantContext: tenant-scoped code ran outside TenantContext.run');
    this.name = 'NoTenantContext';
  }
}

const storage = new AsyncLocalStorage<TenantCtx>();

export const TenantContext = {
  run<T>(ctx: TenantCtx, fn: () => T): T {
    return storage.run(ctx, fn);
  },
  get(): TenantCtx {
    const ctx = storage.getStore();
    if (!ctx) throw new NoTenantContext();
    return ctx;
  },
};
