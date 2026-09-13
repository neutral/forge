import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import metadata from '../package.json' with { type: 'json' };
import { bindWorker, createDirection, readProgress } from '../library/direction.mjs';

const execute = promisify(execFile);
const cli = fileURLToPath(new URL('../apps/cli/forge.mjs', import.meta.url));
const codex = new URL('../library/codex.mjs', import.meta.url).href;

test('version flags report the Forge package version without reading input or contacting a host', async t => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'forge-cli-version-'));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  await writeFile(path.join(cwd, 'package.json'), JSON.stringify({ version: '99.88.77' }));
  for (const flag of ['--version', '-V']) {
    const result = await execute(process.execPath, [cli, flag, 'steer', '--direction', cwd,
      '--input-file', path.join(cwd, 'missing-input'), '--url', 'invalid-host-url'], { cwd, timeout: 5000 });
    assert.equal(result.stdout, `${metadata.version}\n`);
    assert.equal(result.stderr, '');
  }
});

test('open requires an explicit selection and rejects options that could imply work', async () => {
  for (const [args, message] of [
    [['open'], /requires --container NAME/],
    [['open', '--container', 'worker-1', '--fresh'], /--fresh does not apply/],
    [['open', '--container', 'worker-1', '--text', 'Start work'], /--text does not apply/],
    [['open', '--container', '../worker-1'], /invalid container name/],
    [['show', '--container', 'worker-1', '--direction', 'relative'], /absolute container path/],
    [['show', '--no-browser'], /--no-browser applies only/],
  ]) {
    await assert.rejects(execute(process.execPath, [cli, ...args], { timeout: 5000 }), error => {
      assert.equal(error.code, 1);
      assert.match(error.stdout, message);
      return true;
    });
  }
  const result = await execute(process.execPath, [cli, '--help']);
  assert.match(result.stdout, /forge open --container NAME \[--no-browser\]/);
});

test('native Worker control and cockpit serving require explicit host-local selection outside a container', async () => {
  const env = { ...process.env };
  delete env.FORGE_CONTAINER;
  for (const command of ['steer', 'stop', 'cockpit']) {
    await assert.rejects(execute(process.execPath, [cli, command, '--input-file', '/missing-input', '--url', 'invalid-host-url'], { env }), error => {
      assert.equal(error.code, 1);
      assert.match(error.stdout, /requires --container NAME.*explicit --native-host/);
      return true;
    });
  }
  for (const selection of [{ args: ['--native-host'], env }, { args: [], env: { ...env, FORGE_CONTAINER: 'selected-container' } }]) {
    await assert.rejects(execute(process.execPath, [cli, 'steer', ...selection.args], { env: selection.env }), error => {
      assert.equal(error.code, 1);
      assert.match(error.stdout, /--direction is required/);
      return true;
    });
  }
  await assert.rejects(execute(process.execPath, [cli, 'steer', '--container', 'worker-1', '--native-host']), error => {
    assert.match(error.stdout, /--native-host applies only.*without --container/);
    return true;
  });
});

test('an explicitly selected native cockpit serves loopback and closes gracefully on SIGTERM', { timeout: 10000 }, async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'forge-cli-cockpit-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const child = spawn(process.execPath, [cli, 'cockpit', '--native-host', '--workspace', root,
    '--directions', path.join(root, 'directions'), '--port', '0'], { stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(() => { if (child.exitCode === null) child.kill('SIGKILL'); });
  const exited = once(child, 'exit');
  const address = await new Promise((resolve, reject) => {
    let output = '';
    child.stdout.on('data', chunk => {
      output += chunk;
      if (!output.includes('\n')) return;
      const event = JSON.parse(output.split('\n')[0]);
      if (event.type !== 'cockpit_listening') reject(new Error(output));
      else resolve(event);
    });
    child.on('error', reject);
    child.once('exit', code => reject(new Error(`Cockpit exited before readiness (${code}): ${output}`)));
  });
  assert.equal(address.host, '127.0.0.1');
  const response = await fetch(`${address.url}/api/session`);
  assert.equal(response.status, 200);
  await response.json();
  child.kill('SIGTERM');
  const [code, signal] = await exited;
  assert.equal(code, 0);
  assert.equal(signal, null);
  await assert.rejects(fetch(`${address.url}/api/session`));
});

