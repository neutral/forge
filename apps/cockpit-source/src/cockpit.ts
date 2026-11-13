// The cockpit's state: what it has read from the Forge server, the Director's drafts,
// and the selected Direction and view, which also live in the URL. It has no React or
// DOM dependency, so tests drive it with a fake fetch. Reading never dispatches a
// Worker; only sendSteer writes STEER, once per explicit action.

export type View = 'overview' | 'checklist' | 'diff';
export type WorkerMode = 'existing' | 'fresh';
export type History = 'push' | 'replace' | 'none';

export interface Direction {
  name: string;
  folder?: string;
  workerId?: string | null;
  workspace?: string;
  container?: string | null;
  hostOptions?: { ephemeral?: boolean } & Record<string, unknown>;
}
export interface Progress {
  seq: number;
  workerId?: string;
  body?: string;
  createdAt?: string;
  bodyTruncated?: boolean;
  inReplyTo?: string | null;
}
export interface StoredFile {
  path: string;
  encoding?: string;
  content?: string;
  skipped?: string | boolean;
  truncated?: boolean;
  binary?: boolean;
}
export interface Detail extends Direction {
  goal?: string | null;
  goalError?: string;
  goalTruncated?: boolean;
  progress?: Progress[];
  progressWindow?: { limit: number; latest: boolean };
  checklist?: StoredFile[];
  checklistError?: string;
  checklistTruncated?: boolean;
}
export interface Diff {
  available: boolean;
  error?: string;
  patch?: string;
  status?: string;
  untracked?: StoredFile[];
  comparison?: { reference: string; commit?: string | null; kind: string; unborn?: boolean };
  scope?: string;
  truncated?: boolean;
  observedAt?: string;
}
export interface Draft { text: string; workerMode: WorkerMode | null }
export interface Message { text: string; error: boolean }
export interface Place { direction: string | null; view: View; base: string }

export interface CockpitState {
  /** 'loading' until the first list read, 'failed' if that read failed, then 'read'. */
  list: 'loading' | 'failed' | 'read';
  directions: Direction[];
  active: string | null;
  tab: View;
  detail: Detail | null;
  /** The view the current detail was read for; a view renders only its own reading. */
  detailTab: View | null;
  /** Stored accounts read so far, newest first. */
  progress: Progress[];
  historyDone: boolean;
  loadingOlder: boolean;
  refreshing: boolean;
  sending: boolean;
  lastRead: Date | null;
  connectionError: string;
  steerResult: Message | null;
  drafts: Record<string, Draft>;
  diffBase: string;
  diffDraft: string;
  diffEditing: boolean;
  diff: Diff | null;
  createOpen: boolean;
  createName: string;
  createGoal: string;
  creating: boolean;
  createError: string;
}

export interface Deps {
  fetch: (url: string, init: RequestInit) => Promise<{ ok: boolean; status?: number; json: () => Promise<any> }>;
  timeout: (milliseconds: number) => AbortSignal;
  setInterval: (callback: () => void, milliseconds: number) => unknown;
  clearInterval: (handle: unknown) => void;
  isHidden: () => boolean;
  now: () => Date;
  location: { read: () => Place; write: (place: Place, history: 'push' | 'replace') => void };
  onPopState: (listener: () => void) => () => void;
  /** Follow a link outside the cockpit's own URL state with an ordinary page load. */
  assign: (href: string) => void;
  /** Move keyboard focus to an element named by an in-page link. */
  focus: (id: string) => void;
}

const views: View[] = ['overview', 'checklist', 'diff'];
export const isView = (value: unknown): value is View => views.includes(value as View);
const directionURL = (name: string) => `/api/directions/${encodeURIComponent(name)}`;
const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

