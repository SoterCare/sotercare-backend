import {
  Entity,
  Column,
  PrimaryGeneratedColumn,
  Index,
  CreateDateColumn,
} from 'typeorm';

@Entity()
// Hot path getLogsByDateRange/getLogDates filter by userId and range/sort by
// timestamp — a composite index serves the scan + ordering in one shot.
@Index(['userId', 'timestamp'])
export class VitalSign {
  @PrimaryGeneratedColumn()
  id: number;

  @Column()
  userId: number; // Reference to Auth Service User ID

  @Column('float')
  temperature: number;

  @Column('float', { nullable: true })
  ambientTemp: number | null;

  @Column('float', { nullable: true })
  moisture: number | null;

  @Column({ type: 'boolean', nullable: true })
  sos: boolean | null;

  @Column({ type: 'boolean', nullable: true })
  fallAlert: boolean | null;

  @Column({ type: 'text', nullable: true })
  gaitLabel: string | null;

  @Column({ type: 'text', nullable: true })
  thighnodeStatus: string | null;

  @Column({ type: 'int', nullable: true })
  heartRate: number | null;

  @Column({ type: 'int', nullable: true })
  spo2: number | null;

  @Column({ type: 'bigint' })
  timestamp: string; // Storing as string to handle BigInt safely

  @CreateDateColumn()
  syncedAt: Date;
}
