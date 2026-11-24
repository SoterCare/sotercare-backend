import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * AR-5: alerts table as dispatch outbox. Rows that exist when the migration
 * runs become 'skipped' (history is never notified); new rows default to
 * 'pending'. Additive and idempotent.
 */
export class AlertDispatch1760500000002 implements MigrationInterface {
  name = 'AlertDispatch1760500000002';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE alerts ADD COLUMN IF NOT EXISTS "dispatchState" varchar(12) NOT NULL DEFAULT 'skipped'`,
    );
    await queryRunner.query(
      `ALTER TABLE alerts ALTER COLUMN "dispatchState" SET DEFAULT 'pending'`,
    );
    await queryRunner.query(
      `ALTER TABLE alerts ADD COLUMN IF NOT EXISTS "dispatchedAt" timestamptz NULL`,
    );
    await queryRunner.query(
      `ALTER TABLE alerts ADD COLUMN IF NOT EXISTS "dispatchNote" varchar(32) NULL`,
    );
    await queryRunner.query(
      `ALTER TABLE alerts DROP CONSTRAINT IF EXISTS chk_alerts_dispatch_state`,
    );
    await queryRunner.query(
      `ALTER TABLE alerts ADD CONSTRAINT chk_alerts_dispatch_state CHECK ("dispatchState" IN ('pending','dispatched','skipped'))`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS idx_alerts_dispatch_pending ON alerts ("createdAt") WHERE "dispatchState" = 'pending'`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS idx_alerts_dispatch_pending`);
    await queryRunner.query(
      `ALTER TABLE alerts DROP CONSTRAINT IF EXISTS chk_alerts_dispatch_state`,
    );
    await queryRunner.query(
      `ALTER TABLE alerts DROP COLUMN IF EXISTS "dispatchNote"`,
    );
    await queryRunner.query(
      `ALTER TABLE alerts DROP COLUMN IF EXISTS "dispatchedAt"`,
    );
    await queryRunner.query(
      `ALTER TABLE alerts DROP COLUMN IF EXISTS "dispatchState"`,
    );
  }
}
