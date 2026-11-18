import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * PH0-07: explicit ownership periods. Additive and idempotent so it applies
 * whether or not a dev `synchronize` already created the table.
 *
 * Backfill is FAIL-CLOSED: current owners get an interval starting at
 * migration time, because past transfers cannot be reconstructed from the
 * existing schema. Device-keyed history recorded before the migration is
 * therefore not attributed to anyone (quarantined), not deleted. A data owner
 * may grandfather a device after review — see
 * docs/phase-1/02-Ownership-Period-Authorization.md.
 */
export class DeviceOwnerships1760500000001 implements MigrationInterface {
  name = 'DeviceOwnerships1760500000001';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS device_ownerships (
        "id"          bigserial PRIMARY KEY,
        "deviceId"    varchar NOT NULL,
        "userId"      integer NOT NULL,
        "startedAt"   timestamptz NOT NULL,
        "endedAt"     timestamptz NULL,
        "startReason" varchar(32) NOT NULL,
        "endReason"   varchar(32) NULL,
        "createdAt"   timestamptz NOT NULL DEFAULT now()
      )`);
    await queryRunner.query(
      `ALTER TABLE device_ownerships DROP CONSTRAINT IF EXISTS chk_device_ownerships_interval`,
    );
    await queryRunner.query(
      `ALTER TABLE device_ownerships ADD CONSTRAINT chk_device_ownerships_interval CHECK ("endedAt" IS NULL OR "endedAt" >= "startedAt")`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS ux_device_ownerships_open ON device_ownerships ("deviceId") WHERE "endedAt" IS NULL`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS ix_device_ownerships_lookup ON device_ownerships ("deviceId", "userId", "startedAt")`,
    );
    // Current registry owners (claimed IoT devices).
    await queryRunner.query(`
      INSERT INTO device_ownerships ("deviceId", "userId", "startedAt", "startReason")
      SELECT i."deviceId", i."ownerId", now(), 'backfill_migration'
      FROM iot_devices i
      WHERE i."ownerId" IS NOT NULL AND i."isPaired" = true
        AND NOT EXISTS (SELECT 1 FROM device_ownerships o
                        WHERE o."deviceId" = i."deviceId" AND o."endedAt" IS NULL)`);
    // Dashboard-only devices created by /sync/raspberry-pi (no registry row).
    await queryRunner.query(`
      INSERT INTO device_ownerships ("deviceId", "userId", "startedAt", "startReason")
      SELECT d.id, d."userId", now(), 'backfill_migration'
      FROM devices d
      WHERE d."userId" > 0
        AND NOT EXISTS (SELECT 1 FROM iot_devices i WHERE i."deviceId" = d.id)
        AND NOT EXISTS (SELECT 1 FROM device_ownerships o
                        WHERE o."deviceId" = d.id AND o."endedAt" IS NULL)`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS device_ownerships`);
  }
}
