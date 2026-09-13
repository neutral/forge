#!/usr/bin/env node
// npm lifecycle assembly: the packed command uses the same relocatable application.
import { createHash } from 'node:crypto';
import { chmod, lstat, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { applicationFiles } from './build.mjs';

const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const repository = fileURLToPath(new URL('../', import.meta.url));

async function inventory(root, prefix = '') {
  const result = new Map();
  for (const name of (await readdir(path.join(root, prefix))).sort()) {
    const filename = prefix ? `${prefix}/${name}` : name;
    const location = path.join(root, filename);
    const stat = await lstat(location);
    if (stat.isSymbolicLink()) throw new Error(`Generated application contains a symbolic link: ${filename}`);
    if (stat.isDirectory()) for (const entry of await inventory(root, filename)) result.set(...entry);
    else if (stat.isFile() && stat.nlink === 1) result.set(filename, { bytes: await readFile(location), mode: stat.mode & 0o777 });
    else throw new Error(`Generated application contains an unexpected entry: ${filename}`);
  }
  return result;
}

export async function cleanNpmApplication(source = repository) {
  const target = path.join(source, 'application');
  let stat;
  try { stat = await lstat(target); } catch (error) { if (error.code === 'ENOENT') return false; throw error; }
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Refusing to replace a non-directory application path');
  const files = await inventory(target);
  const marker = files.get('npm-assembly.json');
  let manifest;
  try { manifest = JSON.parse(marker?.bytes); } catch { throw new Error('Refusing to remove application without its npm assembly manifest'); }
  if (manifest.schemaVersion !== 1 || manifest.kind !== 'forge-npm-assembly' || !Array.isArray(manifest.files)
    || manifest.files.length !== files.size - 1 || marker.mode !== 0o644) throw new Error('Invalid npm assembly manifest');
  const seen = new Set();
  for (const item of manifest.files) {
    const entry = files.get(item.path);
    if (seen.has(item.path) || item.path === 'npm-assembly.json' || !entry || digest(entry.bytes) !== item.sha256 || entry.mode !== item.mode) {
      throw new Error(`Generated application changed; preserve or move it before packaging: ${item.path}`);
    }
    seen.add(item.path);
  }
  await rm(target, { recursive: true });
  return true;
}

export async function prepareNpmApplication(source = repository) {
  const { files, version } = await applicationFiles(source);
  const metadata = JSON.parse(await readFile(path.join(source, 'package.json')));
  const expectedExports = { '.': './application/src/index.mjs', './workspace': './application/src/workspace.mjs',
    './direction': './application/src/direction.mjs', './cockpit': './application/src/cockpit.mjs' };
  if (metadata.bin?.forge !== 'application/bin/forge' || JSON.stringify(metadata.exports) !== JSON.stringify(expectedExports)
    || !metadata.files?.includes('application/') || metadata.publishConfig?.access !== 'public') {
    throw new Error('npm metadata must expose the assembled Forge application and public package access');
  }
  const entries = [...files].sort(([a], [b]) => a.localeCompare(b));
  const sums = entries.map(([filename, { bytes }]) => `${digest(bytes)}  ${filename}\n`).join('');
  files.set('SHA256SUMS', { bytes: Buffer.from(sums), mode: 0o644 });
  const manifest = { schemaVersion: 1, kind: 'forge-npm-assembly', version,
    files: [...files].map(([filename, { bytes, mode }]) => ({ path: filename, sha256: digest(bytes), mode })) };
  files.set('npm-assembly.json', { bytes: Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`), mode: 0o644 });
  await cleanNpmApplication(source);
  const target = path.join(source, 'application');
  await mkdir(target);
  for (const [filename, { bytes, mode }] of files) {
    const destination = path.join(target, filename);
    await mkdir(path.dirname(destination), { recursive: true });
    await writeFile(destination, bytes, { flag: 'wx', mode });
    await chmod(destination, mode);
  }
  return { directory: target, version, files: files.size };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const { values } = parseArgs({ options: { clean: { type: 'boolean' }, help: { type: 'boolean' } } });
    if (values.help) console.log('Usage: node distribution/pack.mjs [--clean]\nAssemble application/ for npm packing, or remove an unchanged generated assembly.');
    else if (values.clean) await cleanNpmApplication();
    else await prepareNpmApplication();
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