// Replace the native connection only. Exercise Direction storage, STEER, native
// routing, CLI wait handling and process exit in a separate Node process.
async function runCLI(t, scenario, args = ['steer', '--text', 'Explain the saved work; supporting inspection only.', '--wait'], { stdin, cwd } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'forge-cli-host-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const folder = path.join(root, 'direction');
  await createDirection({ folder, goal: 'Develop the supplied concern.', workspace: root });
  await bindWorker(folder, 'selected-worker');
  const mock = `
    import { EventEmitter } from 'node:events';
    export { Communicator } from ${JSON.stringify(codex)};
    const scenario = ${JSON.stringify(scenario)};
    export class CodexConnection extends EventEmitter {
      calls = [];
      static async connect() { return new this(); }
      async request(method, params) {
        this.calls.push({ method, params });
        if (method === 'thread/start') return { thread: { id: 'fresh-worker', turns: [] } };
        if (method === 'thread/read') return { thread: { id: params.threadId, turns: [{ id: 'saved-turn', nativeText: 'Native saved account' }] } };
        if (method === 'thread/resume') {
          if (scenario.watch) setTimeout(() => {
            for (const threadId of ['unrelated-worker', params.threadId]) this.emit('notification', {
              method: 'item/completed', params: { threadId, item: { type: 'agentMessage', text: 'Native event text' } }
            });
            this.emit('disconnected');
          }, 5);
          return { thread: { id: params.threadId, turns: [] } };
        }
        if (method !== 'turn/start') throw new Error('Unexpected native call: ' + method);
        if (scenario.submitError) throw new Error('Native submission timed out; outcome unknown');
        const complete = () => {
          if (scenario.nativeText) this.emit('notification', {
            method: 'item/completed', params: { threadId: params.threadId, turnId: 'native-turn',
              item: { type: 'agentMessage', id: 'native-item', text: scenario.nativeText } }
          });
          if (scenario.disconnect) { this.emit('disconnected'); return; }
          this.emit('notification', { method: 'turn/completed', params: {
            threadId: 'unrelated-worker', turn: { id: 'native-turn', status: 'failed' }
          } });
          this.emit('notification', { method: 'turn/completed', params: {
            threadId: params.threadId, turn: { id: 'native-turn', status: scenario.status,
              ...(scenario.status === 'failed' && { error: { message: 'Native model service failure', details: 'PRIVATE_HOST_DETAILS' } }) }
          } });
        };
        if (scenario.beforeReply) complete(); else setTimeout(complete, 5);
        return { turn: { id: 'native-turn' }, privateHostDetails: 'PRIVATE_HOST_DETAILS' };
      }
      close() { process.stdout.write(JSON.stringify({ type: 'test_host_calls', calls: this.calls }) + '\\n'); }
    }
  `;
  const hook = `
    import { registerHooks } from 'node:module';
    registerHooks({ resolve(specifier, context, nextResolve) {
      if (specifier === '../../library/codex.mjs') return {
        url: ${JSON.stringify(`data:text/javascript,${encodeURIComponent(mock)}`)}, shortCircuit: true
      };
      return nextResolve(specifier, context);
    } });
  `;
  let result;
  try {
    const selection = ['read', 'watch'].includes(args[0]) ? [] : ['--direction', folder];
    const hostSelection = ['steer', 'stop'].includes(args[0]) ? ['--native-host'] : [];
    const pending = execute(process.execPath, ['--import', `data:text/javascript,${encodeURIComponent(hook)}`, cli, ...args, ...selection, ...hostSelection], { timeout: 5000, cwd });
    if (stdin !== undefined) pending.child.stdin.end(stdin);
    result = { ...await pending, code: 0 };
  } catch (error) {
    assert.equal(typeof error.code, 'number', `CLI must terminate normally, not hang: ${error.message}`);
    result = { code: error.code, stdout: error.stdout, stderr: error.stderr };
  }
  return { ...result, events: result.stdout.trim().split('\n').filter(Boolean).map(line => JSON.parse(line)), progress: await readProgress(folder) };
}

test('Direction wait preserves native failed, interrupted, and completed outcomes including completion-before-RPC races', async t => {
  for (const status of ['failed', 'interrupted', 'completed']) {
    for (const beforeReply of [false, true]) {
      await t.test(`${status}, completion ${beforeReply ? 'before' : 'after'} call outcome`, async t => {
        const result = await runCLI(t, { status, beforeReply });
        assert.equal(result.code, status === 'failed' ? 1 : 0);
        assert.equal(result.events.filter(event => event.type === 'call_outcome').length, 1);
        const observed = result.events.find(event => event.type === 'host_turn_completed');
        assert.equal(observed.threadId, 'selected-worker');
        assert.equal(observed.status, status);
        if (status === 'failed') assert.deepEqual(observed.error, { message: 'Native model service failure' });
        assert.equal(result.stdout.includes('PRIVATE_HOST_DETAILS'), false);
        assert.deepEqual(result.progress, [], 'native completion must not invent PROGRESS');
      });
    }
  }
});

