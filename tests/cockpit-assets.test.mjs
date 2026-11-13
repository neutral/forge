import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, realpath, rm } from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { gzipSync } from 'node:zlib';
import { startCockpit } from '../library/cockpit.mjs';

// The built cockpit in apps/cockpit/ is what the server, the npm package and the
// application payload ship. apps/cockpit-source/build.mjs writes it; `npm run check`
// rebuilds it elsewhere and compares.
const built = new URL('../apps/cockpit/', import.meta.url);
const html = await readFile(new URL('index.html', built), 'utf8');
const script = await readFile(new URL('cockpit.js', built));
const css = await readFile(new URL('cockpit.css', built), 'utf8');
const root = html.match(/<div id="root">([\s\S]*)<\/div>\s*<\/body>/)?.[1] ?? '';

// The hydrating script's budget, gzipped: React, React DOM and the React Aria components
// the cockpit uses (handbook/practices/interface.md). Measured at 127 KB.
const scriptBudget = 140 * 1024;

const tags = (markup, name) => [...markup.matchAll(new RegExp(`<${name}\\b[^>]*>`, 'g'))].map(([tag]) => new Map(
  [...tag.matchAll(/([\w:-]+)\s*=\s*"([^"]*)"/g)].map(([, key, value]) => [key, value])));
const text = markup => markup.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();

test('the cockpit ships one page, one module script within its budget and one stylesheet, under the served names', async () => {
  assert.deepEqual((await readdir(built)).sort(), ['cockpit.css', 'cockpit.js', 'index.html']);
  const scripts = tags(html, 'script');
  assert.equal(scripts.length, 1, 'only the hydrating module ships');
  assert.equal(scripts[0].get('type'), 'module');
  assert.equal(scripts[0].get('src'), '/cockpit.js');
  const stylesheets = tags(html, 'link').filter(tag => tag.get('rel') === 'stylesheet');
  assert.deepEqual(stylesheets.map(tag => [tag.get('href'), tag.get('id')]), [['/cockpit.css', 'react-aria-pressable-style']]);
  const gzipped = gzipSync(script).length;
  assert.ok(gzipped <= scriptBudget, `The script is ${gzipped} bytes gzipped, over its ${scriptBudget}-byte budget`);
  assert.match(script.toString('utf8', 0, 300), /THIRD_PARTY\.md/, 'the bundle points to its notices');
});

test('the prerendered first paint satisfies the cockpit Content-Security-Policy and reads before hydration', () => {
  assert.match(html, /<html\b[^>]*\blang="en"/);
  assert.match(html, /<meta name="color-scheme" content="light">/);
  assert.doesNotMatch(html, /<script(?![^>]*\bsrc=)/, 'no inline script');
  assert.doesNotMatch(html, /<style\b|\sstyle=/, 'no inline style');
  assert.doesNotMatch(html, /\son\w+\s*=/i, 'no inline event handlers');
  assert.doesNotMatch(html, /(?:src|href)="(?:https?:)?\/\//, 'nothing loads from elsewhere');
  assert.equal(text(root.match(/<h1\b[^>]*>([\s\S]*?)<\/h1>/)?.[1] ?? ''), 'Forge cockpit');
  for (const words of ['Skip to the Direction', 'Last read', 'not yet · every 5 s', 'Refresh', 'Directions', 'New Direction', 'Loading Directions…', 'Reading Directions…']) {
    assert.ok(text(root).includes(words), `the first paint shows ${words}`);
  }
  assert.ok(tags(root, 'main').some(tag => tag.get('id') === 'main' && tag.get('tabindex') === '-1'));
  const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map(([, id]) => id);
  assert.equal(new Set(ids).size, ids.length, 'HTML ids are unique');
});

test('the stylesheet draws one light sheet in the sheet tokens, shows focus and respects reduced motion', () => {
  assert.match(css, /color-scheme:\s*light/);
  assert.doesNotMatch(css, /prefers-color-scheme/, 'the sheet is drawn on white only');
  assert.doesNotMatch(css, /@import|@font-face|url\(/, 'the cockpit loads no font or image');
  for (const [token, value] of Object.entries({ paper: '#fff', ink: '#15191e', 'blue-9': '#1f3a5a', 'blue-7': '#3d6288', 'blue-5': '#5a7a9b',
    'blue-3': '#b9cadb', 'blue-1': '#edf2f7', 'blue-0': '#f6f8fb', red: '#b0412a', 'red-1': '#f9ece8' })) {
    assert.match(css, new RegExp(`--${token}:\\s*${value}(?:fff)?[;}]`, 'i'), `--${token} is ${value}`);
  }
  assert.match(css, /:focus-visible/);
  assert.match(css, /\[data-focus-visible\]/);
  assert.match(css, /prefers-reduced-motion:\s*reduce/);
  assert.doesNotMatch(css, /:hover/, 'React Aria components are styled by [data-hovered]');
  const sizes = [...css.matchAll(/font-size:\s*([\d.]+)px|font:\s*(?:\d{3}\s+)?([\d.]+)px/g)].map(([, size, shorthand]) => Number(size ?? shorthand));
  assert.ok(sizes.length > 5 && sizes.every(size => size >= 10), `no text under 10px: ${sizes.join(', ')}`);
  assert.deepEqual([...new Set(sizes)].sort((a, b) => a - b), [10.5, 12, 13.5, 15, 19], 'one small type scale');
});

test('THIRD_PARTY.md names each bundled component with its license', async () => {
  const notices = await readFile(new URL('../THIRD_PARTY.md', import.meta.url), 'utf8');
  for (const name of ['react', 'react-dom', 'scheduler', 'react-aria-components', 'react-aria', 'react-stately']) {
    assert.match(notices, new RegExp(`\\| \`${name}\` \\| [\\d.]+ \\| (?:MIT|Apache-2\\.0) \\|`), name);
  }
  assert.match(notices, /Permission is hereby granted, free of charge/);
  assert.match(notices, /Apache License\s+Version 2\.0/);
});

test('the server serves exactly the built page, script and stylesheet', async t => {
  const directory = await realpath(await mkdtemp(path.join(os.tmpdir(), 'forge-cockpit-assets-')));
  const cockpit = await startCockpit({ workspace: directory, port: 0 });
  t.after(async () => { await cockpit.close(); await rm(directory, { recursive: true, force: true }); });
  const get = route => new Promise((resolve, reject) => http.get(`${cockpit.address.url}${route}`, response => {
    const chunks = [];
    response.on('data', chunk => chunks.push(chunk));
    response.on('end', () => resolve({ status: response.statusCode, type: response.headers['content-type'], csp: response.headers['content-security-policy'], body: Buffer.concat(chunks) }));
  }).on('error', reject));
  for (const [route, file, type] of [['/', 'index.html', 'text/html'], ['/?direction=example&view=diff', 'index.html', 'text/html'], ['/cockpit.js', 'cockpit.js', 'text/javascript'], ['/cockpit.css', 'cockpit.css', 'text/css']]) {
    const response = await get(route);
    assert.equal(response.status, 200, route);
    assert.equal(response.type, `${type}; charset=utf-8`);
    assert.ok(response.body.equals(await readFile(new URL(file, built))), route);
    assert.match(response.csp, /script-src 'self'; style-src 'self'/);
  }
});
