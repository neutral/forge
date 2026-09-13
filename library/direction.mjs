import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const SCHEMA_VERSION = 2;
const APPLICATION_ID = 0x464f5247;
const PROGRESS_COLUMNS = 'seq, id, worker_id AS workerId, body, in_reply_to AS inReplyTo, created_at AS createdAt';

function string(value, name, { optional = false, empty = false } = {}) {
  if (optional && value === null) return;
  if (typeof value !== 'string' || (!empty && !value.trim())) {
    throw new TypeError(`${name} must be ${optional ? 'null or ' : ''}a${empty ? '' : ' nonempty'} string`);
  }
}

function folderPath(folder) {
  string(folder, 'folder');
  return path.resolve(folder);
}

function hostOptions(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('hostOptions must be an object');
  const allowed = new Set(['model', 'sandbox', 'approvalPolicy']);
  const result = {};
  for (const [key, option] of Object.entries(value)) {
    if (!allowed.has(key)) throw new TypeError(`Unknown Worker host option: ${key}`);
    string(option, `hostOptions.${key}`);
    if (option.includes('\0')) throw new TypeError(`hostOptions.${key} must not contain NUL bytes`);
    result[key] = option;
  }
  return result;
}

function storedHostOptions(json) {
  try { return hostOptions(JSON.parse(json)); }
  catch (cause) { throw new Error(`Invalid stored Worker host options: ${cause.message}`, { cause }); }
}

function transaction(db, work) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = work();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

function validateDatabase(db) {
  db.exec('PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON');
  const { application_id: applicationId } = db.prepare('PRAGMA application_id').get();
  const { user_version: version } = db.prepare('PRAGMA user_version').get();
  if (applicationId !== APPLICATION_ID || version !== SCHEMA_VERSION) {
    throw new Error(`Unsupported Direction database schema (application ${applicationId}, version ${version})`);
  }
  let binding;
  try {
    db.prepare('SELECT ordinal, worker_id, created_at, options_json FROM workers LIMIT 0');
    db.prepare(`SELECT ${PROGRESS_COLUMNS} FROM progress LIMIT 0`);
    binding = db.prepare('SELECT workspace, container, host_url, current_worker_id FROM direction WHERE singleton = 1').get();
  } catch (cause) {
    throw new Error(`Unsupported Direction database schema (application ${applicationId}, version ${version}): ${cause.message}`, { cause });
  }
  if (!binding) {
    throw new Error('Direction database is missing its binding record');
  }
}

async function openDirection(folder, { readOnly = true } = {}) {
  const root = folderPath(folder);
  const rootInfo = await lstat(root);
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) {
    throw new Error('Choose the real Direction folder');
  }
  const filename = path.join(root, 'direction.sqlite');
  const dbInfo = await lstat(filename);
  if (!dbInfo.isFile() || dbInfo.isSymbolicLink()) throw new Error('Direction database must be a regular file');
  // Reject unsupported storage before a writable connection can recover or checkpoint it.
  let db = new DatabaseSync(filename, { readOnly: true });
  try {
    validateDatabase(db);
    if (!readOnly) {
      const writable = new DatabaseSync(filename);
      try { validateDatabase(writable); }
      catch (error) { writable.close(); throw error; }
      db.close();
      db = writable;
    }
    return { root, db };
  } catch (error) {
    db.close();
    throw error;
  }
}

async function readGoal(root, maxGoalBytes) {
  const filename = path.join(root, 'goal.md');
  if (!(await lstat(filename)).isFile()) throw new Error('Direction goal must be a regular file');
  const file = await open(filename, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = await file.stat();
    if (!info.isFile()) throw new Error('Direction goal must be a regular file');
    if (maxGoalBytes === undefined) return { goal: await file.readFile('utf8') };
    const buffer = Buffer.alloc(Math.min(info.size, maxGoalBytes));
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
    const goalTruncated = info.size > bytesRead;
    const goal = new TextDecoder().decode(buffer.subarray(0, bytesRead), { stream: goalTruncated });
    return { goal, goalTruncated };
  } finally {
    await file.close();
  }
}

