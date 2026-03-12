import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { Device } from './device.entity';

@Entity({ name: 'vitals' })
@Index(['deviceId', 'timestamp'], { unique: true })
export class Vital {
  @PrimaryGeneratedColumn()
  id: number;

  @Column()
  deviceId: string;

  @ManyToOne(() => Device, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'deviceId' })
  device: Device;

  @Column({ type: 'timestamptz' })
  timestamp: Date;

  @Column({ type: 'float', nullable: true })
  temperature: number | null;

  @Column({ type: 'float', nullable: true })
  roomTemperature: number | null;

  @Column({ type: 'int', nullable: true })
  moisture: number | null;

  @Column({ type: 'text', nullable: true })
  gaitAnalysis: string | null;

  @Column()
  syncSlot: string;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;
}
