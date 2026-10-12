import { MigrationInterface, QueryRunner } from 'typeorm';

/** AR-4: acknowledgement columns on alerts + append-only alert_actions audit. */
export class AlertAckAudit1760500000003 implements MigrationInterface {
  name = 'AlertAckAudit1760500000003';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE alerts ADD COLUMN IF NOT EXISTS "acknowledgedAt" timestamptz NULL`);
    await queryRunner.query(`ALTER TABLE alerts ADD COLUMN IF NOT EXISTS "acknowledgedByUserId" integer NULL`);
    await queryRunner.query(`ALTER TABLE alerts ADD COLUMN IF NOT EXISTS "ackAction" varchar(16) NULL`);
    await queryRunner.query(`ALTER TABLE alerts DROP CONSTRAINT IF EXISTS chk_alerts_ack_action`);
    await queryRunner.query(
      `ALTER TABLE alerts ADD CONSTRAINT chk_alerts_ack_action CHECK ("ackAction" IS NULL OR "ackAction" IN ('attended','false_alarm'))`,
    );
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS alert_actions (
        "id"                    bigserial PRIMARY KEY,
        "alertId"               varchar NOT NULL REFERENCES alerts(id) ON DELETE CASCADE,
        "userId"                integer NOT NULL,
        "action"                varchar(40) NOT NULL,
        "source"                varchar(16) NOT NULL,
        "previousState"         varchar(24) NULL,
        "newState"              varchar(24) NULL,
        "reason"                varchar(200) NULL,
        "notificationAttemptId" bigint NULL,
        "createdAt"             timestamptz NOT NULL DEFAULT now()
      )`);
    await queryRunner.query(`ALTER TABLE alert_actions DROP CONSTRAINT IF EXISTS chk_alert_actions_action`);
    await queryRunner.query(
      `ALTER TABLE alert_actions ADD CONSTRAINT chk_alert_actions_action CHECK (action IN ('attended','false_alarm','dismissed','restored','seen','opened_from_push','escalated','ack_rejected_already_acknowledged'))`,
    );
    await queryRunner.query(`ALTER TABLE alert_actions DROP CONSTRAINT IF EXISTS chk_alert_actions_source`);
    await queryRunner.query(
      `ALTER TABLE alert_actions ADD CONSTRAINT chk_alert_actions_source CHECK (source IN ('mobile','web','push','system','unknown'))`,
    );
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS idx_alert_actions_alert ON alert_actions ("alertId", "createdAt")`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS alert_actions`);
    await queryRunner.query(`ALTER TABLE alerts DROP CONSTRAINT IF EXISTS chk_alerts_ack_action`);
    await queryRunner.query(`ALTER TABLE alerts DROP COLUMN IF EXISTS "ackAction"`);
    await queryRunner.query(`ALTER TABLE alerts DROP COLUMN IF EXISTS "acknowledgedByUserId"`);
    await queryRunner.query(`ALTER TABLE alerts DROP COLUMN IF EXISTS "acknowledgedAt"`);
  }
}