/** Create authored files and storage in a fresh folder; existing material is never replaced. */
export async function createDirection({ folder, goal, workspace, container = null, hostUrl = 'ws://127.0.0.1:4500' }) {
  const root = folderPath(folder);
  string(goal, 'goal', { empty: true });
  string(workspace, 'workspace');
  string(container, 'container', { optional: true });
  string(hostUrl, 'hostUrl');
  await mkdir(path.dirname(root), { recursive: true });
  await mkdir(root);
  await writeFile(path.join(root, 'goal.md'), goal, { flag: 'wx' });
  await mkdir(path.join(root, 'checklist'));
  const db = new DatabaseSync(path.join(root, 'direction.sqlite'));
  try {
    db.exec('PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL');
    transaction(db, () => {
      db.exec(`
        CREATE TABLE workers (
          ordinal INTEGER PRIMARY KEY AUTOINCREMENT,
          worker_id TEXT NOT NULL UNIQUE,
          created_at TEXT NOT NULL,
          options_json TEXT NOT NULL DEFAULT '{}'
        );
        CREATE TABLE direction (
          singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
          workspace TEXT NOT NULL,
          container TEXT,
          host_url TEXT NOT NULL,
          current_worker_id TEXT REFERENCES workers(worker_id)
        );
        CREATE TABLE progress (
          seq INTEGER PRIMARY KEY AUTOINCREMENT,
          id TEXT NOT NULL UNIQUE,
          worker_id TEXT NOT NULL REFERENCES workers(worker_id),
          body TEXT NOT NULL,
          in_reply_to TEXT,
          created_at TEXT NOT NULL
        );
        CREATE INDEX progress_worker_seq ON progress(worker_id, seq);
        PRAGMA application_id = ${APPLICATION_ID};
        PRAGMA user_version = ${SCHEMA_VERSION};
      `);
      db.prepare('INSERT INTO direction (singleton, workspace, container, host_url) VALUES (1, ?, ?, ?)')
        .run(workspace, container, hostUrl);
    });
  } finally {
    db.close();
  }
  return readDirection(root);
}

/** Read saved routing metadata without opening authored documents or contacting a host. */
export async function readDirectionBinding(folder, { includeWorkers = true } = {}) {
  if (typeof includeWorkers !== 'boolean') throw new TypeError('includeWorkers must be a boolean');
  const { root, db } = await openDirection(folder);
  try {
    const { optionsJson, boundWorkerId, ...binding } = db.prepare(`
      SELECT d.workspace, d.container, d.host_url AS hostUrl, d.current_worker_id AS workerId,
        w.worker_id AS boundWorkerId, w.options_json AS optionsJson
      FROM direction d LEFT JOIN workers w ON w.worker_id = d.current_worker_id WHERE singleton = 1
    `).get();
    string(binding.workspace, 'Stored workspace');
    string(binding.container, 'Stored container', { optional: true });
    string(binding.hostUrl, 'Stored hostUrl');
    string(binding.workerId, 'Stored workerId', { optional: true });
    if (binding.workerId !== null && !boundWorkerId) throw new Error('Direction database is missing its selected Worker record');
    const workers = includeWorkers ? db.prepare(`SELECT worker_id AS workerId, created_at AS createdAt,
      options_json AS optionsJson FROM workers ORDER BY ordinal`)
      .all().map(({ optionsJson, ...worker }) => ({ ...worker, hostOptions: storedHostOptions(optionsJson) })) : [];
    return { folder: root, ...binding,
      hostOptions: binding.workerId ? storedHostOptions(optionsJson) : {}, workers, ...(!includeWorkers && { workersOmitted: true }) };
  } finally {
    db.close();
  }
}

/** Read the goal alongside its binding; inspection can retain a document access error. */
export async function readDirection(folder, { maxGoalBytes, includeWorkers = true, tolerateGoalError = false } = {}) {
  if (maxGoalBytes !== undefined && (!Number.isSafeInteger(maxGoalBytes) || maxGoalBytes < 1 || maxGoalBytes > 1024 * 1024)) {
    throw new TypeError('maxGoalBytes must be an integer from 1 to 1048576');
  }
  if (typeof tolerateGoalError !== 'boolean') throw new TypeError('tolerateGoalError must be a boolean');
  const binding = await readDirectionBinding(folder, { includeWorkers });
  try {
    return { ...binding, ...await readGoal(binding.folder, maxGoalBytes) };
  } catch (error) {
    if (!tolerateGoalError) throw error;
    return { ...binding, goal: null, goalError: error.message };
  }
}

