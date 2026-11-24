import { MigrationInterface, QueryRunner } from 'typeorm';

/** AR-3: moisture alert episodes (one alert per sustained wet condition). */
export class AlertEpisodes1760500000004 implements MigrationInterface {
  name = 'AlertEpisodes1760500000004';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS alert_episodes (
        "id"             bigserial PRIMARY KEY,
        "deviceId"       varchar NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
        "type"           varchar(16) NOT NULL,
        "state"          varchar(12) NOT NULL,
        "candidateSince" timestamptz NOT NULL,
        "openedAt"       timestamptz NOT NULL,
        "belowSince"     timestamptz NULL,
        "closedAt"       timestamptz NULL,
        "lastSampleAt"   timestamptz NOT NULL,
        "peakValue"      real NULL,
        "alertId"        varchar NULL REFERENCES alerts(id) ON DELETE SET NULL,
        "ruleVersion"    varchar(16) NOT NULL,
        "createdAt"      timestamptz NOT NULL DEFAULT now(),
        "updatedAt"      timestamptz NOT NULL DEFAULT now()
      )`);
    await queryRunner.query(
      `ALTER TABLE alert_episodes DROP CONSTRAINT IF EXISTS chk_alert_episodes_type`,
    );
    await queryRunner.query(
      `ALTER TABLE alert_episodes ADD CONSTRAINT chk_alert_episodes_type CHECK (type IN ('moisture'))`,
    );
    await queryRunner.query(
      `ALTER TABLE alert_episodes DROP CONSTRAINT IF EXISTS chk_alert_episodes_state`,
    );
    await queryRunner.query(
      `ALTER TABLE alert_episodes ADD CONSTRAINT chk_alert_episodes_state CHECK (state IN ('open','clearing','closed'))`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS uq_alert_episodes_active ON alert_episodes ("deviceId", type) WHERE state <> 'closed'`,
    );
    await queryRunner.query(
      `ALTER TABLE alerts ADD COLUMN IF NOT EXISTS "episodeId" bigint NULL`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE alerts DROP COLUMN IF EXISTS "episodeId"`,
    );
    await queryRunner.query(`DROP TABLE IF EXISTS alert_episodes`);
  }
}
