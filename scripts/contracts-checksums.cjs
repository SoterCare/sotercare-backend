// Regenerates contracts/v1/CHECKSUMS.sha256 (AR-11). Run from back-end/.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const root = path.join(__dirname, '..', 'contracts', 'v1');
const files = [];
(function walk(dir) {
  for (const name of fs.readdirSync(dir).sort()) {
    const p = path.join(dir, name);
    if (fs.statSync(p).isDirectory()) walk(p);
    else if (name.endsWith('.json')) files.push(p);
  }
})(root);
const lines = files.map((p) => {
  const body = fs.readFileSync(p, 'utf8').replace(/\r\n/g, '\n');
  const hash = crypto.createHash('sha256').update(body).digest('hex');
  return `${hash}  ${path.relative(root, p).split(path.sep).join('/')}`;
});
fs.writeFileSync(path.join(root, 'CHECKSUMS.sha256'), lines.join('\n') + '\n');
console.log(`wrote ${lines.length} checksums`);
