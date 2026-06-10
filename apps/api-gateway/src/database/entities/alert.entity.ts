import {
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
  // M7: distinct types so SpO2/HR anomalies are no longer mis-filed as
  // 'temperature'/'movement' and the UI can render them correctly.
  SPO2 = 'spo2',
  HEART_RATE = 'heart_rate',
}

@Entity({ name: 'alerts' })
// Hot paths filter by deviceId and order by timestamp, and separately filter the
// dismissed/attended flags — composite indexes serve those query shapes.
@Index(['deviceId', 'timestamp'])
@Index(['deviceId', 'isDismissed'])
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
}
