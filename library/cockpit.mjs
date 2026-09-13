import http from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { lstat, mkdir, open, readFile, readdir, realpath } from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDirection, readDirection, readDirectionBinding, readProgress } from './direction.mjs';
import { CodexConnection } from './codex.mjs';
import { steerDirection } from './steer.mjs';
import { version } from './version.mjs';

const execute = promisify(execFile);
const assets = fileURLToPath(new URL('../apps/cockpit/', import.meta.url));
const MAX_BODY = 256 * 1024;
const MAX_FILE = 128 * 1024;
const MAX_OUTPUT = 2 * 1024 * 1024;

function failure(status, message) { return Object.assign(new Error(message), { status }); }
function name(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(value)) throw failure(400, 'Direction name must use 1–80 letters, numbers, dots, dashes or underscores and start with a letter or number');
  return value;
}
function within(root, file) {
  const relative = path.relative(root, file);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

async function boundedFile(filename) {
  const handle = await open(filename, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = await handle.stat();
    if (!info.isFile()) throw failure(400, 'Only regular files can be inspected');
    const buffer = Buffer.alloc(Math.min(info.size, MAX_FILE));
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    const bytes = buffer.subarray(0, bytesRead);
    return { bytes, truncated: info.size > bytesRead };
  } finally { await handle.close(); }
}

async function checklistFiles(folder) {
  if (!(await lstat(folder)).isDirectory()) throw failure(400, 'Choose the real checklist folder');
  const files = [];
  let size = 0;
  async function visit(current, depth = 0) {
    if (depth > 12) { files.push({ path: path.relative(folder, current), skipped: 'depth limit' }); return; }
    for (const item of (await readdir(current, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      if (files.length >= 200 || size >= MAX_OUTPUT) return;
      const filename = path.join(current, item.name);
      const relative = path.relative(folder, filename);
      if (item.isSymbolicLink()) files.push({ path: relative, skipped: 'symbolic link' });
      else if (item.isDirectory()) await visit(filename, depth + 1);
      else if (item.isFile()) {
        const { bytes, truncated } = await boundedFile(filename);
        size += bytes.length;
        files.push({ path: relative, encoding: 'base64', content: bytes.toString('base64'), truncated });
      } else files.push({ path: relative, skipped: 'not a regular file' });
    }
  }
  await visit(folder);
  return { files, truncated: files.length >= 200 || size >= MAX_OUTPUT };
}

async function progressPage(folder, params) {
  const latest = !params.has('after');
  const progress = await readProgress(folder, { after: Number(params.get('after') ?? 0),
    ...(params.has('before') && { before: Number(params.get('before')) }),
    limit: 200, latest, maxBodyChars: 16384 });
  return { progress, progressWindow: { limit: 200, latest } };
}

/** Inspect the selected working tree without external diff drivers, textconv or Git locks. */
export async function workspaceDiff(workspace, { directions, base: reference = 'HEAD' } = {}) {
  if (typeof reference !== 'string' || !reference.trim() || reference.length > 512 || reference.includes('\0')) throw new TypeError('Choose a Git reference of 1–512 characters');
  const filters = [];
  const git = async args => execute('git', ['--no-optional-locks', '-c', 'core.fsmonitor=false', '-c', 'core.quotePath=false', '-c', 'diff.submodule=short', ...filters,
    '-c', `safe.directory=${workspace}`, '-C', workspace, ...args], { timeout: 10000, maxBuffer: MAX_OUTPUT,
    env: { ...process.env, GIT_PAGER: 'cat', GIT_TERMINAL_PROMPT: '0' } });
  try {
    const { stdout: top } = await git(['rev-parse', '--show-toplevel']);
    if (await realpath(top.trim()) !== workspace) return { available: false, error: 'Workspace must be the selected Git root', patch: '', status: '', untracked: [] };
    // Diff and status otherwise run repository-defined clean/process filters.
    // Do not enter submodule working trees, whose filters have separate config.
    try {
      const keys = (await git(['config', '--null', '--name-only', '--get-regexp', '^filter\\..*\\.(clean|smudge|process|required)$'])).stdout.split('\0').filter(Boolean);
      for (const key of keys) filters.push('-c', `${key}=${key.endsWith('.required') ? 'false' : ''}`);
    } catch (error) { if (error.code !== 1) throw error; }
    const exclusions = ['.', ':(exclude).forge'];
    if (directions && within(workspace, directions)) exclusions.push(`:(exclude,literal)${path.relative(workspace, directions)}`);
    let base = [];
    try { base = [(await git(['rev-parse', '--verify', '--end-of-options', `${reference}^{commit}`])).stdout.trim()]; }
    catch (error) {
      if (reference !== 'HEAD') return { available: false, patch: '', status: '', untracked: [], error: `Git reference does not resolve to a commit: ${reference}` };
      // Distinguish an unborn branch from a damaged or otherwise unusable HEAD.
      try {
        const branch = (await git(['symbolic-ref', '-q', 'HEAD'])).stdout.trim();
        let absent = false;
        try { await git(['show-ref', '--verify', '--quiet', branch]); }
        catch (missing) { if (missing.code !== 1) throw missing; absent = true; }
        if (!absent) throw error;
      }
      catch { throw error; }
    }
    const diffArgs = ['diff', '--no-ext-diff', '--no-textconv', '--ignore-submodules=dirty', ...base, '--', ...exclusions];
    let patch = '';
    let truncated = false;
    try { patch = (await git(diffArgs)).stdout; }
    catch (error) {
      if (error.code !== 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') throw error;
      patch = String(error.stdout ?? '').slice(0, MAX_OUTPUT); truncated = true;
    }
    if (!base.length) {
      try { patch += (await git(['diff', '--cached', '--no-ext-diff', '--no-textconv', '--ignore-submodules=dirty', '--', ...exclusions])).stdout; }
      catch (error) { if (error.code !== 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') throw error; patch += String(error.stdout ?? ''); truncated = true; }
    }
    const status = (await git(['status', '--short', '--ignore-submodules=dirty', '--untracked-files=all', '--', ...exclusions])).stdout;
    const untrackedNames = (await git(['ls-files', '--others', '--exclude-standard', '-z', '--', ...exclusions])).stdout.split('\0').filter(Boolean);
    const untracked = [];
    let total = 0;
    for (const relative of untrackedNames.slice(0, 100)) {
      if (total >= MAX_OUTPUT) { truncated = true; break; }
      const filename = path.resolve(workspace, relative);
      if (!within(workspace, filename)) continue;
      try {
        if (!within(workspace, await realpath(filename))) { untracked.push({ path: relative, skipped: 'outside workspace' }); continue; }
        const { bytes, truncated: partial } = await boundedFile(filename);
        total += bytes.length;
        const binary = bytes.includes(0);
        untracked.push({ path: relative, binary, ...(binary ? {} : { content: bytes.toString('utf8') }), truncated: partial });
      } catch (error) { untracked.push({ path: relative, skipped: error.code ?? error.message }); }
    }
    return { available: true, patch: patch.slice(0, MAX_OUTPUT), status, untracked,
      comparison: { reference, commit: base[0] ?? null, kind: reference === 'HEAD' ? 'uncommitted' : 'reference', unborn: base.length === 0 },
      scope: 'Selected Git root; nested submodule working changes and Direction storage are omitted. Repository diff drivers, text conversion and clean filters are disabled.',
      truncated: truncated || patch.length > MAX_OUTPUT || untrackedNames.length > 100, observedAt: new Date().toISOString() };
  } catch (error) {
    return { available: false, patch: '', status: '', untracked: [], error: String(error.stderr || error.message).slice(0, 2000) };
  }
}

async function directSteer(folder, options) {
  const direction = await readDirectionBinding(folder, { includeWorkers: false });
  const connection = await CodexConnection.connect(direction.hostUrl);
  try {
    const { host, ...outcome } = await steerDirection(connection, folder, options);
    return outcome;
  } finally { connection.close(); }
}

/** Container-local information UI; reading never attaches to or dispatches a Worker. */
export async function startCockpit({ workspace, directions, bind = '127.0.0.1', port = 4310, sendSteer = directSteer } = {}) {
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new TypeError('port must be an integer from 0 to 65535');
  workspace = await realpath(path.resolve(workspace ?? process.cwd()));
  if (!(await lstat(workspace)).isDirectory()) throw new TypeError('workspace must be a directory');
  directions = path.resolve(directions ?? path.join(workspace, '.forge/directions'));
  await mkdir(directions, { recursive: true });
  directions = await realpath(directions);
  const token = randomBytes(32).toString('hex');
  const originToken = Buffer.from(token);
  const selected = async value => {
    const folder = path.join(directions, name(value));
    const info = await lstat(folder);
    if (!info.isDirectory() || info.isSymbolicLink()) throw failure(400, 'Choose the real Direction folder');
    return folder;
  };
  const json = (res, status, body) => {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(body));
  };
  const body = async req => {
    const value = Buffer.from(String(req.headers['x-forge-token'] ?? ''));
    if (value.length !== originToken.length || !timingSafeEqual(value, originToken)) throw failure(403, 'Cockpit token is missing or invalid; reload the page');
    if (!/^application\/json(?:;|$)/i.test(req.headers['content-type'] ?? '')) throw failure(415, 'Use application/json');
    let size = 0;
    const parts = [];
    for await (const chunk of req) {
      size += chunk.length;
      if (size > MAX_BODY) throw failure(413, 'Request body exceeds 256 KiB');
      parts.push(chunk);
    }
    let parsed;
    try { parsed = JSON.parse(Buffer.concat(parts).toString('utf8')); } catch { throw failure(400, 'Invalid JSON'); }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw failure(400, 'Expected a JSON object');
    return parsed;
  };
  const server = http.createServer(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    try {
      // Reject cross-origin requests, including DNS rebinding through a foreign Host.
      const hostname = new URL(`http://${req.headers.host}`).hostname;
      if (!['127.0.0.1', 'localhost', '[::1]'].includes(hostname)) throw failure(403, 'Access the cockpit through a localhost port or tunnel');
      if (req.headers.origin && req.headers.origin !== `http://${req.headers.host}`) throw failure(403, 'Cross-origin access is not allowed');
      if (req.headers['sec-fetch-site'] && !['same-origin', 'none'].includes(req.headers['sec-fetch-site'])) throw failure(403, 'Cross-site access is not allowed');
      const url = new URL(req.url, `http://${req.headers.host}`);
      const parts = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);
      if (req.method === 'GET' && url.pathname === '/api/session') return json(res, 200, {
        application: { name: 'forge', version, layoutVersion: 1 }, token, workspace, directions,
      });
      if (req.method === 'GET' && url.pathname === '/api/directions') {
        const entries = (await readdir(directions, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name));
        const records = [], errors = [];
        for (const entry of entries.slice(0, 1000)) {
          if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
          try {
            const folder = await selected(entry.name);
            const direction = await readDirectionBinding(folder, { includeWorkers: false });
            records.push({ name: entry.name, ...direction });
          } catch (error) { errors.push({ name: entry.name, error: error.message }); }
        }
        return json(res, 200, { directions: records, errors, truncated: entries.length > 1000 });
      }
      if (req.method === 'POST' && url.pathname === '/api/directions') {
        const input = await body(req);
        const folder = path.join(directions, name(input.name));
        if (typeof input.goal !== 'string' || !input.goal.trim()) throw failure(400, 'A goal is required');
        const result = await createDirection({ folder, goal: input.goal, workspace, container: process.env.FORGE_CONTAINER ?? null });
        return json(res, 201, { name: input.name, ...result });
      }
      if (parts[0] === 'api' && parts[1] === 'directions' && parts.length >= 3) {
        const folder = await selected(parts[2]);
        if (req.method === 'GET' && parts.length === 3) {
          const view = url.searchParams.get('view') ?? 'overview';
          if (!['overview', 'checklist', 'diff'].includes(view)) throw failure(400, 'Choose overview, checklist or diff');
          const direction = view === 'overview'
            ? await readDirection(folder, { maxGoalBytes: MAX_FILE, includeWorkers: false, tolerateGoalError: true })
            : await readDirectionBinding(folder, { includeWorkers: false });
          let contents = {};
          if (view === 'overview') contents = await progressPage(folder, new URLSearchParams());
          if (view === 'checklist') {
            const checklist = await checklistFiles(path.join(folder, 'checklist'))
              .catch(error => ({ files: [], truncated: false, error: error.message }));
            contents = { checklist: checklist.files, checklistTruncated: checklist.truncated,
              ...(checklist.error && { checklistError: checklist.error }) };
          }
          return json(res, 200, { name: parts[2], ...direction, ...contents });
        }
        if (req.method === 'GET' && parts.length === 4 && parts[3] === 'progress') {
          await readDirectionBinding(folder, { includeWorkers: false });
          return json(res, 200, await progressPage(folder, url.searchParams));
        }
        if (req.method === 'POST' && parts.length === 4 && parts[3] === 'steer') {
          const input = await body(req);
          if (typeof input.text !== 'string' || !input.text.trim()) throw failure(400, 'STEER text is required');
          if (input.fresh !== undefined && typeof input.fresh !== 'boolean') throw failure(400, 'fresh must be boolean');
          const direction = await readDirectionBinding(folder, { includeWorkers: false });
          if (await realpath(direction.workspace) !== workspace) throw failure(409, 'Direction belongs to another workspace');
          const result = await sendSteer(folder, { text: input.text, fresh: input.fresh ?? false,
            ...(input.model !== undefined && { model: input.model }),
            ...(input.sandbox !== undefined && { sandbox: input.sandbox }),
            ...(input.approvalPolicy !== undefined && { approvalPolicy: input.approvalPolicy }) });
          return json(res, 200, result);
        }
      }
      if (req.method === 'GET' && url.pathname === '/api/diff') return json(res, 200, await workspaceDiff(workspace, { directions, base: url.searchParams.get('base') ?? 'HEAD' }));
      const staticFiles = { '/': ['index.html', 'text/html'], '/cockpit.js': ['cockpit.js', 'text/javascript'], '/cockpit.css': ['cockpit.css', 'text/css'] };
      if (req.method === 'GET' && Object.hasOwn(staticFiles, url.pathname)) {
        const [filename, type] = staticFiles[url.pathname];
        const bytes = await readFile(path.join(assets, filename));
        res.writeHead(200, { 'Content-Type': `${type}; charset=utf-8` }); return res.end(bytes);
      }
      throw failure(404, 'Not found');
    } catch (error) {
      const status = error.status ?? (error.code === 'ENOENT' ? 404 : error.code === 'EEXIST' ? 409 : error instanceof TypeError || error instanceof URIError ? 400 : 500);
      if (!res.headersSent) json(res, status, { error: error.message,
        ...(error.workerId && { createdWorker: error.createdWorker ?? false, workerId: error.workerId, direction: error.direction }),
        ...(error.requestId && { requestId: error.requestId }) });
      else res.end();
    }
  });
  server.requestTimeout = 30000;
  server.headersTimeout = 10000;
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, bind, resolve); });
  const address = { host: bind, port: server.address().port, url: `http://127.0.0.1:${server.address().port}` };
  return { server, address, close: async () => { server.closeIdleConnections(); await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())); } };
}
