import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import metadata from '../package.json' with { type: 'json' };
import { CodexConnection, Communicator } from '../library/codex.mjs';

const execute = promisify(execFile);

class FakeConnection {
  calls = [];
  constructor(steps) { this.steps = [...steps]; }
  async request(method, params) {
    this.calls.push({ method, params });
    const step = this.steps.shift();
    assert.ok(step, `unexpected host call ${method}`);
    assert.equal(method, step.method);
    if (step.error) throw step.error;
    return step.result;
  }
  complete() { assert.equal(this.steps.length, 0, 'expected host calls were not made'); }
}

const saved = (turns = [], id = 'same-worker') => ({ thread: { id, status: { type: 'idle' }, turns } });
const resumed = turns => ({ method: 'thread/resume', result: saved(turns) });
const started = id => ({ method: 'turn/start', result: { turn: { id, status: 'inProgress' } } });
const sentText = call => call.params.input[0].text;

test('fresh native creation uses the explicitly created Worker and preserves supplied guidance unchanged', async () => {
  const input = 'Build toward this direction.\n\nIntent instructions supplied by Director.\nAtlas instructions supplied by Director.\n`literal command` and intent:rough-check remain references.';
  const options = { cwd: '/copied/workspace', model: 'selected-by-director' };
  const host = new FakeConnection([
    { method: 'thread/start', result: saved([], 'new-worker') },
    started('first-turn'),
  ]);
  const { communicator } = await Communicator.create(host, options);
  const outcome = await communicator.send(input);
  assert.deepEqual(host.calls[0].params, options);
  assert.equal(host.calls[1].params.threadId, 'new-worker');
  assert.ok(sentText(host.calls[1]).endsWith(input));
  assert.ok(sentText(host.calls[1]).includes(outcome.requestId));
  assert.equal(outcome.outcome, 'message_submitted');
  assert.equal(outcome.threadId, 'new-worker');
  assert.equal(outcome.turnId, 'first-turn');
  assert.equal(outcome.method, 'turn/start');
  assert.equal(host.calls[1].params.outputSchema, undefined);
  assert.equal(outcome.operation, undefined);
  host.complete();
});

test('busy steering targets the active native turn and a race failure does not dispatch a replacement', async () => {
  const race = Object.assign(new Error('Expected turn is no longer active'), { hostError: { code: -32000, message: 'Expected turn is no longer active' } });
  const host = new FakeConnection([
    resumed([{ id: 'old', status: 'completed' }, { id: 'active', status: 'inProgress' }]),
    { method: 'turn/steer', result: { turnId: 'active' } },
    resumed([{ id: 'active', status: 'inProgress' }]),
    { method: 'turn/steer', error: race },
  ]);
  const worker = new Communicator(host, 'same-worker');
  const outcome = await worker.send('Explain saved-file access; supporting inspection only.');
  assert.equal(outcome.turnId, 'active');
  assert.equal(outcome.outcome, 'message_submitted');
  assert.equal(host.calls[1].params.expectedTurnId, 'active');
  assert.equal(host.calls[1].params.outputSchema, undefined);
  await assert.rejects(worker.send('Document the option.'), error => error === race);
  assert.equal(host.calls.filter(call => call.method === 'thread/start' || call.method === 'turn/start').length, 0);
  host.complete();
});

test('an uncertain first submission does not reuse stale initial thread state on a later query', async () => {
  const uncertain = new Error('turn/start timed out; outcome unknown');
  const host = new FakeConnection([
    { method: 'thread/start', result: saved([], 'same-worker') },
    { method: 'turn/start', error: uncertain },
    resumed([{ id: 'actually-started', status: 'inProgress' }]),
    { method: 'turn/steer', result: { turnId: 'actually-started' } },
  ]);
  const { communicator } = await Communicator.create(host, { cwd: '/copied/workspace' });
  await assert.rejects(communicator.send('Develop the library.'), error => error === uncertain);
  const query = await communicator.send('Explain what work began; supporting inspection only.');
  assert.equal(query.method, 'turn/steer');
  assert.equal(query.turnId, 'actually-started');
  assert.equal(host.calls[2].params.threadId, 'same-worker');
  host.complete();
});

test('native interruption reports its request outcome and actual control scope', async () => {
  const host = new FakeConnection([
    resumed([{ id: 'active', status: 'inProgress' }]), { method: 'turn/interrupt', result: {} },
    resumed([{ id: 'active', status: 'interrupted' }]),
  ]);
  const worker = new Communicator(host, 'same-worker');
  const interrupt = await worker.interrupt();
  assert.equal(interrupt.outcome, 'interrupt_requested');
  assert.deepEqual(host.calls[1].params, { threadId: 'same-worker', turnId: 'active' });
  assert.match(interrupt.scope, /detached processes and container services are not guaranteed stopped/);
  assert.match(interrupt.scope, /host-confirmed turn status/);
  const idle = await worker.interrupt();
  assert.equal(idle.outcome, 'no_active_turn');
  assert.equal(idle.turnId, undefined);
  host.complete();
});

