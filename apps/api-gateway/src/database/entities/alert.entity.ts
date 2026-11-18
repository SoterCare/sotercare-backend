import {
  Check,
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryColumn,
} from 'typeorm';
import { Device } from './device.entity';

export enum AlertType {
  MOVEMENT = 'movement',
  FALL = 'fall',
  URINE = 'urine',
  TEMPERATURE = 'temperature',
  MOISTURE = 'moisture',
  HELP_CALL = 'help_call',
  // Kept for DB compatibility — existing rows use these values.
  // No new alerts of these types are generated; do not remove until
  // a migration has cleared the old rows.
  SPO2 = 'spo2',
  HEART_RATE = 'heart_rate',
}

@Entity({ name: 'alerts' })
// Hot paths filter by deviceId and order by timestamp, and separately filter the
// dismissed/attended flags — composite indexes serve those query shapes.
@Index(['deviceId', 'timestamp'])
@Index(['deviceId', 'isDismissed'])
@Index(['deviceId', 'isAttended', 'timestamp'])
@Check(
  'chk_alerts_dispatch_state',
  `"dispatchState" IN ('pending','dispatched','skipped')`,
)
export class Alert {
  @PrimaryColumn()
  id: string;

  @Column()
  deviceId: string;

  @ManyToOne(() => Device, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'deviceId' })
  device: Device;

  @Column({ type: 'enum', enum: AlertType })
  type: AlertType;

  @Column()
  title: string;

  @Column({ type: 'timestamptz' })
  timestamp: Date;

  @Column({ default: false })
  isDismissed: boolean;

  @Column({ default: false })
  isAttended: boolean;

  @Column({ default: false })
  isFalseAlarm: boolean;

  @Column({ type: 'timestamptz', nullable: true })
  dismissedAt: Date | null;

  @Column()
  syncSlot: string;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;

  // AR-5: the alerts table is the dispatch outbox. Every writer (WS ingest,
  // Safety Guard raw SQL, device events) inserts 'pending'; the dispatcher
  // claims each row exactly once. Migration 1760500000002.
  @Column({ type: 'varchar', length: 12, default: 'pending' })
  dispatchState: 'pending' | 'dispatched' | 'skipped';

  @Column({ type: 'timestamptz', nullable: true })
  dispatchedAt: Date | null;

  @Column({ type: 'varchar', length: 32, nullable: true })
  dispatchNote: string | null;

  // AR-4: the first caregiver decision (migration 1760500000003).
  @Column({ type: 'timestamptz', nullable: true })
  acknowledgedAt: Date | null;

  @Column({ type: 'int', nullable: true })
  acknowledgedByUserId: number | null;

  @Column({ type: 'varchar', length: 16, nullable: true })
  ackAction: 'attended' | 'false_alarm' | null;

  // AR-3: moisture alerts belong to an episode (migration 1760500000004).
  @Column({ type: 'bigint', nullable: true })
  episodeId: string | null;

  // AR-9: the gateway device_event that produced or adopted this alert
  // (migration 1760500000005; partial unique index uq_alerts_event_id).
  @Index('uq_alerts_event_id', { unique: true, where: '"eventId" IS NOT NULL' })
  @Column({ type: 'uuid', nullable: true })
  eventId: string | null;
}
