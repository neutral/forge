import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { bindWorker, createDirection, readDirection, readProgress } from '../library/direction.mjs';
import { steerDirection, stopDirection } from '../library/steer.mjs';

class FakeConnection {
  calls = [];
  constructor(steps = []) { this.steps = [...steps]; }
  async request(method, params) {
    this.calls.push({ method, params });
    const step = this.steps.shift();
    assert.ok(step, `unexpected host call ${method}`);
    assert.equal(method, step.method);
    await step.inspect?.(params);
    if (step.error) throw step.error;
    return step.result;
  }
  complete() { assert.equal(this.steps.length, 0, 'expected host calls were not made'); }
}

const saved = (id, turns = []) => ({ thread: { id, turns } });
const turnStarted = id => ({ method: 'turn/start', result: { turn: { id, status: 'inProgress' } } });
const sentText = call => call.params.input[0].text;

async function fixture(t, name = 'direction') {
  const root = await mkdtemp(path.join(os.tmpdir(), 'forge-steer-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const folder = path.join(root, name);
  await createDirection({ folder, goal: 'Develop the selected component.\n', workspace: '/workspace/project', container: 'shared-development' });
  return folder;
}

test('fresh STEER binds its Worker before direct submission and carries supplied context unchanged', async t => {
  const folder = await fixture(t, "direction's folder");
  await writeFile(path.join(folder, 'checklist', 'rough.md'), 'A rough concern and an unchanged reference.');
  const text = 'Develop the parser.\n\nLiteral context: `echo $(example)`; atlas://reference remains supplied text.\n';
  const host = new FakeConnection([
    { method: 'thread/start', result: saved('new-worker') },
    { ...turnStarted('first-turn'), inspect: async params => {
      assert.equal((await readDirection(folder)).workerId, 'new-worker');
      assert.equal(params.outputSchema, undefined, 'native replies must not become the PROGRESS channel');
    } },
  ]);
  const result = await steerDirection(host, folder, { text, fresh: true, model: 'chosen-model', sandbox: 'workspace-write', approvalPolicy: 'on-request',
    forgeCommand: ['node', '/opt/forge/apps/cli/forge.mjs'] });
  assert.deepEqual(host.calls[0].params, { cwd: '/workspace/project', model: 'chosen-model', sandbox: 'workspace-write', approvalPolicy: 'on-request' });
  assert.equal(host.calls[1].params.threadId, 'new-worker');
  const instructions = sentText(host.calls[1]);
  assert.ok(instructions.endsWith(text));
  const operatingGuide = fileURLToPath(new URL('../spec/OPERATING.md', import.meta.url));
  assert.ok(instructions.includes(`Read Forge's operating guide at ${JSON.stringify(operatingGuide)} through your own tools and follow its Worker guidance.`));
  assert.ok(instructions.includes(JSON.stringify(path.join(folder, 'goal.md'))));
  assert.ok(instructions.includes(JSON.stringify(path.join(folder, 'checklist'))));
  assert.ok(instructions.includes("'node' '/opt/forge/apps/cli/forge.mjs' 'progress' '--direction'"));
  assert.ok(instructions.includes("direction'\\''s folder' '--worker' 'new-worker' '--text'"));
  assert.match(instructions, /your own paraphrased account locally/);
  assert.match(instructions, /Native commentary and final replies are not PROGRESS records/);
  assert.match(instructions, /No periodic PROGRESS is required/);
  assert.equal(result.outcome, 'message_submitted');
  assert.equal(result.direction, folder);
  assert.equal(result.workerId, 'new-worker');
  assert.equal(result.threadId, 'new-worker');
  assert.equal(result.fresh, true);
  assert.deepEqual(await readProgress(folder), [], 'STEER does not invent progress');
  host.complete();
});

test('existing STEER resumes the saved Worker and routes directly into its active native turn', async t => {
  const folder = await fixture(t);
  await bindWorker(folder, 'existing-worker');
  const host = new FakeConnection([
    { method: 'thread/resume', result: saved('existing-worker', [{ id: 'active-turn', status: 'inProgress' }]) },
    { method: 'turn/steer', result: { turnId: 'active-turn' } },
  ]);
  const result = await steerDirection(host, folder, { text: 'Use the smaller design.' });
  assert.deepEqual(host.calls[0].params, { threadId: 'existing-worker' });
  assert.equal(host.calls[1].params.threadId, 'existing-worker');
  assert.equal(host.calls[1].params.expectedTurnId, 'active-turn');
  assert.equal(host.calls[1].params.outputSchema, undefined);
  assert.ok(sentText(host.calls[1]).endsWith('Use the smaller design.'));
  assert.ok(sentText(host.calls[1]).includes(JSON.stringify(fileURLToPath(new URL('../spec/OPERATING.md', import.meta.url)))));
  assert.equal(result.method, 'turn/steer');
  assert.equal(result.fresh, false);
  assert.equal((await readDirection(folder)).workerId, 'existing-worker');
  host.complete();
});

test('only an explicitly fresh STEER selects another Worker and preserves prior attribution', async t => {
  const folder = await fixture(t);
  await bindWorker(folder, 'prior-worker');
  const host = new FakeConnection([
    { method: 'thread/start', result: saved('fresh-worker') },
    turnStarted('first-turn'),
  ]);
  await steerDirection(host, folder, { text: 'Begin with this supplied context.', fresh: true });
  const direction = await readDirection(folder);
  assert.equal(direction.workerId, 'fresh-worker');
  assert.deepEqual(direction.workers.map(worker => worker.workerId), ['prior-worker', 'fresh-worker']);
  assert.deepEqual(host.calls.map(call => call.method), ['thread/start', 'turn/start']);
  host.complete();
});

test('an absent or unusable saved Worker never triggers an implicit fresh Worker', async t => {
  const folder = await fixture(t);
  const emptyHost = new FakeConnection();
  await assert.rejects(steerDirection(emptyHost, folder, { text: 'Develop.' }), /no selected Worker.*explicitly fresh/);
  assert.equal(emptyHost.calls.length, 0);
  await bindWorker(folder, 'missing-worker');
  const failure = new Error('Saved Worker context is unavailable');
  const host = new FakeConnection([{ method: 'thread/resume', error: failure }]);
  await assert.rejects(steerDirection(host, folder, { text: 'Explain the work.' }), error => error === failure);
  assert.deepEqual(host.calls.map(call => call.method), ['thread/resume']);
  assert.equal((await readDirection(folder)).workerId, 'missing-worker');
  host.complete();
});

test('an uncertain first submission retains the newly bound Worker for explicit follow-up', async t => {
  const folder = await fixture(t);
  const failure = new Error('Native submission timed out; outcome unknown');
  const host = new FakeConnection([
    { method: 'thread/start', result: saved('retained-worker') },
    { method: 'turn/start', error: failure },
    { method: 'thread/resume', result: saved('retained-worker', [{ id: 'possibly-started', status: 'inProgress' }]) },
    { method: 'turn/steer', result: { turnId: 'possibly-started' } },
  ]);
  await assert.rejects(steerDirection(host, folder, { text: 'Develop.', fresh: true }), error => error === failure);
  assert.equal((await readDirection(folder)).workerId, 'retained-worker');
  await steerDirection(host, folder, { text: 'Explain what began.' });
  assert.equal(host.calls[2].params.threadId, 'retained-worker');
  assert.equal(host.calls.filter(call => call.method === 'thread/start').length, 1);
  host.complete();
});

test('a binding failure reports the created Worker without submitting, interrupting or disposing it', async t => {
  const folder = await fixture(t);
  const host = new FakeConnection([
    { method: 'thread/start', result: saved('unbound-created-worker'), inspect: async () => {
      await rm(path.join(folder, 'direction.sqlite'));
    } },
  ]);
  await assert.rejects(steerDirection(host, folder, { text: 'Develop.', fresh: true }), error => {
    assert.match(error.message, /Created Worker unbound-created-worker, but could not bind/);
    assert.equal(error.workerId, 'unbound-created-worker');
    assert.equal(error.threadId, 'unbound-created-worker');
    assert.equal(error.direction, folder);
    assert.equal(error.createdWorker, true);
    assert.ok(error.cause);
    return true;
  });
  assert.equal(host.calls.length, 1);
  host.complete();
});

test('invalid STEER inputs fail before any native host request', async t => {
  const folder = await fixture(t);
  const host = new FakeConnection();
  for (const options of [null, [], { text: '' }, { text: '   ' }, { text: 'x\0y' }, { text: 'Develop.', fresh: 'yes' },
    { text: 'Develop.', model: 'override-without-fresh' }, { text: 'Develop.', fresh: true, sandbox: 42 },
    { text: 'Develop.', forgeCommand: [] }, { text: 'Develop.', forgeCommand: ['node', ''] },
    { text: 'Develop.', forgeCommand: 'node forge.mjs' }]) {
    await assert.rejects(steerDirection(host, folder, options), TypeError);
  }
  await assert.rejects(steerDirection(host, '', { text: 'Develop.' }), TypeError);
  await assert.rejects(steerDirection(null, folder, { text: 'Develop.' }), TypeError);
  assert.equal(host.calls.length, 0);
});

test('independent Directions can select Workers against the same workspace and container', async t => {
  const firstFolder = await fixture(t, 'first-direction');
  const secondFolder = await fixture(t, 'second-direction');
  const firstHost = new FakeConnection([{ method: 'thread/start', result: saved('first-worker') }, turnStarted('first-turn')]);
  const secondHost = new FakeConnection([{ method: 'thread/start', result: saved('second-worker') }, turnStarted('second-turn')]);
  await Promise.all([
    steerDirection(firstHost, firstFolder, { text: 'Develop the parser.', fresh: true }),
    steerDirection(secondHost, secondFolder, { text: 'Improve documentation.', fresh: true }),
  ]);
  const first = await readDirection(firstFolder);
  const second = await readDirection(secondFolder);
  assert.equal(first.workspace, second.workspace);
  assert.equal(first.container, second.container);
  assert.equal(first.workerId, 'first-worker');
  assert.equal(second.workerId, 'second-worker');
  firstHost.complete();
  secondHost.complete();
});

test('container policy is sent explicitly and persisted Worker settings survive a different host default', async t => {
  const previous = { sandbox: process.env.FORGE_SANDBOX, approval: process.env.FORGE_APPROVAL_POLICY };
  t.after(() => {
    for (const [key, value] of [['FORGE_SANDBOX', previous.sandbox], ['FORGE_APPROVAL_POLICY', previous.approval]]) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  });
  process.env.FORGE_SANDBOX = 'danger-full-access';
  process.env.FORGE_APPROVAL_POLICY = 'never';
  const folder = await fixture(t);
  const initial = new FakeConnection([{ method: 'thread/start', result: saved('persistent-worker') }, turnStarted('first')]);
  await steerDirection(initial, folder, { text: 'Start the useful work.', fresh: true, model: 'chosen-model' });
  assert.deepEqual(initial.calls[0].params, { cwd: '/workspace/project', model: 'chosen-model', sandbox: 'danger-full-access', approvalPolicy: 'never' });
  assert.deepEqual((await readDirection(folder)).hostOptions, { model: 'chosen-model', sandbox: 'danger-full-access', approvalPolicy: 'never' });
  process.env.FORGE_SANDBOX = 'read-only';
  process.env.FORGE_APPROVAL_POLICY = 'on-request';
  const resumed = new FakeConnection([{ method: 'thread/resume', result: saved('persistent-worker') }, turnStarted('continued')]);
  await steerDirection(resumed, folder, { text: 'Continue using the selected settings.' });
  assert.deepEqual(resumed.calls[0].params, { threadId: 'persistent-worker', model: 'chosen-model', sandbox: 'danger-full-access', approvalPolicy: 'never' });
  initial.complete(); resumed.complete();
});

test('cooperative Direction stop preserves its scope, saved routing and request identity without authored documents', async t => {
  const folder = await fixture(t);
  const settings = { model: 'selected-model', sandbox: 'workspace-write', approvalPolicy: 'on-request' };
  await bindWorker(folder, 'selected-worker', {}, settings);
  await rm(path.join(folder, 'goal.md'));
  await rm(path.join(folder, 'checklist'), { recursive: true });
  const host = new FakeConnection([
    { method: 'thread/resume', result: saved('selected-worker', [{ id: 'active-turn', status: 'inProgress' }]) },
    { method: 'turn/steer', result: { turnId: 'active-turn' } },
  ]);
  const outcome = await stopDirection(host, folder, { reason: 'Director ends this stretch.' });
  assert.deepEqual(host.calls[0].params, { threadId: 'selected-worker', ...settings });
  assert.equal(host.calls[1].params.expectedTurnId, 'active-turn');
  const text = sentText(host.calls[1]);
  assert.match(text, /when this order is received/);
  assert.match(text, /only immediate settling actions/);
  assert.match(text, /explicit continuation instruction/);
  assert.ok(text.includes(outcome.requestId));
  assert.ok(text.endsWith('Director ends this stretch.'));
  assert.equal(outcome.outcome, 'message_submitted');
  assert.equal(outcome.workerId, 'selected-worker');
  assert.equal(outcome.direction, folder);
  assert.deepEqual(await readProgress(folder), []);
  host.complete();
});

test('invalid stop input and an absent Worker fail before native control; native failure retains selected identity', async t => {
  const folder = await fixture(t);
  const empty = new FakeConnection();
  for (const options of [null, [], { mode: 'kill' }, { reason: 42 }, { reason: 'a\0b' }]) {
    await assert.rejects(stopDirection(empty, folder, options), TypeError);
  }
  await assert.rejects(stopDirection(null, folder), TypeError);
  await assert.rejects(stopDirection(empty, ''), TypeError);
  await assert.rejects(stopDirection(empty, folder), /no selected Worker/);
  assert.equal(empty.calls.length, 0);
  await bindWorker(folder, 'selected-worker');
  const failure = new Error('Selected native context is unavailable');
  const host = new FakeConnection([{ method: 'thread/resume', error: failure }]);
  await assert.rejects(stopDirection(host, folder, { mode: 'interrupt' }), error => {
    assert.equal(error, failure);
    assert.equal(error.workerId, 'selected-worker');
    assert.equal(error.direction, folder);
    assert.equal(error.createdWorker, false);
    return true;
  });
  host.complete();
});
