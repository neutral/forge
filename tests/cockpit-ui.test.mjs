import assert from 'node:assert/strict';
import test from 'node:test';
import { Cockpit, draftOf, placeFrom, searchOf, workerModeOf } from '../apps/cockpit-source/src/cockpit.ts';
import { decodeFile, patchLine, workerState } from '../apps/cockpit-source/src/presentation.ts';

const flush = () => new Promise(resolve => setImmediate(resolve));

// The cockpit's state store runs here against a fake Forge server, without a browser or host.
// The browser test (tests/cockpit.browser.spec.mjs) draws the same store; actual delivery
// remains an operated check.
async function fixture({ search = '' } = {}) {
  const server = { token: 'initial-token', patch: '', observed: 0, postFailure: null, sessionFailure: null, details: {}, pending: new Map(),
    directions: [
      { name: 'alpha', folder: '/directions/alpha', goal: 'Alpha goal', workerId: 'worker-alpha', workspace: '/workspace', container: 'test' },
      { name: 'beta', folder: '/directions/beta', goal: 'Beta goal', workerId: null, workspace: '/workspace', container: 'test' },
    ] };
  const calls = [], timeouts = [], history = [];
  let poll, popState, url = `/${search}`;
  const fetch = async (requested, options) => {
    calls.push({ url: requested, options });
    if (requested === '/api/session' && server.sessionFailure) throw server.sessionFailure;
    if (options.method === 'POST') {
      assert.equal(options.headers['X-Forge-Token'], server.token, 'writes must use the current service token');
      if (server.postFailure) throw server.postFailure;
      return { ok: true, json: async () => ({ outcome: 'message_submitted', workerId: 'worker-alpha' }) };
    }
    let body;
    if (requested === '/api/session') body = { token: server.token };
    else if (requested === '/api/directions') body = { directions: server.directions, errors: [] };
    else if (requested.startsWith('/api/directions/')) {
      const request = new URL(requested, 'http://fixture');
      const name = request.pathname.split('/')[3];
      const direction = server.directions.find(direction => direction.name === name);
      const { goal, goalError, ...binding } = direction;
      const detail = server.details[name] || {};
      const progress = { progress: detail.progress || [], progressWindow: { latest: true, limit: 200 } };
      if (request.pathname.endsWith('/progress')) body = { ...progress, progress: detail.earlierProgress || [] };
      else if (request.searchParams.get('view') === 'overview') body = { ...binding, goal, goalError, ...progress };
      else if (request.searchParams.get('view') === 'checklist') body = { ...binding, checklist: detail.checklist || [], checklistError: detail.checklistError };
      else if (request.searchParams.get('view') === 'diff') body = binding;
      else throw new Error(`Unexpected Direction view: ${requested}`);
    } else {
      const reference = new URL(requested, 'http://fixture').searchParams.get('base');
      body = { available: true, patch: server.patch, status: '', untracked: [], observedAt: String(++server.observed), scope: 'Actual comparison scope',
        comparison: { reference, kind: reference === 'HEAD' ? 'uncommitted' : 'reference' } };
    }
    await server.pending.get(requested);
    return { ok: true, json: async () => body };
  };
  const cockpit = new Cockpit({
    fetch, now: () => new Date('2026-11-12T12:00:00Z'), isHidden: () => false,
    timeout(ms) { timeouts.push(ms); return AbortSignal.timeout(ms); },
    setInterval(callback) { poll = callback; return 1; }, clearInterval() {},
    location: {
      read: () => placeFrom(url.slice(1)),
      write(place, mode) { url = `/${searchOf(place)}`; history.push([mode, url]); },
    },
    onPopState(listener) { popState = listener; return () => {}; },
    assign(href) { history.push(['assign', href]); }, focus(id) { history.push(['focus', id]); },
  });
  await cockpit.start(); await flush();
  const writeDraft = text => cockpit.setDraftText(text);
  const chooseFresh = () => cockpit.setWorkerMode('fresh');
  return { cockpit, server, calls, timeouts, history, writeDraft, chooseFresh, state: () => cockpit.state,
    poll: async () => { poll(); await flush(); },
    back: async target => { url = target; popState(); await flush(); await flush(); } };
}

