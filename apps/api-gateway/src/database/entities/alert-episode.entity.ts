import {
  Check,
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

/**
 * AR-3: one row per moisture episode (a sustained wet condition). At most one
 * non-closed episode per (device, type), enforced by a partial unique index
 * across processes. Migration 1760500000004.
 */
@Entity({ name: 'alert_episodes' })
@Index('uq_alert_episodes_active', ['deviceId', 'type'], {
  unique: true,
  where: `state <> 'closed'`,
})
@Check('chk_alert_episodes_type', `type IN ('moisture')`)
@Check('chk_alert_episodes_state', `state IN ('open','clearing','closed')`)
export class AlertEpisode {
  @PrimaryGeneratedColumn('increment', { type: 'bigint' })
  id: string;

  @Column({ type: 'varchar' })
  deviceId: string;

  @Column({ type: 'varchar', length: 16 })
  type: 'moisture';

  @Column({ type: 'varchar', length: 12 })
  state: 'open' | 'clearing' | 'closed';

  @Column({ type: 'timestamptz' })
  candidateSince: Date;

  @Column({ type: 'timestamptz' })
  openedAt: Date;

  @Column({ type: 'timestamptz', nullable: true })
  belowSince: Date | null;

  @Column({ type: 'timestamptz', nullable: true })
  closedAt: Date | null;

  @Column({ type: 'timestamptz' })
  lastSampleAt: Date;

  @Column({ type: 'real', nullable: true })
  peakValue: number | null;

  @Column({ type: 'varchar', nullable: true })
  alertId: string | null;

  @Column({ type: 'varchar', length: 16 })
  ruleVersion: string;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt: Date;
}
