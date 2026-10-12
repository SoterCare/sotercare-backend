import {
  Check,
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  Unique,
  UpdateDateColumn,
} from 'typeorm';

export type NotificationAttemptState =
  | 'queued'
  | 'sending'
  | 'provider_accepted'
  | 'provider_rejected'
  | 'receipt_ok'
  | 'receipt_error'
  | 'receipt_unknown'
  | 'failed'
  | 'cancelled';

/**
 * AR-6: one push attempt per (alert, token, escalation level). States record
 * what the provider said, never that a person saw the alert: there is no
 * "delivered" state. receivedOnDeviceAt/openedAt are client-reported only.
 * Migration 1760500000006.
 */
@Entity({ name: 'notification_attempts' })
@Unique('uq_notification_attempt', [
  'alertId',
  'pushTokenId',
  'escalationLevel',
])
@Index('idx_notification_attempts_due', ['nextAttemptAt'], {
  where: `state = 'queued'`,
})
@Index('idx_notification_attempts_receipts', ['receiptCheckAfter'], {
  where: `state = 'provider_accepted'`,
})
@Index('idx_notification_attempts_alert', ['alertId'])
@Check('chk_notification_attempts_channel', `channel IN ('expo_push')`)
@Check(
  'chk_notification_attempts_state',
  `state IN ('queued','sending','provider_accepted','provider_rejected','receipt_ok','receipt_error','receipt_unknown','failed','cancelled')`,
)
export class NotificationAttempt {
  @PrimaryGeneratedColumn('increment', { type: 'bigint' })
  id: string;

  @Column({ type: 'varchar' })
  alertId: string;

  /** Recipient resolved at creation; re-checked before every send. */
  @Column({ type: 'int' })
  userId: number;

  @Column({ type: 'bigint', nullable: true })
  pushTokenId: string | null;

  @Column({ type: 'varchar', length: 16, default: 'expo_push' })
  channel: 'expo_push';

  @Column({ type: 'smallint', default: 0 })
  escalationLevel: number;

  @Column({ type: 'varchar', length: 24, default: 'queued' })
  state: NotificationAttemptState;

  @Column({ type: 'int', default: 0 })
  attemptCount: number;

  @Column({ type: 'timestamptz', default: () => 'now()' })
  nextAttemptAt: Date;

  @Column({ type: 'varchar', length: 64, nullable: true })
  expoTicketId: string | null;

  @Column({ type: 'timestamptz', nullable: true })
  receiptCheckAfter: Date | null;

  /** Provider error code, or the reason an attempt was cancelled. */
  @Column({ type: 'varchar', length: 64, nullable: true })
  providerError: string | null;

  @Column({ type: 'varchar', length: 500, nullable: true })
  providerMessage: string | null;

  @Column({ type: 'timestamptz', nullable: true })
  acceptedAt: Date | null;

  @Column({ type: 'timestamptz', nullable: true })
  receiptAt: Date | null;

  @Column({ type: 'timestamptz', nullable: true })
  receivedOnDeviceAt: Date | null;

  @Column({ type: 'timestamptz', nullable: true })
  openedAt: Date | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt: Date;
}
