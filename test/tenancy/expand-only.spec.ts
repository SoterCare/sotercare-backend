import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

describe('tenant migrations are expand-only', () => {
  const dir = join(__dirname, '../../migrations/tenant');
  const files = readdirSync(dir).filter((f) => f.endsWith('.ts'));

  it('has at least the core migration', () => {
    expect(files).toContain('0001-core.ts');
  });

  it.each(files)('%s has no destructive statement', (f) => {
    const sql = readFileSync(join(dir, f), 'utf8');
    expect(sql).not.toMatch(/\bDROP\s+(TABLE|COLUMN|SCHEMA)\b/i);
    expect(sql).not.toMatch(/\bRENAME\b/i);
    expect(sql).not.toMatch(/\bALTER\s+COLUMN\b[^;]*\bTYPE\b/i);
  });
});
