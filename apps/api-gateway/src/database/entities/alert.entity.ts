import {
  Column,
  CreateDateColumn,
  Entity,
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
}

@Entity({ name: 'alerts' })
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
