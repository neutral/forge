import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { promisify } from 'node:util';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { appendProgress, bindWorker, createDirection, readProgress } from '../library/direction.mjs';
import { containerArguments } from '../library/container.mjs';

const execute = promisify(execFile);
const cli = fileURLToPath(new URL('../apps/cli/forge.mjs', import.meta.url));
async function run(...args) {
  const result = await execute(process.execPath, [cli, ...args]);
  return result.stdout.trim().split('\n').filter(Boolean).map(JSON.parse);
}

// Exercise the real CLI and Communicator, replacing only the native connection.
async function hostCLI(folder, command, extra = []) {
  const codex = new URL('../library/codex.mjs', import.meta.url).href;
  const mock = `
    import { EventEmitter } from 'node:events';
    export { Communicator, nativeWorkerOptions } from ${JSON.stringify(codex)};
    export class CodexConnection extends EventEmitter {
      static async connect(url) { const connection = new this(); connection.url = url; connection.calls = []; return connection; }
      async request(method, params) {
        this.calls.push({ method, params });
        if (method === 'thread/resume') return { thread: { id: params.threadId, turns: [{ id: 'active-turn', status: 'inProgress' }] } };
        if (method === 'turn/interrupt') return {};
        if (method === 'turn/steer') return { turnId: 'active-turn' };
        throw new Error('Unexpected native call: ' + method);
      }
      close() { process.stdout.write(JSON.stringify({ type: 'test_host_calls', url: this.url, calls: this.calls }) + '\\n'); }
    }
  `;
  const hook = `
    import { registerHooks } from 'node:module';
    registerHooks({ resolve(specifier, context, nextResolve) {
      if (specifier === '../../library/codex.mjs') return { url: ${JSON.stringify(`data:text/javascript,${encodeURIComponent(mock)}`)}, shortCircuit: true };
      return nextResolve(specifier, context);
    } });
  `;
  try {
    const result = await execute(process.execPath, ['--import', `data:text/javascript,${encodeURIComponent(hook)}`, cli, command, '--native-host', '--direction', folder, ...extra], { timeout: 5000 });
    return { code: 0, events: result.stdout.trim().split('\n').map(JSON.parse) };
  } catch (error) {
    assert.equal(typeof error.code, 'number', 'CLI must exit normally');
    return { code: error.code, events: error.stdout.trim().split('\n').map(JSON.parse) };
  }
}

test('Direction stop routes both modes using saved Worker settings when goal is missing', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'forge-cli-stop-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const folder = path.join(root, 'direction');
  await createDirection({ folder, goal: 'Keep this work stoppable.', workspace: root, hostUrl: 'ws://127.0.0.1:4567' });
  await bindWorker(folder, 'earlier-worker');
  const earlier = await appendProgress(folder, { workerId: 'earlier-worker', body: 'Earlier account remains attributed.' });
  const settings = { model: 'saved-model', sandbox: 'workspace-write', approvalPolicy: 'never' };
  await bindWorker(folder, 'selected-worker', {}, settings);
  const latest = await appendProgress(folder, { workerId: 'selected-worker', body: 'Intact account.\r\nStill unresolved.', inReplyTo: 'prior-steer' });
  await rm(path.join(folder, 'goal.md'));
  for (const mode of ['interrupt', 'request']) {
    const result = await hostCLI(folder, 'stop', ['--mode', mode]);
    assert.equal(result.code, 0);
    const native = result.events.find(event => event.type === 'test_host_calls');
    assert.equal(native.url, 'ws://127.0.0.1:4567');
    assert.deepEqual(native.calls[0], { method: 'thread/resume', params: { ...settings, threadId: 'selected-worker' } });
    assert.deepEqual(native.calls.map(call => call.method), ['thread/resume', mode === 'interrupt' ? 'turn/interrupt' : 'turn/steer']);
    assert.equal(native.calls[1].params.threadId, 'selected-worker');
    assert.equal(native.calls[1].params[mode === 'interrupt' ? 'turnId' : 'expectedTurnId'], 'active-turn');
    if (mode === 'request') assert.match(native.calls[1].params.input[0].text, /Stop development/);
    const outcome = result.events.find(event => event.type === 'call_outcome');
    assert.equal(outcome.outcome, mode === 'interrupt' ? 'interrupt_requested' : 'message_submitted');
    assert.deepEqual(await readProgress(folder), [earlier, latest]);
  }
  const [shown] = await run('show', '--direction', folder);
  assert.equal(shown.workerId, 'selected-worker');
  assert.equal(shown.goal, null);
  assert.match(shown.goalError, /ENOENT.*goal\.md/);
  const wrongHost = await hostCLI(folder, 'stop', ['--mode', 'interrupt', '--url', 'ws://127.0.0.1:4999']);
  assert.equal(wrongHost.code, 1);
  assert.match(wrongHost.events[0].error, /saved host/);
  assert.equal(wrongHost.events.some(event => event.type === 'test_host_calls'), false);

  const db = new DatabaseSync(path.join(folder, 'direction.sqlite'));
  try { db.prepare('UPDATE workers SET options_json = ? WHERE worker_id = ?').run('{"config":{}}', 'selected-worker'); }
  finally { db.close(); }
  const damaged = await hostCLI(folder, 'stop', ['--mode', 'interrupt']);
  assert.equal(damaged.code, 1);
  assert.match(damaged.events[0].error, /Invalid stored Worker host options/);
  assert.equal(damaged.events.some(event => event.type === 'test_host_calls'), false);
  assert.deepEqual(await readProgress(folder), [earlier, latest]);
});

