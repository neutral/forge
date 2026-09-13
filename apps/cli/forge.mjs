#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { readFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { CodexConnection, Communicator } from '../../library/codex.mjs';
import { readChecklist } from '../../library/checklist.mjs';
import { version } from '../../library/version.mjs';

const usage = `Forge — Directions, direct STEER and stored PROGRESS\n
forge --version                         Print this Forge package's version
forge open --container NAME [--no-browser] Open the selected running container's cockpit
forge init --direction PATH --workspace PATH --text GOAL
forge show --direction PATH
forge steer --direction PATH --text MESSAGE [--fresh] [--wait]
forge progress --direction PATH [--after SEQ] [--limit N] [--latest]
forge progress --direction PATH --worker ID --text SUMMARY [--reply-to REQUEST_ID]
forge stop --direction PATH [--mode request|interrupt] [--reason TEXT]
forge checklist --direction PATH
forge cockpit [--workspace PATH] [--directions PATH] [--port 4310] [--bind 127.0.0.1]
Direction and cockpit commands accept --container NAME to run inside that container.
Paths then require absolute container paths. --input-file - reads stdin;
--input-file PATH reads there. open inspects the selection and never starts work.
STEER is direct. PROGRESS reads and writes local storage without contacting a host.

Native diagnosis and workspace copies:
Use --native-host with steer, stop or cockpit to select advanced host-local execution.
Normal Worker operations require --container NAME; container startup supplies its binding.
forge host [--url ws://127.0.0.1:4500]     Run the native app-server in this terminal
forge read --thread ID                     Read native saved conversation
forge watch --thread ID                    Stream native events until disconnected
forge checklist [--folder PATH]            Present files without executing anything
forge snapshot --source PATH --destination PATH
All host commands accept --url. Instruction text accepts --text or --input-file
(or stdin). Fresh STEER accepts native --model, --sandbox and --approval-policy overrides.
Omitted host settings use Codex defaults. Host tool/approval requests are surfaced;
this binding never silently approves them. Use a host configured for your workspace.
JSON output is also the agent-facing command interface. See README.md.`;

