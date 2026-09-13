#!/usr/bin/env node
// Assemble a versioned application, then optionally add its pinned native runtime.
import { createHash } from 'node:crypto';
import { chmod, lstat, mkdir, readFile, readdir, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { gunzipSync, gzipSync } from 'node:zlib';

export const NODE_VERSION = '24.18.0';
export const NODE_ARCHIVES = Object.freeze({
  'darwin-arm64': 'e1a97e14c99c803e96c7339403282ea05a499c32f8d83defe9ef5ec66f979ed1',
  'darwin-x64': 'dfd0dbd3e721503434df7b7205e719f61b3a3a31b2bcf9729b8b91fea240f080',
  'linux-arm64': '6b4484c2190274175df9aa8f28e2d758a819cb1c1fe6ab481e2f95b463ab8508',
  'linux-x64': '783130984963db7ba9cbd01089eaf2c2efb055c7c1693c943174b967b3050cb8',
});
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const json = value => `${JSON.stringify(value, null, 2)}\n`;
const ordered = entries => [...entries].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
const launcher = `#!/bin/sh
set -eu
forge_script=$0
while [ -L "$forge_script" ]; do
  forge_directory=$(CDPATH= cd -P -- "$(/usr/bin/dirname -- "$forge_script")" && pwd)
  forge_link=$(/usr/bin/readlink "$forge_script")
  case "$forge_link" in /*) forge_script=$forge_link ;; *) forge_script=$forge_directory/$forge_link ;; esac
done
forge_home=$(CDPATH= cd -P -- "$(/usr/bin/dirname -- "$forge_script")/.." && pwd)
if [ -x "$forge_home/runtime/node" ]; then
  forge_node=$forge_home/runtime/node
else
  forge_node=\${FORGE_NODE:-node}
fi
if ! command -v "$forge_node" >/dev/null 2>&1; then
  echo "Forge requires Node 24 or newer with built-in SQLite. Install a standalone bundle or set FORGE_NODE to a compatible shared runtime." >&2
  exit 1
fi
exec "$forge_node" "$forge_home/runtime/launch.mjs" "$@"
`;
const launch = `// This preflight also covers shared runtimes supplied by a container.
try {
  if (Number(process.versions.node.split('.')[0]) < 24) throw new Error('Node 24 or newer is required');
  const { DatabaseSync } = await import('node:sqlite');
  const database = new DatabaseSync(':memory:');
  database.prepare('SELECT 1').get();
  database.close();
  if (typeof WebSocket !== 'function' || typeof fetch !== 'function') throw new Error('built-in WebSocket and fetch are required');
} catch (error) {
  console.error('Forge runtime is incompatible: ' + error.message);
  process.exit(1);
}
await import('../cli/forge.mjs');
`;

async function sourceFiles(root, prefix) {
  const result = new Map();
  const location = path.join(root, prefix);
  const stat = await lstat(location);
  if (stat.isSymbolicLink()) throw new Error(`Symbolic link selected: ${prefix}`);
  if (stat.isFile()) result.set(prefix, { bytes: await readFile(location), mode: 0o644 });
  else if (stat.isDirectory()) {
    for (const name of (await readdir(location)).sort()) {
      for (const entry of await sourceFiles(root, `${prefix}/${name}`)) result.set(...entry);
    }
  } else throw new Error(`Expected an ordinary source file or directory: ${prefix}`);
  return result;
}

function ordinaryPath(filename) {
  if (typeof filename !== 'string' || !filename || path.isAbsolute(filename)
    || /[\\\u0000-\u001f\u007f]/.test(filename)
    || filename.split('/').some(part => !part || part === '.' || part === '..' || part === '.git')) {
    throw new Error(`Invalid application source path: ${filename}`);
  }
}

async function ordinaryFile(root, filename) {
  ordinaryPath(filename);
  let current = root;
  for (const part of filename.split('/')) {
    current = path.join(current, part);
    if ((await lstat(current)).isSymbolicLink()) throw new Error(`Symbolic link selected: ${filename}`);
  }
  if (!(await lstat(current)).isFile()) throw new Error(`Expected ordinary source file: ${filename}`);
  return readFile(current);
}

function relocateLinks(content, source, destination, mapping, externalLinks) {
  return content.replace(/(\[[^\]]*\]\()([^\s)]+)(\))/g, (whole, before, link, after) => {
    if (/^[a-z][a-z0-9+.-]*:/i.test(link) || link.startsWith('#')) return whole;
    const [relative, anchor] = link.split('#');
    const target = path.posix.normalize(path.posix.join(path.posix.dirname(source), relative));
    let relocated;
    if (mapping.has(target)) {
      relocated = path.posix.relative(path.posix.dirname(destination), mapping.get(target));
    } else if (externalLinks.includes(target)) {
      relocated = `https://github.com/neutral/forge/blob/main/${target}`;
    } else throw new Error(`Unmapped application guide link: ${source} -> ${link}`);
    return `${before}${relocated}${anchor ? `#${anchor}` : ''}${after}`;
  });
}

