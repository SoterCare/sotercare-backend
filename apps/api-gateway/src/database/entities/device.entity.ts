import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryColumn,
  UpdateDateColumn,
} from 'typeorm';

export enum DeviceType {
  THIGH_BAND = 'thigh_band',
  WRIST_BAND = 'wrist_band',
  HUB = 'hub',
}

@Entity({ name: 'devices' })
export class Device {
  @PrimaryColumn()
  id: string;

  // userId is the WHERE column in nearly every device/dashboard/timeline lookup.
  @Index()
  @Column()
  userId: number;

  @Column()
  name: string;

  @Column({ type: 'enum', enum: DeviceType })
  type: DeviceType;

  @Column({ type: 'timestamptz' })
  lastSeenAt: Date;

  @Column()
  lastSyncSlot: string;

  @Column({ default: 'mobile_sync' })
  syncSource: string;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt: Date;
}