const print = value => process.stdout.write(`${JSON.stringify(value)}\n`);
try {
  const { positionals, values: v, tokens } = parseArgs({ allowPositionals: true, tokens: true, options: {
    url: { type: 'string' },
    direction: { type: 'string' }, directions: { type: 'string' }, container: { type: 'string' },
    worker: { type: 'string' }, after: { type: 'string' }, limit: { type: 'string' },
    latest: { type: 'boolean' }, fresh: { type: 'boolean' },
    port: { type: 'string' }, bind: { type: 'string' },
    thread: { type: 'string' }, workspace: { type: 'string' }, text: { type: 'string' },
    'input-file': { type: 'string' }, folder: { type: 'string' }, 'reply-to': { type: 'string' },
    mode: { type: 'string', default: 'request' }, reason: { type: 'string' },
    model: { type: 'string' }, sandbox: { type: 'string' }, 'approval-policy': { type: 'string' },
    wait: { type: 'boolean' }, help: { type: 'boolean', short: 'h' }, version: { type: 'boolean', short: 'V' },
    'no-browser': { type: 'boolean' },
    'native-host': { type: 'boolean' },
    source: { type: 'string' }, destination: { type: 'string' },
  } });
  const [command] = positionals;
  if (v.version) { console.log(version); process.exit(0); }
  if (!command || v.help) { console.log(usage); process.exit(0); }
  if (positionals.length !== 1) throw new Error('Expected one Forge command');
  if (v.thread !== undefined && !['read', 'watch'].includes(command)) throw new Error('--thread applies only to read and watch');
  if (v['no-browser'] !== undefined && command !== 'open') throw new Error('--no-browser applies only to open');
  if (v['native-host'] && (!['steer', 'stop', 'cockpit'].includes(command) || v.container !== undefined)) {
    throw new Error('--native-host applies only to host-local steer, stop and cockpit without --container');
  }
  if (['steer', 'stop', 'cockpit'].includes(command) && !v.container && !process.env.FORGE_CONTAINER && !v['native-host']) {
    throw new Error(`${command} requires --container NAME; advanced host-local diagnostics require explicit --native-host`);
  }
  const suppliedText = async () => v.text ?? await readFile(!v['input-file'] || v['input-file'] === '-' ? '/dev/stdin' : v['input-file'], 'utf8');
  if (command === 'open') {
    if (!v.container) throw new Error('forge open requires --container NAME');
    for (const token of tokens) if (token.kind === 'option' && !['container', 'no-browser'].includes(token.name)) {
      throw new Error(`--${token.name} does not apply to forge open`);
    }
    const { openContainer } = await import('../../library/container.mjs');
    print({ type: 'cockpit_access', ...await openContainer(v.container, { browser: !v['no-browser'] }) });
  } else if (v.container !== undefined) {
    if (!['init', 'show', 'steer', 'progress', 'stop', 'checklist', 'host', 'cockpit'].includes(command)) throw new Error('--container applies to Direction commands, host and cockpit');
    const omit = new Set();
    for (const token of tokens) if (token.kind === 'option' && token.name === 'container') {
      omit.add(token.index);
      if (!token.inlineValue) omit.add(token.index + 1);
    }
    const { inContainer } = await import('../../library/container.mjs');
    process.exitCode = await inContainer(v.container, process.argv.slice(2).filter((_, index) => !omit.has(index)));
  } else if (command === 'cockpit') {
    const { startCockpit } = await import('../../library/cockpit.mjs');
    const workspace = path.resolve(v.workspace ?? process.cwd());
    const cockpit = await startCockpit({ workspace, directions: v.directions ?? path.join(workspace, '.forge/directions'),
      port: v.port === undefined ? 4310 : Number(v.port), bind: v.bind ?? '127.0.0.1' });
    print({ type: 'cockpit_listening', ...cockpit.address });
    let closing = false;
    const close = async () => {
      if (closing) return;
      closing = true;
      try { await cockpit.close(); }
      catch (error) { print({ type: 'error', error: error.message }); process.exitCode = 1; }
      finally { for (const signal of ['SIGTERM', 'SIGINT']) process.off(signal, close); }
    };
    for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, close);
  } else if (['init', 'show', 'steer', 'progress', 'stop'].includes(command)) {
    if (!v.direction) throw new Error('--direction is required');
    const { createDirection, readDirection, readDirectionBinding, appendProgress, readProgress } = await import('../../library/direction.mjs');
    if (command === 'init') {
      if (!v.workspace) throw new Error('--workspace is required');
      print(await createDirection({ folder: v.direction, goal: await suppliedText(), workspace: path.resolve(v.workspace),
        container: process.env.FORGE_CONTAINER ?? null, hostUrl: v.url ?? 'ws://127.0.0.1:4500' }));
    } else if (command === 'show') print(await readDirection(v.direction, { tolerateGoalError: true }));
    else if (command === 'progress') {
      if (v.worker || v.text !== undefined || v['input-file'] !== undefined || v['reply-to'] !== undefined) {
        if (!v.worker) throw new Error('--worker is required to append PROGRESS');
        if (v.after !== undefined || v.limit !== undefined || v.latest) throw new Error('Read filters cannot be used when appending PROGRESS');
        print(await appendProgress(v.direction, { workerId: v.worker, body: await suppliedText(), inReplyTo: v['reply-to'] ?? null }));
      } else {
        for (const record of await readProgress(v.direction, { after: v.after === undefined ? 0 : Number(v.after),
          limit: v.limit === undefined ? (v.latest ? 1 : 100) : Number(v.limit), latest: v.latest ?? false })) print(record);
      }
    } else {
      const direction = await readDirectionBinding(v.direction, { includeWorkers: false });
      if (v.url !== undefined && v.url !== direction.hostUrl) throw new Error('--url differs from this Direction\'s saved host; use its configured host');
      if (!['request', 'interrupt'].includes(v.mode)) throw new Error('--mode must be request or interrupt');
      if (command === 'stop' && !direction.workerId) throw new Error('Direction has no Worker');
      const text = command === 'steer' ? await suppliedText() : undefined;
      const connection = await CodexConnection.connect(direction.hostUrl);
      const turns = new Map();
      let target;
      let finish;
      let disconnected = false;
      const ended = new Promise(resolve => { finish = resolve; });
      connection.on('notification', event => {
        if (event.method !== 'turn/completed') return;
        const { threadId, turn } = event.params;
        turns.set(`${threadId}/${turn.id}`, { threadId, turnId: turn.id, status: turn.status,
          ...(turn.error && { error: { message: turn.error.message } }) });
        if (target === `${threadId}/${turn.id}`) finish();
      });
      connection.on('hostRequest', event => print({ type: 'host_request', id: event.id, method: event.method, threadId: event.params?.threadId }));
      connection.on('disconnected', () => { disconnected = true; finish(); });
      connection.on('transportError', error => print({ type: 'transport_error', error: error.message }));
      connection.on('protocolError', error => print({ type: 'protocol_error', error: error.message }));
      try {
        let result;
        if (command === 'steer') {
          const { steerDirection } = await import('../../library/steer.mjs');
          result = await steerDirection(connection, v.direction, { text, fresh: v.fresh ?? false,
            model: v.model, sandbox: v.sandbox, approvalPolicy: v['approval-policy'] });
        } else {
          const { stopDirection } = await import('../../library/steer.mjs');
          result = await stopDirection(connection, v.direction, { mode: v.mode, reason: v.reason });
        }
        const { host, ...outcome } = result;
        print({ type: 'call_outcome', ...outcome });
        target = result.turnId ? `${result.threadId}/${result.turnId}` : undefined;
        if (v.wait && target) {
          if (!turns.has(target) && !disconnected) await ended;
          if (!turns.has(target)) throw new Error('Host disconnected before a completed turn was observed');
          print({ type: 'host_turn_completed', ...turns.get(target) });
          if (turns.get(target).status === 'failed') process.exitCode = 1;
        }
      } finally { connection.close(); }
    }
  } else if (command === 'host') {
    const listen = v.url ?? 'ws://127.0.0.1:4500';
    const url = new URL(listen);
    if (url.protocol !== 'ws:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) throw new Error('Host must listen on loopback');
    const child = spawn('codex', ['app-server', '--listen', listen], { stdio: 'inherit' });
    for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => child.kill(signal));
    child.on('error', error => { console.error(error.message); process.exitCode = 1; });
    child.on('exit', code => { process.exitCode = code ?? 1; });
  } else if (command === 'checklist') {
    if (v.folder && v.direction) throw new Error('Select --folder or --direction');
    for (const file of await readChecklist(v.direction ? path.join(v.direction, 'checklist') : v.folder)) print(file.bytes ? { path: file.path, encoding: 'base64', content: file.bytes.toString('base64') } : file);
  } else if (command === 'snapshot') {
    const { snapshot } = await import('../../library/workspace.mjs');
    print(await snapshot({ source: v.source, destination: v.destination }));
  } else if (['read', 'watch'].includes(command)) {
    if (!v.thread) throw new Error('--thread is required');
    if (v.direction) throw new Error('Native diagnosis selects --thread');
    const connection = await CodexConnection.connect(v.url);
    connection.on('transportError', error => print({ type: 'transport_error', error: error.message }));
    connection.on('protocolError', error => print({ type: 'protocol_error', error: error.message }));
    try {
      const communicator = new Communicator(connection, v.thread);
      if (command === 'read') print(await communicator.read());
      else {
        const ended = new Promise(resolve => connection.once('disconnected', resolve));
        connection.on('notification', event => {
          if (event.params?.threadId && event.params.threadId !== v.thread) return;
          print({ type: 'host_event', ...event });
        });
        connection.on('hostRequest', event => print({ type: 'host_request', ...event }));
        await communicator.attach();
        await ended;
        throw new Error('Host disconnected; watch ended without establishing Worker state');
      }
    } finally { connection.close(); }
  } else throw new Error(`Unknown command: ${command}`);
} catch (error) {
  print({ type: 'error', error: error.message, ...(error.hostError && { hostError: error.hostError }),
    ...(error.workerId && { createdWorker: error.createdWorker ?? false, workerId: error.workerId, direction: error.direction }),
    ...(error.requestId && { requestId: error.requestId, threadId: error.threadId }) });
  process.exitCode = 1;
}