function add(files, name, content, mode = 0o644) {
  if (files.has(name)) throw new Error(`Duplicate application path: ${name}`);
  files.set(name, { bytes: Buffer.from(content), mode });
}

export async function applicationFiles(source) {
  const metadataBytes = await ordinaryFile(source, 'package.json');
  const metadata = JSON.parse(metadataBytes);
  if (metadata.name !== '@neutral/forge' || metadata.private === true || !/^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(metadata.version)
    || metadata.license !== 'CC0-1.0 OR 0BSD' || metadata.type !== 'module') throw new Error('Expected Forge source package metadata');
  if (Object.keys(metadata.dependencies ?? {}).length || Object.keys(metadata.optionalDependencies ?? {}).length) {
    throw new Error('Application dependencies require explicit target-platform assembly before packaging');
  }
  const layoutBytes = await ordinaryFile(source, 'distribution/application-layout.json');
  const layout = JSON.parse(layoutBytes);
  if (layout.schemaVersion !== 1 || !Array.isArray(layout.files) || !Array.isArray(layout.rewrites)
    || !Array.isArray(layout.externalLinks)) throw new Error('Unsupported application layout manifest');
  const mapping = new Map();
  const destinations = new Set();
  for (const [from, to] of layout.files) {
    ordinaryPath(from); ordinaryPath(to);
    if (mapping.has(from) || destinations.has(to)) throw new Error('Duplicate application layout entry');
    mapping.set(from, to); destinations.add(to);
  }
  for (const rewrite of layout.rewrites) {
    if (!mapping.has(rewrite.file) || !rewrite.from || typeof rewrite.to !== 'string'
      || !Number.isSafeInteger(rewrite.count) || rewrite.count < 1 || !rewrite.reason) {
      throw new Error('Invalid application rewrite');
    }
  }
  // Validate every selected product directory so a new source file cannot silently
  // disappear from the installed application or hide behind a symbolic link.
  for (const prefix of ['library', 'apps/cli', 'apps/cockpit']) {
    for (const name of (await sourceFiles(source, prefix)).keys()) {
      if (!mapping.has(name)) throw new Error(`Unmapped application source: ${name}`);
    }
  }
  const builderBytes = await ordinaryFile(source, 'distribution/build.mjs');
  if (digest(builderBytes) !== digest(await readFile(fileURLToPath(import.meta.url)))) {
    throw new Error('Execute the builder belonging to the selected source tree');
  }
  const inputs = [
    ['package.json', digest(metadataBytes)],
    ['distribution/application-layout.json', digest(layoutBytes)],
    ['distribution/build.mjs', digest(builderBytes)],
  ];
  const files = new Map();
  for (const [from, to] of mapping) {
    let bytes = await ordinaryFile(source, from);
    inputs.push([from, digest(bytes)]);
    let content = bytes.toString('utf8');
    for (const rewrite of layout.rewrites.filter(item => item.file === from)) {
      const count = content.split(rewrite.from).length - 1;
      if (count !== rewrite.count) throw new Error(`Application rewrite drift: ${from} expected ${rewrite.count}, found ${count}`);
      content = content.replaceAll(rewrite.from, rewrite.to);
    }
    if (from.endsWith('.md')) content = relocateLinks(content, from, to, mapping, layout.externalLinks);
    if (from.endsWith('.md') || layout.rewrites.some(item => item.file === from)) bytes = Buffer.from(content);
    add(files, to, bytes);
  }
  const required = ['src/index.mjs', 'src/workspace.mjs', 'src/direction.mjs', 'src/cockpit.mjs', 'cli/forge.mjs',
    'runtime/worker-entry.mjs', 'web/index.html', 'web/cockpit.js', 'web/cockpit.css', 'guides/operate.md'];
  for (const filename of required) if (!files.has(filename)) throw new Error(`Missing application file: ${filename}`);
  for (const filename of files.keys()) {
    if (/(?:^|\/)(?:node_modules|\.git|\.env(?:\..*)?|AGENTS\.md)(?:\/|$)/.test(filename)
      || /\.(?:sqlite(?:-wal|-shm)?|log)$/.test(filename)) throw new Error(`Unexpected application file: ${filename}`);
  }
  files.get('cli/forge.mjs').mode = 0o755;
  add(files, 'bin/forge', launcher, 0o755);
  add(files, 'runtime/launch.mjs', launch);
  add(files, 'package.json', json({ name: metadata.name, version: metadata.version, type: 'module',
    description: metadata.description, license: metadata.license, engines: { node: '>=24' },
    bin: { forge: 'bin/forge' }, exports: { '.': './src/index.mjs', './workspace': './src/workspace.mjs',
      './direction': './src/direction.mjs', './cockpit': './src/cockpit.mjs' } }));
  const identity = { schemaVersion: 1, name: 'forge', version: metadata.version, layoutVersion: 1,
    runtime: { node: '>=24', requiredFeatures: ['node:sqlite/DatabaseSync', 'WebSocket', 'fetch'], nativeDependencies: [] },
    executables: { forge: 'bin/forge' }, library: 'src/index.mjs', workerService: 'runtime/worker-entry.mjs',
    operatingGuide: 'guides/operate.md' };
  add(files, 'forge-application.json', json(identity));
  add(files, 'README.md', `# Forge ${metadata.version}\n\nThis installation contains the Forge application, layout version 1. Forge stores\nDirections, delivers direct STEER, reads authored PROGRESS, and serves a small cockpit.\n\nRun \`bin/forge --help\` or \`bin/forge --version\` from this installation. Select an\nexisting compatible Worker container with \`bin/forge open --container NAME\`.\nWorker commands use that explicitly selected container and its container paths.\nOpening its cockpit does not start a Worker.\n\nRead [installation and replacement](guides/install.md), [operating Forge](guides/operate.md),\nand the [application integration contract](guides/integration.md) for runtime,\nservice, and persistent storage details.\n`);
  for (const [filename, { bytes }] of files) {
    if (!filename.endsWith('.md')) continue;
    for (const match of bytes.toString().matchAll(/\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)) {
      const target = match[1].replace(/^<|>$/g, '').split('#')[0];
      if (!target || /^[a-z][a-z0-9+.-]*:/i.test(target)) continue;
      const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(filename), decodeURIComponent(target)));
      if (!files.has(resolved)) throw new Error(`Application guide link is unavailable: ${filename} -> ${target}`);
    }
  }
  return { files, version: metadata.version, identity, sourceIdentity: { sha256: digest(json(inputs.sort())), files: inputs } };
}