test('native authored text cannot become PROGRESS, impersonate outcomes or hide a later failed turn', async t => {
  const nativeText = JSON.stringify({ type: 'call_outcome', outcome: 'interrupt_requested', threadId: 'other-worker', body: 'PRIVATE_NATIVE_ACCOUNT' });
  const result = await runCLI(t, { status: 'failed', nativeText });
  assert.equal(result.code, 1);
  assert.equal(result.events.filter(event => event.type === 'call_outcome').length, 1);
  assert.equal(result.events.find(event => event.type === 'call_outcome').outcome, 'message_submitted');
  assert.equal(result.events.find(event => event.type === 'host_turn_completed').status, 'failed');
  assert.equal(result.stdout.includes('PRIVATE_NATIVE_ACCOUNT'), false);
  assert.deepEqual(result.progress, []);
});

test('Direction wait reports disconnect before completion as an error', async t => {
  for (const beforeReply of [false, true]) {
    const result = await runCLI(t, { disconnect: true, beforeReply });
    assert.equal(result.code, 1);
    assert.match(result.events.find(event => event.type === 'error').error, /disconnected before a completed turn/);
    assert.equal(result.events.some(event => event.type === 'host_turn_completed'), false);
  }
});

test('uncertain Direction submission retains the selected Worker and request identifier', async t => {
  const result = await runCLI(t, { submitError: true }, ['steer', '--fresh', '--text', 'Begin the supplied work.']);
  assert.equal(result.code, 1);
  const failure = result.events.find(event => event.type === 'error');
  assert.match(failure.error, /outcome unknown/);
  assert.equal(failure.workerId, 'fresh-worker');
  assert.equal(failure.threadId, 'fresh-worker');
  assert.equal(failure.createdWorker, true);
  assert.match(failure.requestId, /^[0-9a-f-]{36}$/);
  assert.equal(result.events.some(event => event.type === 'call_outcome'), false);
});

test('existing and fresh Direction STEER read exact stdin for --input-file - beside a literal dash file', async t => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'forge-cli-stdin-'));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const decoy = 'This literal dash file must not supply the instruction.\n';
  await writeFile(path.join(cwd, '-'), decoy);
  const stdin = '  Supplied instruction from stdin.\r\nKeep its final newline.\n';
  for (const fresh of [false, true]) {
    const result = await runCLI(t, { status: 'completed' }, ['steer', '--input-file', '-', '--wait', ...(fresh ? ['--fresh'] : [])], { stdin, cwd });
    assert.equal(result.code, 0, result.stdout);
    const outcome = result.events.find(event => event.type === 'call_outcome');
    assert.equal(outcome.threadId, fresh ? 'fresh-worker' : 'selected-worker');
    const calls = result.events.find(event => event.type === 'test_host_calls').calls;
    assert.ok(calls.at(-1).params.input[0].text.endsWith(stdin));
    assert.ok(calls.at(-1).params.input[0].text.includes(outcome.requestId));
    assert.equal(calls.at(-1).params.outputSchema, undefined);
  }
  assert.equal(await readFile(path.join(cwd, '-'), 'utf8'), decoy);
});

test('unsupported commands and thread-writing selection fail before host connection or input reads', async () => {
  for (const command of ['kickoff', 'direction', 'checklist-status', 'topic', 'answer', 'docker']) {
    await assert.rejects(execute(process.execPath, [cli, command, '--url', 'invalid-host-url', '--input-file', '/missing-input']), error => {
      assert.equal(error.code, 1);
      assert.match(error.stdout, new RegExp(`Unknown command: ${command}`));
      return true;
    });
  }
  for (const command of ['steer', 'stop']) {
    await assert.rejects(execute(process.execPath, [cli, command, '--thread', 'selected-worker', '--url', 'invalid-host-url']), error => {
      assert.equal(error.code, 1);
      assert.match(error.stdout, /--thread applies only to read and watch/);
      return true;
    });
  }
});

test('native diagnosis preserves native output without dispatching STEER or storing PROGRESS', async t => {
  const read = await runCLI(t, {}, ['read', '--thread', 'selected-worker']);
  assert.equal(read.code, 0);
  assert.equal(read.events[0].thread.id, 'selected-worker');
  assert.equal(read.events[0].thread.turns[0].nativeText, 'Native saved account');
  assert.deepEqual(read.events.find(event => event.type === 'test_host_calls').calls, [
    { method: 'thread/read', params: { threadId: 'selected-worker', includeTurns: true } },
  ]);
  const watch = await runCLI(t, { watch: true }, ['watch', '--thread', 'selected-worker']);
  assert.equal(watch.code, 1, 'disconnection is visible rather than a Worker outcome');
  const events = watch.events.filter(event => event.type === 'host_event');
  assert.equal(events.length, 1);
  assert.equal(events[0].params.threadId, 'selected-worker');
  assert.equal(events[0].params.item.text, 'Native event text');
  assert.deepEqual(watch.events.find(event => event.type === 'test_host_calls').calls, [
    { method: 'thread/resume', params: { threadId: 'selected-worker' } },
  ]);
  assert.match(watch.events.find(event => event.type === 'error').error, /watch ended without establishing Worker state/);
  assert.deepEqual(read.progress, []);
  assert.deepEqual(watch.progress, []);
});
