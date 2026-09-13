import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

const html = await readFile(new URL('../apps/cockpit/index.html', import.meta.url), 'utf8');
const script = await readFile(new URL('../apps/cockpit/cockpit.js', import.meta.url), 'utf8');
const flush = () => new Promise(resolve => setImmediate(resolve));
const descendants = node => [node, ...node.children.flatMap(descendants)];

// A small event/DOM surface exercises the shipped script without a browser or host.
// Browser layout, native radio behavior and actual delivery remain operated checks.
async function fixture() {
  let document;
  class Element {
    constructor(tag = '') {
      Object.assign(this, { tagName: tag, children: [], handlers: new Map(), dataset: {}, value: '', checked: false,
        disabled: false, hidden: false, attributes: {}, classList: { add() {}, toggle() {} } });
    }
    append(...children) { for (const child of children) child.parentElement = this; this.children.push(...children); }
    replaceChildren(...children) { for (const child of this.children) child.parentElement = null; this.children = []; this.append(...children); }
    addEventListener(type, callback) { this.handlers.set(type, callback); }
    async emit(type) { return this.handlers.get(type)?.({ preventDefault() {} }); }
    setAttribute(name, value) { this.attributes[name] = value; }
    removeAttribute(name) { delete this.attributes[name]; }
    focus() { document.activeElement = this; }
    setSelectionRange() {}
    closest(selector) {
      for (let node = this; node; node = node.parentElement) if (node.className?.split(' ').includes(selector.slice(1))) return node;
      return null;
    }
  }
  const ids = new Map([...html.matchAll(/id="([^"]+)"/g)].map(([, id]) => [id, Object.assign(new Element(), { id })]));
  ids.get('worker-existing').value = 'existing'; ids.get('worker-fresh').value = 'fresh';
  const tabs = ['overview', 'checklist', 'diff'].map(tab => Object.assign(new Element('button'), { dataset: { tab } }));
  document = {
    hidden: false, activeElement: null, querySelector: selector => ids.get(selector.slice(1)),
    querySelectorAll: selector => selector === '[data-tab]' ? tabs : selector === '[name="worker-mode"]' ? [ids.get('worker-existing'), ids.get('worker-fresh')] : [],
    createElement: tag => new Element(tag), createTextNode: text => Object.assign(new Element(), { textContent: text }),
  };
  const server = { token: 'initial-token', patch: '', observed: 0, postFailure: null, sessionFailure: null, details: {}, pending: new Map(),
    directions: [
      { name: 'alpha', folder: '/directions/alpha', goal: 'Alpha goal', workerId: 'worker-alpha', workspace: '/workspace', container: 'test' },
      { name: 'beta', folder: '/directions/beta', goal: 'Beta goal', workerId: null, workspace: '/workspace', container: 'test' },
    ] };
  const calls = [], timeouts = [];
  let poll;
  const fetch = async (url, options) => {
    calls.push({ url, options });
    if (url === '/api/session' && server.sessionFailure) throw server.sessionFailure;
    if (options.method === 'POST') {
      assert.equal(options.headers['X-Forge-Token'], server.token, 'writes must use the current service token');
      if (server.postFailure) throw server.postFailure;
      return { ok: true, json: async () => ({ outcome: 'message_submitted', workerId: 'worker-alpha' }) };
    }
    let body;
    if (url === '/api/session') body = { token: server.token };
    else if (url === '/api/directions') body = { directions: server.directions, errors: [] };
    else if (url.startsWith('/api/directions/')) {
      const request = new URL(url, 'http://fixture');
      const name = request.pathname.split('/')[3];
      const direction = server.directions.find(direction => direction.name === name);
      const { goal, goalError, ...binding } = direction;
      const detail = server.details[name] || {};
      const progress = { progress: detail.progress || [], progressWindow: { latest: true, limit: 200 } };
      if (request.pathname.endsWith('/progress')) body = { ...progress, progress: detail.earlierProgress || [] };
      else if (request.searchParams.get('view') === 'overview') body = { ...binding, goal, goalError, ...progress };
      else if (request.searchParams.get('view') === 'checklist') body = { ...binding, checklist: detail.checklist || [], checklistError: detail.checklistError };
      else if (request.searchParams.get('view') === 'diff') body = binding;
      else throw new Error(`Unexpected Direction view: ${url}`);
    }
    else {
      const reference = new URL(url, 'http://fixture').searchParams.get('base');
      body = { available: true, patch: server.patch, status: '', untracked: [], observedAt: String(++server.observed), scope: 'Actual comparison scope',
        comparison: { reference, kind: reference === 'HEAD' ? 'uncommitted' : 'reference' } };
    }
    await server.pending.get(url);
    return { ok: true, json: async () => body };
  };
  vm.runInContext(script, vm.createContext({ document, fetch, setInterval(callback) { poll = callback; }, TextDecoder, Uint8Array, atob,
    AbortSignal: { timeout(ms) { timeouts.push(ms); return AbortSignal.timeout(ms); } } }));
  await flush();
  const select = async name => {
    const row = ids.get('direction-list').children.find(row => row.children[0]?.children[0]?.textContent === name);
    assert.ok(row, `Direction ${name} is visible`); await row.children[0].emit('click');
  };
  const writeDraft = async text => { ids.get('steer-text').value = text; await ids.get('steer-text').emit('input'); };
  const chooseFresh = async () => {
    ids.get('worker-fresh').checked = true; ids.get('worker-existing').checked = false;
    await ids.get('worker-fresh').emit('change');
  };
  return { ids, tabs, server, calls, timeouts, select, writeDraft, chooseFresh, poll: async () => { poll(); await flush(); } };
}

test('cockpit keeps each Direction draft and explicit Worker choice without dispatch during reads', async () => {
  const { ids, calls, select, writeDraft, chooseFresh } = await fixture();
  assert.equal(ids.get('worker-existing').checked, true, 'loaded bound Direction defaults Existing');
  assert.equal(ids.get('worker-fresh').checked, false);
  await writeDraft('Draft only for Alpha'); await chooseFresh();
  await ids.get('refresh').emit('click');
  assert.equal(ids.get('worker-fresh').checked, true, 'an explicit choice survives polling');
  await select('beta');
  assert.equal(ids.get('steer-text').value, '', 'Alpha text never becomes a Beta instruction');
  assert.equal(ids.get('worker-fresh').checked, true, 'confirmed unbound Direction defaults Fresh');
  await writeDraft('Draft only for Beta');
  await select('alpha');
  assert.equal(ids.get('steer-text').value, 'Draft only for Alpha');
  assert.equal(ids.get('worker-fresh').checked, true);
  await select('beta');
  assert.equal(ids.get('steer-text').value, 'Draft only for Beta');
  assert.equal(calls.some(call => call.options.method === 'POST'), false);
});

test('cockpit diff polling preserves controls and defers changed content while editing a reference', async () => {
  const { ids, tabs, server, calls } = await fixture();
  await tabs.find(tab => tab.dataset.tab === 'diff').emit('click'); await flush();
  const initial = ids.get('content').children[0];
  assert.ok(descendants(initial).some(node => node.textContent === 'Actual comparison scope'));
  const form = descendants(initial).find(node => node.className === 'diff-controls');
  const input = descendants(initial).find(node => node.id === 'diff-base');
  await ids.get('refresh').emit('click'); await flush();
  assert.equal(ids.get('content').children[0], initial, 'observedAt alone does not replace the DOM');
  input.value = 'feature-base'; await input.emit('input'); input.focus(); server.patch = 'changed patch';
  await ids.get('refresh').emit('click'); await flush();
  assert.equal(ids.get('content').children[0], initial, 'editing keeps its live input node');
  await form.emit('submit'); await flush();
  assert.notEqual(ids.get('content').children[0], initial, 'manual Compare applies while focused');
  assert.ok(calls.some(call => call.url === '/api/diff?base=feature-base'));
});

test('cockpit polls the visible view and reads earlier PROGRESS without fetching documents', async () => {
  const { ids, tabs, server, calls, poll } = await fixture();
  const account = { seq: 201, workerId: 'worker-alpha', body: 'Current authored account.' };
  server.details.alpha = { progress: [account], earlierProgress: [{ seq: 1, workerId: 'prior-worker', body: 'Earlier attributed account.' }] };
  let before = calls.length;
  await poll();
  assert.deepEqual(calls.slice(before).map(call => call.url), ['/api/directions', '/api/directions/alpha?view=overview']);
  assert.ok(descendants(ids.get('content')).some(node => node.textContent === account.body));
  const older = descendants(ids.get('content')).find(node => node.textContent === 'Load earlier PROGRESS');
  before = calls.length;
  await older.emit('click');
  assert.deepEqual(calls.slice(before).map(call => call.url), ['/api/directions/alpha/progress?before=201']);
  assert.ok(descendants(ids.get('content')).some(node => node.textContent === 'Earlier attributed account.'));

  await tabs.find(tab => tab.dataset.tab === 'checklist').emit('click');
  before = calls.length;
  await poll();
  assert.deepEqual(calls.slice(before).map(call => call.url), ['/api/directions', '/api/directions/alpha?view=checklist']);
  await tabs.find(tab => tab.dataset.tab === 'diff').emit('click'); await flush();
  before = calls.length;
  await poll();
  assert.deepEqual(calls.slice(before).map(call => call.url), ['/api/directions', '/api/directions/alpha?view=diff', '/api/diff?base=HEAD']);
  assert.equal(calls.some(call => call.options.method === 'POST'), false);
});

test('late PROGRESS pagination cannot render checklist data as an empty goal while Overview is loading', async () => {
  const { ids, tabs, server } = await fixture();
  server.details.alpha = { progress: [{ seq: 2, workerId: 'worker-alpha', body: 'Recent account.' }],
    earlierProgress: [{ seq: 1, workerId: 'prior-worker', body: 'Earlier account.' }] };
  await ids.get('refresh').emit('click');
  let finishProgress, finishOverview;
  server.pending.set('/api/directions/alpha/progress?before=2', new Promise(resolve => { finishProgress = resolve; }));
  const earlier = descendants(ids.get('content')).find(node => node.textContent === 'Load earlier PROGRESS').emit('click');
  await tabs.find(tab => tab.dataset.tab === 'checklist').emit('click');
  const checklist = ids.get('content').children[0];
  server.pending.set('/api/directions/alpha?view=overview', new Promise(resolve => { finishOverview = resolve; }));
  const overview = tabs.find(tab => tab.dataset.tab === 'overview').emit('click');
  finishProgress(); await earlier;
  assert.equal(ids.get('content').children[0], checklist, 'pagination waits for the requested view instead of using the previous view data');
  finishOverview(); await overview;
  const contents = descendants(ids.get('content'));
  assert.ok(contents.some(node => node.textContent === 'Alpha goal'));
  assert.ok(contents.some(node => node.textContent === 'Earlier account.'));
  assert.equal(contents.some(node => node.textContent === 'No goal text recorded.'), false);
});

test('cockpit shows document errors alongside authored accounts and the saved Worker without empty-document claims', async () => {
  const { ids, tabs, server, calls } = await fixture();
  Object.assign(server.directions[0], { goal: null, goalError: 'Cannot read goal.md' });
  const account = { seq: 1, workerId: 'prior-worker', body: 'An intact authored account.\r\n', inReplyTo: 'saved-steer' };
  server.details.alpha = { checklistError: 'Cannot read checklist folder', progress: [account] };
  await ids.get('refresh').emit('click');
  const overview = descendants(ids.get('content'));
  assert.ok(overview.some(node => node.textContent === 'Goal unavailable: Cannot read goal.md'));
  assert.ok(overview.some(node => node.textContent === account.body));
  assert.ok(overview.some(node => node.textContent === account.workerId));
  assert.ok(overview.some(node => node.textContent === 'In reply to saved-steer'));
  assert.equal(overview.some(node => node.textContent === 'No goal text recorded.'), false);
  assert.equal(ids.get('worker-badge').textContent, 'Worker · worker-alpha');
  assert.equal(ids.get('worker-existing').disabled, false);
  assert.equal(ids.get('worker-existing').checked, true);
  assert.equal(ids.get('steer-section').hidden, false);

  await tabs.find(tab => tab.dataset.tab === 'checklist').emit('click');
  const checklist = descendants(ids.get('content'));
  assert.ok(checklist.some(node => node.textContent === 'Checklist unavailable: Cannot read checklist folder'));
  assert.equal(checklist.some(node => node.textContent === 'An open checklist'), false);
  assert.equal(ids.get('worker-badge').textContent, 'Worker · worker-alpha');
  assert.equal(ids.get('steer-section').hidden, false);
  await tabs.find(tab => tab.dataset.tab === 'overview').emit('click');
  assert.ok(descendants(ids.get('content')).some(node => node.textContent === 'Goal unavailable: Cannot read goal.md'));
  assert.equal(calls.some(call => call.options.method === 'POST'), false);
});

test('cockpit refreshes a restarted service token before one POST and preserves drafts after uncertain failure', async () => {
  const { ids, server, calls, timeouts, writeDraft, chooseFresh, select } = await fixture();
  await writeDraft('Retain this instruction if delivery is uncertain.'); await chooseFresh();
  server.token = 'rotated-service-token';
  server.postFailure = new TypeError('Network failed after submission; outcome unknown');
  const before = calls.length;
  await ids.get('steer-form').emit('submit');
  const submitted = calls.slice(before);
  assert.equal(submitted[0].url, '/api/session');
  assert.equal(submitted[0].options.method, 'GET');
  assert.equal(submitted[1].options.method, 'POST');
  assert.equal(submitted[1].options.headers['X-Forge-Token'], 'rotated-service-token');
  assert.equal(submitted.filter(call => call.options.method === 'POST').length, 1, 'no automatic write retry');
  assert.equal(ids.get('steer-text').value, 'Retain this instruction if delivery is uncertain.');
  assert.equal(ids.get('worker-existing').checked, true, 'failure re-reads the existing binding');
  assert.equal(ids.get('send-steer').disabled, false);
  assert.match(ids.get('steer-result').textContent, /outcome unknown/);
  await select('beta'); await select('alpha');
  assert.equal(ids.get('steer-text').value, 'Retain this instruction if delivery is uncertain.');
  assert.ok(timeouts.includes(15000)); assert.ok(timeouts.includes(120000));
  server.sessionFailure = new TypeError('Session unavailable');
  const next = calls.length;
  await ids.get('steer-form').emit('submit');
  assert.equal(calls.slice(next).some(call => call.options.method === 'POST'), false, 'failed token retrieval never sends a write');
  assert.equal(ids.get('send-steer').disabled, false);
  assert.equal(ids.get('steer-text').value, 'Retain this instruction if delivery is uncertain.');
});
