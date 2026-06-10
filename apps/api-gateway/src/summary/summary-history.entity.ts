import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, Index } from 'typeorm';

@Entity({ name: 'summary_history' })
@Index(['userId', 'windowStart'])
export class SummaryHistory {
  @PrimaryGeneratedColumn()
  id: number;

  @Column()
  userId: number;

  @Column({ type: 'text', nullable: true })
  summary: string | null;

  @Column({ type: 'text', nullable: true })
  recommendations: string | null;

  @Column({ default: false })
  hasCritical: boolean;

  @Column({ type: 'timestamptz', nullable: true })
  windowStart: Date | null;

  @Column({ type: 'text', default: 'on_demand' })
  reportType: string;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;
}
