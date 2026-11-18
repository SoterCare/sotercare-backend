import {
  Check,
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
} from 'typeorm';

/**
 * An explicit, time-bounded ownership relationship between a user and a
 * device (Phase 1, PH0-07). Access to device-keyed history is limited to the
 * caller's own interval; rows are never deleted. At most one open interval
 * (endedAt IS NULL) per device, enforced by a partial unique index.
 * Schema is created by migration 1760500000001 (same names as declared here).
 */
@Entity({ name: 'device_ownerships' })
@Index('ux_device_ownerships_open', ['deviceId'], {
  unique: true,
  where: '"endedAt" IS NULL',
})
@Index('ix_device_ownerships_lookup', ['deviceId', 'userId', 'startedAt'])
@Check(
  'chk_device_ownerships_interval',
  '"endedAt" IS NULL OR "endedAt" >= "startedAt"',
)
export class DeviceOwnership {
  @PrimaryGeneratedColumn('increment', { type: 'bigint' })
  id: string;

  @Column({ type: 'varchar' })
  deviceId: string;

  @Column({ type: 'int' })
  userId: number;

  @Column({ type: 'timestamptz' })
  startedAt: Date;

  @Column({ type: 'timestamptz', nullable: true })
  endedAt: Date | null;

  @Column({ type: 'varchar', length: 32 })
  startReason: string;

  @Column({ type: 'varchar', length: 32, nullable: true })
  endReason: string | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;
}
