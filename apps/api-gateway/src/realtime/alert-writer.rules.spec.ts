/* eslint-disable @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-return */
/**
 * AR-3 rules in the per-frame writer: moisture is owned by the episode engine
 * (no per-frame moisture alerts while episodes are enabled), and the
 * firmware's 3-frame SOS latch yields one help_call even when the frames
 * straddle a second boundary, while separate presses stay separate alerts.
 */
import { AlertType } from '../database/entities';
import { AlertWriterService } from './alert-writer.service';

function repo() {
  const inserted: any[] = [];
  const seen = new Set<string>();
  const qb: any = {
    _rows: [] as any[],
    insert: () => qb,
    values: (rows: any[]) => ((qb._rows = rows), qb),
    orIgnore: () => qb,
    returning: () => qb,
    execute: () => {
      const raw = qb._rows.filter((r: any) => !seen.has(r.id));
      raw.forEach((r: any) => seen.add(r.id));
      inserted.push(...raw);
      return Promise.resolve({ raw: raw.map((r: any) => ({ id: r.id })) });
    },
  };
  return { inserted, repo: { create: (r: any) => r, createQueryBuilder: () => qb } as any };
}

const log = (timestamp: number, over: Record<string, unknown> = {}) => ({
  timestamp, sos: false, fall_alert: false, moisture: 0, temperature: 36, ...over,
});

describe('AlertWriterService rules (AR-3)', () => {
  const saved = process.env.MOISTURE_EPISODES_ENABLED;
  afterEach(() => {
    process.env.MOISTURE_EPISODES_ENABLED = saved;
  });

  it('leaves moisture to the episode engine when episodes are enabled', async () => {
    delete process.env.MOISTURE_EPISODES_ENABLED;
    const { inserted, repo: r } = repo();
    const writer = new AlertWriterService();
    await writer.writeAlertsForLogs('d', [log(1000, { moisture: 80 }), log(2000, { moisture: 80 })] as any, 'iot_live', r);
    expect(inserted).toEqual([]);
  });

  it('keeps the legacy per-frame moisture rule only when episodes are explicitly disabled', async () => {
    process.env.MOISTURE_EPISODES_ENABLED = 'false';
    const { inserted, repo: r } = repo();
    await new AlertWriterService().writeAlertsForLogs('d', [log(1000, { moisture: 80 })] as any, 'iot_live', r);
    expect(inserted.map((a) => a.type)).toEqual([AlertType.MOISTURE]);
  });

  it('merges the 3-frame SOS latch across a second boundary into one help_call', async () => {
    const { inserted, repo: r } = repo();
    const writer = new AlertWriterService();
    // Gateway timestamps are whole seconds: frames at 9.98 s, 10.00 s, 10.02 s.
    await writer.writeAlertsForLogs('d', [log(9000, { sos: true })] as any, 'iot_live', r);
    await writer.writeAlertsForLogs('d', [log(10000, { sos: true }), log(10000, { sos: true })] as any, 'iot_live', r);
    expect(inserted.filter((a) => a.type === AlertType.HELP_CALL)).toHaveLength(1);
  });

  it('keeps two distinct presses (beyond the merge window) as two help_calls', async () => {
    const { inserted, repo: r } = repo();
    const writer = new AlertWriterService();
    await writer.writeAlertsForLogs('d', [log(10000, { sos: true })] as any, 'iot_live', r);
    await writer.writeAlertsForLogs('d', [log(14000, { sos: true })] as any, 'iot_live', r);
    expect(inserted.filter((a) => a.type === AlertType.HELP_CALL)).toHaveLength(2);
  });
});
