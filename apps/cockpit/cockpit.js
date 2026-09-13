(() => {
  'use strict';
  const $ = selector => document.querySelector(selector);
  const state = { token: null, directions: [], active: null, detail: null, detailTab: null, tab: 'overview', refreshing: false, sending: false, detailSequence: 0, listSignature: '', detailSignature: '', progress: new Map(), historyDone: false, loadingOlder: false, drafts: new Map(), diffBase: 'HEAD', diffDraft: 'HEAD', diffRoot: null, diffSignature: null };

  function draftFor(name) {
    if (!state.drafts.has(name)) state.drafts.set(name, { text: '', workerMode: null });
    return state.drafts.get(name);
  }
  function restoreWorkerChoice() {
    const detail = state.detail;
    $('#worker-existing').disabled = !detail?.workerId;
    if (!detail) return;
    const preferred = draftFor(state.active).workerMode;
    const mode = detail.workerId ? preferred || 'existing' : 'fresh';
    $('#worker-existing').checked = mode === 'existing';
    $('#worker-fresh').checked = mode === 'fresh';
  }

  function element(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = String(text);
    return node;
  }
  function notice(node, message, error = false) {
    node.textContent = message || '';
    node.hidden = !message;
    node.classList.toggle('notice-error', error);
  }
  async function api(url, body) {
    // A service restart rotates the token. Refresh it before an explicit write;
    // never retry the write itself when delivery is uncertain.
    if (body !== undefined) state.token = (await api('/api/session')).token;
    const response = await fetch(url, { method: body === undefined ? 'GET' : 'POST', credentials: 'same-origin',
      signal: AbortSignal.timeout(body === undefined ? 15000 : 120000),
      headers: body === undefined ? { Accept: 'application/json' } : { Accept: 'application/json', 'Content-Type': 'application/json', 'X-Forge-Token': state.token },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    let data;
    try { data = await response.json(); } catch { throw new Error(`The server returned an unreadable response (${response.status}).`); }
    if (!response.ok) throw Object.assign(new Error(data.error || `Request failed (${response.status}).`), { response: data });
    return data;
  }
  const directionURL = name => `/api/directions/${encodeURIComponent(name)}`;
  function time(value) {
    if (!value) return 'Time unavailable';
    const date = new Date(value);
    return Number.isNaN(date.valueOf()) ? String(value) : date.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  }
  function panel(title, eyebrow) {
    const root = element('section', 'panel');
    const heading = element('div', 'panel-heading');
    const titleGroup = element('div');
    if (eyebrow) titleGroup.append(element('span', 'eyebrow', eyebrow));
    titleGroup.append(element('h3', '', title));
    heading.append(titleGroup);
    root.append(heading);
    return { root, heading };
  }
  function empty(title, description) {
    const root = element('div', 'empty-state');
    root.append(element('h4', '', title), element('p', '', description));
    return root;
  }
  function documentError(label, message) {
    return element('p', 'notice notice-error', `${label} unavailable: ${message}`);
  }
  function progressEntry(progress) {
    const root = element('article', 'progress-entry');
    const meta = element('div', 'progress-meta');
    const author = element('span', 'progress-author mono', progress.workerId || 'Worker');
    author.title = progress.workerId || 'Worker';
    const date = element('time', '', time(progress.createdAt));
    if (progress.createdAt) { date.dateTime = progress.createdAt; date.title = progress.createdAt; }
    meta.append(author, date);
    root.append(meta, element('p', 'progress-body', progress.body ?? ''));
    if (progress.bodyTruncated) root.append(element('p', 'progress-reply', 'Account preview truncated. Read the complete stored account through the Forge CLI.'));
    if (progress.inReplyTo) root.append(element('p', 'progress-reply', `In reply to ${progress.inReplyTo}`));
    return root;
  }
  function renderDirections(force = false) {
    $('#direction-count').textContent = state.directions.length;
    const signature = JSON.stringify([state.directions, state.active]);
    if (!force && signature === state.listSignature) return;
    state.listSignature = signature;
    const rows = state.directions.map(direction => {
      const row = element('div', `direction-row${state.active === direction.name ? ' active' : ''}`);
      const button = element('button', 'direction-select');
      button.type = 'button';
      if (state.active === direction.name) button.setAttribute('aria-current', 'page');
      button.append(element('span', 'direction-name', direction.name));
      const meta = element('span', 'direction-meta');
      meta.append(element('span', `direction-marker${direction.workerId ? ' bound' : ''}`), document.createTextNode(direction.workerId ? 'Worker selected' : 'No Worker selected'));
      button.append(meta);
      button.addEventListener('click', () => selectDirection(direction.name));
      row.append(button);
      return row;
    });
    $('#direction-list').replaceChildren(...(rows.length ? rows : [element('p', 'empty-small', 'No Directions yet. Create one to give a Worker a place to begin.')]));
  }
  function updateHeading() {
    const detail = state.detail;
    $('#view-eyebrow').textContent = 'DIRECTION';
    $('#view-title').textContent = state.active || 'Your workspace, in view.';
    $('#view-description').textContent = detail?.folder || 'Loading Direction…';
    $('#worker-badge').hidden = !detail;
    $('#worker-badge').textContent = detail?.workerId ? `Worker · ${detail.workerId}` : 'No Worker selected';
    $('#worker-badge').title = detail?.workerId || '';
    $('#workspace-label').textContent = detail ? `${detail.container || 'Workspace'} · ${detail.workspace}` : 'Forge';
    $('#detail-tabs').hidden = !detail;
    $('#steer-section').hidden = !detail;
    $('#steer-direction').textContent = state.active || '';
    restoreWorkerChoice();
    $('#steer-help').textContent = detail?.workerId
      ? 'Delivered directly to the selected Worker. Authored results appear in PROGRESS.'
      : 'A fresh Worker receives your supplied context and this Direction’s goal and checklist pointers.';
  }
  function renderOverview() {
    const detail = state.detail;
    const grid = element('div', 'detail-grid');
    const goal = panel('Goal', 'WHAT THIS WORKER PURSUES');
    const body = element('div', 'panel-body');
    body.append(detail.goalError ? documentError('Goal', detail.goalError) : element('div', 'goal-body', detail.goal || 'No goal text recorded.'));
    if (detail.goalTruncated) body.append(element('p', 'file-note', 'Goal preview truncated. The complete goal remains in goal.md.'));
    const metadata = element('dl', 'metadata');
    for (const [label, value] of [['Direction folder', detail.folder], ['Worker', detail.workerId || 'No Worker selected'], ['Container', detail.container || 'Configured by the host'], ['Workspace', detail.workspace]]) {
      const pair = element('div'); pair.append(element('dt', '', label), element('dd', 'mono', value)); metadata.append(pair);
    }
    body.append(metadata); goal.root.append(body);
    const progress = panel('PROGRESS', 'WORKER → DIRECTOR · AUTHORED ACCOUNTS');
    const items = [...state.progress.values()].sort((a, b) => b.seq - a.seq);
    progress.heading.append(element('span', 'count', `${items.length} loaded`));
    if (detail.progressWindow?.latest) progress.root.append(element('p', 'file-note', `The latest ${detail.progressWindow.limit} stored accounts load first.`));
    if (items.length) {
      const list = element('div', 'progress-list'); list.append(...items.map(progressEntry)); progress.root.append(list);
      const history = element('div', 'progress-history');
      if (state.historyDone) history.append(element('p', 'muted small', 'You have reached the first stored account.'));
      else {
        const older = element('button', 'button button-secondary button-compact', state.loadingOlder ? 'Loading…' : 'Load earlier PROGRESS');
        older.type = 'button'; older.disabled = state.loadingOlder;
        older.addEventListener('click', loadOlderProgress);
        history.append(older);
      }
      progress.root.append(history);
    } else progress.root.append(empty('No PROGRESS recorded yet', 'The Worker can write an account here when it has something useful to share.'));
    grid.append(goal.root, progress.root);
    $('#content').replaceChildren(grid);
  }
  function decodeFile(file) {
    if (file.encoding !== 'base64') return { text: String(file.content ?? '') };
    try {
      const bytes = Uint8Array.from(atob(file.content || ''), char => char.charCodeAt(0));
      if (bytes.includes(0)) return { binary: true };
      return { text: new TextDecoder('utf-8', { fatal: true }).decode(bytes) };
    } catch { return { binary: true }; }
  }
  function fileDetail(file, content) {
    const root = element('details', 'checklist-file');
    root.append(element('summary', 'mono', file.path));
    if (file.skipped) root.append(element('p', 'file-note', `Skipped: ${typeof file.skipped === 'string' ? file.skipped : 'unsupported file'}`));
    else if (content.binary) root.append(element('p', 'file-note', 'Binary content is retained in the workspace.'));
    else root.append(element('pre', '', content.text));
    if (file.truncated) root.append(element('p', 'file-note', 'This preview is truncated.'));
    return root;
  }
  function renderChecklist() {
    const view = panel('Checklist', 'AUTHORED FILES');
    const files = state.detail.checklist || [];
    view.heading.append(element('span', 'count', state.detail.checklistError ? 'Unavailable' : files.length));
    if (state.detail.checklistError) view.root.append(documentError('Checklist', state.detail.checklistError));
    if (files.length) view.root.append(...files.map(file => fileDetail(file, decodeFile(file))));
    else if (!state.detail.checklistError) view.root.append(empty('An open checklist', 'Checks live in this Direction’s checklist folder. Add ordinary files through the workspace.'));
    if (state.detail.checklistTruncated) view.root.append(element('p', 'file-note', 'The checklist preview is truncated. Inspect the Direction folder for all files and complete contents.'));
    $('#content').replaceChildren(view.root);
  }
  function renderDiff(diff) {
    const focused = document.activeElement?.id === 'diff-base';
    const selection = focused ? [document.activeElement.selectionStart, document.activeElement.selectionEnd] : null;
    const reference = diff.comparison?.reference || state.diffBase;
    const uncommitted = diff.comparison?.kind === 'uncommitted' || (!diff.comparison && reference === 'HEAD');
    const view = panel(uncommitted ? 'Uncommitted changes' : `Changes from ${reference}`, 'SHARED CONTAINER WORKSPACE');
    const form = element('form', 'diff-controls');
    const label = element('label', '', 'Compare against Git reference'); label.htmlFor = 'diff-base';
    const controls = element('div', 'diff-control-row');
    const input = element('input', 'mono'); input.id = 'diff-base'; input.type = 'text'; input.value = state.diffDraft; input.required = true;
    input.placeholder = 'HEAD, a branch, tag or commit'; input.autocomplete = 'off'; input.spellcheck = false;
    input.addEventListener('input', () => { state.diffDraft = input.value; });
    const apply = element('button', 'button button-secondary', 'Compare'); apply.type = 'submit';
    controls.append(input, apply); form.append(label, controls);
    form.addEventListener('submit', event => {
      event.preventDefault();
      if (!input.value.trim()) { input.focus(); return; }
      state.diffBase = input.value.trim(); state.diffDraft = state.diffBase;
      loadDiff({ force: true });
    });
    form.append(element('p', 'muted small', 'HEAD shows uncommitted changes. Choose an earlier reference to include committed work.'));
    view.root.append(form);
    const show = () => {
      $('#content').replaceChildren(view.root);
      state.diffRoot = view.root;
      if (focused) { input.focus({ preventScroll: true }); input.setSelectionRange(...selection); }
    };
    if (!diff.available) {
      view.root.append(empty('Git diff unavailable', diff.error || 'This workspace does not have an available Git comparison.'));
      show(); return;
    }
    const comparison = element('div', 'diff-summary');
    comparison.append(element('span', '', `Shared workspace · ${uncommitted ? 'Uncommitted changes relative to HEAD' : `Compared with ${reference}`}`));
    if (diff.comparison?.commit) { const commit = element('span', 'mono', diff.comparison.commit.slice(0, 12)); commit.title = diff.comparison.commit; comparison.append(commit); }
    if (diff.comparison?.unborn) comparison.append(element('span', '', 'No initial commit'));
    view.root.append(comparison);
    if (diff.scope) view.root.append(element('p', 'file-note diff-scope', diff.scope));
    if (diff.status) view.root.append(element('pre', 'diff-status', diff.status));
    if (diff.patch) {
      const patch = element('pre', 'diff-patch');
      for (const line of diff.patch.split('\n')) {
        let className = 'diff-line';
        if (line.startsWith('diff --git') || line.startsWith('+++') || line.startsWith('---')) className += ' diff-file';
        else if (line.startsWith('+')) className += ' diff-added';
        else if (line.startsWith('-')) className += ' diff-removed';
        else if (line.startsWith('@@')) className += ' diff-hunk';
        patch.append(element('span', className, line || '\u200b'));
      }
      view.root.append(patch);
    }
    if (diff.truncated) view.root.append(element('p', 'file-note', 'The diff preview is truncated. Inspect the workspace for the complete patch.'));
    if (diff.untracked?.length) {
      view.root.append(element('h4', 'untracked-title', `Untracked files · ${diff.untracked.length}`));
      view.root.append(...diff.untracked.map(file => fileDetail(file, { binary: file.binary, text: file.content ?? 'Content preview unavailable.' })));
    }
    if (!diff.patch && !diff.untracked?.length) view.root.append(empty(uncommitted ? 'No uncommitted changes relative to HEAD' : 'No differences from the selected reference', diff.status ? 'See the workspace status above.' : `Comparison: ${reference}`));
    show();
  }
  function presentDiff(diff, force) {
    const { observedAt, ...visible } = diff;
    const signature = JSON.stringify(visible);
    const mounted = state.diffRoot?.parentElement === $('#content');
    if (mounted && !force) {
      if (signature === state.diffSignature) return;
      if (document.activeElement?.closest('.diff-controls')) return;
    }
    state.diffSignature = signature;
    renderDiff(diff);
  }
  async function loadDiff({ force = false } = {}) {
    const active = state.active;
    const base = state.diffBase;
    try {
      const diff = await api(`/api/diff?base=${encodeURIComponent(base)}`);
      if (state.tab === 'diff' && state.active === active && state.diffBase === base) presentDiff(diff, force);
    } catch (error) { if (state.tab === 'diff' && state.active === active && state.diffBase === base) presentDiff({ available: false, error: error.message }, force); }
  }
  function renderDetail() {
    if (!state.detail) return;
    updateHeading();
    for (const tab of document.querySelectorAll('[data-tab]')) {
      const active = tab.dataset.tab === state.tab;
      tab.classList.toggle('active', active);
      if (active) tab.setAttribute('aria-current', 'page'); else tab.removeAttribute('aria-current');
    }
    if (state.tab === 'overview') renderOverview();
    else if (state.tab === 'checklist') renderChecklist();
    else loadDiff();
  }
  async function loadDetail(force = false) {
    if (!state.active) return;
    const name = state.active;
    const tab = state.tab;
    const sequence = ++state.detailSequence;
    const detail = await api(`${directionURL(name)}?view=${tab}`);
    if (name !== state.active || tab !== state.tab || sequence !== state.detailSequence) return;
    state.detail = detail; state.detailTab = tab;
    for (const record of detail.progress || []) state.progress.set(record.seq, record);
    const signature = JSON.stringify(detail);
    if (force || signature !== state.detailSignature) {
      state.detailSignature = signature;
      renderDetail();
    } else if (state.tab === 'diff') loadDiff();
  }
  async function loadOlderProgress() {
    if (state.loadingOlder || !state.active || !state.progress.size) return;
    const name = state.active;
    const before = Math.min(...state.progress.keys());
    state.loadingOlder = true; renderOverview();
    try {
      const detail = await api(`${directionURL(name)}/progress?before=${before}`);
      if (state.active !== name) return;
      const records = detail.progress || [];
      if (!records.length) state.historyDone = true;
      for (const record of records) state.progress.set(record.seq, record);
    } catch (error) { if (state.active === name) notice($('#connection-error'), `Could not read earlier PROGRESS: ${error.message}`, true); }
    finally {
      if (state.active === name) {
        state.loadingOlder = false;
        if (state.tab === 'overview' && state.detailTab === 'overview') renderOverview();
      }
    }
  }
  async function selectDirection(name) {
    const changed = name !== state.active;
    state.active = name;
    if (changed) {
      state.detail = null; state.detailSignature = ''; state.tab = 'overview';
      state.progress.clear(); state.historyDone = false; state.loadingOlder = false;
      $('#steer-text').value = draftFor(name).text;
      notice($('#steer-result'), '');
      $('#content').replaceChildren(empty('Loading Direction', name));
    }
    renderDirections(); updateHeading();
    try { await loadDetail(true); notice($('#connection-error'), ''); }
    catch (error) { notice($('#connection-error'), error.message, true); }
  }
  async function refresh() {
    if (state.refreshing) return;
    state.refreshing = true; $('#refresh').disabled = true;
    try {
      const data = await api('/api/directions');
      state.directions = data.directions || [];
      const names = new Set(state.directions.map(direction => direction.name));
      renderDirections();
      if (!state.active && state.directions.length) await selectDirection(state.directions[0].name);
      else if (state.active && names.has(state.active)) await loadDetail();
      else if (state.active && !names.has(state.active)) {
        state.active = null; state.detail = null; state.progress.clear(); state.historyDone = false; state.loadingOlder = false;
        if (state.directions.length) await selectDirection(state.directions[0].name);
        else { updateHeading(); $('#view-description').textContent = 'Create a Direction to give a Worker a place to begin.'; $('#content').replaceChildren(empty('No Directions available', 'Create a Direction with its own goal.')); }
      }
      const errors = data.errors || [];
      notice($('#connection-error'), errors.length ? `Some Directions could not be read: ${errors.map(error => typeof error === 'string' ? error : `${error.name || error.folder || 'Direction'}: ${error.error || error.message || 'read failed'}`).join('; ')}` : '', errors.length > 0);
      $('#refreshed-at').textContent = `Read ${new Date().toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' })}`;
    } catch (error) { notice($('#connection-error'), error.message, true); }
    finally { state.refreshing = false; $('#refresh').disabled = false; }
  }

  $('#refresh').addEventListener('click', refresh);
  $('#steer-text').addEventListener('input', () => { if (state.active) draftFor(state.active).text = $('#steer-text').value; });
  for (const choice of document.querySelectorAll('[name="worker-mode"]')) choice.addEventListener('change', () => {
    if (state.active && choice.checked) draftFor(state.active).workerMode = choice.value;
  });
  for (const tab of document.querySelectorAll('[data-tab]')) tab.addEventListener('click', async () => {
    state.tab = tab.dataset.tab;
    try { await loadDetail(true); notice($('#connection-error'), ''); }
    catch (error) { notice($('#connection-error'), error.message, true); }
  });
  $('#new-direction').addEventListener('click', () => { notice($('#create-error'), ''); $('#create-dialog').showModal(); $('#direction-name').focus(); });
  for (const selector of ['#close-dialog', '#cancel-create']) $(selector).addEventListener('click', () => $('#create-dialog').close());
  $('#create-form').addEventListener('submit', async event => {
    event.preventDefault();
    $('#create-submit').disabled = true; notice($('#create-error'), '');
    const name = $('#direction-name').value.trim(); const goal = $('#direction-goal').value;
    try {
      await api('/api/directions', { name, goal });
      $('#create-dialog').close(); $('#create-form').reset();
      await refresh(); await selectDirection(name);
    } catch (error) { notice($('#create-error'), error.message, true); }
    finally { $('#create-submit').disabled = false; }
  });
  $('#steer-form').addEventListener('submit', async event => {
    event.preventDefault();
    if (!state.active || state.sending) return;
    const name = state.active; const text = $('#steer-text').value;
    if (!text.trim()) { $('#steer-text').focus(); return; }
    draftFor(name).text = text;
    state.sending = true; $('#send-steer').disabled = true; $('#send-steer').textContent = 'Sending…'; notice($('#steer-result'), '');
    try {
      const result = await api(`${directionURL(name)}/steer`, { text, fresh: $('#worker-fresh').checked });
      const sentDraft = draftFor(name);
      if (sentDraft.text === text) sentDraft.text = '';
      sentDraft.workerMode = 'existing';
      if (state.active === name) {
        notice($('#steer-result'), `STEER submitted for ${name}. Worker: ${result.workerId || result.threadId || 'selected'}${result.turnId ? ` · Turn: ${result.turnId}` : ''}. Authored results appear in PROGRESS.`);
        $('#steer-text').value = sentDraft.text;
        restoreWorkerChoice();
      }
      await refresh();
    } catch (error) {
      // A failed response can follow a successful binding or an uncertain submission.
      // Re-read that binding; a second send always requires an explicit user action.
      await refresh();
      if (state.active === name) {
        try { await loadDetail(true); } catch { /* Preserve the original dispatch error. */ }
        if (state.detail?.workerId) { draftFor(name).workerMode = 'existing'; restoreWorkerChoice(); }
        notice($('#steer-result'), error.message, true);
      } else {
        if (state.directions.find(direction => direction.name === name)?.workerId || error.response?.workerId) draftFor(name).workerMode = 'existing';
        notice($('#connection-error'), `STEER for ${name}: ${error.message}`, true);
      }
    }
    finally { state.sending = false; $('#send-steer').disabled = false; $('#send-steer').textContent = 'Send STEER ↗'; }
  });
  async function start() {
    try { const session = await api('/api/session'); state.token = session.token; await refresh(); }
    catch (error) { notice($('#connection-error'), error.message, true); }
    setInterval(() => { if (!document.hidden) refresh(); }, 5000);
  }
  start();
})();
