import {
  Column,
  CreateDateColumn,
  Entity,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { Device } from './device.entity';

@Entity({ name: 'device_statuses' })
export class DeviceStatus {
  @PrimaryGeneratedColumn()
  id: number;

  @Column()
  deviceId: string;

  @ManyToOne(() => Device, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'deviceId' })
  device: Device;

  @Column({ type: 'int', nullable: true })
  battery: number | null;

  @Column({ type: 'int', nullable: true })
  signalRssi: number | null;

  @Column({ type: 'timestamptz', nullable: true })
  connectedAt: Date | null;

  @Column({ type: 'jsonb', default: () => "'[]'" })
  bands: Array<{ name: string; status: string }>;

  @Column({ type: 'timestamptz' })
  receivedAt: Date;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;
}
