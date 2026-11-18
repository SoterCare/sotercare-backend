import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * AR-9: durable gateway safety events. Unlike the design draft there is no FK
 * from "deviceId" to devices: the event is evidence and must be recordable
 * (and kept) even when the dashboard device row is missing or later removed.
 */
export class DeviceEvents1760500000005 implements MigrationInterface {
  name = 'DeviceEvents1760500000005';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS device_events (
        "id"           bigserial PRIMARY KEY,
        "deviceId"     varchar NOT NULL,
        "eventId"      uuid NOT NULL,
        "type"         varchar(8) NOT NULL,
        "nodeMac"      varchar(17) NULL,
        "detectedAt"   timestamptz NOT NULL,
        "receivedAt"   timestamptz NOT NULL DEFAULT now(),
        "gatewaySeq"   bigint NULL,
        "bootId"       varchar(64) NULL,
        "clockSynced"  boolean NULL,
        "clockSuspect" boolean NOT NULL DEFAULT false,
        "attempt"      integer NULL,
        "quarantined"  boolean NOT NULL DEFAULT false,
        "alertId"      varchar NULL REFERENCES alerts(id) ON DELETE SET NULL,
        "payload"      jsonb NOT NULL,
        CONSTRAINT uq_device_events_device_event UNIQUE ("deviceId", "eventId")
      )`);
    await queryRunner.query(
      `ALTER TABLE device_events DROP CONSTRAINT IF EXISTS chk_device_events_type`,
    );
    await queryRunner.query(
      `ALTER TABLE device_events ADD CONSTRAINT chk_device_events_type CHECK (type IN ('fall','sos'))`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS idx_device_events_device_received ON device_events ("deviceId", "receivedAt")`,
    );
    await queryRunner.query(
      `ALTER TABLE alerts ADD COLUMN IF NOT EXISTS "eventId" uuid NULL`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS uq_alerts_event_id ON alerts ("eventId") WHERE "eventId" IS NOT NULL`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS uq_alerts_event_id`);
    await queryRunner.query(
      `ALTER TABLE alerts DROP COLUMN IF EXISTS "eventId"`,
    );
    await queryRunner.query(`DROP TABLE IF EXISTS device_events`);
  }
}
