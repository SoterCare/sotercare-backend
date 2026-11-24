import { MigrationInterface, QueryRunner } from 'typeorm';

export class Tenant1763500000001 implements MigrationInterface {
  name = 'Tenant1763500000001';

  async up(q: QueryRunner): Promise<void> {
    await q.query(`CREATE SCHEMA IF NOT EXISTS core`);
    await q.query(`CREATE SCHEMA IF NOT EXISTS telemetry`);
    await q.query(`CREATE SCHEMA IF NOT EXISTS agents`);
    // agents_rw is cluster-wide; create once. It gets nothing on core / telemetry.
    await q.query(`DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'agents_rw') THEN
        CREATE ROLE agents_rw NOLOGIN;
      END IF;
    END $$`);
    await q.query(`REVOKE ALL ON SCHEMA core, telemetry FROM agents_rw`);
    await q.query(`GRANT USAGE, CREATE ON SCHEMA agents TO agents_rw`);

    await q.query(`CREATE TABLE core.idempotency_keys (
      scope_key text PRIMARY KEY, body_hash text NOT NULL,
      response jsonb, expires_at timestamptz NOT NULL
    )`);
    await q.query(`CREATE TABLE core.audit (
      id text PRIMARY KEY, at timestamptz NOT NULL DEFAULT now(),
      actor text NOT NULL, action text NOT NULL, subject text,
      meta jsonb NOT NULL DEFAULT '{}'
    )`);
    await q.query(`CREATE TABLE core.outbox (
      event_id text PRIMARY KEY, type text NOT NULL, payload jsonb NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(), published_at timestamptz
    )`);
    await q.query(
      `CREATE INDEX outbox_unpublished ON core.outbox (created_at) WHERE published_at IS NULL`,
    );
  }

  async down(): Promise<void> {
    // Expand-only: tenant migrations are never reverted (D-56).
  }
}