export function initialState(): CockpitState {
  return {
    list: 'loading', directions: [], active: null, tab: 'overview', detail: null, detailTab: null,
    progress: [], historyDone: false, loadingOlder: false, refreshing: false, sending: false,
    lastRead: null, connectionError: '', steerResult: null, drafts: {}, diffBase: 'HEAD', diffDraft: 'HEAD',
    diffEditing: false, diff: null, createOpen: false, createName: '', createGoal: '', creating: false, createError: '',
  };
}

/** The STEER draft of the selected Direction. */
export function draftOf(state: CockpitState): Draft {
  return (state.active && state.drafts[state.active]) || { text: '', workerMode: null };
}

/** The Worker the next STEER reaches: a Direction without a Worker can only start a fresh one. */
export function workerModeOf(state: CockpitState): WorkerMode {
  if (!state.detail?.workerId) return 'fresh';
  return draftOf(state).workerMode || 'existing';
}

export class Cockpit {
  state: CockpitState = initialState();
  private listeners = new Set<() => void>();
  private token: string | null = null;
  private detailSequence = 0;
  private detailSignature = '';
  private diffSignature = '';
  private pendingDiff: { diff: Diff; signature: string } | null = null;
  private progressBySeq = new Map<number, Progress>();
  private requested: Place | null = null;
  private timer: unknown = null;
  private stopPopState: (() => void) | null = null;
  private started = false;
  private deps: Deps;

