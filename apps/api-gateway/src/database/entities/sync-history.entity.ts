import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
} from 'typeorm';

@Entity({ name: 'sync_history' })
export class SyncHistory {
  @PrimaryGeneratedColumn()
  id: number;

  @Column()
  userId: number;

  @Column()
  source: string;

  @Column()
  slot: string;

  @Column({ type: 'timestamptz' })
  syncedAt: Date;

  @Column()
  gatewayHost: string;

  @CreateDateColumn({ type: 'timestamptz' })
  receivedAt: Date;

  @Column({ type: 'jsonb' })
  upsertSummary: {
    devices: number;
    statuses: number;
    vitals: number;
    alerts: number;
    recordings: number;
  };

  @Index({ unique: true })
  @Column()
  idempotencyKey: string;
}
