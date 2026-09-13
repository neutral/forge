import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { version } from './version.mjs';

const execute = promisify(execFile);
const applicationFile = '/opt/forge/forge-application.json';
const containerLauncher = '/opt/forge/bin/forge';
const pathOptions = new Set(['direction', 'directions', 'workspace', 'folder', 'input-file']);

function validateContainer(container) {
  if (typeof container !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(container)) {
    throw new TypeError('invalid container name');
  }
}

/** Container paths remain literal absolute POSIX paths; the controller never resolves them. */
function validateArguments(args) {
  if (!Array.isArray(args) || !args.every(arg => typeof arg === 'string' && !arg.includes('\0'))) {
    throw new TypeError('container command arguments must be strings without NUL bytes');
  }
  for (let index = 0; index < args.length; index++) {
    const match = /^--([^=]+)(?:=(.*))?$/s.exec(args[index]);
    if (!match || !pathOptions.has(match[1])) continue;
    const value = match[2] ?? args[++index];
    if (match[1] === 'input-file' && value === '-') continue;
    if (!value?.startsWith('/')) throw new TypeError(`--${match[1]} requires an absolute container path with --container`);
  }
}

/** Run the installed Forge payload in one selected container, without a shell. */
export function containerArguments(container, args, containerId = container) {
  validateContainer(container);
  validateContainer(containerId);
  validateArguments(args);
  return ['exec', '-i', '--env', `FORGE_CONTAINER=${container}`, containerId, containerLauncher, ...args];
}

async function runDocker(args) {
  try {
    return await execute('docker', args, { encoding: 'utf8', timeout: 10000, maxBuffer: 1024 * 1024 });
  } catch (error) {
    if (error.code === 'ENOENT') throw new Error('Docker CLI is required to select a container; install Docker and make docker available on PATH');
    throw new Error(`Docker could not inspect the selected container: ${error.stderr?.trim() || error.message}`);
  }
}

function readJSON(text, label) {
  try { return JSON.parse(text); }
  catch { throw new Error(`${label} returned invalid JSON`); }
}

/** Inspect the existing selection and its installed payload without dispatching a Worker. */
export async function inspectContainer(container, { run = runDocker } = {}) {
  validateContainer(container);
  const inspected = readJSON((await run(['inspect', '--type', 'container', '--', container])).stdout, 'Docker container inspection');
  if (!Array.isArray(inspected) || inspected.length !== 1 || !inspected[0]?.Id) throw new Error('Docker did not identify one selected container');
  const selected = inspected[0];
  validateContainer(selected.Id);
  const state = selected.State;
  if (!state?.Running || state.Paused || state.Restarting || state.Dead) {
    throw new Error(`Container ${container} is unavailable (${state?.Paused ? 'paused' : state?.Status ?? 'unknown state'}); start or resume it explicitly`);
  }
  let application;
  try {
    application = readJSON((await run(['exec', selected.Id, 'cat', applicationFile])).stdout, 'Forge application metadata');
  } catch (error) {
    throw new Error(`Container ${container} has no readable compatible Forge installation at /opt/forge: ${error.message}`);
  }
  if (application?.schemaVersion !== 1 || application.name !== 'forge' || application.layoutVersion !== 1 || application.version !== version) {
    throw new Error(`Container ${container} has an incompatible Forge application; expected Forge ${version}, metadata schema 1 and layout 1`);
  }
  return { container, id: selected.Id, application, inspection: selected };
}

export async function inContainer(container, args, { run = runDocker } = {}) {
  // Validate before invoking Docker so an accidental host-relative path cannot reach it.
  containerArguments(container, args);
  const selected = await inspectContainer(container, { run });
  const argv = containerArguments(container, args, selected.id);
  return new Promise((resolve, reject) => {
    const child = spawn('docker', argv, { stdio: 'inherit' });
    const handlers = new Map(['SIGINT', 'SIGTERM'].map(signal => [signal, () => child.kill(signal)]));
    for (const [signal, handler] of handlers) process.on(signal, handler);
    const cleanup = () => { for (const [signal, handler] of handlers) process.off(signal, handler); };
    child.on('error', error => { cleanup(); reject(error); });
    child.on('exit', code => { cleanup(); resolve(code ?? 1); });
  });
}

