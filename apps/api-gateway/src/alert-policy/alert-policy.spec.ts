import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { escalationAllowed, loadAlertPolicy } from './alert-policy';

describe('alert policy (single source of alert rules)', () => {
  const saved = { ...process.env };
  afterEach(() => {
    process.env = { ...saved };
  });

  it('loads the repository policy and exposes the moisture rule', () => {
    const policy = loadAlertPolicy();
    expect(policy.moisture).toMatchObject({ openAtOrAbove: 25, closeBelow: 15 });
    expect(policy.status).toBe('engineering-default-not-clinically-approved');
  });

  it('never allows escalation while the policy is unapproved, even if the flag is set', () => {
    process.env.ESCALATION_ENABLED = 'true';
    expect(escalationAllowed(loadAlertPolicy())).toBe(false);
  });

  it('allows escalation only for an approved policy with the flag on', () => {
    const approved = { ...loadAlertPolicy(), status: 'approved' as const };
    expect(escalationAllowed(approved)).toBe(false);
    process.env.ESCALATION_ENABLED = 'true';
    expect(escalationAllowed(approved)).toBe(true);
  });

  it('rejects an inconsistent moisture rule (close threshold above open threshold)', () => {
    const bad = { ...loadAlertPolicy(), moisture: { ...loadAlertPolicy().moisture, closeBelow: 30 } };
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'policy-')), 'p.json');
    fs.writeFileSync(file, JSON.stringify(bad));
    process.env.ALERT_POLICY_PATH = file;
    expect(() => loadAlertPolicy()).toThrow(/closeBelow/);
  });
});
