import { MigrationInterface, QueryRunner } from 'typeorm';

export class Control1763500000001 implements MigrationInterface {
  name = 'Control1763500000001';

  async up(q: QueryRunner): Promise<void> {
    await q.query(`CREATE TABLE tenants (
      tenant_id text PRIMARY KEY,
      status text NOT NULL CHECK (status IN ('provisioning','provisioning_failed','onboarding','active','maintenance','closing','closed')),
      pool_id text, client_ids jsonb NOT NULL DEFAULT '[]',
      db_endpoint text, db_secret_arn text, kms_key_arn text, s3_prefix text,
      service jsonb NOT NULL DEFAULT '{"state":"ok"}',
      schema_version int NOT NULL DEFAULT 0,
      migration_status text NOT NULL DEFAULT 'pending'
    )`);
    await q.query(`CREATE TABLE gateway_registry (
      gateway_id text PRIMARY KEY, tenant_id text REFERENCES tenants(tenant_id),
      facility_id text, role text NOT NULL DEFAULT 'active' CHECK (role IN ('active','standby')),
      wrapping_public_key text, bound_at timestamptz, revoked_at timestamptz
    )`);
    await q.query(`CREATE TABLE provisioning_jobs (
      job_id text PRIMARY KEY, tenant_id text NOT NULL,
      status text NOT NULL DEFAULT 'running', steps jsonb NOT NULL DEFAULT '[]'
    )`);
    await q.query(`CREATE TABLE signing_keys (
      kid text PRIMARY KEY, alg text NOT NULL,
      purpose text NOT NULL CHECK (purpose IN ('local_credential','service_token')),
      not_before timestamptz NOT NULL, not_after timestamptz NOT NULL,
      private_key_ref text NOT NULL
    )`);
  }

  async down(): Promise<void> {
    // Expand-only: control migrations are never reverted.
  }
}
