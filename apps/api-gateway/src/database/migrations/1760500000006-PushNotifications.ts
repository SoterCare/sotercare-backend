import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * AR-6: push tokens and notification attempts. Deviation from the design
 * draft: push_tokens."userId" has no FK (the user table belongs to
 * auth-service), matching alert_actions.
 */
export class PushNotifications1760500000006 implements MigrationInterface {
  name = 'PushNotifications1760500000006';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS push_tokens (
        "id"             bigserial PRIMARY KEY,
        "userId"         integer NOT NULL,
        "token"          varchar(255) NOT NULL,
        "platform"       varchar(8) NOT NULL,
        "installationId" varchar(64) NOT NULL,
        "appVersion"     varchar(32) NULL,
        "permission"     varchar(16) NULL,
        "createdAt"      timestamptz NOT NULL DEFAULT now(),
        "lastSeenAt"     timestamptz NOT NULL DEFAULT now(),
        "revokedAt"      timestamptz NULL,
        "revokedReason"  varchar(32) NULL,
        CONSTRAINT uq_push_tokens_token UNIQUE (token)
      )`);
    await queryRunner.query(
      `ALTER TABLE push_tokens DROP CONSTRAINT IF EXISTS chk_push_tokens_platform`,
    );
    await queryRunner.query(
      `ALTER TABLE push_tokens ADD CONSTRAINT chk_push_tokens_platform CHECK (platform IN ('ios','android'))`,
    );
    await queryRunner.query(
      `ALTER TABLE push_tokens DROP CONSTRAINT IF EXISTS chk_push_tokens_revoked_reason`,
    );
    await queryRunner.query(
      `ALTER TABLE push_tokens ADD CONSTRAINT chk_push_tokens_revoked_reason CHECK ("revokedReason" IS NULL OR "revokedReason" IN ('logout','DeviceNotRegistered','replaced','reassigned','user_deleted','admin'))`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS idx_push_tokens_user_active ON push_tokens ("userId") WHERE "revokedAt" IS NULL`,
    );
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS notification_attempts (
        "id"                 bigserial PRIMARY KEY,
        "alertId"            varchar NOT NULL REFERENCES alerts(id) ON DELETE CASCADE,
        "userId"             integer NOT NULL,
        "pushTokenId"        bigint NULL REFERENCES push_tokens(id) ON DELETE SET NULL,
        "channel"            varchar(16) NOT NULL DEFAULT 'expo_push',
        "escalationLevel"    smallint NOT NULL DEFAULT 0,
        "state"              varchar(24) NOT NULL DEFAULT 'queued',
        "attemptCount"       integer NOT NULL DEFAULT 0,
        "nextAttemptAt"      timestamptz NOT NULL DEFAULT now(),
        "expoTicketId"       varchar(64) NULL,
        "receiptCheckAfter"  timestamptz NULL,
        "providerError"      varchar(64) NULL,
        "providerMessage"    varchar(500) NULL,
        "acceptedAt"         timestamptz NULL,
        "receiptAt"          timestamptz NULL,
        "receivedOnDeviceAt" timestamptz NULL,
        "openedAt"           timestamptz NULL,
        "createdAt"          timestamptz NOT NULL DEFAULT now(),
        "updatedAt"          timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT uq_notification_attempt UNIQUE ("alertId", "pushTokenId", "escalationLevel")
      )`);
    await queryRunner.query(
      `ALTER TABLE notification_attempts DROP CONSTRAINT IF EXISTS chk_notification_attempts_channel`,
    );
    await queryRunner.query(
      `ALTER TABLE notification_attempts ADD CONSTRAINT chk_notification_attempts_channel CHECK (channel IN ('expo_push'))`,
    );
    await queryRunner.query(
      `ALTER TABLE notification_attempts DROP CONSTRAINT IF EXISTS chk_notification_attempts_state`,
    );
    await queryRunner.query(
      `ALTER TABLE notification_attempts ADD CONSTRAINT chk_notification_attempts_state CHECK (state IN ('queued','sending','provider_accepted','provider_rejected','receipt_ok','receipt_error','receipt_unknown','failed','cancelled'))`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS idx_notification_attempts_due ON notification_attempts ("nextAttemptAt") WHERE state = 'queued'`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS idx_notification_attempts_receipts ON notification_attempts ("receiptCheckAfter") WHERE state = 'provider_accepted'`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS idx_notification_attempts_alert ON notification_attempts ("alertId")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS notification_attempts`);
    await queryRunner.query(`DROP TABLE IF EXISTS push_tokens`);
  }
}