test('cockpit keeps each Direction draft and explicit Worker choice without dispatch during reads', async () => {
  const { cockpit, calls, writeDraft, chooseFresh, state } = await fixture();
  assert.equal(workerModeOf(state()), 'existing', 'loaded bound Direction defaults Existing');
  writeDraft('Draft only for Alpha'); chooseFresh();
  await cockpit.refresh();
  assert.equal(workerModeOf(state()), 'fresh', 'an explicit choice survives polling');
  await cockpit.selectDirection('beta');
  assert.equal(draftOf(state()).text, '', 'Alpha text never becomes a Beta instruction');
  assert.equal(workerModeOf(state()), 'fresh', 'confirmed unbound Direction defaults Fresh');
  writeDraft('Draft only for Beta');
  await cockpit.selectDirection('alpha');
  assert.equal(draftOf(state()).text, 'Draft only for Alpha');
  assert.equal(workerModeOf(state()), 'fresh');
  await cockpit.selectDirection('beta');
  assert.equal(draftOf(state()).text, 'Draft only for Beta');
  assert.equal(calls.some(call => call.options.method === 'POST'), false);
});

test('cockpit diff polling preserves the drafted reference and defers changed content while editing it', async () => {
  const { cockpit, server, calls, state } = await fixture();
  await cockpit.selectView('diff'); await flush();
  const initial = state().diff;
  assert.equal(initial.scope, 'Actual comparison scope');
  await cockpit.refresh(); await flush();
  assert.equal(state().diff, initial, 'observedAt alone does not replace the comparison');
  cockpit.setDiffDraft('feature-base'); cockpit.setDiffEditing(true); server.patch = 'changed patch';
  await cockpit.refresh(); await flush();
  assert.equal(state().diff, initial, 'editing keeps the shown comparison');
  assert.equal(state().diffDraft, 'feature-base', 'polling keeps the drafted reference');
  assert.equal(cockpit.compare(), true); await flush();
  assert.notEqual(state().diff, initial, 'manual Compare applies while editing');
  assert.equal(state().diff.patch, 'changed patch');
  assert.ok(calls.some(call => call.url === '/api/diff?base=feature-base'));
  cockpit.setDiffDraft('  '); assert.equal(cockpit.compare(), false, 'an empty reference is not compared');
});

test('a comparison deferred while editing appears when editing ends', async () => {
  const { cockpit, server, state } = await fixture();
  await cockpit.selectView('diff'); await flush();
  const initial = state().diff;
  cockpit.setDiffEditing(true); server.patch = 'later patch';
  await cockpit.refresh(); await flush();
  assert.equal(state().diff, initial);
  cockpit.setDiffEditing(false);
  assert.equal(state().diff.patch, 'later patch');
});

test('cockpit polls the visible view and reads earlier PROGRESS without fetching documents', async () => {
  const { cockpit, server, calls, poll, state } = await fixture();
  const account = { seq: 201, workerId: 'worker-alpha', body: 'Current authored account.' };
  server.details.alpha = { progress: [account], earlierProgress: [{ seq: 1, workerId: 'prior-worker', body: 'Earlier attributed account.' }] };
  let before = calls.length;
  await poll();
  assert.deepEqual(calls.slice(before).map(call => call.url), ['/api/directions', '/api/directions/alpha?view=overview']);
  assert.ok(state().progress.some(record => record.body === account.body));
  before = calls.length;
  await cockpit.loadOlderProgress();
  assert.deepEqual(calls.slice(before).map(call => call.url), ['/api/directions/alpha/progress?before=201']);
  assert.deepEqual(state().progress.map(record => record.body), ['Current authored account.', 'Earlier attributed account.'], 'newest first');

  await cockpit.selectView('checklist');
  before = calls.length;
  await poll();
  assert.deepEqual(calls.slice(before).map(call => call.url), ['/api/directions', '/api/directions/alpha?view=checklist']);
  await cockpit.selectView('diff'); await flush();
  before = calls.length;
  await poll();
  assert.deepEqual(calls.slice(before).map(call => call.url), ['/api/directions', '/api/directions/alpha?view=diff', '/api/diff?base=HEAD']);
  assert.equal(calls.some(call => call.options.method === 'POST'), false);
});

test('an empty earlier page marks the first stored account', async () => {
  const { cockpit, server, state } = await fixture();
  server.details.alpha = { progress: [{ seq: 3, workerId: 'worker-alpha', body: 'Only account.' }], earlierProgress: [] };
  await cockpit.refresh();
  await cockpit.loadOlderProgress();
  assert.equal(state().historyDone, true);
  assert.equal(state().loadingOlder, false);
});

