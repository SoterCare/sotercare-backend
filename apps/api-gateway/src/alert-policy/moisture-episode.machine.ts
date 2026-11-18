/**
 * AR-3: pure moisture-episode state machine (no I/O, deterministic).
 *
 *   none ──(value ≥ open)──► candidate ──(held ≥ openHold)──► open ─┐
 *     ▲                         │ (value < open)                  │ (value < close)
 *     └─────────────────────────┘                                 ▼
 *   closed ◄──(below ≥ closeHold)── clearing ──(value ≥ close)──► open
 *     │ (value ≥ open within reopenCooldown) → open again, same episode, no new alert
 *     │ (value ≥ open after the cooldown)    → candidate of a NEW episode
 *
 * Only 'opened' creates an alert. Out-of-order, duplicate and invalid samples
 * are ignored, so replays and interleaved live/replay sockets cannot reopen or
 * close an episode.
 */

export type MoisturePolicy = {
  openAtOrAbove: number;
  closeBelow: number;
  openHoldSeconds: number;
  closeHoldSeconds: number;
  reopenCooldownSeconds: number;
};

export type EpisodePhase = 'none' | 'candidate' | 'open' | 'clearing' | 'closed';

export type EpisodeState = {
  phase: EpisodePhase;
  candidateSince: number | null;
  openedAt: number | null;
  belowSince: number | null;
  closedAt: number | null;
  lastSampleAt: number | null;
  peak: number | null;
};

export type EpisodeEvent =
  | { kind: 'opened'; at: number; candidateSince: number; peak: number }
  | { kind: 'reopened'; at: number }
  | { kind: 'clearing'; at: number }
  | { kind: 'resumed'; at: number }
  | { kind: 'closed'; at: number };

export const initialEpisodeState = (): EpisodeState => ({
  phase: 'none',
  candidateSince: null,
  openedAt: null,
  belowSince: null,
  closedAt: null,
  lastSampleAt: null,
  peak: null,
});

const isValid = (value: number) =>
  Number.isFinite(value) && value >= 0 && value <= 100;

export function stepEpisode(
  state: EpisodeState,
  sample: { ts: number; value: number },
  policy: MoisturePolicy,
): { state: EpisodeState; event?: EpisodeEvent } {
  const { ts, value } = sample;
  if (!isValid(value) || (state.lastSampleAt !== null && ts <= state.lastSampleAt)) {
    return { state };
  }
  const s: EpisodeState = { ...state, lastSampleAt: ts };
  const wet = value >= policy.openAtOrAbove;
  const dry = value < policy.closeBelow;

  switch (s.phase) {
    case 'none':
    case 'closed': {
      if (!wet) return { state: s };
      const inCooldown =
        s.phase === 'closed' &&
        s.closedAt !== null &&
        ts - s.closedAt < policy.reopenCooldownSeconds * 1000;
      if (inCooldown) {
        return {
          state: { ...s, phase: 'open', closedAt: null, belowSince: null, peak: Math.max(s.peak ?? 0, value) },
          event: { kind: 'reopened', at: ts },
        };
      }
      return {
        state: { ...initialEpisodeState(), phase: 'candidate', candidateSince: ts, lastSampleAt: ts, peak: value },
      };
    }
    case 'candidate': {
      if (!wet) {
        return { state: { ...initialEpisodeState(), lastSampleAt: ts } };
      }
      const peak = Math.max(s.peak ?? 0, value);
      if (ts - (s.candidateSince as number) >= policy.openHoldSeconds * 1000) {
        return {
          state: { ...s, phase: 'open', openedAt: ts, peak },
          event: { kind: 'opened', at: ts, candidateSince: s.candidateSince as number, peak },
        };
      }
      return { state: { ...s, peak } };
    }
    case 'open': {
      if (dry) {
        return { state: { ...s, phase: 'clearing', belowSince: ts }, event: { kind: 'clearing', at: ts } };
      }
      return { state: { ...s, peak: Math.max(s.peak ?? 0, value) } };
    }
    case 'clearing': {
      if (!dry) {
        return {
          state: { ...s, phase: 'open', belowSince: null, peak: Math.max(s.peak ?? 0, value) },
          event: { kind: 'resumed', at: ts },
        };
      }
      if (ts - (s.belowSince as number) >= policy.closeHoldSeconds * 1000) {
        return { state: { ...s, phase: 'closed', closedAt: ts, belowSince: null }, event: { kind: 'closed', at: ts } };
      }
      return { state: s };
    }
  }
}
