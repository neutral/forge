import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import http from 'node:http';
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { promisify } from 'node:util';
import test from 'node:test';
import { startCockpit } from '../library/cockpit.mjs';
import { CodexConnection } from '../library/codex.mjs';
import { appendProgress, bindWorker, createDirection, readDirection, readProgress } from '../library/direction.mjs';

const execute = promisify(execFile);

async function fixture(t, { native = false, steerError } = {}) {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'forge-cockpit-test-')));
  const workspace = path.join(root, 'workspace');
  await mkdir(workspace);
  const directions = path.join(workspace, '.forge', 'directions');
  const calls = [];
  const mockSteer = async (folder, options) => {
    calls.push({ folder, options });
    if (steerError) throw steerError;
    return { kind: 'call_outcome', workerId: 'selected-worker', submitted: true };
  };
  const cockpit = await startCockpit({ workspace, directions, port: 0, ...(native ? {} : { sendSteer: mockSteer }) });
  t.after(async () => { await cockpit.close(); await rm(root, { recursive: true, force: true }); });
  const api = (route, { method = 'GET', headers = {}, value, raw } = {}) => new Promise((resolve, reject) => {
    const payload = raw ?? (value === undefined ? undefined : JSON.stringify(value));
    const request = http.request(`${cockpit.address.url}${route}`, { method, headers: {
      ...(payload !== undefined ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } : {}), ...headers,
    } }, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('error', reject);
      response.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let body = text;
        if (response.headers['content-type']?.startsWith('application/json')) body = JSON.parse(text);
        resolve({ status: response.statusCode, body, headers: response.headers });
      });
    });
    request.on('error', reject);
    request.end(payload);
  });
  const session = await api('/api/session');
  assert.equal(session.status, 200);
  const headers = { 'x-forge-token': session.body.token, origin: cockpit.address.url, 'sec-fetch-site': 'same-origin' };
  return { root, workspace, directions, calls, cockpit, api, headers, session };
}