test('late PROGRESS pagination cannot render checklist data as an empty goal while Overview is loading', async () => {
  const { cockpit, server, state } = await fixture();
  server.details.alpha = { progress: [{ seq: 2, workerId: 'worker-alpha', body: 'Recent account.' }],
    earlierProgress: [{ seq: 1, workerId: 'prior-worker', body: 'Earlier account.' }] };
  await cockpit.refresh();
  let finishProgress, finishOverview;
  server.pending.set('/api/directions/alpha/progress?before=2', new Promise(resolve => { finishProgress = resolve; }));
  const earlier = cockpit.loadOlderProgress();
  await cockpit.selectView('checklist');
  const checklist = state().detail;
  server.pending.set('/api/directions/alpha?view=overview', new Promise(resolve => { finishOverview = resolve; }));
  const overview = cockpit.selectView('overview');
  finishProgress(); await earlier;
  assert.equal(state().tab, 'overview');
  assert.equal(state().detailTab, 'checklist', 'Overview waits for its own reading instead of using the previous view data');
  assert.equal(state().detail, checklist);
  finishOverview(); await overview;
  assert.equal(state().detailTab, 'overview');
  assert.equal(state().detail.goal, 'Alpha goal');
  assert.ok(state().progress.some(record => record.body === 'Earlier account.'));
});

test('cockpit shows document errors alongside authored accounts and the saved Worker without empty-document claims', async () => {
  const { cockpit, server, calls, state } = await fixture();
  Object.assign(server.directions[0], { goal: null, goalError: 'Cannot read goal.md' });
  const account = { seq: 1, workerId: 'prior-worker', body: 'An intact authored account.\r\n', inReplyTo: 'saved-steer' };
  server.details.alpha = { checklistError: 'Cannot read checklist folder', progress: [account] };
  await cockpit.refresh();
  assert.equal(state().detail.goalError, 'Cannot read goal.md');
  assert.equal(state().detail.goal, null, 'an unreadable goal is not an empty goal');
  assert.deepEqual(state().progress, [account], 'stored PROGRESS stays readable and byte-exact');
  assert.equal(state().detail.workerId, 'worker-alpha');
  assert.equal(workerModeOf(state()), 'existing');

  await cockpit.selectView('checklist');
  assert.equal(state().detail.checklistError, 'Cannot read checklist folder');
  assert.equal(state().detail.workerId, 'worker-alpha', 'the binding stays beside a checklist error');
  await cockpit.selectView('overview');
  assert.equal(state().detail.goalError, 'Cannot read goal.md');
  assert.equal(calls.some(call => call.options.method === 'POST'), false);
});

test('cockpit refreshes a restarted service token before one POST and preserves drafts after uncertain failure', async () => {
  const { cockpit, server, calls, timeouts, writeDraft, chooseFresh, state } = await fixture();
  writeDraft('Retain this instruction if delivery is uncertain.'); chooseFresh();
  server.token = 'rotated-service-token';
  server.postFailure = new TypeError('Network failed after submission; outcome unknown');
  const before = calls.length;
  assert.equal(await cockpit.sendSteer(), 'failed');
  const submitted = calls.slice(before);
  assert.equal(submitted[0].url, '/api/session');
  assert.equal(submitted[0].options.method, 'GET');
  assert.equal(submitted[1].options.method, 'POST');
  assert.equal(submitted[1].options.headers['X-Forge-Token'], 'rotated-service-token');
  assert.deepEqual(JSON.parse(submitted[1].options.body), { text: 'Retain this instruction if delivery is uncertain.', fresh: true });
  assert.equal(submitted.filter(call => call.options.method === 'POST').length, 1, 'no automatic write retry');
  assert.equal(draftOf(state()).text, 'Retain this instruction if delivery is uncertain.');
  assert.equal(workerModeOf(state()), 'existing', 'failure re-reads the existing binding');
  assert.equal(state().sending, false);
  assert.match(state().steerResult.text, /outcome unknown/);
  assert.equal(state().steerResult.error, true);
  await cockpit.selectDirection('beta'); await cockpit.selectDirection('alpha');
  assert.equal(draftOf(state()).text, 'Retain this instruction if delivery is uncertain.');
  assert.ok(timeouts.includes(15000)); assert.ok(timeouts.includes(120000));
  server.sessionFailure = new TypeError('Session unavailable');
  const next = calls.length;
  await cockpit.sendSteer();
  assert.equal(calls.slice(next).some(call => call.options.method === 'POST'), false, 'failed token retrieval never sends a write');
  assert.equal(state().sending, false);
  assert.equal(draftOf(state()).text, 'Retain this instruction if delivery is uncertain.');
});

test('a submitted STEER clears its unchanged draft and reports the host outcome apart from PROGRESS', async () => {
  const { cockpit, calls, writeDraft, state } = await fixture();
  assert.equal(await cockpit.sendSteer(), 'empty', 'an empty draft is not sent');
  writeDraft('Explain the remaining checklist concerns.');
  assert.equal(await cockpit.sendSteer(), 'sent');
  assert.equal(calls.filter(call => call.options.method === 'POST').length, 1);
  assert.equal(draftOf(state()).text, '');
  assert.equal(state().steerResult.error, false);
  assert.match(state().steerResult.text, /^STEER submitted for alpha\. Worker: worker-alpha\. Authored results appear in PROGRESS\.$/);
});