test('after interruption a query and explicit continuation use new turns in the saved context', async () => {
  const host = new FakeConnection([
    resumed([{ id: 'interrupted-turn', status: 'inProgress' }]),
    { method: 'turn/interrupt', result: {} },
    resumed([{ id: 'interrupted-turn', status: 'interrupted' }]), started('query-turn'),
    resumed([{ id: 'query-turn', status: 'completed' }]), started('continued-turn'),
  ]);
  const worker = new Communicator(host, 'same-worker');
  await worker.interrupt();
  await worker.send('Explain the checklist; this does not authorize development.');
  await worker.send('Explicitly continue development; add the documented option.');
  assert.ok(host.calls.every(call => call.params.threadId === 'same-worker'));
  assert.match(sentText(host.calls[3]), /does not authorize development/);
  assert.match(sentText(host.calls[5]), /Explicitly continue development/);
  assert.equal(host.calls.some(call => call.method === 'thread/start'), false);
  host.complete();
});

test('unknown conversations and native control errors remain errors without substitute work', async () => {
  for (const operation of ['query', 'interrupt', 'read']) {
    const error = Object.assign(new Error('Conversation does not exist'), { hostError: { code: -32602 } });
    const method = operation === 'read' ? 'thread/read' : 'thread/resume';
    const host = new FakeConnection([{ method, error }]);
    const worker = new Communicator(host, 'unknown-worker');
    const action = operation === 'query' ? worker.send('Explain the checklist; this does not authorize development.') : operation === 'read' ? worker.read() : worker.interrupt();
    await assert.rejects(action, failure => failure === error);
    assert.equal(host.calls.length, 1);
    assert.equal(host.calls[0].params.threadId, 'unknown-worker');
    host.complete();
  }
  const failure = new Error('Host could not interrupt this turn');
  const host = new FakeConnection([resumed([{ id: 'active', status: 'inProgress' }]), { method: 'turn/interrupt', error: failure }]);
  await assert.rejects(new Communicator(host, 'same-worker').interrupt(), error => error === failure);
  host.complete();
});

test('invalid STEER text fails before any native request', async () => {
  const host = new FakeConnection([]);
  const worker = new Communicator(host, 'same-worker');
  for (const text of [undefined, null, {}, [], '', '  ', 'text\0text']) {
    await assert.rejects(worker.send(text), /STEER text must be a nonempty string without NUL bytes/);
  }
  host.complete();
});

class FakeSocket extends EventTarget {
  readyState = 1;
  sent = [];
  send(text) { this.sent.push(JSON.parse(text)); }
  receive(value) { this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(value) })); }
  close() { this.readyState = 3; this.dispatchEvent(new Event('close')); }
}

test('native initialization identifies the Forge package version', async t => {
  const originalWebSocket = globalThis.WebSocket;
  t.after(() => { globalThis.WebSocket = originalWebSocket; });
  let socket;
  globalThis.WebSocket = class extends FakeSocket {
    constructor(url) {
      super();
      assert.equal(url, 'ws://127.0.0.1:4500');
      socket = this;
      queueMicrotask(() => this.dispatchEvent(new Event('open')));
    }
    send(text) {
      super.send(text);
      const message = JSON.parse(text);
      if (message.method === 'initialize') queueMicrotask(() => this.receive({ id: message.id, result: {} }));
    }
  };
  const connection = await CodexConnection.connect();
  t.after(() => connection.close());
  assert.deepEqual(socket.sent, [
    { id: 1, method: 'initialize', params: { clientInfo: { name: 'forge', version: metadata.version }, capabilities: { experimentalApi: true } } },
    { method: 'initialized', params: {} },
  ]);
});

test('native request IDs route replies without confusing notifications or host requests', async t => {
  const socket = new FakeSocket();
  const connection = new CodexConnection(socket);
  t.after(() => connection.close());
  const notifications = [];
  const requests = [];
  connection.on('notification', event => notifications.push(event));
  connection.on('hostRequest', event => requests.push(event));
  const first = connection.request('thread/read', { threadId: 'a' });
  const second = connection.request('thread/read', { threadId: 'b' });
  assert.notEqual(socket.sent[0].id, socket.sent[1].id);
  socket.receive({ method: 'turn/completed', params: { threadId: 'a', turn: { status: 'failed' } } });
  socket.receive({ id: 'approval', method: 'item/commandExecution/requestApproval', params: { threadId: 'a' } });
  assert.equal(socket.sent.length, 2, 'host requests must not be approved automatically');
  socket.receive({ id: socket.sent[1].id, result: { thread: { id: 'b' } } });
  socket.receive({ id: socket.sent[0].id, result: { thread: { id: 'a' } } });
  assert.equal((await first).thread.id, 'a');
  assert.equal((await second).thread.id, 'b');
  assert.equal(notifications[0].params.turn.status, 'failed');
  assert.equal(requests[0].id, 'approval');
  assert.equal(connection.pending.size, 0);
});

