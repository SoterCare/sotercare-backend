import {
  Check,
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  Unique,
} from 'typeorm';

export type PushTokenRevokedReason =
  | 'logout'
  | 'DeviceNotRegistered'
  | 'replaced'
  | 'reassigned'
  | 'user_deleted'
  | 'admin';

/**
 * AR-6: one Expo push token per app installation. A token belongs to exactly
 * one user at a time (unique token; re-registration by another user
 * reassigns it). Rows are revoked, never deleted. userId has no FK: the user
 * table belongs to auth-service. Migration 1760500000006.
 */
@Entity({ name: 'push_tokens' })
@Unique('uq_push_tokens_token', ['token'])
@Index('idx_push_tokens_user_active', ['userId'], {
  where: '"revokedAt" IS NULL',
})
@Check('chk_push_tokens_platform', `platform IN ('ios','android')`)
@Check(
  'chk_push_tokens_revoked_reason',
  `"revokedReason" IS NULL OR "revokedReason" IN ('logout','DeviceNotRegistered','replaced','reassigned','user_deleted','admin')`,
)
export class PushToken {
  @PrimaryGeneratedColumn('increment', { type: 'bigint' })
  id: string;

  @Column({ type: 'int' })
  userId: number;

  @Column({ type: 'varchar', length: 255 })
  token: string;

  @Column({ type: 'varchar', length: 8 })
  platform: 'ios' | 'android';

  @Column({ type: 'varchar', length: 64 })
  installationId: string;

  @Column({ type: 'varchar', length: 32, nullable: true })
  appVersion: string | null;

  @Column({ type: 'varchar', length: 16, nullable: true })
  permission: string | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;

  @Column({ type: 'timestamptz', default: () => 'now()' })
  lastSeenAt: Date;

  @Column({ type: 'timestamptz', nullable: true })
  revokedAt: Date | null;

  @Column({ type: 'varchar', length: 32, nullable: true })
  revokedReason: PushTokenRevokedReason | null;
}
