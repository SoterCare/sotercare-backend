/* eslint-disable @typescript-eslint/no-unsafe-argument */
/**
 * AR-11: the versioned wire contracts in back-end/contracts/v1 are the single
 * source of truth that the gateway, web and mobile repos vendor byte-for-byte.
 * Every schema must parse and compile, every fixture must agree with its
 * schema, and CHECKSUMS.sha256 must match (regenerate with
 * `node scripts/contracts-checksums.cjs`).
 */
import Ajv2020 from 'ajv/dist/2020';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

const ROOT = path.resolve(__dirname, '../../../../contracts/v1');
const read = (p: string) => fs.readFileSync(p, 'utf8');
const schemaFiles = fs
  .readdirSync(ROOT)
  .filter((f) => f.endsWith('.schema.json'));
const fixtures = (kind: 'valid' | 'invalid') =>
  fs
    .readdirSync(path.join(ROOT, 'fixtures', kind))
    .filter((f) => f.endsWith('.json'));

/**
 * Fixture `device_event.fall.json` -> schema `device_event` (longest prefix
 * wins); request schemas also match without `.request`.
 */
function schemaFor(fixture: string) {
  const base = schemaFiles
    .map((f) => f.replace(/\.schema\.json$/, ''))
    .filter((name) =>
      [name, name.replace(/\.request$/, '')].some(
        (prefix) =>
          fixture === `${prefix}.json` || fixture.startsWith(`${prefix}.`),
      ),
    )
    .sort((a, b) => b.length - a.length)[0];
  if (!base) throw new Error(`no schema for fixture ${fixture}`);
  return base;
}

describe('wire contracts v1 (AR-11)', () => {
  it.each(schemaFiles)('%s is valid JSON and compiles', (file) => {
    const ajv = new Ajv2020({ strict: true, allErrors: true });
    expect(() =>
      ajv.compile(JSON.parse(read(path.join(ROOT, file)))),
    ).not.toThrow();
  });

  describe('fixtures', () => {
    let ajv: Ajv2020;
    beforeAll(() => {
      ajv = new Ajv2020({ strict: true, allErrors: true });
      for (const file of schemaFiles) {
        ajv.addSchema(
          JSON.parse(read(path.join(ROOT, file))),
          file.replace(/\.schema\.json$/, ''),
        );
      }
    });

    it.each(fixtures('valid'))('accepts valid/%s', (file) => {
      const validate = ajv.getSchema(schemaFor(file))!;
      const ok = validate(
        JSON.parse(read(path.join(ROOT, 'fixtures', 'valid', file))),
      );
      expect(validate.errors ?? []).toEqual([]);
      expect(ok).toBe(true);
    });

    it.each(fixtures('invalid'))('rejects invalid/%s', (file) => {
      const validate = ajv.getSchema(schemaFor(file))!;
      expect(
        validate(
          JSON.parse(read(path.join(ROOT, 'fixtures', 'invalid', file))),
        ),
      ).toBe(false);
    });
  });

  it('CHECKSUMS.sha256 matches every contract file', () => {
    const listed = read(path.join(ROOT, 'CHECKSUMS.sha256'))
      .trim()
      .split('\n')
      .map((line) => line.split(/\s+/))
      .map(([hash, rel]) => [rel, hash]);
    const actual = listed.map(([rel]) => [
      rel,
      crypto
        .createHash('sha256')
        .update(read(path.join(ROOT, rel)).replace(/\r\n/g, '\n'))
        .digest('hex'),
    ]);
    expect(actual).toEqual(listed);
    const allJson: string[] = [];
    (function walk(dir: string) {
      for (const name of fs.readdirSync(dir)) {
        const p = path.join(dir, name);
        if (fs.statSync(p).isDirectory()) walk(p);
        else if (name.endsWith('.json'))
          allJson.push(path.relative(ROOT, p).split(path.sep).join('/'));
      }
    })(ROOT);
    expect(listed.map(([rel]) => rel).sort()).toEqual(allJson.sort());
  });
});