/** Select a native Worker handle while preserving earlier Worker attribution. */
export async function bindWorker(folder, workerId, readOptions = {}, selectedHostOptions = {}) {
  string(workerId, 'workerId');
  const options = hostOptions(selectedHostOptions);
  const { root, db } = await openDirection(folder, { readOnly: false });
  try {
    transaction(db, () => {
      const prior = db.prepare('SELECT options_json FROM workers WHERE worker_id = ?').get(workerId);
      const retained = prior ? storedHostOptions(prior.options_json) : {};
      db.prepare(`INSERT INTO workers (worker_id, created_at, options_json) VALUES (?, ?, ?)
        ON CONFLICT(worker_id) DO UPDATE SET options_json = excluded.options_json`)
        .run(workerId, new Date().toISOString(), JSON.stringify({ ...retained, ...options }));
      db.prepare('UPDATE direction SET current_worker_id = ? WHERE singleton = 1').run(workerId);
    });
  } finally {
    db.close();
  }
  return readDirection(root, readOptions);
}

/** Store exactly the account authored by a known Worker, including an earlier Worker. */
export async function appendProgress(folder, { workerId, body, inReplyTo = null }) {
  string(workerId, 'workerId');
  string(body, 'body', { empty: true });
  string(inReplyTo, 'inReplyTo', { optional: true, empty: true });
  const { db } = await openDirection(folder, { readOnly: false });
  try {
    return transaction(db, () => {
      if (!db.prepare('SELECT 1 FROM workers WHERE worker_id = ?').get(workerId)) {
        throw new Error(`Worker is not bound to this Direction: ${workerId}`);
      }
      const id = randomUUID();
      const createdAt = new Date().toISOString();
      const { lastInsertRowid } = db.prepare(`
        INSERT INTO progress (id, worker_id, body, in_reply_to, created_at) VALUES (?, ?, ?, ?, ?)
      `).run(id, workerId, body, inReplyTo, createdAt);
      return { seq: Number(lastInsertRowid), id, workerId, body, inReplyTo, createdAt };
    });
  } finally {
    db.close();
  }
}

/** Return ordered stored accounts; after is an exclusive sequence cursor. */
export async function readProgress(folder, { after = 0, before, limit = 100, latest = false, workerId, maxBodyChars } = {}) {
  if (!Number.isSafeInteger(after) || after < 0) throw new TypeError('after must be a nonnegative safe integer');
  if (before !== undefined && (!Number.isSafeInteger(before) || before < 1)) throw new TypeError('before must be a positive safe integer');
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) throw new TypeError('limit must be an integer from 1 to 1000');
  if (typeof latest !== 'boolean') throw new TypeError('latest must be a boolean');
  if (workerId !== undefined) string(workerId, 'workerId');
  if (maxBodyChars !== undefined && (!Number.isSafeInteger(maxBodyChars) || maxBodyChars < 1 || maxBodyChars > 1024 * 1024)) {
    throw new TypeError('maxBodyChars must be an integer from 1 to 1048576');
  }
  const { db } = await openDirection(folder);
  try {
    const params = maxBodyChars === undefined ? [] : [maxBodyChars * 4];
    params.push(after);
    if (before !== undefined) params.push(before);
    if (workerId !== undefined) params.push(workerId);
    params.push(limit);
    // SQLite TEXT length/substr stop at NUL. A bounded UTF-8 byte prefix also preserves those authored characters.
    const columns = maxBodyChars === undefined ? PROGRESS_COLUMNS : `seq, id, worker_id AS workerId,
      in_reply_to AS inReplyTo, created_at AS createdAt,
      substr(CAST(body AS BLOB), 1, ?) AS bodyBytes, length(CAST(body AS BLOB)) AS bodySize`;
    const rows = db.prepare(`
      SELECT ${columns} FROM progress
      WHERE seq > ? ${before === undefined ? '' : 'AND seq < ?'} ${workerId === undefined ? '' : 'AND worker_id = ?'}
      ORDER BY seq ${latest ? 'DESC' : 'ASC'} LIMIT ?
    `).all(...params).map(row => {
      if (maxBodyChars === undefined) return { ...row };
      const { bodyBytes, bodySize, ...record } = row;
      const partialBytes = bodySize > bodyBytes.length;
      const characters = [...new TextDecoder().decode(bodyBytes, { stream: partialBytes })];
      return { ...record, body: characters.slice(0, maxBodyChars).join(''), bodyTruncated: partialBytes || characters.length > maxBodyChars };
    });
    return latest ? rows.reverse() : rows;
  } finally {
    db.close();
  }
}
