import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { version } from './version.mjs';

/** Explicit container policy defaults are applied to native calls, not approval replies. */
export function nativeWorkerOptions(options = {}) {
  return {
    ...(process.env.FORGE_SANDBOX && { sandbox: process.env.FORGE_SANDBOX }),
    ...(process.env.FORGE_APPROVAL_POLICY && { approvalPolicy: process.env.FORGE_APPROVAL_POLICY }),
    ...Object.fromEntries(Object.entries(options).filter(([, value]) => value !== undefined)),
  };
}

/** One connection to an existing Codex app-server. It never reads project files. */
export class CodexConnection extends EventEmitter {
  constructor(socket, { requestTimeoutMs = 30_000 } = {}) {
    super();
    this.socket = socket;
    this.pending = new Map();
    this.sequence = 0;
    this.requestTimeoutMs = requestTimeoutMs;
    socket.addEventListener('message', event => {
      let message;
      try { message = JSON.parse(event.data.toString()); }
      catch { this.emit('protocolError', new Error('Host sent invalid JSON')); return; }
      if (message.method) {
        this.emit(message.id === undefined ? 'notification' : 'hostRequest', message);
      } else {
        const pending = this.pending.get(message.id);
        if (!pending) return;
        this.pending.delete(message.id);
        clearTimeout(pending.timer);
        if (message.error) {
          const error = new Error(message.error.message);
          error.hostError = message.error;
          pending.reject(error);
        } else pending.resolve(message.result);
      }
    });
    socket.addEventListener('close', () => {
      for (const p of this.pending.values()) {
        clearTimeout(p.timer);
        p.reject(new Error('Codex host disconnected; request outcome may be unknown'));
      }
      this.pending.clear();
      this.emit('disconnected');
    });
    socket.addEventListener('error', () => { if (!this.closing) this.emit('transportError', new Error('Codex WebSocket transport error')); });
  }

  static async connect(url = 'ws://127.0.0.1:4500', options = {}) {
    const parsed = new URL(url);
    if (parsed.protocol !== 'ws:' || !['127.0.0.1', 'localhost', '[::1]'].includes(parsed.hostname)) {
      throw new Error('This binding supports only local loopback ws:// hosts; use a protected local tunnel for remote hosts');
    }
    const socket = new WebSocket(url);
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { socket.close(); reject(new Error('Codex host connection timed out')); }, options.requestTimeoutMs ?? 30_000);
      socket.addEventListener('open', () => { clearTimeout(timer); resolve(); }, { once: true });
      socket.addEventListener('error', () => { clearTimeout(timer); reject(new Error(`Cannot connect to Codex host at ${url}`)); }, { once: true });
    });
    const connection = new CodexConnection(socket, options);
    try {
      await connection.request('initialize', { clientInfo: { name: 'forge', version }, capabilities: { experimentalApi: true } });
      connection.notify('initialized', {});
      return connection;
    } catch (error) { connection.close(); throw error; }
  }

  request(method, params) {
    if (this.socket.readyState !== 1) return Promise.reject(new Error('Codex host is not connected'));
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Codex ${method} timed out; outcome unknown. Inspect the existing conversation before retrying.`));
      }, this.requestTimeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try { this.socket.send(JSON.stringify({ id, method, params })); }
      catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error);
      }
    });
  }
  notify(method, params) { this.socket.send(JSON.stringify({ method, params })); }
  respond(id, result) { this.socket.send(JSON.stringify({ id, result })); }
  close() { this.closing = true; this.socket.close(); }
}

export class Communicator {
  constructor(connection, threadId, attachOptions = {}) { this.connection = connection; this.threadId = threadId; this.attachOptions = attachOptions; }
  static async create(connection, options = {}) {
    const result = await connection.request('thread/start', options);
    const { model, sandbox, approvalPolicy } = options;
    const communicator = new Communicator(connection, result.thread.id, {
      ...(model !== undefined && { model }), ...(sandbox !== undefined && { sandbox }), ...(approvalPolicy !== undefined && { approvalPolicy }),
    });
    communicator.initialThread = result.thread;
    return { communicator, host: result };
  }
  async attach() {
    return this.connection.request('thread/resume', { ...this.attachOptions, threadId: this.threadId });
  }
  async read() {
    return this.connection.request('thread/read', { threadId: this.threadId, includeTurns: true });
  }
  async send(text) {
    if (typeof text !== 'string' || !text.trim() || text.includes('\0')) throw new TypeError('STEER text must be a nonempty string without NUL bytes');
    const requestId = randomUUID();
    const current = this.initialThread ? { thread: this.initialThread } : await this.attach();
    const active = current.thread.turns?.findLast(turn => turn.status === 'inProgress');
    const content = [{ type: 'text', text: `Director STEER (request ${requestId}).\n\n${text}`, text_elements: [] }];
    const method = active ? 'turn/steer' : 'turn/start';
    const params = active
      ? { threadId: this.threadId, expectedTurnId: active.id, input: content }
      : { threadId: this.threadId, input: content };
    this.initialThread = undefined;
    let host;
    try { host = await this.connection.request(method, params); }
    catch (error) {
      Object.assign(error, { requestId, threadId: this.threadId, ...(active && { turnId: active.id }) });
      throw error;
    }
    return { outcome: 'message_submitted', requestId, threadId: this.threadId, turnId: host.turn?.id ?? host.turnId ?? active?.id, method, host };
  }
  async interrupt() {
    const current = await this.attach();
    const active = current.thread.turns?.findLast(turn => turn.status === 'inProgress');
    if (!active) return { outcome: 'no_active_turn', threadId: this.threadId, host: current.thread.status };
    const host = await this.connection.request('turn/interrupt', { threadId: this.threadId, turnId: active.id });
    return { outcome: 'interrupt_requested', threadId: this.threadId, turnId: active.id, host,
      scope: 'Native Codex turn interruption; already-running tools (including foreground processes), detached processes and container services are not guaranteed stopped. Observe turn/completed for host-confirmed turn status.' };
  }
}