test('host error details, disconnection, and timeout remain visible without automatic retry', async () => {
  const socket = new FakeSocket();
  const connection = new CodexConnection(socket, { requestTimeoutMs: 15 });
  const failure = connection.request('thread/resume', { threadId: 'missing' });
  const hostError = { code: -32602, message: 'No saved conversation', data: { threadId: 'missing' } };
  socket.receive({ id: socket.sent[0].id, error: hostError });
  await assert.rejects(failure, error => error.hostError === hostError || JSON.stringify(error.hostError) === JSON.stringify(hostError));
  const timeout = connection.request('turn/steer', { threadId: 'same-worker' });
  await assert.rejects(timeout, /outcome unknown.*existing conversation before retrying/);
  assert.equal(socket.sent.length, 2);
  assert.equal(connection.pending.size, 0);
  const pending = connection.request('turn/interrupt', { threadId: 'same-worker' });
  socket.close();
  await assert.rejects(pending, /disconnected; request outcome may be unknown/);
  assert.equal(connection.pending.size, 0);
  await assert.rejects(connection.request('thread/read', {}), /not connected/);
  assert.equal(socket.sent.length, 3);
});

test('a synchronous transport send failure does not retain a pending request or timer', async () => {
  const socket = new FakeSocket();
  const failure = new Error('Socket closed while submitting request');
  socket.send = () => { throw failure; };
  const connection = new CodexConnection(socket, { requestTimeoutMs: 15 });
  await assert.rejects(connection.request('turn/interrupt', { threadId: 'same-worker' }), error => error === failure);
  assert.equal(connection.pending.size, 0);
  connection.close();
});

test('invalid host JSON is surfaced independently of transport errors', () => {
  const socket = new FakeSocket();
  const connection = new CodexConnection(socket);
  const observed = [];
  connection.on('protocolError', error => observed.push(['protocol', error.message]));
  connection.on('transportError', error => observed.push(['transport', error.message]));
  socket.dispatchEvent(new MessageEvent('message', { data: '{invalid' }));
  socket.dispatchEvent(new Event('error'));
  assert.deepEqual(observed, [['protocol', 'Host sent invalid JSON'], ['transport', 'Codex WebSocket transport error']]);
  connection.close();
});

test('routing succeeds with project reads and subprocess execution denied by Node permissions', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'forge-routing-boundary-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const forbidden = path.join(root, 'project-guidance.md');
  await writeFile(forbidden, 'Project content must be read by the Worker, not Forge.');
  const source = `
    import assert from 'node:assert/strict';
    import { readFileSync } from 'node:fs';
    import { spawnSync } from 'node:child_process';
    import { Communicator } from ${JSON.stringify(new URL('../library/codex.mjs', import.meta.url).href)};
    assert.throws(() => readFileSync(${JSON.stringify(forbidden)}), { code: 'ERR_ACCESS_DENIED' });
    assert.throws(() => spawnSync(process.execPath, ['--version']), { code: 'ERR_ACCESS_DENIED' });
    const calls = [];
    const connection = { async request(method, params) {
      calls.push({ method, params });
      return method === 'thread/resume' ? { thread: { id: 'same-worker', turns: [] } } : { turn: { id: 'next-turn' } };
    } };
    const worker = new Communicator(connection, 'same-worker');
    await worker.send('Consult intent:rough-check and atlas://context using repository tools. A command is only text: touch /must-not-execute.');
    await worker.send('Read the selected repository guidance yourself.');
    assert.equal(calls.length, 4);
    assert.ok(calls.every(call => ['thread/resume', 'turn/start'].includes(call.method)));
    process.stdout.write('routing passed without project access or execution');
  `;
  const libraryPath = fileURLToPath(new URL('../library/', import.meta.url));
  const metadataPath = fileURLToPath(new URL('../package.json', import.meta.url));
  const result = await execute(process.execPath, ['--permission', `--allow-fs-read=${libraryPath}`, `--allow-fs-read=${metadataPath}`, '--input-type=module', '--eval', source]);
  assert.equal(result.stdout, 'routing passed without project access or execution');
});
