import { Column, Entity, PrimaryColumn } from 'typeorm';

export const TENANT_STATUSES = [
  'provisioning',
  'provisioning_failed',
  'onboarding',
  'active',
  'maintenance',
  'closing',
  'closed',
] as const;
export type TenantStatus = (typeof TENANT_STATUSES)[number];

@Entity({ name: 'tenants' })
export class TenantEntity {
  @PrimaryColumn({ name: 'tenant_id', type: 'text' }) tenantId: string;
  @Column({ type: 'text' }) status: TenantStatus;
  @Column({ name: 'pool_id', type: 'text', nullable: true }) poolId:
    | string
    | null;
  @Column({ name: 'client_ids', type: 'jsonb', default: () => `'[]'` })
  clientIds: string[];
  // Local / dev: the full connection URL. Prod: an endpoint, with credentials
  // read from dbSecretArn (not wired in this task).
  @Column({ name: 'db_endpoint', type: 'text', nullable: true }) dbEndpoint:
    | string
    | null;
  @Column({ name: 'db_secret_arn', type: 'text', nullable: true }) dbSecretArn:
    | string
    | null;
  @Column({ name: 'kms_key_arn', type: 'text', nullable: true }) kmsKeyArn:
    | string
    | null;
  @Column({ name: 's3_prefix', type: 'text', nullable: true }) s3Prefix:
    | string
    | null;
  @Column({ type: 'jsonb', default: () => `'{"state":"ok"}'` })
  service: { state: string; since?: string; suspendsAt?: string };
  @Column({ name: 'schema_version', type: 'int', default: 0 })
  schemaVersion: number;
  @Column({ name: 'migration_status', type: 'text', default: 'pending' })
  migrationStatus: string;
}

@Entity({ name: 'gateway_registry' })
export class GatewayRegistryEntity {
  @PrimaryColumn({ name: 'gateway_id', type: 'text' }) gatewayId: string;
  @Column({ name: 'tenant_id', type: 'text', nullable: true }) tenantId:
    | string
    | null;
  @Column({ name: 'facility_id', type: 'text', nullable: true }) facilityId:
    | string
    | null;
  @Column({ type: 'text', default: 'active' }) role: 'active' | 'standby';
  @Column({ name: 'wrapping_public_key', type: 'text', nullable: true })
  wrappingPublicKey: string | null;
  @Column({ name: 'bound_at', type: 'timestamptz', nullable: true })
  boundAt: Date | null;
  @Column({ name: 'revoked_at', type: 'timestamptz', nullable: true })
  revokedAt: Date | null;
}

@Entity({ name: 'provisioning_jobs' })
export class ProvisioningJobEntity {
  @PrimaryColumn({ name: 'job_id', type: 'text' }) jobId: string;
  @Column({ name: 'tenant_id', type: 'text' }) tenantId: string;
  @Column({ type: 'text', default: 'running' }) status: string;
  @Column({ type: 'jsonb', default: () => `'[]'` })
  steps: { name: string; status: string }[];
}

@Entity({ name: 'signing_keys' })
export class SigningKeyEntity {
  @PrimaryColumn({ type: 'text' }) kid: string;
  @Column({ type: 'text' }) alg: string;
  @Column({ type: 'text' }) purpose: 'local_credential' | 'service_token';
  @Column({ name: 'not_before', type: 'timestamptz' }) notBefore: Date;
  @Column({ name: 'not_after', type: 'timestamptz' }) notAfter: Date;
  @Column({ name: 'private_key_ref', type: 'text' }) privateKeyRef: string;
}

export const CONTROL_ENTITIES = [
  TenantEntity,
  GatewayRegistryEntity,
  ProvisioningJobEntity,
  SigningKeyEntity,
];