async function requireLocalDocker(run, env) {
  let endpoint;
  if (env.DOCKER_HOST && !env.DOCKER_CONTEXT) endpoint = env.DOCKER_HOST;
  else {
    const args = ['context', 'inspect', ...(env.DOCKER_CONTEXT ? [env.DOCKER_CONTEXT] : [])];
    const contexts = readJSON((await run(args)).stdout, 'Docker context inspection');
    endpoint = contexts?.[0]?.Endpoints?.docker?.Host;
  }
  if (typeof endpoint !== 'string' || !/^(unix|npipe):\/\//.test(endpoint)) {
    throw new Error('forge open requires a local Docker endpoint; the selected Docker context is remote or unsupported. Open its published cockpit on that Docker host explicitly');
  }
}

function cockpitURL(inspection) {
  const setting = inspection.Config?.Env?.findLast(value => value.startsWith('FORGE_PORT='));
  const port = setting === undefined ? 4310 : Number(setting.slice('FORGE_PORT='.length));
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Selected container has an invalid FORGE_PORT');
  const mappings = inspection.NetworkSettings?.Ports?.[`${port}/tcp`];
  if (!Array.isArray(mappings) || !mappings.length) throw new Error(`Selected container does not publish cockpit port ${port}/tcp`);
  const candidates = mappings.map(mapping => {
    const port = Number(mapping.HostPort);
    if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
    if (/^127\.\d+\.\d+\.\d+$/.test(mapping.HostIp)) return { url: `http://${mapping.HostIp}:${port}`, priority: 0 };
    if (mapping.HostIp === '::1') return { url: `http://[::1]:${port}`, priority: 1 };
    if (mapping.HostIp === '0.0.0.0' || mapping.HostIp === '') return { url: `http://127.0.0.1:${port}`, priority: 2 };
    if (mapping.HostIp === '::') return { url: `http://[::1]:${port}`, priority: 3 };
    return null;
  }).filter(Boolean).sort((a, b) => a.priority - b.priority);
  if (!candidates.length) throw new Error('Selected container has no cockpit port mapping accessible through host loopback');
  return candidates[0].url;
}

/** Resolve and probe the selected container's existing cockpit; no browser or Worker side effects. */
export async function containerCockpit(container, { run = runDocker, env = process.env, fetch: request = globalThis.fetch } = {}) {
  const selected = await inspectContainer(container, { run });
  await requireLocalDocker(run, env);
  const url = cockpitURL(selected.inspection);
  try {
    const response = await request(`${url}/api/session`, { signal: AbortSignal.timeout(5000), redirect: 'error' });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const session = await response.json();
    if (session.application?.name !== 'forge' || session.application.version !== selected.application.version || session.application.layoutVersion !== 1) {
      throw new Error('the published service does not identify the selected compatible Forge cockpit');
    }
  } catch (error) {
    throw new Error(`Selected container cockpit is unavailable at ${url}: ${error.message}`);
  }
  return { container, containerId: selected.id, url, version: selected.application.version };
}

/** Browser launch failure leaves a usable URL and does not invalidate cockpit access. */
export async function openContainer(container, { browser = true, open = execute, platform = process.platform, ...options } = {}) {
  const cockpit = await containerCockpit(container, options);
  if (!browser) return { ...cockpit, browser: 'disabled' };
  const command = platform === 'darwin' ? ['open', [cockpit.url]]
    : platform === 'linux' ? ['xdg-open', [cockpit.url]]
      : platform === 'win32' ? ['rundll32', ['url.dll,FileProtocolHandler', cockpit.url]] : null;
  try {
    if (!command) throw new Error(`No browser opener is configured for ${platform}`);
    await open(...command, { timeout: 5000, maxBuffer: 64 * 1024 });
    return { ...cockpit, browser: 'requested' };
  } catch {
    return { ...cockpit, browser: 'unavailable', message: 'Open the URL in a browser to use this cockpit.' };
  }
}
