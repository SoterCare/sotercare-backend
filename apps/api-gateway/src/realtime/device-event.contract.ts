/**
 * AR-9: `device_event` v1 (legacy wire format), validated by hand so the
 * production bundle does not need ajv.
 */
export interface DeviceEventV1 {
  schema: 'sotercare.device_event.v1';
  event_id: string;
  type: 'fall' | 'sos';
  device_id: string;
  node_mac?: string | null;
  detected_at: number;
  seq: number;
  boot_id?: string;
  clock_synced?: boolean;
  attempt: number;
  source?: 'udp' | 'ble' | null;
  detector?: { name?: string; info?: string };
}

export type DeviceEventAck =
  | {
      accepted: true;
      success: true;
      event_id: string;
      alert_id: string | null;
      duplicate: boolean;
      quarantined: boolean;
      server_received_at: number;
    }
  | {
      accepted: false;
      success: false;
      event_id: string | null;
      retryable: boolean;
      reason:
        | 'invalid_payload'
        | 'device_mismatch'
        | 'not_authenticated'
        | 'event_conflict'
        | 'internal_error'
        | 'disabled';
    };

const KEYS = new Set([
  'schema',
  'event_id',
  'type',
  'device_id',
  'node_mac',
  'detected_at',
  'seq',
  'boot_id',
  'clock_synced',
  'attempt',
  'source',
  'detector',
]);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const MAC = /^([0-9A-F]{2}:){5}[0-9A-F]{2}$/;

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
const isInt = (v: unknown, min: number) =>
  typeof v === 'number' && Number.isInteger(v) && v >= min;
const isStr = (v: unknown, min: number, max: number) =>
  typeof v === 'string' && [...v].length >= min && [...v].length <= max;

export function parseDeviceEvent(body: unknown): DeviceEventV1 | null {
  if (!isObject(body)) return null;
  if (Object.keys(body).some((k) => !KEYS.has(k))) return null;
  const b = body;
  const ok =
    b.schema === 'sotercare.device_event.v1' &&
    typeof b.event_id === 'string' &&
    UUID.test(b.event_id) &&
    (b.type === 'fall' || b.type === 'sos') &&
    isStr(b.device_id, 1, 128) &&
    (b.node_mac === undefined ||
      b.node_mac === null ||
      (typeof b.node_mac === 'string' && MAC.test(b.node_mac))) &&
    isInt(b.detected_at, 0) &&
    isInt(b.seq, 1) &&
    (b.boot_id === undefined || isStr(b.boot_id, 0, 64)) &&
    (b.clock_synced === undefined || typeof b.clock_synced === 'boolean') &&
    isInt(b.attempt, 1) &&
    (b.source === undefined ||
      b.source === null ||
      b.source === 'udp' ||
      b.source === 'ble') &&
    (b.detector === undefined || isDetector(b.detector));
  return ok ? ({ ...b } as unknown as DeviceEventV1) : null;
}

function isDetector(v: unknown) {
  if (!isObject(v)) return false;
  if (Object.keys(v).some((k) => k !== 'name' && k !== 'info')) return false;
  return (
    (v.name === undefined || isStr(v.name, 0, 64)) &&
    (v.info === undefined || isStr(v.info, 0, 200))
  );
}
