#!/usr/bin/env node
// Qualify the exact local tarball without registry access or native host invocation.
import assert from 'node:assert/strict';
import { execFile as callbackExecFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstat, mkdir, readFile, readdir, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs, promisify } from 'node:util';

const execFile = promisify(callbackExecFile);
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const json = value => `${JSON.stringify(value, null, 2)}\n`;

async function inventory(root, prefix = '') {
  const files = new Map();
  for (const name of (await readdir(path.join(root, prefix))).sort()) {
    const filename = prefix ? `${prefix}/${name}` : name;
    const location = path.join(root, filename);
    const stat = await lstat(location);
    if (stat.isSymbolicLink()) throw new Error(`Unexpected package link: ${filename}`);
    if (stat.isDirectory()) for (const entry of await inventory(root, filename)) files.set(...entry);
    else if (stat.isFile()) files.set(filename, { bytes: await readFile(location), mode: stat.mode & 0o777 });
    else throw new Error(`Unexpected package entry: ${filename}`);
  }
  return files;
}

export function validatePackageFiles(files, metadata) {
  assert.equal(metadata.name, '@neutral/forge');
  assert.notEqual(metadata.private, true);
  assert.equal(metadata.bin.forge, 'application/bin/forge');
  for (const relative of [metadata.bin.forge, ...Object.values(metadata.exports).map(value => value.replace(/^\.\//, '')),
    'README.md', 'CHANGELOG.md', 'CONTRIBUTING.md', 'LICENSE', 'LICENSE.0BSD', 'LICENSE.CC0-1.0',
    'docs/install.md', 'docs/releases.md', 'docs/integration.md', 'spec/SPEC.md', 'spec/OPERATING.md',
    'examples/greeting/README.md', 'application/forge-application.json', 'application/runtime/worker-entry.mjs',
    'application/web/index.html', 'application/web/cockpit.js', 'application/web/cockpit.css', 'application/guides/operate.md']) {
    assert.ok(files.has(relative), `Missing packaged file: ${relative}`);
  }
  assert.equal(files.get(metadata.bin.forge).mode & 0o111, 0o111, 'Packaged launcher must be executable');
  for (const [filename, { bytes }] of files) {
    assert.match(filename, /^(?:application\/|docs\/|spec\/|examples\/greeting\/|distribution\/README\.md$|(?:README\.md|CHANGELOG\.md|CONTRIBUTING\.md|LICENSE(?:\.0BSD|\.CC0-1\.0)?|package\.json)$)/,
      `Unexpected packaged path: ${filename}`);
    assert.doesNotMatch(filename, /(?:^|\/)(?:node_modules|\.git|\.env(?:\..*)?|AGENTS\.md)(?:\/|$)|\.(?:sqlite(?:-wal|-shm)?|log)$/);
    if (!filename.endsWith('.md')) continue;
    const prose = bytes.toString().replace(/^(```|~~~)[^\n]*\n[\s\S]*?^\1[^\n]*$/gm, '');
    for (const match of prose.matchAll(/\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)) {
      const link = match[1].replace(/^<|>$/g, '').split('#')[0];
      if (!link || /^[a-z][a-z0-9+.-]*:/i.test(link)) continue;
      const target = path.posix.normalize(path.posix.join(path.posix.dirname(filename), decodeURIComponent(link)));
      assert.ok(files.has(target), `Missing packaged documentation link: ${filename} -> ${link}`);
    }
  }
  const identity = JSON.parse(files.get('application/forge-application.json').bytes);
  assert.equal(identity.name, 'forge');
  assert.equal(identity.version, metadata.version);
  assert.equal(identity.layoutVersion, 1);
  assert.equal(JSON.parse(files.get('application/package.json').bytes).version, metadata.version);
  for (const line of files.get('application/SHA256SUMS').bytes.toString().trim().split('\n')) {
    const [hash, filename] = line.split('  ');
    assert.equal(digest(files.get(`application/${filename}`)?.bytes ?? ''), hash, `Application checksum mismatch: ${filename}`);
  }
}

const installedProbe = `import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import * as forge from '@neutral/forge';
import { snapshot } from '@neutral/forge/workspace';
import { createDirection, bindWorker, appendProgress, readProgress, readDirection } from '@neutral/forge/direction';
import { startCockpit, workspaceDiff } from '@neutral/forge/cockpit';
assert.equal(forge.version, process.argv[2]);
assert.equal(typeof workspaceDiff, 'function');
assert.equal(typeof forge.steerDirection, 'function');
const workspace = path.resolve('workspace with spaces');
await mkdir(workspace);
await writeFile(path.join(workspace, 'project.txt'), 'Local package check.\\n');
await snapshot({ source: workspace, destination: path.resolve('snapshot with spaces') });
assert.equal(await readFile(path.resolve('snapshot with spaces/project.txt'), 'utf8'), 'Local package check.\\n');
const folder = path.join(workspace, '.forge/directions/package-check');
await createDirection({ folder, workspace, goal: 'Check the installed package.' });
await bindWorker(folder, 'package-check-worker');
await appendProgress(folder, { workerId: 'package-check-worker', body: 'Stored through the installed library.' });
assert.equal((await readProgress(folder))[0].body, 'Stored through the installed library.');
assert.equal((await readDirection(folder)).goal, 'Check the installed package.');
const cockpit = await startCockpit({ workspace, directions: path.dirname(folder), port: 0 });
try {
  for (const [route, filename] of [['/', 'index.html'], ['/cockpit.js', 'cockpit.js'], ['/cockpit.css', 'cockpit.css']]) {
    const response = await fetch(cockpit.address.url + route);
    assert.equal(response.status, 200);
    assert.equal(await response.text(), await readFile(path.join(process.argv[3], 'application/web', filename), 'utf8'));
  }
  const response = await fetch(cockpit.address.url + '/api/directions');
  assert.equal(response.status, 200);
  assert.equal((await response.json()).directions[0].name, 'package-check');
} finally { await cockpit.close(); }
console.log(JSON.stringify({ exports: ['@neutral/forge', '@neutral/forge/workspace', '@neutral/forge/direction', '@neutral/forge/cockpit'],
  version: forge.version, direction: folder, cockpit: 'packaged assets and stored Direction read successfully' }));
`;

export async function verifyPackage({ source, output }) {
  if (!source || !output || !path.isAbsolute(source) || !path.isAbsolute(output)) throw new Error('Select absolute --source and --output directories');
  source = await realpath(source);
  output = path.join(await realpath(path.dirname(output)), path.basename(output));
  const relative = path.relative(source, output);
  if (!relative || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))) throw new Error('Select package qualification output outside the source');
  await mkdir(output);
  const logs = path.join(output, 'logs');
  await mkdir(logs);
  const config = path.join(output, 'empty.npmrc');
  await writeFile(config, '');
  const env = { ...process.env, npm_config_userconfig: config, npm_config_globalconfig: path.join(output, 'global.npmrc'),
    npm_config_cache: path.join(output, 'npm-cache'), npm_config_audit: 'false', npm_config_fund: 'false',
    npm_config_update_notifier: 'false', npm_config_offline: 'true', FORGE_NODE: process.execPath };
  await writeFile(env.npm_config_globalconfig, '');
  let sequence = 0;
  const run = async (name, command, args, options = {}) => {
    const log = `${String(++sequence).padStart(2, '0')}-${name}.json`;
    try {
      const result = await execFile(command, args, { cwd: source, env, timeout: 120000, maxBuffer: 8 * 1024 * 1024, ...options });
      await writeFile(path.join(logs, log), json({ command, args, code: 0, stdout: result.stdout, stderr: result.stderr }));
      return result;
    } catch (error) {
      await writeFile(path.join(logs, log), json({ command, args, code: error.code, stdout: error.stdout, stderr: error.stderr }));
      throw error;
    }
  };
  const metadata = JSON.parse(await readFile(path.join(source, 'package.json')));
  const packed = await run('npm-pack', 'npm', ['pack', '--json', '--offline', '--pack-destination', output]);
  const [packing] = JSON.parse(packed.stdout);
  assert.equal(packing.name, '@neutral/forge');
  assert.equal(packing.version, metadata.version);
  assert.equal(packing.filename, `neutral-forge-${metadata.version}.tgz`);
  await assert.rejects(lstat(path.join(source, 'application')), { code: 'ENOENT' }, 'postpack must restore the source inventory');
  const artifact = path.join(output, packing.filename);
  await run('npm-publish-dry-run', 'npm', ['publish', artifact, '--dry-run', '--offline', '--access', 'public', '--registry', 'https://registry.npmjs.org/'], { cwd: output });
  const consumer = path.join(output, 'consumer with spaces');
  await mkdir(consumer);
  await writeFile(path.join(consumer, 'package.json'), json({ name: 'forge-installed-check', private: true, type: 'module' }));
  await run('npm-install', 'npm', ['install', '--offline', '--ignore-scripts', '--no-audit', '--no-fund', '--package-lock=false', artifact], { cwd: consumer });
  const installed = path.join(consumer, 'node_modules/@neutral/forge');
  const files = await inventory(installed);
  const installedMetadata = JSON.parse(files.get('package.json').bytes);
  validatePackageFiles(files, installedMetadata);
  assert.deepEqual([...files.keys()].sort(), packing.files.map(item => item.path).sort(), 'Installed inventory must match the exact packed tarball');
  await writeFile(path.join(output, 'package-inventory.json'), json([...files].map(([filename, { bytes, mode }]) => ({ path: filename, sha256: digest(bytes), mode }))));
  const executable = path.join(consumer, 'node_modules/.bin/forge');
  const version = await run('local-version', executable, ['--version'], { cwd: consumer });
  assert.equal(version.stdout.trim(), metadata.version);
  assert.match((await run('local-help', executable, ['--help'], { cwd: consumer })).stdout, /forge open --container NAME/);
  await run('npm-exec', 'npm', ['exec', '--offline', '--', 'forge', '--version'], { cwd: consumer });
  const runner = path.join(output, 'npx project with spaces');
  await mkdir(runner);
  assert.equal((await run('npx-tarball', 'npm', ['exec', '--offline', '--yes', '--package', artifact, '--', 'forge', '--version'], { cwd: runner })).stdout.trim(), metadata.version);
  const global = path.join(output, 'global prefix with spaces');
  await run('npm-global-install', 'npm', ['install', '--global', '--prefix', global, '--offline', '--ignore-scripts', '--no-audit', '--no-fund', artifact]);
  assert.equal((await run('global-version', path.join(global, 'bin/forge'), ['--version'], { cwd: consumer })).stdout.trim(), metadata.version);
  await writeFile(path.join(consumer, 'installed-probe.mjs'), installedProbe);
  await run('installed-library-cockpit', process.execPath, ['installed-probe.mjs', metadata.version, installed], { cwd: consumer });
  const folder = path.join(consumer, 'workspace with spaces/.forge/directions/package-check');
  const progress = await run('stored-progress', executable, ['progress', '--direction', folder, '--latest'], { cwd: consumer });
  assert.match(progress.stdout, /Stored through the installed library/);
  await assert.rejects(run('required-container', executable, ['open', '--no-browser'], { cwd: consumer }), error => /requires --container NAME/.test(error.stdout));
  const bytes = await readFile(artifact);
  const report = { schemaVersion: 1, status: 'passed', name: metadata.name, version: metadata.version,
    runtime: { node: process.version, platform: process.platform, architecture: process.arch },
    artifacts: [{ name: packing.filename, sha256: digest(bytes), size: bytes.length }],
    checks: ['offline-pack', 'tarball-publish-dry-run', 'exact-installed-inventory', 'application-checksums', 'packaged-documentation-links',
      'local-command', 'npm-exec', 'npx-tarball', 'global-command-and-paths-with-spaces', 'all-public-exports', 'snapshot',
      'stored-direction-and-progress', 'packaged-cockpit-assets', 'explicit-container-selection', 'postpack-cleanup'].map(name => ({ name, status: 'passed' })),
    files: files.size, logs: 'logs/', inventory: 'package-inventory.json',
    limits: ['Uses the locally packed tarball as the registry substitute; no registry publication was attempted.',
      'Exercises the listed Node runtime and platform only.', 'Does not invoke a Worker, authenticate a native host, or establish container delivery, interruption, continuation, or survival.'] };
  await writeFile(path.join(output, 'report.json'), json(report));
  return { output, ...report };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const { values } = parseArgs({ options: { source: { type: 'string' }, output: { type: 'string' }, help: { type: 'boolean' } } });
    if (values.help) console.log('Usage: node distribution/verify-package.mjs --source /absolute/source --output /absolute/new/qualification\nPack and install offline; retain the exact npm artifact, installation, inventory, logs, and report.json.');
    else console.log(JSON.stringify(await verifyPackage(values)));
  } catch (error) { console.error(error.stack ?? error.message); process.exitCode = 1; }
}
