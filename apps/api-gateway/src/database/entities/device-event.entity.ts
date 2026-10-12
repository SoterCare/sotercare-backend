import {
  Check,
  Column,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  Unique,
} from 'typeorm';

/**
 * AR-9: one row per discrete safety event (fall / SOS) sent by a gateway's
 * durable outbox. (deviceId, eventId) is unique, so gateway retries are
 * idempotent. Quarantined events (no current owner may see them) are recorded
 * with alertId null and never create an alert. Migration 1760500000005.
 */
@Entity({ name: 'device_events' })
@Unique('uq_device_events_device_event', ['deviceId', 'eventId'])
@Index('idx_device_events_device_received', ['deviceId', 'receivedAt'])
@Check('chk_device_events_type', `type IN ('fall','sos')`)
export class DeviceEvent {
  @PrimaryGeneratedColumn('increment', { type: 'bigint' })
  id: string;

  @Column({ type: 'varchar' })
  deviceId: string;

  @Column({ type: 'uuid' })
  eventId: string;

  @Column({ type: 'varchar', length: 8 })
  type: 'fall' | 'sos';

  @Column({ type: 'varchar', length: 17, nullable: true })
  nodeMac: string | null;

  /** Gateway (Pi) wall clock; the firmware supplies no timestamp. */
  @Column({ type: 'timestamptz' })
  detectedAt: Date;

  @Column({ type: 'timestamptz', default: () => 'now()' })
  receivedAt: Date;

  @Column({ type: 'bigint', nullable: true })
  gatewaySeq: string | null;

  @Column({ type: 'varchar', length: 64, nullable: true })
  bootId: string | null;

  @Column({ type: 'boolean', nullable: true })
  clockSynced: boolean | null;

  @Column({ type: 'boolean', default: false })
  clockSuspect: boolean;

  @Column({ type: 'int', nullable: true })
  attempt: number | null;

  @Column({ type: 'boolean', default: false })
  quarantined: boolean;

  @Column({ type: 'varchar', nullable: true })
  alertId: string | null;

  @Column({ type: 'jsonb' })
  payload: Record<string, unknown>;
}
