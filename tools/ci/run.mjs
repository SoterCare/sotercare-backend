// Runs the CI steps and prints serenedge step markers. Steps map to npm scripts in package.json.
import { spawnSync } from 'node:child_process';

const quick = process.argv.includes('--quick');
const steps = quick
  ? ['lint:check', 'typecheck']
  : ['lint:check', 'typecheck', 'test', 'test:int', 'build'];

for (const name of steps) {
  console.log(`::serenedge-step name=${name} status=start::`);
  const r = spawnSync('npm', ['run', name], { stdio: 'inherit', shell: true });
  const ok = r.status === 0;
  console.log(`::serenedge-step name=${name} status=${ok ? 'pass' : 'fail'}::`);
  if (!ok) process.exit(r.status ?? 1);
}