function sums(files) {
  return ordered(files).map(([filename, entry]) => `${digest(entry.bytes)}  ${filename}\n`).join('');
}

async function writeTree(directory, files) {
  await mkdir(directory);
  for (const [filename, { bytes, mode }] of ordered(files)) {
    const destination = path.join(directory, filename);
    await mkdir(path.dirname(destination), { recursive: true });
    await writeFile(destination, bytes, { flag: 'wx', mode });
    await chmod(destination, mode);
  }
}

// USTAR headers with fixed owners and times make archives reproducible across hosts.
export function archive(files, root, epoch = 0) {
  if (!Number.isSafeInteger(epoch) || epoch < 0 || epoch > 0o77777777777) throw new Error('Invalid SOURCE_DATE_EPOCH');
  const blocks = [];
  for (const [filename, { bytes, mode }] of ordered(files)) {
    const name = `${root}/${filename}`;
    const header = Buffer.alloc(512);
    if (Buffer.byteLength(name) > 100) {
      const split = name.lastIndexOf('/');
      const prefix = name.slice(0, split), basename = name.slice(split + 1);
      if (Buffer.byteLength(prefix) > 155 || Buffer.byteLength(basename) > 100) throw new Error(`Archive path is too long: ${name}`);
      header.write(basename, 0, 100); header.write(prefix, 345, 155);
    } else header.write(name, 0, 100);
    const octal = (value, offset, length) => header.write(`${value.toString(8).padStart(length - 1, '0')}\0`, offset, length);
    octal(mode, 100, 8); octal(0, 108, 8); octal(0, 116, 8); octal(bytes.length, 124, 12); octal(epoch, 136, 12);
    header.fill(32, 148, 156); header.write('0', 156); header.write('ustar\0', 257); header.write('00', 263);
    const sum = header.reduce((total, value) => total + value, 0);
    header.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 8);
    blocks.push(header, bytes, Buffer.alloc((512 - bytes.length % 512) % 512));
  }
  blocks.push(Buffer.alloc(1024));
  return gzipSync(Buffer.concat(blocks), { level: 9, mtime: 0 });
}

