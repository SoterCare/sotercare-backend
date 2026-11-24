import { readdirSync, readFileSync, statSync } from 'fs';
import { join, relative } from 'path';

const ROOT = join(__dirname, '..', '..');
const SCAN = ['apps', 'src', 'libs', 'scripts', 'config', 'test', 'tools'];
const FILES = ['package.json', 'jest.int.config.js', 'jest.setup.js'];
const SELF = join('test', 'core', 'no-legacy-contracts.spec.ts');
// Built from parts so this file does not match itself.
const BANNED = [
  ['contracts', 'v1'].join('/'),
  ['config', 'alert-policy.v1.json'].join('/'),
];

function walk(dir: string, out: string[]) {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === 'dist') continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else out.push(p);
  }
}

describe('legacy contracts copy', () => {
  it('no source file references contracts/v1 or config/alert-policy.v1.json', () => {
    const files: string[] = FILES.map((f) => join(ROOT, f));
    for (const d of SCAN) walk(join(ROOT, d), files);
    const hits = files
      .filter((f) => relative(ROOT, f) !== SELF)
      .filter((f) => {
        const text = readFileSync(f, 'utf8');
        return BANNED.some((b) => text.includes(b));
      })
      .map((f) => relative(ROOT, f));
    expect(hits).toEqual([]);
  });

  it('the default alert policy resolves from @sotercare/contracts', () => {
    expect(() =>
      require.resolve('@sotercare/contracts/policy/default.alert-policy.v1.json'),
    ).not.toThrow();
  });
});
