import { spawn } from 'node:child_process';
import { mkdir, open } from 'node:fs/promises';
import path from 'node:path';
import { startCockpit } from '../library/cockpit.mjs';

// Both services live in this container. This supervises processes, never Workers.
const workspace = path.resolve(process.env.FORGE_WORKSPACE ?? '/workspace');
const codexDirectory = process.env.CODEX_HOME ?? '/var/lib/forge/codex';
process.env.CODEX_HOME = codexDirectory;
const sandbox = process.env.FORGE_SANDBOX;
const approvalPolicy = process.env.FORGE_APPROVAL_POLICY;
if (sandbox !== undefined && !['danger-full-access', 'workspace-write', 'read-only'].includes(sandbox)) throw new Error('Invalid FORGE_SANDBOX');
if (approvalPolicy !== undefined && !['never', 'on-request', 'untrusted', 'on-failure'].includes(approvalPolicy)) throw new Error('Invalid FORGE_APPROVAL_POLICY');
const port = Number(process.env.FORGE_PORT ?? 4310);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('FORGE_PORT must be an integer from 1 to 65535');
await mkdir(codexDirectory, { recursive: true, mode: 0o700 });
const log = await open(path.join(codexDirectory, 'app-server.log'), 'a', 0o600);
const host = spawn('codex', ['app-server', '--listen', 'ws://127.0.0.1:4500',
  ...(sandbox === undefined ? [] : ['-c', `sandbox_mode=${JSON.stringify(sandbox)}`]),
  ...(approvalPolicy === undefined ? [] : ['-c', `approval_policy=${JSON.stringify(approvalPolicy)}`])], { stdio: ['ignore', log.fd, log.fd] });
let cockpit;
let stopping = false;
let hostExited = false;
let hostFinished;
const hostExit = new Promise(resolve => { hostFinished = resolve; });
async function stop(code, signal = 'SIGTERM') {
  if (stopping) return;
  stopping = true;
  process.exitCode = code;
  if (!hostExited) host.kill(signal);
  const cutoff = setTimeout(() => {
    cockpit?.server.closeAllConnections();
    if (!hostExited) host.kill('SIGKILL');
  }, 8000);
  try { await Promise.all([hostExit, cockpit?.close()]); }
  finally { clearTimeout(cutoff); await log.close(); }
}
host.on('error', error => { hostExited = true; hostFinished(); console.error(`Codex host could not start: ${error.message}`); void stop(1); });
host.on('exit', code => { hostExited = true; hostFinished(); if (!stopping) { console.error(`Codex host exited (${code}); see ${codexDirectory}/app-server.log`); void stop(code || 1); } });
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => void stop(0, signal));
try {
  cockpit = await startCockpit({ workspace, directions: process.env.FORGE_DIRECTIONS ?? path.join(workspace, '.forge/directions'),
    bind: process.env.FORGE_BIND ?? '127.0.0.1', port });
  if (stopping) await cockpit.close();
  else console.log(JSON.stringify({ type: 'cockpit_listening', ...cockpit.address }));
} catch (error) { console.error(error.message); await stop(1); }