test('the URL holds the selected Direction, view and reference, and back restores them', async () => {
  const { cockpit, history, state, back } = await fixture({ search: '?direction=beta&view=checklist' });
  assert.equal(state().active, 'beta', 'the URL selects its Direction on load');
  assert.equal(state().tab, 'checklist');
  assert.deepEqual(history[0], ['replace', '/?direction=beta&view=checklist'], 'the first selection replaces rather than adds history');
  await cockpit.selectDirection('alpha');
  assert.deepEqual(history.at(-1), ['push', '/?direction=alpha']);
  await cockpit.selectView('diff'); await flush();
  cockpit.setDiffDraft('main'); cockpit.compare(); await flush();
  assert.deepEqual(history.at(-1), ['push', '/?direction=alpha&view=diff&base=main']);
  await back('/?direction=beta&view=checklist');
  assert.equal(state().active, 'beta');
  assert.equal(state().tab, 'checklist');
  assert.equal(state().diffBase, 'HEAD');
  await back('/?direction=alpha&view=diff&base=main');
  assert.equal(state().active, 'alpha');
  assert.equal(state().tab, 'diff');
  assert.equal(state().diff.comparison.reference, 'main');
});

test('a URL naming no listed Direction selects the first one', async () => {
  const { state, history } = await fixture({ search: '?direction=missing' });
  assert.equal(state().active, 'alpha');
  assert.deepEqual(history[0], ['replace', '/?direction=alpha']);
});

test('links leave the cockpit by ordinary navigation, and in-page links move focus', async () => {
  const { cockpit, history } = await fixture();
  cockpit.follow('#main'); cockpit.follow('/');
  assert.deepEqual(history.slice(-2), [['focus', 'main'], ['assign', '/']]);
});

test('creating a Direction sends one explicit request and selects it without starting a Worker', async () => {
  const { cockpit, server, calls, state } = await fixture();
  cockpit.openCreate(); cockpit.setCreateName(' gamma '); cockpit.setCreateGoal('Gamma goal');
  server.directions.push({ name: 'gamma', folder: '/directions/gamma', goal: 'Gamma goal', workerId: null, workspace: '/workspace', container: 'test' });
  await cockpit.createDirection();
  const posts = calls.filter(call => call.options.method === 'POST');
  assert.deepEqual(posts.map(call => [call.url, JSON.parse(call.options.body)]), [['/api/directions', { name: 'gamma', goal: 'Gamma goal' }]]);
  assert.equal(state().createOpen, false);
  assert.equal(state().createName, '');
  assert.equal(state().active, 'gamma');
  assert.equal(workerModeOf(state()), 'fresh');
});

test('a refused Direction keeps the dialog and its fields with the error', async () => {
  const { cockpit, server, state } = await fixture();
  server.postFailure = new Error('Direction name must use 1–80 letters');
  cockpit.openCreate(); cockpit.setCreateName('bad name'); cockpit.setCreateGoal('Goal');
  await cockpit.createDirection();
  assert.equal(state().createOpen, true);
  assert.equal(state().createName, 'bad name');
  assert.match(state().createError, /1–80 letters/);
  cockpit.closeCreate(); cockpit.openCreate();
  assert.equal(state().createError, '', 'reopening clears the error and keeps the fields');
  assert.equal(state().createGoal, 'Goal');
});

test('the selected Worker is a mark and a word, as the Directions list says it', () => {
  assert.deepEqual(workerState({ workerId: 'w' }), { mark: '●', word: 'Worker selected', attend: false });
  assert.deepEqual(workerState({ workerId: null }), { mark: '○', word: 'No Worker selected', attend: false });
});

test('stored files keep their bytes: valid UTF-8 is text, anything else is binary', () => {
  assert.deepEqual(decodeFile({ path: 'a', encoding: 'base64', content: Buffer.from('- [ ] Concern\r\n').toString('base64') }), { text: '- [ ] Concern\r\n' });
  assert.deepEqual(decodeFile({ path: 'b', encoding: 'base64', content: Buffer.from([0xff, 0x00]).toString('base64') }), { binary: true });
  assert.deepEqual(['diff --git a b', '+++ b/x', '+add', '-remove', '@@ -1 +1 @@', ' same'].map(patchLine), ['file', 'file', 'added', 'removed', 'hunk', 'context']);
});
