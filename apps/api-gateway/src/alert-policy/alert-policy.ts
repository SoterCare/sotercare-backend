import * as fs from 'fs';
import * as path from 'path';
import { MoisturePolicy } from './moisture-episode.machine';

/**
 * Single alert-policy contract shared by the api-gateway and the Python
 * Safety Guard (config/alert-policy.v1.json). Product/clinical values are not
 * approved yet; the file says so and escalation stays off until it is.
 */
export type AlertPolicy = {
  version: string;
  status: 'approved' | 'engineering-default-not-clinically-approved';
  moisture: MoisturePolicy & { unit: string };
  temperature: {
    fever: number;
    low: number;
    misplacementHigh: number;
    invalidSentinels: number[];
    sentinelTolerance: number;
  };
  helpCall: { mergeWindowMs: number };
  severity: Record<string, 'critical' | 'high' | 'normal'>;
  notifications: {
    push: Record<string, boolean>;
    escalation: { types: string[]; scheduleSeconds: number[] };
  };
};

export function loadAlertPolicy(): AlertPolicy {
  const file =
    process.env.ALERT_POLICY_PATH ??
    path.resolve(process.cwd(), 'config/alert-policy.v1.json');
  const policy = JSON.parse(fs.readFileSync(file, 'utf8')) as AlertPolicy;
  const m = policy.moisture;
  if (!(m.closeBelow <= m.openAtOrAbove)) {
    throw new Error('alert policy: moisture.closeBelow must be <= openAtOrAbove');
  }
  for (const key of ['openHoldSeconds', 'closeHoldSeconds', 'reopenCooldownSeconds'] as const) {
    if (!(m[key] >= 0)) throw new Error(`alert policy: moisture.${key} must be >= 0`);
  }
  return policy;
}

/** Escalation requires an approved policy AND an explicit operator flag. */
export const escalationAllowed = (policy: AlertPolicy) =>
  policy.status === 'approved' && process.env.ESCALATION_ENABLED === 'true';
