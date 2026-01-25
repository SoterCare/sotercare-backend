import { Entity, Column, PrimaryGeneratedColumn, Index, CreateDateColumn } from 'typeorm';

@Entity()
export class VitalSign {
    @PrimaryGeneratedColumn()
    id: number;

    @Index()
    @Column()
    userId: number; // Reference to Auth Service User ID

    @Column('float')
    heartRate: number;

    @Column('float')
    spo2: number;

    @Column('float')
    temperature: number;

    @Column({ type: 'bigint' })
    timestamp: number; // Unix timestamp from device

    @CreateDateColumn()
    syncedAt: Date;
}
