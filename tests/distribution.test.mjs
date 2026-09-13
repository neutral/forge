import assert from 'node:assert/strict';
import { execFile as callbackExecFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import { applicationFiles, archive, build, extractRuntime, NODE_ARCHIVES } from '../distribution/build.mjs';
import { prepareRelease } from './helpers/public-source.mjs';

const execFile = promisify(callbackExecFile);
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'forge-distribution-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = path.join(root, 'public source');
  await prepareRelease(source);
  return { root, source };
}

test('application assembly preserves public exports and runtime content without authoring content', async t => {
  const { source } = await fixture(t);
  const { files, identity, version } = await applicationFiles(source);
  assert.equal(identity.name, 'forge');
  assert.equal(identity.version, version);
  assert.equal(identity.layoutVersion, 1);
  assert.equal(identity.runtime.node, '>=24');
  assert.deepEqual(identity.runtime.nativeDependencies, []);
  for (const name of ['bin/forge', 'web/index.html', 'runtime/worker-entry.mjs', 'guides/operate.md', 'LICENSE.0BSD', 'LICENSE.CC0-1.0']) assert.ok(files.has(name));
  assert.equal([...files.keys()].some(name => /^(test|tests|examples|packaging|tools)\//.test(name)), false);
  assert.equal(files.has('runtime/node'), false);
  assert.equal(files.has('README.md'), true);
  assert.match(files.get('README.md').bytes.toString(), /bin\/forge open --container NAME/);
  assert.notEqual(files.get('README.md').bytes.toString(), await readFile(path.join(source, 'README.md'), 'utf8'));
  assert.equal(files.has('guides/verify.md'), false);
  const metadata = JSON.parse(files.get('package.json').bytes);
  assert.equal(metadata.name, '@neutral/forge');
  assert.notEqual(metadata.private, true);
  assert.equal(metadata.scripts, undefined);
  assert.equal(metadata.bin.forge, 'bin/forge');
  assert.deepEqual(Object.keys(metadata.exports), Object.keys(JSON.parse(await readFile(path.join(source, 'package.json'))).exports));
  assert.equal(metadata.exports['.'], './src/index.mjs');
});

test('runtime-free artifacts are reproducible, checksummed, relocatable and launch through a symlink with no Node in PATH', async t => {
  const { root, source } = await fixture(t);
  const first = await build({ source, output: path.join(root, 'first'), applicationOnly: true });
  const second = await build({ source, output: path.join(root, 'second'), applicationOnly: true });
  assert.deepEqual(first.artifacts, second.artifacts);
  const artifact = first.artifacts[0];
  assert.equal(sha256(await readFile(path.join(first.output, artifact.name))), artifact.sha256);
  const relocated = path.join(root, 'relocated app with spaces');
  await mkdir(relocated);
  await execFile('/usr/bin/tar', ['-xzf', path.join(first.output, artifact.name), '-C', relocated]);
  const application = path.join(relocated, first.application.directory);
  const bin = path.join(root, 'forge link');
  await symlink(path.join(application, 'bin/forge'), bin);
  const env = { ...process.env, PATH: '/nonexistent', FORGE_NODE: process.execPath };
  const help = await execFile(bin, ['--help'], { cwd: root, env });
  assert.match(help.stdout, /forge/i);
  const version = await execFile(bin, ['--version'], { cwd: root, env });
  assert.match(version.stdout, new RegExp(first.component.version.replaceAll('.', '\\.')));
  for (const line of (await readFile(path.join(application, 'SHA256SUMS'), 'utf8')).trim().split('\n')) {
    const [hash, filename] = line.split('  ');
    assert.equal(sha256(await readFile(path.join(application, filename))), hash, filename);
  }
  await assert.rejects(execFile(bin, ['--help'], { env: { ...env, FORGE_NODE: '' } }), error => /requires Node 24/.test(error.stderr));
  await assert.rejects(build({ source, output: first.output, applicationOnly: true }), { code: 'EEXIST' });
});

test('application packaging rejects unsafe source entries, unsupported dependencies and output selection', async t => {
  const { root, source } = await fixture(t);
  await assert.rejects(build({ source, output: 'relative', applicationOnly: true }), /absolute/);
  await assert.rejects(build({ source, output: path.join(source, 'output'), applicationOnly: true }), /outside/);
  await assert.rejects(build({ source, output: path.join(root, 'windows'), target: 'win32-x64' }), /Unsupported/);
  await symlink(path.join(source, 'package.json'), path.join(source, 'library/linked.mjs'));
  await assert.rejects(applicationFiles(source), /Symbolic link/);
  await rm(path.join(source, 'library/linked.mjs'));
  const metadata = JSON.parse(await readFile(path.join(source, 'package.json')));
  metadata.dependencies = { native: '1.0.0' };
  await writeFile(path.join(source, 'package.json'), JSON.stringify(metadata));
  await assert.rejects(applicationFiles(source), /target-platform assembly/);
  assert.equal((await readdir(root)).includes('windows'), false);
});

test('archives use deterministic headers and native extraction requires the pinned checksum', () => {
  const files = new Map([['bin/forge', { bytes: Buffer.from('content'), mode: 0o755 }]]);
  assert.deepEqual(archive(files, 'forge-1'), archive(files, 'forge-1'));
  assert.notDeepEqual(archive(files, 'forge-1', 1), archive(files, 'forge-1', 2));
  assert.throws(() => archive(files, 'forge-1', -1), /SOURCE_DATE_EPOCH/);
  for (const target of Object.keys(NODE_ARCHIVES)) assert.throws(() => extractRuntime(Buffer.from('corrupted'), target), /checksum mismatch/);
});


test('assembly provenance binds selected metadata and refuses a different source recipe', async t => {
  const { source } = await fixture(t);
  const { sourceIdentity } = await applicationFiles(source);
  const inputs = new Map(sourceIdentity.files);
  assert.equal(inputs.get('package.json'), sha256(await readFile(path.join(source, 'package.json'))));
  assert.equal(inputs.get('distribution/build.mjs'), sha256(await readFile(new URL('../distribution/build.mjs', import.meta.url))));
  await writeFile(path.join(source, 'distribution/build.mjs'), '// different recipe\n');
  await assert.rejects(applicationFiles(source), /builder belonging to the selected source/);
});