  constructor(deps: Deps) { this.deps = deps; }

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };
  getSnapshot = () => this.state;

  private set(patch: Partial<CockpitState>) {
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) listener();
  }
  private draft(name: string): Draft { return this.state.drafts[name] || { text: '', workerMode: null }; }
  private setDraft(name: string, patch: Partial<Draft>) {
    this.set({ drafts: { ...this.state.drafts, [name]: { ...this.draft(name), ...patch } } });
  }
  private mergeProgress(records: Progress[] = []) {
    for (const record of records) this.progressBySeq.set(record.seq, record);
    return [...this.progressBySeq.values()].sort((a, b) => b.seq - a.seq);
  }
  private writeLocation(history: History) {
    if (history === 'none') return;
    this.deps.location.write({ direction: this.state.active, view: this.state.tab, base: this.state.diffBase }, history);
  }

  async api(url: string, body?: unknown): Promise<any> {
    // A service restart rotates the token. Refresh it before an explicit write;
    // never retry the write itself when delivery is uncertain.
    if (body !== undefined) this.token = (await this.api('/api/session')).token;
    const response = await this.deps.fetch(url, {
      method: body === undefined ? 'GET' : 'POST', credentials: 'same-origin',
      signal: this.deps.timeout(body === undefined ? 15000 : 120000),
      headers: body === undefined ? { Accept: 'application/json' }
        : { Accept: 'application/json', 'Content-Type': 'application/json', 'X-Forge-Token': this.token ?? '' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    let data: any;
    try { data = await response.json(); } catch { throw new Error(`The server returned an unreadable response (${response.status}).`); }
    if (!response.ok) throw Object.assign(new Error(data?.error || `Request failed (${response.status}).`), { response: data });
    return data;
  }

  async start() {
    if (this.started) return;
    this.started = true;
    const place = this.deps.location.read();
    this.requested = place;
    this.set({ diffBase: place.base, diffDraft: place.base });
    this.stopPopState = this.deps.onPopState(() => { void this.applyLocation(); });
    try {
      const session = await this.api('/api/session');
      this.token = session.token;
      await this.refresh();
    } catch (error) { this.set({ connectionError: message(error), list: this.state.list === 'loading' ? 'failed' : this.state.list }); }
    if (this.started) this.timer = this.deps.setInterval(() => { if (!this.deps.isHidden()) void this.refresh(); }, 5000);
  }

  stop() {
    this.started = false;
    if (this.timer !== null) this.deps.clearInterval(this.timer);
    this.timer = null;
    this.stopPopState?.();
    this.stopPopState = null;
  }

  async refresh() {
    if (this.state.refreshing) return;
    this.set({ refreshing: true });
    try {
      const data = await this.api('/api/directions');
      const directions: Direction[] = data.directions || [];
      const names = new Set(directions.map(direction => direction.name));
      this.set({ directions, list: 'read' });
      const { active } = this.state;
      if (!active && directions.length) await this.selectRequested(directions);
      else if (active && names.has(active)) await this.loadDetail();
      else if (active && !names.has(active)) {
        this.progressBySeq.clear();
        this.set({ active: null, detail: null, detailTab: null, progress: [], historyDone: false, loadingOlder: false });
        if (directions.length) await this.selectDirection(directions[0].name, { history: 'replace' });
        else this.writeLocation('replace');
      }
      const errors: unknown[] = data.errors || [];
      this.set({
        connectionError: errors.length ? `Some Directions could not be read: ${errors.map(error => typeof error === 'string' ? error
          : `${(error as any).name || (error as any).folder || 'Direction'}: ${(error as any).error || (error as any).message || 'read failed'}`).join('; ')}` : '',
        lastRead: this.deps.now(),
      });
    } catch (error) {
      this.set({ connectionError: message(error), list: this.state.list === 'loading' ? 'failed' : this.state.list });
    } finally { this.set({ refreshing: false }); }
  }

  /** The first selection: the Direction the URL names when it exists, otherwise the first. */
  private async selectRequested(directions: Direction[]) {
    const wanted = this.requested;
    this.requested = null;
    const found = wanted?.direction && directions.some(direction => direction.name === wanted.direction);
    await this.selectDirection(found ? wanted!.direction! : directions[0].name,
      { view: found ? wanted!.view : 'overview', history: 'replace' });
  }

  async selectDirection(name: string, { view = 'overview', history = 'push' }: { view?: View; history?: History } = {}) {
    if (name !== this.state.active) {
      this.detailSignature = '';
      this.progressBySeq.clear();
      this.set({ active: name, tab: view, detail: null, detailTab: null, progress: [], historyDone: false,
        loadingOlder: false, steerResult: null, ...(view === 'diff' ? { diff: null } : {}) });
      if (view === 'diff') this.diffSignature = '';
    } else if (view !== this.state.tab) this.set({ tab: view });
    this.writeLocation(history);
    try { await this.loadDetail(true); this.set({ connectionError: '' }); }
    catch (error) { this.set({ connectionError: message(error) }); }
  }

  async selectView(view: View, { history = 'push' }: { history?: History } = {}) {
    if (view === 'diff' && this.state.tab !== 'diff') { this.diffSignature = ''; this.pendingDiff = null; this.set({ diff: null }); }
    this.set({ tab: view });
    this.writeLocation(history);
    try { await this.loadDetail(true); this.set({ connectionError: '' }); }
    catch (error) { this.set({ connectionError: message(error) }); }
  }

  /** Back and forward restore the Direction, view and compared reference the URL names. */
  async applyLocation() {
    const place = this.deps.location.read();
    const baseChanged = place.base !== this.state.diffBase;
    if (baseChanged) { this.diffSignature = ''; this.pendingDiff = null; this.set({ diffBase: place.base, diffDraft: place.base, diff: null }); }
    const { directions } = this.state;
    if (!directions.length) return;
    if (!place.direction || !directions.some(direction => direction.name === place.direction)) {
      await this.selectDirection(directions[0].name, { history: 'replace' });
    } else if (place.direction !== this.state.active) await this.selectDirection(place.direction, { view: place.view, history: 'none' });
    else if (place.view !== this.state.tab) await this.selectView(place.view, { history: 'none' });
    else if (baseChanged && this.state.tab === 'diff') await this.loadDiff({ force: true });
  }

  /** Router links: in-page targets take focus; other cockpit URLs restore their state; anything else loads. */
  follow = (href: string) => {
    if (href.startsWith('#')) { this.deps.focus(href.slice(1)); return; }
    this.deps.assign(href);
  };

  async loadDetail(force = false) {
    const name = this.state.active;
    if (!name) return;
    const tab = this.state.tab;
    const sequence = ++this.detailSequence;
    const detail = await this.api(`${directionURL(name)}?view=${tab}`) as Detail;
    if (name !== this.state.active || tab !== this.state.tab || sequence !== this.detailSequence) return;
    const progress = this.mergeProgress(detail.progress);
    const signature = JSON.stringify(detail);
    if (force || signature !== this.detailSignature || this.state.detailTab !== tab) {
      this.detailSignature = signature;
      this.set({ detail, detailTab: tab, progress });
    }
    if (tab === 'diff') void this.loadDiff();
  }

  async loadOlderProgress() {
    if (this.state.loadingOlder || !this.state.active || !this.progressBySeq.size) return;
    const name = this.state.active;
    const before = Math.min(...this.progressBySeq.keys());
    this.set({ loadingOlder: true });
    try {
      const detail = await this.api(`${directionURL(name)}/progress?before=${before}`);
      if (this.state.active !== name) return;
      const records: Progress[] = detail.progress || [];
      this.set({ progress: this.mergeProgress(records), ...(records.length ? {} : { historyDone: true }) });
    } catch (error) {
      if (this.state.active === name) this.set({ connectionError: `Could not read earlier PROGRESS: ${message(error)}` });
    } finally {
      if (this.state.active === name) this.set({ loadingOlder: false });
    }
  }

  setDraftText(text: string) { if (this.state.active) this.setDraft(this.state.active, { text }); }
  setWorkerMode(workerMode: WorkerMode) { if (this.state.active) this.setDraft(this.state.active, { workerMode }); }

  setDiffDraft(diffDraft: string) { this.set({ diffDraft }); }
  /** While the Director edits the reference, a changed comparison waits until editing ends. */
  setDiffEditing(diffEditing: boolean) {
    this.set({ diffEditing });
    if (!diffEditing && this.pendingDiff) {
      const { diff, signature } = this.pendingDiff;
      this.pendingDiff = null; this.diffSignature = signature;
      this.set({ diff });
    }
  }
  /** Compare against the drafted reference; false when it is empty. */
  compare(): boolean {
    const base = this.state.diffDraft.trim();
    if (!base) return false;
    this.set({ diffBase: base, diffDraft: base });
    this.writeLocation('push');
    void this.loadDiff({ force: true });
    return true;
  }

  async loadDiff({ force = false }: { force?: boolean } = {}) {
    const { active, diffBase: base } = this.state;
    const current = () => this.state.tab === 'diff' && this.state.active === active && this.state.diffBase === base;
    try {
      const diff = await this.api(`/api/diff?base=${encodeURIComponent(base)}`) as Diff;
      if (current()) this.presentDiff(diff, force);
    } catch (error) { if (current()) this.presentDiff({ available: false, error: message(error) }, force); }
  }

  private presentDiff(diff: Diff, force: boolean) {
    const { observedAt, ...visible } = diff;
    const signature = JSON.stringify(visible);
    if (this.state.diff && !force) {
      if (signature === this.diffSignature) return;
      if (this.state.diffEditing) { this.pendingDiff = { diff, signature }; return; }
    }
    this.diffSignature = signature; this.pendingDiff = null;
    this.set({ diff });
  }

  /** Send the selected Direction's draft once: 'sent', 'failed', 'empty' or 'busy'. */
  async sendSteer(): Promise<'sent' | 'failed' | 'empty' | 'busy'> {
    if (!this.state.active || this.state.sending) return 'busy';
    const name = this.state.active;
    const text = this.draft(name).text;
    if (!text.trim()) return 'empty';
    const fresh = workerModeOf(this.state) === 'fresh';
    this.set({ sending: true, steerResult: null });
    try {
      const result = await this.api(`${directionURL(name)}/steer`, { text, fresh });
      const sent = this.draft(name);
      this.setDraft(name, { text: sent.text === text ? '' : sent.text, workerMode: 'existing' });
      if (this.state.active === name) {
        this.set({ steerResult: { error: false, text: `STEER submitted for ${name}. Worker: ${result.workerId || result.threadId || 'selected'}${result.turnId ? ` · Turn: ${result.turnId}` : ''}. Authored results appear in PROGRESS.` } });
      }
      await this.refresh();
      return 'sent';
    } catch (error) {
      // A failed response can follow a successful binding or an uncertain submission.
      // Re-read that binding; a second send always requires an explicit Director action.
      await this.refresh();
      if (this.state.active === name) {
        try { await this.loadDetail(true); } catch { /* Preserve the original dispatch error. */ }
        if (this.state.detail?.workerId) this.setDraft(name, { workerMode: 'existing' });
        this.set({ steerResult: { error: true, text: message(error) } });
      } else {
        if (this.state.directions.find(direction => direction.name === name)?.workerId || (error as any)?.response?.workerId) {
          this.setDraft(name, { workerMode: 'existing' });
        }
        this.set({ connectionError: `STEER for ${name}: ${message(error)}` });
      }
      return 'failed';
    } finally { this.set({ sending: false }); }
  }

  openCreate() { this.set({ createOpen: true, createError: '' }); }
  closeCreate() { this.set({ createOpen: false }); }
  setCreateName(createName: string) { this.set({ createName }); }
  setCreateGoal(createGoal: string) { this.set({ createGoal }); }

  /** Create a Direction from the dialog's fields; it starts no Worker. */
  async createDirection() {
    if (this.state.creating) return;
    const name = this.state.createName.trim();
    const goal = this.state.createGoal;
    this.set({ creating: true, createError: '' });
    try {
      await this.api('/api/directions', { name, goal });
    } catch (error) {
      this.set({ creating: false, createError: message(error) });
      return;
    }
    this.set({ creating: false, createOpen: false, createName: '', createGoal: '' });
    await this.refresh();
    await this.selectDirection(name);
  }
}

/** Read and write the cockpit's place in the URL query, keeping the page's own path. */
export function placeFrom(search: string): Place {
  const params = new URLSearchParams(search);
  const view = params.get('view');
  return { direction: params.get('direction') || null, view: isView(view) ? view : 'overview', base: params.get('base')?.trim() || 'HEAD' };
}
export function searchOf(place: Place): string {
  const params = new URLSearchParams();
  if (place.direction) params.set('direction', place.direction);
  if (place.view !== 'overview') params.set('view', place.view);
  if (place.base !== 'HEAD') params.set('base', place.base);
  const search = params.toString();
  return search ? `?${search}` : '';
}

export function browserDeps(): Deps {
  return {
    fetch: (url, init) => fetch(url, init),
    timeout: milliseconds => AbortSignal.timeout(milliseconds),
    setInterval: (callback, milliseconds) => window.setInterval(callback, milliseconds),
    clearInterval: handle => window.clearInterval(handle as number),
    isHidden: () => document.hidden,
    now: () => new Date(),
    location: {
      read: () => placeFrom(window.location.search),
      write: (place, history) => {
        const url = `${window.location.pathname}${searchOf(place)}${window.location.hash}`;
        if (url === `${window.location.pathname}${window.location.search}${window.location.hash}`) return;
        if (history === 'push') window.history.pushState(null, '', url);
        else window.history.replaceState(null, '', url);
      },
    },
    onPopState: listener => {
      window.addEventListener('popstate', listener);
      return () => window.removeEventListener('popstate', listener);
    },
    assign: href => window.location.assign(href),
    focus: id => {
      const target = document.getElementById(id);
      target?.focus();
      target?.scrollIntoView({ block: 'start' });
    },
  };
}
