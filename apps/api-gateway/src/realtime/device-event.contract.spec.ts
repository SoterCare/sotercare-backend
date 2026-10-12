/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-call */
/**
 * AR-9 / AR-11: the runtime validator for `device_event` (no ajv in the
 * production bundle) must accept and reject exactly what the v1 JSON Schema
 * does. Checked against the contract fixtures and a set of mutations.
 */
import Ajv2020 from 'ajv/dist/2020';
import * as fs from 'fs';
import * as path from 'path';
import { parseDeviceEvent } from './device-event.contract';

const ROOT = path.resolve(__dirname, '../../../../contracts/v1');
const json = (rel: string) =>
  JSON.parse(fs.readFileSync(path.join(ROOT, rel), 'utf8'));
const schema = new Ajv2020({ strict: true }).compile(
  json('device_event.schema.json'),
);
const fall = json('fixtures/valid/device_event.fall.json');

const mutations: [string, unknown][] = [
  ['fixture', fall],
  [
    'minimal',
    {
      schema: fall.schema,
      event_id: fall.event_id,
      type: 'sos',
      device_id: 'd',
      detected_at: 0,
      seq: 1,
      attempt: 1,
    },
  ],
  ['not an object', 'fall'],
  ['null', null],
  ['array', [fall]],
  ['unknown property', { ...fall, extra: 1 }],
  ['wrong schema', { ...fall, schema: 'sotercare.device_event.v2' }],
  ['uppercase uuid', { ...fall, event_id: fall.event_id.toUpperCase() }],
  ['type temp', { ...fall, type: 'temperature' }],
  ['empty device', { ...fall, device_id: '' }],
  ['long device', { ...fall, device_id: 'x'.repeat(129) }],
  ['lowercase mac', { ...fall, node_mac: 'aa:bb:cc:dd:ee:ff' }],
  ['valid mac', { ...fall, node_mac: 'AA:BB:CC:DD:EE:FF' }],
  ['fractional detected_at', { ...fall, detected_at: 1.5 }],
  ['negative detected_at', { ...fall, detected_at: -1 }],
  ['string detected_at', { ...fall, detected_at: '1791770400123' }],
  ['seq 0', { ...fall, seq: 0 }],
  ['attempt 0', { ...fall, attempt: 0 }],
  [
    'missing attempt',
    Object.fromEntries(
      Object.entries(fall).filter(([key]) => key !== 'attempt'),
    ),
  ],
  ['long boot_id', { ...fall, boot_id: 'b'.repeat(65) }],
  ['clock_synced string', { ...fall, clock_synced: 'yes' }],
  ['source wifi', { ...fall, source: 'wifi' }],
  ['source null', { ...fall, source: null }],
  ['detector extra key', { ...fall, detector: { name: 'x', extra: 1 } }],
  ['detector long info', { ...fall, detector: { info: 'i'.repeat(201) } }],
  ['detector empty', { ...fall, detector: {} }],
];

describe('device_event runtime validator (AR-9)', () => {
  it.each(mutations)('agrees with the JSON Schema: %s', (_name, payload) => {
    expect(parseDeviceEvent(payload) !== null).toBe(schema(payload));
  });

  it('rejects every invalid device_event fixture', () => {
    const dir = path.join(ROOT, 'fixtures', 'invalid');
    const files = fs
      .readdirSync(dir)
      .filter((f) => f.startsWith('device_event.'));
    expect(files.length).toBeGreaterThan(0);
    for (const f of files)
      expect(parseDeviceEvent(json(`fixtures/invalid/${f}`))).toBeNull();
  });

  it('returns a typed copy of a valid event', () => {
    expect(parseDeviceEvent(fall)).toMatchObject({
      event_id: fall.event_id,
      type: 'fall',
      detected_at: fall.detected_at,
    });
  });
});
