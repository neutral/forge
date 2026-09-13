import assert from 'node:assert/strict';
import { lstat, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { prepareNpmApplication, cleanNpmApplication } from '../distribution/pack.mjs';
import { verifyPackage } from '../distribution/verify-package.mjs';
import { prepareRelease } from './helpers/public-source.mjs';

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'forge-npm-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = path.join(root, 'source with spaces');
  await prepareRelease(source);
  return { root, source };
}

test('the exact npm artifact supplies the documented installed command, exports, cockpit and documentation', async t => {
  const { root, source } = await fixture(t);
  const result = await verifyPackage({ source, output: path.join(root, 'qualified package') });
  assert.equal(result.name, '@neutral/forge');
  assert.equal(result.status, 'passed');
  assert.equal(result.artifacts[0].name, `neutral-forge-${result.version}.tgz`);
  assert.ok(result.checks.every(check => check.status === 'passed'));
  assert.equal(JSON.parse(await readFile(path.join(result.output, 'report.json'))).artifacts[0].sha256, result.artifacts[0].sha256);
  await assert.rejects(lstat(path.join(source, 'application')), { code: 'ENOENT' });
});

test('npm assembly refuses broken entry points and preserves changed generated files during cleanup', async t => {
  const { source } = await fixture(t);
  const metadataPath = path.join(source, 'package.json');
  const original = await readFile(metadataPath);
  const metadata = JSON.parse(original);
  metadata.exports['.'] = './library/index.mjs';
  await writeFile(metadataPath, JSON.stringify(metadata));
  await assert.rejects(prepareNpmApplication(source), /npm metadata must expose/);
  await writeFile(metadataPath, original);
  await prepareNpmApplication(source);
  const file = path.join(source, 'application/README.md');
  const readme = await readFile(file);
  await writeFile(file, 'Preserve this modified file.');
  await assert.rejects(cleanNpmApplication(source), /Generated application changed/);
  assert.equal(await readFile(file, 'utf8'), 'Preserve this modified file.');
  await writeFile(file, readme);
  await prepareNpmApplication(source);
  assert.equal(await cleanNpmApplication(source), true);
  assert.equal(await cleanNpmApplication(source), false);
});