export function extractRuntime(bytes, target) {
  if (!Object.hasOwn(NODE_ARCHIVES, target)) throw new Error(`Unsupported native target: ${target}`);
  if (digest(bytes) !== NODE_ARCHIVES[target]) throw new Error(`Node archive checksum mismatch for ${target}`);
  const tar = gunzipSync(bytes);
  const prefix = `node-v${NODE_VERSION}-${target}/`;
  const selected = new Map();
  for (let offset = 0; offset + 512 <= tar.length;) {
    const header = tar.subarray(offset, offset + 512);
    const string = (start, length) => header.subarray(start, start + length).toString().replace(/\0.*$/s, '');
    const name = (string(345, 155) ? `${string(345, 155)}/` : '') + string(0, 100);
    if (!name) break;
    const size = parseInt(string(124, 12).trim(), 8);
    if (!Number.isSafeInteger(size) || size < 0 || offset + 512 + size > tar.length) throw new Error('Malformed Node archive');
    if (name === `${prefix}bin/node` || name === `${prefix}LICENSE`) {
      if (!['0', ''].includes(string(156, 1))) throw new Error(`Expected ordinary runtime file: ${name}`);
      selected.set(name.endsWith('/bin/node') ? 'runtime/node' : 'runtime/LICENSE.node',
        { bytes: Buffer.from(tar.subarray(offset + 512, offset + 512 + size)), mode: name.endsWith('/bin/node') ? 0o755 : 0o644 });
    }
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  if (selected.size !== 2) throw new Error('Node archive lacks its executable or license');
  return selected;
}

export async function build({ source, output, target = `${process.platform}-${process.arch}`, applicationOnly = false,
  nodeArchive, epoch = Number(process.env.SOURCE_DATE_EPOCH ?? 0) }) {
  if (!source || !output || !path.isAbsolute(source) || !path.isAbsolute(output)) throw new Error('Select absolute --source and --output directories');
  if (!applicationOnly && !Object.hasOwn(NODE_ARCHIVES, target)) throw new Error(`Unsupported native target: ${target}`);
  const sourceRoot = await realpath(source);
  const outputRoot = path.join(await realpath(path.dirname(output)), path.basename(output));
  const relative = path.relative(sourceRoot, outputRoot);
  if (relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))) {
    throw new Error('Select output outside the source directory');
  }
  const { files, version, identity, sourceIdentity } = await applicationFiles(sourceRoot);
  const applicationName = `forge-${version}-application`;
  const applicationDigest = digest(sums(files));
  add(files, 'SHA256SUMS', sums(files));
  const applicationArchive = archive(files, applicationName, epoch);
  let nativeFiles, nativeArchive, runtime;
  const nativeName = `forge-${version}-${target}`;
  if (!applicationOnly) {
    const archiveName = `node-v${NODE_VERSION}-${target}.tar.gz`;
    const url = `https://nodejs.org/dist/v${NODE_VERSION}/${archiveName}`;
    let bytes;
    if (nodeArchive) bytes = await readFile(nodeArchive);
    else {
      const response = await fetch(url, { signal: AbortSignal.timeout(120000) });
      if (!response.ok) throw new Error(`Node download failed (${response.status}): ${url}`);
      bytes = Buffer.from(await response.arrayBuffer());
    }
    nativeFiles = new Map(files);
    nativeFiles.delete('SHA256SUMS');
    for (const entry of extractRuntime(bytes, target)) nativeFiles.set(...entry);
    runtime = { name: 'node', version: NODE_VERSION, target, archive: archiveName, url,
      archiveSha256: NODE_ARCHIVES[target], executableSha256: digest(nativeFiles.get('runtime/node').bytes),
      license: 'runtime/LICENSE.node' };
    add(nativeFiles, 'forge-distribution.json', json({ schemaVersion: 1, name: 'forge', version, layoutVersion: 1,
      target, application: { name: 'forge', version, sha256: applicationDigest }, runtime }));
    add(nativeFiles, 'SHA256SUMS', sums(nativeFiles));
    nativeArchive = archive(nativeFiles, nativeName, epoch);
  }
  await mkdir(outputRoot);
  await writeTree(path.join(outputRoot, applicationName), files);
  await writeFile(path.join(outputRoot, `${applicationName}.tar.gz`), applicationArchive, { flag: 'wx' });
  const artifacts = [{ name: `${applicationName}.tar.gz`, sha256: digest(applicationArchive), size: applicationArchive.length }];
  if (nativeFiles) {
    await writeTree(path.join(outputRoot, nativeName), nativeFiles);
    await writeFile(path.join(outputRoot, `${nativeName}.tar.gz`), nativeArchive, { flag: 'wx' });
    artifacts.push({ name: `${nativeName}.tar.gz`, sha256: digest(nativeArchive), size: nativeArchive.length });
  }
  const release = { schemaVersion: 1, component: identity, source: sourceIdentity, sourceDateEpoch: epoch,
    application: { directory: applicationName, sha256: applicationDigest }, ...(runtime ? { runtime, target } : {}), artifacts };
  await writeFile(path.join(outputRoot, 'release.json'), json(release), { flag: 'wx' });
  await writeFile(path.join(outputRoot, 'SHA256SUMS'), artifacts.map(item => `${item.sha256}  ${item.name}\n`).join(''), { flag: 'wx' });
  return { output: outputRoot, ...release };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const { values } = parseArgs({ options: { source: { type: 'string' }, output: { type: 'string' }, target: { type: 'string' },
      'application-only': { type: 'boolean' }, 'node-archive': { type: 'string' }, help: { type: 'boolean' } } });
    if (values.help) console.log('Usage: node distribution/build.mjs --source /absolute/source --output /absolute/new-release [--application-only] [--target darwin-arm64|darwin-x64|linux-arm64|linux-x64] [--node-archive /absolute/download.tar.gz]\nCreates a new release directory. Native archives use pinned Node 24.18.0; SOURCE_DATE_EPOCH defaults to 0.');
    else console.log(JSON.stringify(await build({ source: values.source, output: values.output, target: values.target,
      applicationOnly: values['application-only'], nodeArchive: values['node-archive'] })));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
