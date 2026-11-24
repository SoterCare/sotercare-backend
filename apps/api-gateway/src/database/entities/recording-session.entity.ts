import { Column, Entity, JoinColumn, ManyToOne, PrimaryColumn } from 'typeorm';
import { Device } from './device.entity';

@Entity({ name: 'recording_sessions' })
export class RecordingSession {
  @PrimaryColumn()
  recordingId: string;

  @Column()
  deviceId: string;

  @ManyToOne(() => Device, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'deviceId' })
  device: Device;

  @Column({ type: 'timestamptz' })
  createdAt: Date;

  @Column({ type: 'timestamptz' })
  syncedAt: Date;
}
