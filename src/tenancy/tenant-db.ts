import { Injectable } from '@nestjs/common';
import { TenantContext } from '../core/context';
import { TenantDataSource, TenantRegistry } from './tenant-registry';

@Injectable()
export class TenantDb {
  constructor(private readonly registry: TenantRegistry) {}

  // Throws NoTenantContext outside TenantContext.run.
  async get(): Promise<TenantDataSource> {
    const { tenantId } = TenantContext.get();
    return this.registry.forTenant(tenantId);
  }
}
