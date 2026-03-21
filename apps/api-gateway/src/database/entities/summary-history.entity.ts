import {
  Column,
  CreateDateColumn,
  Entity,
  PrimaryGeneratedColumn,
  Index,
} from 'typeorm';

@Entity({ name: 'summary_history' })
export class SummaryHistory {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Index()
  @Column({ type: 'int' })
  userId: number;

  @Column({ type: 'text' })
  summary: string;

  @Column({ type: 'text', nullable: true })
  recommendations: string;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;
}
