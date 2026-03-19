import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryColumn,
  UpdateDateColumn,
} from 'typeorm';

@Entity({ name: 'iot_devices' })
export class IotDevice {
  @PrimaryColumn()
  deviceId: string;

  @Column()
  deviceKeyHash: string;

  @Column({ type: 'int', nullable: true })
  ownerId: number | null;

  @Column({ default: false })
  isPaired: boolean;

  @Index()
  @Column({ type: 'timestamptz', nullable: true })
  lastSeen: Date | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt: Date;
}
