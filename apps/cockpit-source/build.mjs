#!/usr/bin/env node
// Build the cockpit into apps/cockpit/ and its notices into THIRD_PARTY.md.
//   node apps/cockpit-source/build.mjs          write the built cockpit
//   node apps/cockpit-source/build.mjs --check  rebuild elsewhere and fail if the committed build differs
// Vite builds the browser script and stylesheet, then the same Root renders the first
// paint into index.html with react-dom/static; the browser hydrates it.
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'vite';
import config, { output } from './vite.config.mjs';

const repository = fileURLToPath(new URL('../../', import.meta.url));
const notices = path.join(repository, 'THIRD_PARTY.md');
const files = ['cockpit.css', 'cockpit.js', 'index.html'];
const marker = '<!--app-->';
const check = process.argv.includes('--check');

/** Record the npm packages whose code enters the browser script. */
function bundledPackages(found) {
  return {
    name: 'forge-bundled-packages',
    generateBundle(_, bundle) {
      for (const chunk of Object.values(bundle)) {
        if (chunk.type !== 'chunk') continue;
        for (const id of chunk.moduleIds ?? Object.keys(chunk.modules ?? {})) {
          const at = id.lastIndexOf('/node_modules/');
          if (at < 0) continue;
          const parts = id.slice(at + '/node_modules/'.length).split('/');
          found.add(parts[0].startsWith('@') ? `${parts[0]}/${parts[1]}` : parts[0]);
        }
      }
    },
  };
}

async function licenseText(directory) {
  const name = (await readdir(directory)).find(file => /^(?:licen[cs]e|copying)(?:\.(?:md|txt))?$/i.test(file));
  if (!name) throw new Error(`No license file in ${directory}; record its notice before bundling it`);
  return (await readFile(path.join(directory, name), 'utf8')).replace(/\r\n/g, '\n').trim();
}

async function noticeFile(found) {
  const packages = [];
  for (const name of [...found].sort()) {
    const directory = path.join(repository, 'node_modules', name);
    const metadata = JSON.parse(await readFile(path.join(directory, 'package.json'), 'utf8'));
    packages.push({ name, version: metadata.version, license: metadata.license, text: await licenseText(directory) });
  }
  const texts = new Map();
  for (const item of packages) texts.set(item.text, [...(texts.get(item.text) ?? []), item]);
  return [
    '# Third-party components',
    '',
    '<!-- apps/cockpit-source/build.mjs writes this file from the packages bundled into the cockpit. -->',
    '',
    'The Forge cockpit\'s browser script, `apps/cockpit/cockpit.js`, installed as',
    '`web/cockpit.js`, bundles these components. Each keeps its license, reproduced',
    'below. Forge\'s [CC0-1.0 or 0BSD license](LICENSE) applies to its original material.',
    '',
    '| Component | Version | License |',
    '| --- | --- | --- |',
    ...packages.map(item => `| \`${item.name}\` | ${item.version} | ${item.license} |`),
    '',
    '## License texts',
    ...[...texts].flatMap(([text, items]) => [
      '',
      `### ${items.map(item => `\`${item.name}\``).join(', ')}`,
      '',
      '```text',
      text,
      '```',
    ]),
    '',
  ].join('\n');
}

async function buildInto(directory) {
  const found = new Set();
  await build({ ...config, configFile: false, plugins: [...config.plugins, bundledPackages(found)],
    build: { ...config.build, outDir: directory } });
  const server = await mkdtemp(path.join(os.tmpdir(), 'forge-cockpit-prerender-'));
  try {
    await build({ ...config, configFile: false, ssr: { noExternal: true },
      build: { ...config.build, ssr: 'src/entry-server.tsx', outDir: server, emptyOutDir: true, rolldownOptions: { output: { entryFileNames: 'entry-server.mjs' } } } });
    const { render } = await import(pathToFileURL(path.join(server, 'entry-server.mjs')).href);
    const page = path.join(directory, 'index.html');
    const html = await readFile(page, 'utf8');
    if (html.split(marker).length !== 2) throw new Error(`index.html needs exactly one ${marker} marker`);
    const app = await render();
    // React Aria adds an inline <style> for touch-action unless an element with its id exists; the
    // cockpit's Content-Security-Policy refuses inline styles, so the stylesheet carries the rule
    // and its link carries the id.
    const links = html.match(/<link rel="stylesheet"[^>]*>/g) ?? [];
    if (links.length !== 1) throw new Error('index.html needs exactly one stylesheet link');
    // The cockpit's Content-Security-Policy admits no inline script or style attribute.
    if (/<script\b|\sstyle=/i.test(app)) throw new Error('The prerendered cockpit must not contain inline scripts or style attributes');
    await writeFile(page, html.replace(links[0], links[0].replace('<link ', '<link id="react-aria-pressable-style" ')).replace(marker, () => app));
  } finally { await rm(server, { recursive: true, force: true }); }
  const built = (await readdir(directory)).sort();
  if (JSON.stringify(built) !== JSON.stringify(files)) throw new Error(`The cockpit build must produce exactly ${files.join(', ')}; found ${built.join(', ')}`);
  return noticeFile(found);
}

if (check) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'forge-cockpit-check-'));
  try {
    const notice = await buildInto(directory);
    const stale = [];
    for (const file of files) {
      const committed = await readFile(path.join(output, file)).catch(() => null);
      if (!committed?.equals(await readFile(path.join(directory, file)))) stale.push(`apps/cockpit/${file}`);
    }
    if (JSON.stringify((await readdir(output)).sort()) !== JSON.stringify(files)) stale.push('apps/cockpit/ (unexpected files)');
    if ((await readFile(notices, 'utf8').catch(() => '')) !== notice) stale.push('THIRD_PARTY.md');
    if (stale.length) {
      console.error(`The built cockpit differs from its source: ${stale.join(', ')}. Run node apps/cockpit-source/build.mjs.`);
      process.exitCode = 1;
    } else console.log('The built cockpit matches its source.');
  } finally { await rm(directory, { recursive: true, force: true }); }
} else {
  await writeFile(notices, await buildInto(output));
  console.log('Built apps/cockpit/ and THIRD_PARTY.md');
}
