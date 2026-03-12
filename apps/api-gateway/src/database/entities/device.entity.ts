import {
  Column,
  CreateDateColumn,
  Entity,
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
