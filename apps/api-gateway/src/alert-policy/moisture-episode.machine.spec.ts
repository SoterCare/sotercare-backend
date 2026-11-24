/**
 * AR-3: moisture alert episodes as a pure state machine (no I/O). One
 * sustained wet condition = one episode = one alert; hysteresis, hold times
 * and a reopen cooldown absorb sensor flapping.
 */
import {
  EpisodeState,
  MoisturePolicy,
  initialEpisodeState,
  stepEpisode,
} from './moisture-episode.machine';

const P: MoisturePolicy = {
  openAtOrAbove: 25,
  closeBelow: 15,
  openHoldSeconds: 10,
  closeHoldSeconds: 120,
  reopenCooldownSeconds: 900,
};

/** Feed (secondOffset, value) samples; return the events emitted. */
function run(
  samples: [number, number][],
  state: EpisodeState = initialEpisodeState(),
) {
  const events: string[] = [];
  for (const [s, v] of samples) {
    const r = stepEpisode(state, { ts: s * 1000, value: v }, P);
    state = r.state;
    // Alert-relevant transitions only; 'clearing'/'resumed' are internal states.
    if (r.event && ['opened', 'reopened', 'closed'].includes(r.event.kind)) {
      events.push(`${r.event.kind}@${r.event.at / 1000}`);
    }
  }
  return { events, state };
}

const range = (
  from: number,
  to: number,
  value: number,
  step = 1,
): [number, number][] =>
  Array.from({ length: Math.floor((to - from) / step) + 1 }, (_, i) => [
    from + i * step,
    value,
  ]);

describe('moisture episode machine (AR-3)', () => {
  it('stays quiet below the opening threshold (24.9 %)', () => {
    expect(run(range(0, 60, 24.9)).events).toEqual([]);
  });

  it('opens exactly once after the hold time at the threshold (25 %) and stays open while wet', () => {
    const { events, state } = run(range(0, 3600, 25)); // an hour of continuous wetness
    expect(events).toEqual(['opened@10']);
    expect(state.phase).toBe('open');
  });

  it('does not open on a flapping signal that never stays above the threshold for the hold time', () => {
    const flapping = range(0, 120, 0).map(
      ([s]) => [s, s % 8 < 6 ? 30 : 20] as [number, number],
    );
    expect(run(flapping).events).toEqual([]);
  });

  it('stays open in the hysteresis band (between close and open thresholds)', () => {
    const { events, state } = run([...range(0, 20, 40), ...range(21, 600, 20)]);
    expect(events).toEqual(['opened@10']);
    expect(state.phase).toBe('open');
  });

  it('closes only after the value stays below the close threshold for the close hold', () => {
    const wet = range(0, 20, 40);
    const briefDip = [...range(21, 60, 10), ...range(61, 70, 40)]; // dip shorter than 120 s
    const dry = range(71, 300, 5);
    expect(run([...wet, ...briefDip, ...dry]).events).toEqual([
      'opened@10',
      'closed@191',
    ]);
  });

  it('reopens the same episode without a new alert inside the cooldown, and opens a new episode after it', () => {
    const first = [...range(0, 20, 40), ...range(21, 150, 5)]; // opens @10, closes @141
    const reentryInCooldown = range(200, 230, 40);
    const dryAgain = range(231, 400, 5); // closes again @351
    const reentryAfterCooldown = range(1300, 1320, 40); // > 900 s after 351
    expect(
      run([
        ...first,
        ...reentryInCooldown,
        ...dryAgain,
        ...reentryAfterCooldown,
      ]).events,
    ).toEqual([
      'opened@10',
      'closed@141',
      'reopened@200',
      'closed@351',
      'opened@1310',
    ]);
  });

  it('ignores out-of-order, duplicate and invalid samples', () => {
    const { events } = run([
      [0, 40],
      [5, 40],
      [5, 40],
      [3, 40],
      [7, Number.NaN],
      [8, 140],
      [9, -1],
      [10, 40],
    ]);
    expect(events).toEqual(['opened@10']);
  });
});