test('CLI rejects version 1 before host control and preserves its database on reads and writes', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'forge-cli-unsupported-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const folder = path.join(root, 'direction');
  await createDirection({ folder, goal: 'Keep the authored goal.', workspace: root });
  await bindWorker(folder, 'selected-worker');
  await appendProgress(folder, { workerId: 'selected-worker', body: 'Keep this attributed account.', inReplyTo: 'selected-request' });
  const filename = path.join(folder, 'direction.sqlite');
  const db = new DatabaseSync(filename);
  try { db.exec('ALTER TABLE workers DROP COLUMN options_json; PRAGMA user_version = 1'); }
  finally { db.close(); }
  const before = await readFile(filename);
  for (const args of [
    ['show'], ['progress'], ['progress', '--worker', 'selected-worker', '--text', 'Must not be stored.'],
  ]) {
    await assert.rejects(run(...args, '--direction', folder), error => {
      assert.equal(error.code, 1);
      assert.deepEqual(JSON.parse(error.stdout), { type: 'error', error: 'Unsupported Direction database schema (application 1179603527, version 1)' });
      return true;
    });
    assert.deepEqual(await readFile(filename), before);
  }
  for (const [command, ...args] of [
    ['stop', '--mode', 'interrupt'], ['stop', '--mode', 'request'],
    ['steer', '--text', 'Continue.'], ['steer', '--fresh', '--text', 'Start a fresh Worker.'],
  ]) {
    const result = await hostCLI(folder, command, args);
    assert.equal(result.code, 1);
    assert.equal(result.events.length, 1, 'unsupported storage must fail before connecting to the host');
    assert.equal(result.events[0].type, 'error');
    assert.match(result.events[0].error, /Unsupported Direction database schema.*version 1/);
    assert.deepEqual(await readFile(filename), before);
  }
  assert.equal(await readFile(path.join(folder, 'goal.md'), 'utf8'), 'Keep the authored goal.');
});

test('CLI persists and retrieves PROGRESS across invocations with no available host', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'forge-cli-direction-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const folder = path.join(root, 'nested', 'direction');
  const [created] = await run('init', '--direction', folder, '--workspace', root, '--url', 'ws://127.0.0.1:1', '--text', 'A rough goal.');
  assert.equal(created.workerId, null);
  await bindWorker(folder, 'actual-worker');
  const body = 'Finished the first useful part.\nThe next concern remains open.';
  const [stored] = await run('progress', '--direction', folder, '--worker', 'actual-worker', '--text', body, '--reply-to', 'selected-steer');
  assert.equal(stored.inReplyTo, 'selected-steer');
  const [read] = await run('progress', '--direction', folder, '--latest');
  assert.equal(read.body, body);
  assert.equal(read.seq, stored.seq);
  assert.deepEqual(await run('progress', '--direction', folder, '--after', String(read.seq)), []);
  const [shown] = await run('show', '--direction', folder);
  assert.equal(shown.goal, 'A rough goal.');
  assert.equal(shown.workerId, 'actual-worker');
  await assert.rejects(run('progress', '--direction', folder, '--text', body), error => /--worker is required/.test(error.stdout));
  await assert.rejects(run('progress', '--direction', folder, '--limit=-1'), error => /limit must/.test(error.stdout));
});

test('container forwarding uses literal argv and never a shell or implicit container creation', () => {
  const args = ['steer', '--direction', '/workspace/a b', '--text', '$(touch /bad); `whoami`'];
  const result = containerArguments('worker-1', args);
  assert.deepEqual(result, ['exec', '-i', '--env', 'FORGE_CONTAINER=worker-1', 'worker-1', '/opt/forge/bin/forge', ...args]);
  for (const value of ['--privileged', 'a b', 'a;whoami', '', null]) assert.throws(() => containerArguments(value, []), /container/);
  assert.throws(() => containerArguments('valid', ['bad\0arg']), /NUL/);
});
