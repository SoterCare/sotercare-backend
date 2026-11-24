import {
  Check,
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
} from 'typeorm';

export type AlertActionType =
  | 'attended'
  | 'false_alarm'
  | 'dismissed'
  | 'restored'
  | 'seen'
  | 'opened_from_push'
  | 'escalated'
  | 'ack_rejected_already_acknowledged';

export type AlertActionSource =
  | 'mobile'
  | 'web'
  | 'push'
  | 'system'
  | 'unknown';

/**
 * AR-4: append-only audit of every human or system action on an alert
 * (who, what, server time, previous -> new state, channel). Rows are never
 * updated. Migration 1760500000003. userId has no FK: the user table belongs
 * to auth-service and the audit must survive account deletion.
 */
@Entity({ name: 'alert_actions' })
@Index('idx_alert_actions_alert', ['alertId', 'createdAt'])
@Check(
  'chk_alert_actions_action',
  `action IN ('attended','false_alarm','dismissed','restored','seen','opened_from_push','escalated','ack_rejected_already_acknowledged')`,
)
@Check(
  'chk_alert_actions_source',
  `source IN ('mobile','web','push','system','unknown')`,
)
export class AlertAction {
  @PrimaryGeneratedColumn('increment', { type: 'bigint' })
  id: string;

  @Column({ type: 'varchar' })
  alertId: string;

  @Column({ type: 'int' })
  userId: number;

  @Column({ type: 'varchar', length: 40 })
  action: AlertActionType;

  @Column({ type: 'varchar', length: 16 })
  source: AlertActionSource;

  @Column({ type: 'varchar', length: 24, nullable: true })
  previousState: string | null;

  @Column({ type: 'varchar', length: 24, nullable: true })
  newState: string | null;

  @Column({ type: 'varchar', length: 200, nullable: true })
  reason: string | null;

  @Column({ type: 'bigint', nullable: true })
  notificationAttemptId: string | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;
}