async function setupGit(workspace) {
  const git = args => execute('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false',
    '-c', 'user.name=Forge test', '-c', 'user.email=forge@example.invalid', '-C', workspace, ...args],
  { env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' } });
  await git(['init', '-q']);
  return git;
}

test('cockpit reads stored Directions, byte-preserved checklist and progress without dispatching a Worker', async t => {
  const f = await fixture(t);
  const goal = 'Inspect exactly this scope.\r\n';
  const folder = path.join(f.directions, 'scope-a');
  await createDirection({ folder, goal, workspace: f.workspace });
  await bindWorker(folder, 'worker-before');
  const first = await appendProgress(folder, { workerId: 'worker-before', body: 'A recorded result; no current recheck.' });
  await bindWorker(folder, 'worker-current');
  const latest = await appendProgress(folder, { workerId: 'worker-current', body: 'Need an answer before continuing.', inReplyTo: 'steer-1' });
  const source = Buffer.from('- [ ] Rough concern\r\nRun $(touch forbidden)\n\xff', 'latin1');
  await writeFile(path.join(folder, 'checklist', 'rough.md'), source);
  const list = await f.api('/api/directions');
  assert.equal(list.status, 200);
  assert.equal(list.body.directions.length, 1);
  assert.equal(list.body.directions[0].goal, undefined);
  assert.equal(list.body.directions[0].workerId, 'worker-current');
  assert.equal(list.body.directions[0].latestProgress, undefined);
  assert.deepEqual(list.body.errors, []);
  const detail = await f.api('/api/directions/scope-a');
  assert.equal(detail.status, 200);
  assert.equal(detail.body.goal, goal);
  assert.deepEqual(detail.body.progress, [first, latest].map(record => ({ ...record, bodyTruncated: false })));
  assert.equal(detail.body.checklist, undefined);
  const checklist = await f.api('/api/directions/scope-a?view=checklist');
  assert.deepEqual(Buffer.from(checklist.body.checklist[0].content, 'base64'), source);
  assert.equal(checklist.body.checklist[0].truncated, false);
  assert.equal(checklist.body.goal, undefined);
  assert.equal(checklist.body.progress, undefined);
  const after = await f.api(`/api/directions/scope-a/progress?after=${first.seq}`);
  assert.deepEqual(after.body.progress, [{ ...latest, bodyTruncated: false }]);
  assert.equal(after.body.progressWindow.latest, false);
  assert.equal((await f.api('/api/directions/scope-a/progress?after=-1')).status, 400);
  assert.equal((await f.api('/api/directions/scope-a?view=unknown')).status, 400);
  await f.api('/api/diff');
  assert.deepEqual(f.calls, []);
  assert.equal(detail.headers['cache-control'], 'no-store');
  assert.match(detail.headers['content-security-policy'], /frame-ancestors 'none'/);
  assert.equal(detail.headers['x-content-type-options'], 'nosniff');
});

test('only an explicit authenticated STEER submits supplied text to the selected Direction', async t => {
  const f = await fixture(t);
  const create = await f.api('/api/directions', { method: 'POST', headers: f.headers, value: { name: 'selected', goal: 'Small independent goal.' } });
  assert.equal(create.status, 201);
  assert.equal(create.body.workerId, null);
  assert.deepEqual(f.calls, []);
  const text = '  Continue the selected work.\r\nPreserve this supplied context.\n';
  const response = await f.api('/api/directions/selected/steer', { method: 'POST', headers: f.headers, value: { text, fresh: true } });
  assert.equal(response.status, 200);
  assert.deepEqual(f.calls, [{ folder: path.join(f.directions, 'selected'), options: { text, fresh: true } }]);
  assert.deepEqual(response.body, { kind: 'call_outcome', workerId: 'selected-worker', submitted: true });
  assert.equal(response.body.host, undefined);
  assert.equal(response.body.transcript, undefined);
  assert.equal(response.body.output, undefined);
  await f.api('/api/directions/selected');
  await f.api('/api/directions');
  assert.equal(f.calls.length, 1);
  assert.equal((await f.api('/api/directions/selected/steer', { method: 'POST', headers: f.headers, value: { text, fresh: 'yes' } })).status, 400);
  assert.equal((await f.api('/api/directions/selected/steer', { method: 'POST', headers: f.headers, value: { text: ' ' } })).status, 400);
  assert.equal(f.calls.length, 1);
});

test('missing documents retain binding, authored progress and intact files without a host connection', async t => {
  let connections = 0;
  t.mock.method(CodexConnection, 'connect', async () => { connections++; throw new Error('Reading must not contact the host'); });
  const f = await fixture(t, { native: true });
  const folder = path.join(f.directions, 'available-accounts');
  const goal = 'Keep the supplied goal.\r\n';
  const hostOptions = { model: 'selected-model', sandbox: 'workspace-write', approvalPolicy: 'on-request' };
  await createDirection({ folder, goal, workspace: f.workspace, container: 'selected-container', hostUrl: 'ws://127.0.0.1:5678' });
  await bindWorker(folder, 'prior-worker');
  const first = await appendProgress(folder, { workerId: 'prior-worker', body: 'Earlier claim; unresolved.\r\n' });
  await bindWorker(folder, 'saved-worker', {}, hostOptions);
  const latest = await appendProgress(folder, { workerId: 'saved-worker', body: 'Saved account\0with exact contents.\r\n', inReplyTo: 'saved-request' });
  const expectedProgress = [first, latest].map(record => ({ ...record, bodyTruncated: false }));
  const expectedBinding = { folder, workspace: f.workspace, container: 'selected-container', hostUrl: 'ws://127.0.0.1:5678', workerId: 'saved-worker', hostOptions };
  const assertBinding = detail => {
    for (const [key, value] of Object.entries(expectedBinding)) assert.deepEqual(detail[key], value, key);
  };

  await rm(path.join(folder, 'checklist'), { recursive: true });
  const missingChecklist = await f.api('/api/directions/available-accounts?view=checklist');
  assert.equal(missingChecklist.status, 200);
  assertBinding(missingChecklist.body);
  assert.equal(missingChecklist.body.goal, undefined);
  assert.match(missingChecklist.body.checklistError, /ENOENT.*checklist/);
  assert.deepEqual(missingChecklist.body.checklist, []);
  const overview = (await f.api('/api/directions/available-accounts?view=overview')).body;
  assertBinding(overview);
  assert.deepEqual(overview.progress, expectedProgress);
  assert.equal(overview.goal, goal);
  assert.equal(overview.checklistError, undefined);
  assert.equal(await readFile(path.join(folder, 'goal.md'), 'utf8'), goal);
  await assert.rejects(lstat(path.join(folder, 'checklist')), { code: 'ENOENT' });

  await mkdir(path.join(folder, 'checklist'));
  const source = Buffer.from('- [ ] Keep this ordinary concern.\r\n');
  await writeFile(path.join(folder, 'checklist', 'concern.md'), source);
  await rm(path.join(folder, 'goal.md'));
  const missingGoal = await f.api('/api/directions/available-accounts');
  assert.equal(missingGoal.status, 200);
  assertBinding(missingGoal.body);
  assert.deepEqual(missingGoal.body.progress, expectedProgress);
  assert.equal(missingGoal.body.goal, null);
  assert.match(missingGoal.body.goalError, /ENOENT.*goal\.md/);
  assert.equal(missingGoal.body.checklistError, undefined);
  const checklist = (await f.api('/api/directions/available-accounts?view=checklist')).body;
  assertBinding(checklist);
  assert.deepEqual(Buffer.from(checklist.checklist[0].content, 'base64'), source);
  assert.equal(checklist.goal, undefined);
  assert.equal(checklist.goalError, undefined);
  const listing = await f.api('/api/directions');
  assert.equal(listing.body.directions.length, 1);
  const listed = listing.body.directions[0];
  assertBinding(listed);
  assert.equal(listed.goalError, undefined);
  assert.equal(listed.latestProgress, undefined);
  assert.deepEqual(listing.body.errors, []);

  await rm(path.join(folder, 'checklist'), { recursive: true });
  const missingBoth = await f.api('/api/directions/available-accounts');
  assert.equal(missingBoth.status, 200);
  assertBinding(missingBoth.body);
  assert.deepEqual(missingBoth.body.progress, expectedProgress);
  assert.match(missingBoth.body.goalError, /ENOENT.*goal\.md/);
  const diffBinding = (await f.api('/api/directions/available-accounts?view=diff')).body;
  assertBinding(diffBinding);
  for (const key of ['goal', 'goalError', 'checklist', 'checklistError', 'progress']) assert.equal(diffBinding[key], undefined);
  const page = await f.api('/api/directions/available-accounts/progress');
  assert.equal(page.status, 200);
  assert.deepEqual(page.body.progress, expectedProgress);
  assert.equal(page.body.goalError, undefined);
  assert.equal(page.body.checklistError, undefined);
  assert.equal((await f.api('/api/directions/available-accounts/progress?after=-1')).status, 400);
  assert.deepEqual(await readProgress(folder), [first, latest]);
  await assert.rejects(lstat(path.join(folder, 'goal.md')), { code: 'ENOENT' });
  await assert.rejects(lstat(path.join(folder, 'checklist')), { code: 'ENOENT' });
  assert.equal(connections, 0);
});

test('document access failures do not relax routing validation or prevent explicit STEER', async t => {
  const f = await fixture(t);
  const folder = path.join(f.directions, 'saved-binding');
  await createDirection({ folder, goal: 'Missing after initialization.', workspace: f.workspace });
  await bindWorker(folder, 'saved-worker');
  await rm(path.join(folder, 'goal.md'));
  const input = { text: 'Inspect the missing goal and explain the available work.' };
  const sent = await f.api('/api/directions/saved-binding/steer', { method: 'POST', headers: f.headers, value: input });
  assert.equal(sent.status, 200);
  assert.deepEqual(f.calls, [{ folder, options: { ...input, fresh: false } }]);

  const db = new DatabaseSync(path.join(folder, 'direction.sqlite'));
  try { db.prepare('UPDATE workers SET options_json = ? WHERE worker_id = ?').run('{invalid options', 'saved-worker'); }
  finally { db.close(); }
  const damaged = await f.api('/api/directions/saved-binding');
  assert.equal(damaged.status, 500);
  assert.match(damaged.body.error, /Invalid stored Worker host options/);
  for (const route of ['?view=checklist', '?view=diff', '/progress']) {
    const rejected = await f.api(`/api/directions/saved-binding${route}`);
    assert.equal(rejected.status, 500);
    assert.equal(rejected.body.error, damaged.body.error);
  }
  const listed = await f.api('/api/directions');
  assert.deepEqual(listed.body.directions, []);
  assert.match(listed.body.errors[0].error, /Invalid stored Worker host options/);
  const refused = await f.api('/api/directions/saved-binding/steer', { method: 'POST', headers: f.headers, value: input });
  assert.equal(refused.status, 500);
  assert.equal(f.calls.length, 1);
});

test('the native STEER adapter returns its submission outcome without forwarding host output', async t => {
  let connections = 0;
  let closed = 0;
  const nativeCalls = [];
  t.mock.method(CodexConnection, 'connect', async () => {
    connections++;
    return {
      request: async (method, params) => {
        nativeCalls.push({ method, params });
        if (method === 'thread/start') return { thread: { id: 'native-worker', turns: [], providerTranscript: 'RAW_PRIVATE_TRANSCRIPT' } };
        if (method === 'turn/start') return { turn: { id: 'native-turn', status: 'inProgress', items: [{ type: 'commandExecution', aggregatedOutput: 'RAW_PRIVATE_TOOL_OUTPUT' }] } };
        throw new Error(`Unexpected native request: ${method}`);
      },
      close: () => { closed++; },
    };
  });
  const f = await fixture(t, { native: true });
  await createDirection({ folder: path.join(f.directions, 'native'), goal: 'Direct native binding.', workspace: f.workspace });
  await f.api('/api/directions');
  await f.api('/api/directions/native');
  assert.equal(connections, 0);
  const response = await f.api('/api/directions/native/steer', { method: 'POST', headers: f.headers, value: { text: 'Start this scope.', fresh: true } });
  assert.equal(response.status, 200);
  assert.equal(response.body.outcome, 'message_submitted');
  assert.equal(response.body.workerId, 'native-worker');
  assert.deepEqual(nativeCalls.map(call => call.method), ['thread/start', 'turn/start']);
  assert.equal(connections, 1);
  assert.equal(closed, 1);
  assert.equal(response.body.host, undefined);
  assert.ok(!JSON.stringify(response.body).includes('RAW_PRIVATE_'));
  const detail = await f.api('/api/directions/native');
  assert.deepEqual(detail.body.progress, []);
  assert.equal(connections, 1);
});

test('an uncertain native submission preserves its Worker and request identity without retrying', async t => {
  const error = Object.assign(new Error('Native submission timed out; its delivery is unknown.'), {
    workerId: 'created-worker', createdWorker: true, direction: 'selected-direction', requestId: 'native-request',
    providerTranscript: 'RAW_PRIVATE_TRANSCRIPT',
  });
  const f = await fixture(t, { steerError: error });
  await createDirection({ folder: path.join(f.directions, 'uncertain'), goal: 'Retain uncertainty.', workspace: f.workspace });
  const response = await f.api('/api/directions/uncertain/steer', { method: 'POST', headers: f.headers, value: { text: 'Start once.', fresh: true } });
  assert.equal(response.status, 500);
  assert.deepEqual(response.body, { error: error.message, workerId: error.workerId, createdWorker: true, direction: error.direction, requestId: error.requestId });
  assert.equal(f.calls.length, 1);
  assert.ok(!JSON.stringify(response.body).includes('RAW_PRIVATE_'));
});

test('token, content type, Origin, Host and browser site boundaries reject unauthorized requests', async t => {
  const f = await fixture(t);
  const value = { name: 'never-created', goal: 'Should not be written.' };
  assert.match(f.session.body.token, /^[a-f0-9]{64}$/);
  assert.equal((await f.api('/api/directions', { method: 'POST', value })).status, 403);
  assert.equal((await f.api('/api/directions', { method: 'POST', headers: { ...f.headers, 'x-forge-token': 'x'.repeat(64) }, value })).status, 403);
  assert.equal((await f.api('/api/directions', { method: 'POST', headers: { ...f.headers, 'content-type': 'text/plain' }, value })).status, 415);
  for (const headers of [
    { ...f.headers, origin: 'https://unrelated.example' },
    { ...f.headers, host: 'unrelated.example' },
    { ...f.headers, 'sec-fetch-site': 'cross-site' },
    { ...f.headers, 'sec-fetch-site': 'same-site' },
  ]) {
    assert.equal((await f.api('/api/directions', { method: 'POST', headers, value })).status, 403);
    assert.equal((await f.api('/api/session', { headers })).status, 403);
  }
  assert.equal((await f.api('/api/directions', { method: 'POST', headers: f.headers, raw: '{bad' })).status, 400);
  assert.equal((await f.api('/api/directions', { method: 'POST', headers: f.headers, value: [] })).status, 400);
  assert.equal((await f.api('/api/directions', { method: 'POST', headers: f.headers, value: { ...value, goal: 'x'.repeat(256 * 1024) } })).status, 413);
  assert.deepEqual(await readdir(f.directions), []);
  assert.deepEqual(f.calls, []);
});

test('Direction selection refuses traversal and symlinks and reports missing or damaged records', async t => {
  const f = await fixture(t);
  const outside = await createDirection({ folder: path.join(f.root, 'outside'), goal: 'Outside material', workspace: f.workspace });
  await symlink(outside.folder, path.join(f.directions, 'alias'));
  assert.equal((await f.api('/api/directions/alias')).status, 400);
  assert.equal((await f.api('/api/directions/alias/steer', { method: 'POST', headers: f.headers, value: { text: 'Do not submit.' } })).status, 400);
  for (const name of ['../outside', '/absolute', 'nested/name', 'space name', '..', '', 'x'.repeat(81)]) {
    const response = await f.api('/api/directions', { method: 'POST', headers: f.headers, value: { name, goal: 'Wrong path.' } });
    assert.equal(response.status, 400, name);
  }
  for (const route of ['/api/directions/%2e%2e%2foutside', '/api/directions/%2Fabsolute', '/api/directions/%00', '/api/directions/%zz']) {
    assert.equal((await f.api(route)).status, 400, route);
  }
  assert.equal((await f.api('/api/directions/missing')).status, 404);
  assert.equal((await f.api('/unknown-route')).status, 404);
  await mkdir(path.join(f.directions, 'damaged'));
  assert.equal((await f.api('/api/directions/damaged')).status, 404);
  const listing = await f.api('/api/directions');
  assert.deepEqual(listing.body.directions, []);
  assert.equal(listing.body.errors[0].name, 'damaged');
  assert.equal((await readDirection(outside.folder)).goal, 'Outside material');
  assert.deepEqual(f.calls, []);
});

test('creation preserves existing material and STEER rejects a Direction belonging to another workspace', async t => {
  const f = await fixture(t);
  const folder = path.join(f.directions, 'existing');
  await createDirection({ folder, goal: 'Preserve this goal.', workspace: f.workspace });
  const duplicate = await f.api('/api/directions', { method: 'POST', headers: f.headers, value: { name: 'existing', goal: 'Replacement' } });
  assert.equal(duplicate.status, 409);
  assert.equal((await readDirection(folder)).goal, 'Preserve this goal.');
  const otherWorkspace = path.join(f.root, 'other-workspace');
  await mkdir(otherWorkspace);
  await createDirection({ folder: path.join(f.directions, 'other'), goal: 'Other workspace.', workspace: otherWorkspace });
  const response = await f.api('/api/directions/other/steer', { method: 'POST', headers: f.headers, value: { text: 'Wrong workspace.' } });
  assert.equal(response.status, 409);
  assert.deepEqual(f.calls, []);
});

test('unsupported Direction databases remain intact when cockpit inspection and STEER reject them', async t => {
  const f = await fixture(t);
  for (const version of [1, 3]) {
    const name = `unsupported-${version}`;
    const folder = path.join(f.directions, name);
    await createDirection({ folder, goal: 'Preserve the canonical goal.\r\n', workspace: f.workspace });
    await bindWorker(folder, 'saved-worker');
    await appendProgress(folder, { workerId: 'saved-worker', body: 'Preserve this attributed account.\r\n', inReplyTo: 'saved-request' });
    const checklist = path.join(folder, 'checklist', 'concern.md');
    await writeFile(checklist, '- [ ] Preserve the saved work.\r\n');
    const filename = path.join(folder, 'direction.sqlite');
    const db = new DatabaseSync(filename);
    try {
      if (version === 1) db.exec('ALTER TABLE workers DROP COLUMN options_json');
      db.exec(`PRAGMA user_version = ${version}`);
    } finally { db.close(); }
    const before = await readFile(filename);
    const detail = await f.api(`/api/directions/${name}`);
    assert.equal(detail.status, 500);
    assert.match(detail.body.error, new RegExp(`Unsupported Direction database schema.*version ${version}`));
    for (const route of ['?view=checklist', '?view=diff', '/progress']) {
      const rejected = await f.api(`/api/directions/${name}${route}`);
      assert.equal(rejected.status, 500);
      assert.equal(rejected.body.error, detail.body.error);
    }
    for (const fresh of [false, true]) {
      const sent = await f.api(`/api/directions/${name}/steer`, {
        method: 'POST', headers: f.headers, value: { text: 'Do not dispatch from unsupported storage.', fresh },
      });
      assert.equal(sent.status, 500);
      assert.equal(sent.body.error, detail.body.error);
    }
    const listing = await f.api('/api/directions');
    assert.deepEqual(listing.body.directions, []);
    assert.equal(listing.body.errors.find(entry => entry.name === name).error, detail.body.error);
    assert.deepEqual(await readFile(filename), before);
    assert.equal(await readFile(path.join(folder, 'goal.md'), 'utf8'), 'Preserve the canonical goal.\r\n');
    assert.equal(await readFile(checklist, 'utf8'), '- [ ] Preserve the saved work.\r\n');
  }
  assert.deepEqual(f.calls, []);
});

test('checklist display reports bounded content and skipped links without reading outside files', async t => {
  const f = await fixture(t);
  const folder = path.join(f.directions, 'bounded');
  await createDirection({ folder, goal: 'Display authored files.', workspace: f.workspace });
  const outside = path.join(f.root, 'private.txt');
  await writeFile(outside, 'Outside file must not appear.');
  await symlink(outside, path.join(folder, 'checklist', 'alias'));
  await writeFile(path.join(folder, 'checklist', 'large.txt'), 'x'.repeat(130 * 1024));
  const response = await f.api('/api/directions/bounded?view=checklist');
  assert.equal(response.status, 200);
  assert.deepEqual(response.body.checklist.find(file => file.path === 'alias'), { path: 'alias', skipped: 'symbolic link' });
  const large = response.body.checklist.find(file => file.path === 'large.txt');
  assert.equal(large.truncated, true);
  assert.equal(Buffer.from(large.content, 'base64').length, 128 * 1024);
  assert.ok(!JSON.stringify(response.body).includes('Outside file must not appear.'));
  await rm(path.join(folder, 'checklist'), { recursive: true });
  await symlink(f.root, path.join(folder, 'checklist'));
  const linked = await f.api('/api/directions/bounded?view=checklist');
  assert.equal(linked.status, 200);
  assert.match(linked.body.checklistError, /Choose the real checklist folder/);
  assert.deepEqual(linked.body.checklist, []);
  assert.equal(linked.body.workerId, null);
  assert.equal(linked.body.goal, undefined);
  assert.ok(!JSON.stringify(linked.body).includes('Outside file must not appear.'));
});

test('display limits are explicit and older progress remains queryable without invoking a Worker', async t => {
  const f = await fixture(t);
  const folder = path.join(f.directions, 'history');
  const goal = 'g'.repeat(140 * 1024);
  await createDirection({ folder, goal, workspace: f.workspace });
  await bindWorker(folder, 'worker');
  for (let index = 1; index <= 205; index++) {
    await appendProgress(folder, { workerId: 'worker', body: index === 205 ? 'p'.repeat(20 * 1024) : `Account ${index}` });
  }
  const listing = (await f.api('/api/directions')).body.directions[0];
  assert.equal(listing.goal, undefined);
  assert.equal(listing.workersOmitted, true);
  assert.equal(listing.latestProgress, undefined);
  const detail = (await f.api('/api/directions/history')).body;
  assert.equal(detail.goal.length, 128 * 1024);
  assert.equal(detail.goalTruncated, true);
  assert.equal(detail.progress.length, 200);
  assert.equal(detail.progress[0].seq, 6);
  assert.equal(detail.progress.at(-1).body.length, 16 * 1024);
  assert.equal(detail.progress.at(-1).bodyTruncated, true);
  const earlier = await f.api(`/api/directions/history/progress?before=${detail.progress[0].seq}`);
  assert.equal(earlier.status, 200);
  assert.deepEqual(earlier.body.progress.map(record => record.seq), [1, 2, 3, 4, 5]);
  assert.equal(earlier.body.progressWindow.latest, true);
  assert.equal((await f.api('/api/directions/history/progress?before=0')).status, 400);
  assert.equal((await readDirection(folder)).goal, goal);
  assert.deepEqual(f.calls, []);
});

test('Git inspection includes staged, unstaged and untracked files while disabling external diff and textconv', async t => {
  const f = await fixture(t);
  const git = await setupGit(f.workspace);
  await writeFile(path.join(f.workspace, 'tracked.txt'), 'original\n');
  await writeFile(path.join(f.workspace, '.gitattributes'), '*.txt diff=unsafe\n');
  await git(['add', 'tracked.txt', '.gitattributes']);
  await git(['commit', '-qm', 'Fixture']);
  await writeFile(path.join(f.workspace, 'tracked.txt'), 'staged change\n');
  await git(['add', 'tracked.txt']);
  await writeFile(path.join(f.workspace, 'tracked.txt'), 'working tree change\n');
  await writeFile(path.join(f.workspace, 'untracked.txt'), 'Inspect this untracked content.\n');
  await writeFile(path.join(f.workspace, 'binary.bin'), Buffer.from([0, 1, 2, 3]));
  const outside = path.join(f.root, 'outside.txt');
  await writeFile(outside, 'External symlink content stays outside.');
  await symlink(outside, path.join(f.workspace, 'linked.txt'));
  await createDirection({ folder: path.join(f.directions, 'inert'), goal: 'Direction data stays out of source diffs.', workspace: f.workspace });
  const marker = path.join(f.root, 'external-command-ran');
  const driver = path.join(f.root, 'unsafe-driver');
  await writeFile(driver, `#!/bin/sh\nprintf ran > '${marker}'\nprintf RAW_DRIVER_OUTPUT\n`);
  await chmod(driver, 0o700);
  await git(['config', 'diff.external', driver]);
  await git(['config', 'diff.unsafe.command', driver]);
  await git(['config', 'diff.unsafe.textconv', driver]);
  const result = await f.api('/api/diff');
  assert.equal(result.status, 200);
  assert.equal(result.body.available, true, result.body.error);
  assert.match(result.body.patch, /-original/);
  assert.match(result.body.patch, /\+working tree change/);
  assert.match(result.body.status, /MM tracked\.txt/);
  assert.equal(result.body.untracked.find(file => file.path === 'untracked.txt').content, 'Inspect this untracked content.\n');
  assert.deepEqual(result.body.untracked.find(file => file.path === 'binary.bin'), { path: 'binary.bin', binary: true, truncated: false });
  assert.equal(result.body.untracked.find(file => file.path === 'linked.txt').skipped, 'outside workspace');
  assert.ok(!result.body.status.includes('.forge'));
  assert.ok(!JSON.stringify(result.body).includes('RAW_DRIVER_OUTPUT'));
  await assert.rejects(lstat(marker), { code: 'ENOENT' });
  assert.deepEqual(f.calls, []);
});

test('Git inspection suppresses clean and process filters and does not inspect nested submodule work', async t => {
  const f = await fixture(t);
  const git = await setupGit(f.workspace);
  await writeFile(path.join(f.workspace, '.gitattributes'), '*.txt filter=clean-danger\n*.data filter=process-danger\n');
  await writeFile(path.join(f.workspace, 'tracked.txt'), 'original text\n');
  await writeFile(path.join(f.workspace, 'tracked.data'), 'original data\n');
  const nested = path.join(f.workspace, 'nested');
  await mkdir(nested);
  const nestedGit = await setupGit(nested);
  await writeFile(path.join(nested, '.gitattributes'), '*.txt filter=nested-danger\n');
  await writeFile(path.join(nested, 'nested.txt'), 'original nested\n');
  await nestedGit(['add', '.']);
  await nestedGit(['commit', '-qm', 'Nested fixture']);
  await writeFile(path.join(f.workspace, '.gitmodules'), '[submodule "nested"]\n\tpath = nested\n\turl = ./nested\n');
  await git(['add', '.gitattributes', '.gitmodules', 'tracked.txt', 'tracked.data', 'nested']);
  await git(['commit', '-qm', 'Fixture with nested repository']);
  const markers = [];
  for (const [label, configure, key, tail] of [
    ['clean', git, 'filter.clean-danger.clean', 'cat'],
    ['process', git, 'filter.process-danger.process', 'exit 1'],
    ['nested', nestedGit, 'filter.nested-danger.clean', 'cat'],
    ['fsmonitor', git, 'core.fsmonitor', 'exit 0'],
  ]) {
    const marker = path.join(f.root, `${label}-ran`);
    const driver = path.join(f.root, `${label}-driver`);
    markers.push(marker);
    await writeFile(driver, `#!/bin/sh\nprintf ran > '${marker}'\n${tail}\n`);
    await chmod(driver, 0o700);
    await configure(['config', key, driver]);
  }
  await git(['config', 'filter.process-danger.required', 'true']);
  await git(['config', 'diff.submodule', 'diff']);
  await writeFile(path.join(f.workspace, 'tracked.txt'), 'changed text\n');
  await writeFile(path.join(f.workspace, 'tracked.data'), 'changed data\n');
  await writeFile(path.join(nested, 'nested.txt'), 'nested change must stay outside this diff\n');
  const result = await f.api('/api/diff');
  assert.equal(result.status, 200);
  assert.equal(result.body.available, true, result.body.error);
  assert.match(result.body.patch, /\+changed text/);
  assert.match(result.body.patch, /\+changed data/);
  assert.ok(!JSON.stringify(result.body).includes('nested change must stay outside this diff'));
  assert.match(result.body.scope, /nested submodule working changes.*omitted/);
  for (const marker of markers) await assert.rejects(lstat(marker), { code: 'ENOENT' });
  assert.deepEqual(f.calls, []);
});

test('Git inspection handles an unborn repository and missing Git metadata without changing files', async t => {
  const f = await fixture(t);
  await writeFile(path.join(f.workspace, 'ordinary.txt'), 'Still readable without Git.');
  const unavailable = await f.api('/api/diff');
  assert.equal(unavailable.status, 200);
  assert.equal(unavailable.body.available, false);
  const git = await setupGit(f.workspace);
  await git(['add', 'ordinary.txt']);
  await writeFile(path.join(f.workspace, 'ordinary.txt'), 'Changed after staging.');
  const unborn = await f.api('/api/diff');
  assert.equal(unborn.body.available, true, unborn.body.error);
  assert.match(unborn.body.patch, /Still readable without Git/);
  assert.match(unborn.body.patch, /Changed after staging/);
  assert.equal(await readFile(path.join(f.workspace, 'ordinary.txt'), 'utf8'), 'Changed after staging.');
  assert.deepEqual(f.calls, []);
});

test('a selected Git ref compares committed and working changes while default HEAD reports uncommitted work', async t => {
  const f = await fixture(t);
  const git = await setupGit(f.workspace);
  await writeFile(path.join(f.workspace, 'source.txt'), 'initial source\n');
  await git(['add', 'source.txt']);
  await git(['commit', '-qm', 'Initial source']);
  const initialCommit = (await git(['rev-parse', 'HEAD'])).stdout.trim();
  await git(['tag', 'review-start']);
  await writeFile(path.join(f.workspace, 'source.txt'), 'committed improvement\n');
  await git(['add', 'source.txt']);
  await git(['commit', '-qm', 'Improve source']);
  const currentCommit = (await git(['rev-parse', 'HEAD'])).stdout.trim();
  const clean = await f.api('/api/diff');
  assert.equal(clean.body.available, true);
  assert.equal(clean.body.patch, '');
  assert.deepEqual(clean.body.comparison, { reference: 'HEAD', commit: currentCommit, kind: 'uncommitted', unborn: false });
  const committed = await f.api('/api/diff?base=review-start');
  assert.equal(committed.body.available, true);
  assert.match(committed.body.patch, /-initial source/);
  assert.match(committed.body.patch, /\+committed improvement/);
  assert.deepEqual(committed.body.comparison, { reference: 'review-start', commit: initialCommit, kind: 'reference', unborn: false });
  await writeFile(path.join(f.workspace, 'source.txt'), 'committed improvement\nworking extension\n');
  await writeFile(path.join(f.workspace, 'new.txt'), 'untracked addition');
  const selected = await f.api(`/api/diff?base=${initialCommit}`);
  assert.equal(selected.body.available, true);
  assert.match(selected.body.patch, /-initial source/);
  assert.match(selected.body.patch, /\+committed improvement/);
  assert.match(selected.body.patch, /\+working extension/);
  assert.equal(selected.body.untracked.find(file => file.path === 'new.txt').content, 'untracked addition');
  assert.deepEqual(selected.body.comparison, { reference: initialCommit, commit: initialCommit, kind: 'reference', unborn: false });
  const uncommitted = await f.api('/api/diff');
  assert.ok(!uncommitted.body.patch.includes('-initial source'));
  assert.match(uncommitted.body.patch, /\+working extension/);
  const before = await readFile(path.join(f.workspace, 'source.txt'), 'utf8');
  const marker = path.join(f.root, 'invalid-reference-ran');
  for (const reference of ['does-not-exist', '--help', '--output=reference-output', `$(touch ${marker})`, 'review-start; touch reference-output']) {
    const response = await f.api(`/api/diff?base=${encodeURIComponent(reference)}`);
    assert.equal(response.status, 200, reference);
    assert.equal(response.body.available, false, reference);
    assert.match(response.body.error, /reference does not resolve/);
  }
  assert.equal((await f.api('/api/diff?base=')).status, 400);
  assert.equal((await f.api('/api/diff?base=%00')).status, 400);
  await assert.rejects(lstat(marker), { code: 'ENOENT' });
  await assert.rejects(lstat(path.join(f.workspace, 'reference-output')), { code: 'ENOENT' });
  assert.equal(await readFile(path.join(f.workspace, 'source.txt'), 'utf8'), before);
  assert.deepEqual(f.calls, []);
});
