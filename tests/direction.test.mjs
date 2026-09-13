import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { appendProgress, bindWorker, createDirection, readDirection, readDirectionBinding, readProgress } from '../library/direction.mjs';

async function temporary(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'forge-direction-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

async function direction(t, options = {}) {
  const root = await temporary(t);
  return createDirection({ folder: path.join(root, 'direction'), goal: 'Develop the selected scope.', workspace: '/workspace', ...options });
}

test('Direction creation keeps the goal in its authored file and records only bindings and progress in SQLite', async t => {
  const goal = '# Goal\r\n\r\nA rough concern, unchanged.\n';
  const created = await direction(t, { goal, container: 'shared-container', hostUrl: 'ws://127.0.0.1:59999' });
  assert.deepEqual(created, {
    folder: created.folder, goal, workspace: '/workspace', container: 'shared-container',
    hostUrl: 'ws://127.0.0.1:59999', workerId: null, hostOptions: {}, workers: [],
  });
  assert.equal(await readFile(path.join(created.folder, 'goal.md'), 'utf8'), goal);
  assert.deepEqual(await readdir(path.join(created.folder, 'checklist')), []);
  assert.deepEqual(await readProgress(created.folder), []);

  const revisedGoal = 'The edited file is canonical.\r\n';
  await writeFile(path.join(created.folder, 'goal.md'), revisedGoal);
  assert.equal((await readDirection(created.folder)).goal, revisedGoal);
  const db = new DatabaseSync(path.join(created.folder, 'direction.sqlite'), { readOnly: true });
  try {
    assert.deepEqual(db.prepare('PRAGMA table_info(direction)').all().map(row => row.name),
      ['singleton', 'workspace', 'container', 'host_url', 'current_worker_id']);
    assert.equal(db.prepare('PRAGMA application_id').get().application_id, 0x464f5247);
    assert.equal(db.prepare('PRAGMA user_version').get().user_version, 2);
    assert.equal(db.prepare('PRAGMA journal_mode').get().journal_mode, 'wal');
  } finally { db.close(); }
});

test('creation refuses an existing folder and validation leaves no partial folder', async t => {
  const root = await temporary(t);
  const folder = path.join(root, 'existing');
  await mkdir(folder);
  await writeFile(path.join(folder, 'goal.md'), 'Keep this material.');
  await assert.rejects(createDirection({ folder, goal: 'Replacement', workspace: '/workspace' }), { code: 'EEXIST' });
  assert.deepEqual(await readdir(folder), ['goal.md']);
  assert.equal(await readFile(path.join(folder, 'goal.md'), 'utf8'), 'Keep this material.');
  await assert.rejects(createDirection({ folder: path.join(root, 'invalid'), goal: {}, workspace: '/workspace' }), /goal must/);
  assert.deepEqual(await readdir(root), ['existing']);
  const nested = await createDirection({ folder: path.join(root, 'new-parent', 'nested', 'direction'), goal: 'Nested goal', workspace: '/workspace' });
  assert.equal(nested.goal, 'Nested goal');
});

test('goal reads reject symlinks and special files while preserving the selected ordinary file', async t => {
  const { folder } = await direction(t);
  const goalFile = path.join(folder, 'goal.md');
  await writeFile(path.join(folder, 'unselected.txt'), 'Do not present an aliased goal.');
  await rm(goalFile);
  await symlink(path.join(folder, 'unselected.txt'), goalFile);
  await assert.rejects(readDirection(folder), /goal must be a regular file/);
  await rm(goalFile);
  await mkdir(goalFile);
  await assert.rejects(readDirection(folder), /goal must be a regular file/);
  await rm(goalFile, { recursive: true });
  await writeFile(goalFile, 'The replacement goal is selected directly.');
  assert.equal((await readDirection(folder)).goal, 'The replacement goal is selected directly.');
});

test('reopened bindings preserve earlier Workers and their progress after a fresh Worker is selected', async t => {
  const { folder } = await direction(t);
  const firstBinding = await bindWorker(folder, 'worker-first');
  assert.equal(firstBinding.workerId, 'worker-first');
  assert.equal(firstBinding.workers.length, 1);
  const first = await appendProgress(folder, { workerId: 'worker-first', body: 'Established the first concern.', inReplyTo: 'steer-1' });
  await bindWorker(folder, 'worker-fresh');
  const late = await appendProgress(folder, { workerId: 'worker-first', body: 'A final note from the earlier context.' });
  const fresh = await appendProgress(folder, { workerId: 'worker-fresh', body: 'I have not rechecked that earlier result.' });
  const reopened = await readDirection(folder);
  assert.equal(reopened.workerId, 'worker-fresh');
  assert.deepEqual(reopened.workers.map(worker => worker.workerId), ['worker-first', 'worker-fresh']);
  assert.deepEqual(await readProgress(folder), [first, late, fresh]);
  assert.equal(first.inReplyTo, 'steer-1');
  assert.equal(late.inReplyTo, null);
  assert.match(first.id, /^[a-f0-9-]{36}$/);
  assert.equal(new Date(first.createdAt).toISOString(), first.createdAt);
  assert.equal(new Set([first.id, late.id, fresh.id]).size, 3);

  const rebound = await bindWorker(folder, 'worker-first');
  assert.deepEqual(rebound.workers, reopened.workers);
  assert.equal(rebound.workerId, 'worker-first');
});

test('missing authored documents leave routing and intact accounts available without replacement', async t => {
  const { folder } = await direction(t, { container: 'retained', hostUrl: 'ws://127.0.0.1:4555' });
  await bindWorker(folder, 'earlier');
  const earlier = await appendProgress(folder, { workerId: 'earlier', body: 'Original account.\r\nUnresolved concern.', inReplyTo: 'original-request' });
  await bindWorker(folder, 'selected', {}, { model: 'saved-model', sandbox: 'workspace-write', approvalPolicy: 'never' });
  const selected = await appendProgress(folder, { workerId: 'selected', body: 'Current account\u0000retains bytes.' });
  const binding = await readDirectionBinding(folder);
  await rm(path.join(folder, 'goal.md'));
  await rm(path.join(folder, 'checklist'), { recursive: true });
  assert.deepEqual(await readDirectionBinding(folder), binding);
  await assert.rejects(readDirection(folder), { code: 'ENOENT' });
  const detail = await readDirection(folder, { tolerateGoalError: true });
  const { goal, goalError, ...retained } = detail;
  assert.equal(goal, null);
  assert.match(goalError, /ENOENT.*goal\.md/);
  assert.deepEqual(retained, binding);
  assert.deepEqual(await readProgress(folder), [earlier, selected]);
  await assert.rejects(readFile(path.join(folder, 'goal.md')), { code: 'ENOENT' });
  await assert.rejects(readdir(path.join(folder, 'checklist')), { code: 'ENOENT' });
});

test('document-tolerant inspection and control reads still reject damaged routing', async t => {
  const { folder } = await direction(t);
  await bindWorker(folder, 'selected');
  const account = await appendProgress(folder, { workerId: 'selected', body: 'Preserved despite routing damage.' });
  await rm(path.join(folder, 'goal.md'));
  const db = new DatabaseSync(path.join(folder, 'direction.sqlite'));
  t.after(() => db.close());
  const rejectBoth = async pattern => {
    await assert.rejects(readDirectionBinding(folder, { includeWorkers: false }), pattern);
    await assert.rejects(readDirection(folder, { tolerateGoalError: true }), pattern);
    assert.deepEqual(await readProgress(folder), [account]);
  };
  db.prepare('UPDATE workers SET options_json = ?').run('{"config":{}}');
  await rejectBoth(/Invalid stored Worker host options/);
  db.exec("PRAGMA foreign_keys = OFF; UPDATE workers SET options_json = '{}'; UPDATE direction SET current_worker_id = 'missing'");
  await rejectBoth(/missing its selected Worker record/);
  db.exec("UPDATE direction SET current_worker_id = 'selected', host_url = ''");
  await rejectBoth(/Stored hostUrl/);
  db.exec("UPDATE direction SET host_url = 'ws://127.0.0.1:4500'; PRAGMA user_version = 999");
  await assert.rejects(readDirectionBinding(folder), /Unsupported Direction database schema/);
  await assert.rejects(readDirection(folder, { tolerateGoalError: true }), /Unsupported Direction database schema/);
});

test('Worker host options survive reopening and rebinding while fresh Workers retain independent settings', async t => {
  const { folder } = await direction(t);
  const selected = { model: 'selected-model', sandbox: 'workspace-write', approvalPolicy: 'never' };
  const initial = await bindWorker(folder, 'first', {}, selected);
  assert.deepEqual(initial.hostOptions, selected);
  assert.deepEqual(initial.workers[0].hostOptions, selected);
  const secondOptions = { sandbox: 'read-only', approvalPolicy: 'on-request' };
  await bindWorker(folder, 'second', {}, secondOptions);
  const rebound = await bindWorker(folder, 'first');
  assert.deepEqual(rebound.hostOptions, selected);
  assert.deepEqual(rebound.workers.map(worker => worker.hostOptions), [selected, secondOptions]);
  assert.equal(rebound.workers[0].createdAt, initial.workers[0].createdAt);
  const updated = await bindWorker(folder, 'first', { maxGoalBytes: 10, includeWorkers: false }, { model: "model'; DROP TABLE workers; --" });
  assert.deepEqual(updated.hostOptions, { ...selected, model: "model'; DROP TABLE workers; --" });
  assert.deepEqual(updated.workers, []);
  assert.equal(updated.workersOmitted, true);
  const reopened = await readDirection(folder);
  assert.deepEqual(reopened.hostOptions, updated.hostOptions);
  assert.equal(reopened.workers.length, 2);
  for (const invalid of [null, [], { config: {} }, { sandbox: '' }, { model: 1 }, { approvalPolicy: 'never\0extra' }]) {
    await assert.rejects(bindWorker(folder, 'should-not-bind', {}, invalid), /hostOptions|host option/);
  }
  assert.deepEqual((await readDirection(folder)).workers, reopened.workers);
});

for (const fixture of [
  { name: 'version 1', sql: 'ALTER TABLE workers DROP COLUMN options_json; PRAGMA user_version = 1', version: 1 },
  { name: 'unversioned storage', sql: 'PRAGMA user_version = 0', version: 0 },
  { name: 'future version', sql: 'PRAGMA user_version = 3', version: 3 },
  { name: 'unrelated application', sql: 'PRAGMA application_id = 0', version: 2 },
  { name: 'current version missing required Worker settings column', sql: 'ALTER TABLE workers DROP COLUMN options_json', version: 2 },
]) {
  test(`${fixture.name} rejects every Direction read and write without changing stored content`, async t => {
    const goal = 'Keep the authored goal.\r\n';
    const checklist = 'A plain concern remains unresolved.\r\n';
    const { folder } = await direction(t, { goal });
    await writeFile(path.join(folder, 'checklist', 'concern.md'), checklist);
    await bindWorker(folder, 'earlier-worker');
    await appendProgress(folder, { workerId: 'earlier-worker', body: 'Earlier account.\r\n', inReplyTo: 'earlier-steer' });
    await bindWorker(folder, 'selected-worker', {}, { model: 'selected-model', sandbox: 'workspace-write', approvalPolicy: 'never' });
    await appendProgress(folder, { workerId: 'selected-worker', body: 'Selected account\u0000keeps authored text.' });
    const filename = path.join(folder, 'direction.sqlite');
    const unsupported = new DatabaseSync(filename);
    try { unsupported.exec(fixture.sql); }
    finally { unsupported.close(); }
    const databaseBytes = await readFile(filename);
    const storedContents = () => {
      const db = new DatabaseSync(filename, { readOnly: true });
      try {
        return {
          version: db.prepare('PRAGMA user_version').get().user_version,
          schema: db.prepare('SELECT * FROM sqlite_schema ORDER BY name').all(),
          binding: db.prepare('SELECT * FROM direction').all(),
          workers: db.prepare('SELECT * FROM workers ORDER BY ordinal').all(),
          progress: db.prepare('SELECT * FROM progress ORDER BY seq').all(),
        };
      } finally { db.close(); }
    };
    const before = storedContents();
    assert.equal(before.version, fixture.version);
    for (const operation of [
      () => readDirection(folder),
      () => readDirection(folder, { includeWorkers: false, tolerateGoalError: true }),
      () => readDirectionBinding(folder),
      () => readDirectionBinding(folder, { includeWorkers: false }),
      () => readProgress(folder),
      () => readProgress(folder, { latest: true, limit: 1 }),
      () => bindWorker(folder, 'selected-worker', {}, { model: 'replacement-model' }),
      () => bindWorker(folder, 'fresh-worker'),
      () => appendProgress(folder, { workerId: 'selected-worker', body: 'Must not be stored.' }),
    ]) {
      await assert.rejects(operation, new RegExp(`Unsupported Direction database schema.*version ${fixture.version}`));
      assert.deepEqual(await readFile(filename), databaseBytes, 'rejection preserves the database bytes');
      assert.deepEqual(storedContents(), before, 'rejection preserves schema, routing, attribution and accounts');
      assert.equal(await readFile(path.join(folder, 'goal.md'), 'utf8'), goal);
      assert.equal(await readFile(path.join(folder, 'checklist', 'concern.md'), 'utf8'), checklist);
    }
  });
}

test('unsupported storage with committed WAL accounts rejects reads and writes without checkpointing', async t => {
  const { folder } = await direction(t);
  await bindWorker(folder, 'worker');
  const filename = path.join(folder, 'direction.sqlite');
  execFileSync(process.execPath, ['--input-type=module', '-e', `
    import { DatabaseSync } from 'node:sqlite';
    const db = new DatabaseSync(process.argv[1]);
    db.exec('PRAGMA wal_autocheckpoint = 0; BEGIN IMMEDIATE');
    db.prepare('INSERT INTO progress (id, worker_id, body, in_reply_to, created_at) VALUES (?, ?, ?, ?, ?)')
      .run('uncheckpointed-account', 'worker', 'Preserve the committed WAL account.', 'saved-request', '2026-09-09T00:00:00.000Z');
    db.exec('ALTER TABLE workers DROP COLUMN options_json; PRAGMA user_version = 1; COMMIT');
    // Exit without SQLite connection cleanup to leave the committed WAL in place.
    process.exit(0);
  `, filename]);
  const databaseBytes = await readFile(filename);
  const walBytes = await readFile(`${filename}-wal`);
  assert.ok(walBytes.length > 0);
  for (const operation of [
    () => readDirection(folder),
    () => readDirectionBinding(folder, { includeWorkers: false }),
    () => readProgress(folder),
    () => bindWorker(folder, 'fresh-worker'),
    () => appendProgress(folder, { workerId: 'worker', body: 'Must not be stored.' }),
  ]) {
    await assert.rejects(operation, /Unsupported Direction database schema.*version 1/);
    assert.deepEqual(await readFile(filename), databaseBytes);
    assert.deepEqual(await readFile(`${filename}-wal`), walBytes);
  }
  const retained = new DatabaseSync(filename, { readOnly: true });
  try {
    assert.equal(retained.prepare('PRAGMA user_version').get().user_version, 1);
    assert.deepEqual({ ...retained.prepare('SELECT * FROM progress').get() }, {
      seq: 1, id: 'uncheckpointed-account', worker_id: 'worker', body: 'Preserve the committed WAL account.',
      in_reply_to: 'saved-request', created_at: '2026-09-09T00:00:00.000Z',
    });
    assert.equal(retained.prepare('SELECT current_worker_id FROM direction').get().current_worker_id, 'worker');
  } finally { retained.close(); }
});

test('corrupt stored Worker options fail explicitly instead of falling back to host defaults', async t => {
  const { folder } = await direction(t);
  await bindWorker(folder, 'worker', {}, { sandbox: 'workspace-write' });
  const db = new DatabaseSync(path.join(folder, 'direction.sqlite'));
  try { db.prepare('UPDATE workers SET options_json = ?').run('{"config":{"arbitrary":"setting"}}'); }
  finally { db.close(); }
  await assert.rejects(readDirection(folder, { includeWorkers: false }), /Invalid stored Worker host options/);
  await assert.rejects(bindWorker(folder, 'worker'), /Invalid stored Worker host options/);
  assert.deepEqual(await readProgress(folder), []);
});

test('Directions in one workspace keep goals, bindings and sequence cursors independent', async t => {
  const root = await temporary(t);
  const first = await createDirection({ folder: path.join(root, 'first'), goal: 'Scope A', workspace: '/workspace', container: 'shared' });
  const second = await createDirection({ folder: path.join(root, 'second'), goal: 'Scope B', workspace: '/workspace', container: 'shared' });
  await bindWorker(first.folder, 'worker-a');
  await bindWorker(second.folder, 'worker-b');
  const account = await appendProgress(first.folder, { workerId: 'worker-a', body: 'Only A has progress.' });
  assert.equal(account.seq, 1);
  assert.deepEqual(await readProgress(second.folder), []);
  await assert.rejects(appendProgress(second.folder, { workerId: 'worker-a', body: 'Wrong Direction.' }), /not bound/);
  assert.equal((await readDirection(second.folder)).workerId, 'worker-b');
  assert.equal((await appendProgress(second.folder, { workerId: 'worker-b', body: 'B begins.' })).seq, 1);
});

test('stored accounts preserve caller text and parameterized worker IDs without interpretation', async t => {
  const { folder } = await direction(t);
  const workerId = "worker'); DROP TABLE progress; --";
  const body = "  # Unchanged\r\n\n'quoted'; $(touch should-not-exist)\n漢字 🧭\n  ";
  const inReplyTo = "request' OR 1 = 1 --";
  await bindWorker(folder, workerId);
  const recorded = await appendProgress(folder, { workerId, body, inReplyTo });
  assert.deepEqual(await readProgress(folder, { workerId }), [recorded]);
  assert.equal(recorded.body, body);
  assert.equal((await readDirection(folder)).workerId, workerId);
  assert.deepEqual(await readProgress(folder, { workerId: "' OR 1 = 1 --" }), []);
  assert.ok(!(await readdir(folder)).includes('should-not-exist'));
});

test('progress reads use exclusive stable cursors, ordered limits and Worker filters', async t => {
  const { folder } = await direction(t);
  await bindWorker(folder, 'first');
  await bindWorker(folder, 'second');
  const accounts = [];
  for (let index = 0; index < 6; index++) {
    accounts.push(await appendProgress(folder, { workerId: index % 2 ? 'second' : 'first', body: `Account ${index}` }));
  }
  assert.deepEqual(await readProgress(folder, { limit: 2 }), accounts.slice(0, 2));
  assert.deepEqual(await readProgress(folder, { after: 2, limit: 2 }), accounts.slice(2, 4));
  assert.deepEqual(await readProgress(folder, { latest: true, limit: 2 }), accounts.slice(-2));
  assert.deepEqual(await readProgress(folder, { after: 2, latest: true, limit: 2, workerId: 'first' }), [accounts[2], accounts[4]]);
  assert.deepEqual(await readProgress(folder, { before: 5, latest: true, limit: 2 }), accounts.slice(2, 4));
  assert.deepEqual(await readProgress(folder, { after: 2, before: 5 }), accounts.slice(2, 4));
  assert.deepEqual(await readProgress(folder, { after: 5, before: 3 }), []);
  assert.deepEqual(await readProgress(folder, { after: 6 }), []);
  const next = await appendProgress(folder, { workerId: 'first', body: 'Added after the previous read.' });
  assert.deepEqual(await readProgress(folder, { after: 6 }), [next]);
  for (const after of [-1, 0.5, '1', Number.MAX_SAFE_INTEGER + 1, Infinity]) {
    await assert.rejects(readProgress(folder, { after }), /after must/);
  }
  for (const limit of [0, -1, 1.5, 1001, '2', Infinity]) {
    await assert.rejects(readProgress(folder, { limit }), /limit must/);
  }
  for (const before of [0, -1, 0.5, '1', Number.MAX_SAFE_INTEGER + 1]) {
    await assert.rejects(readProgress(folder, { before }), /before must/);
  }
  await assert.rejects(readProgress(folder, { latest: 'true' }), /latest must/);
  await assert.rejects(readProgress(folder, { workerId: null }), /workerId must/);
  await assert.rejects(appendProgress(folder, { workerId: 'first', body: {} }), /body must/);
  await assert.rejects(appendProgress(folder, { workerId: 'first', body: 'ok', inReplyTo: 123 }), /inReplyTo must/);
});

test('optional display projections bound reads and report truncation without changing authored records', async t => {
  const goal = 'a🧭漢字\u0000more text';
  const { folder } = await direction(t, { goal });
  await bindWorker(folder, 'worker');
  const exact = await appendProgress(folder, { workerId: 'worker', body: 'a🧭\u0000漢字 retained beyond the display limit' });
  const bounded = await readDirection(folder, { maxGoalBytes: 3, includeWorkers: false });
  assert.equal(bounded.goal, 'a');
  assert.equal(bounded.goalTruncated, true);
  assert.equal(bounded.workersOmitted, true);
  assert.deepEqual(bounded.workers, []);
  assert.equal(bounded.workerId, 'worker');
  const whole = await readDirection(folder, { maxGoalBytes: 100 });
  assert.equal(whole.goal, goal);
  assert.equal(whole.goalTruncated, false);
  assert.equal(whole.workers.length, 1);
  const projected = await readProgress(folder, { maxBodyChars: 4 });
  assert.deepEqual(projected, [{ ...exact, body: 'a🧭\u0000漢', bodyTruncated: true }]);
  assert.deepEqual(await readProgress(folder, { maxBodyChars: 100 }), [{ ...exact, bodyTruncated: false }]);
  assert.deepEqual(await readProgress(folder), [exact]);
  assert.equal((await readDirection(folder)).goal, goal);
  for (const bound of [0, -1, 1.5, '3', 1024 * 1024 + 1]) {
    await assert.rejects(readDirection(folder, { maxGoalBytes: bound }), /maxGoalBytes must/);
    await assert.rejects(readProgress(folder, { maxBodyChars: bound }), /maxBodyChars must/);
  }
  await assert.rejects(readDirection(folder, { includeWorkers: 'false' }), /includeWorkers must/);
});

test('missing, unrelated and unsupported databases fail without initializing or replacing them', async t => {
  const root = await temporary(t);
  const missing = path.join(root, 'missing');
  await assert.rejects(readDirection(missing), { code: 'ENOENT' });
  await assert.rejects(readProgress(missing), { code: 'ENOENT' });
  await assert.rejects(bindWorker(missing, 'worker'), { code: 'ENOENT' });
  assert.deepEqual(await readdir(root), []);
  const empty = path.join(root, 'empty');
  await mkdir(empty);
  await assert.rejects(readDirection(empty), { code: 'ENOENT' });
  await assert.rejects(appendProgress(empty, { workerId: 'worker', body: 'x' }), { code: 'ENOENT' });
  assert.deepEqual(await readdir(empty), []);
  const filename = path.join(empty, 'direction.sqlite');
  await writeFile(filename, 'not a database');
  await assert.rejects(readProgress(empty), /not a database/);
  assert.equal(await readFile(filename, 'utf8'), 'not a database');

  const unsupported = await createDirection({ folder: path.join(root, 'unsupported'), goal: '', workspace: '/workspace' });
  const db = new DatabaseSync(path.join(unsupported.folder, 'direction.sqlite'));
  db.exec('PRAGMA user_version = 999');
  db.close();
  await assert.rejects(readDirection(unsupported.folder), /Unsupported Direction database schema.*999/);
  await assert.rejects(bindWorker(unsupported.folder, 'worker'), /Unsupported Direction database schema/);
  await symlink(unsupported.folder, path.join(root, 'alias'));
  await assert.rejects(readDirection(path.join(root, 'alias')), /real Direction folder/);
});

test('SQLite serializes a separate process append behind a write lock while stored reads remain available', async t => {
  const { folder } = await direction(t);
  await bindWorker(folder, 'worker');
  const prior = await appendProgress(folder, { workerId: 'worker', body: 'Before lock.' });
  const db = new DatabaseSync(path.join(folder, 'direction.sqlite'));
  db.exec('BEGIN IMMEDIATE');
  let locked = true;
  t.after(() => { if (locked) db.exec('ROLLBACK'); db.close(); });
  assert.deepEqual(await readProgress(folder), [prior]);
  const moduleUrl = new URL('../library/direction.mjs', import.meta.url).href;
  const child = spawn(process.execPath, ['--input-type=module', '-e', `
    import { appendProgress } from ${JSON.stringify(moduleUrl)};
    process.stdout.write('ready\\n');
    const record = await appendProgress(process.argv[1], { workerId: 'worker', body: 'After lock.' });
    process.stdout.write(JSON.stringify(record));
  `, folder], { stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(() => child.kill());
  let output = '';
  let errors = '';
  child.stderr.on('data', chunk => { errors += chunk; });
  const finished = new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('close', code => code === 0 ? resolve() : reject(new Error(`append child exited ${code}: ${errors}`)));
  });
  child.stdout.on('data', chunk => {
    output += chunk;
    if (output === 'ready\n') {
      setTimeout(() => { db.exec('COMMIT'); locked = false; }, 200);
    }
  });
  await finished;
  const next = JSON.parse(output.slice('ready\n'.length));
  assert.equal(next.seq, prior.seq + 1);
  assert.deepEqual(await readProgress(folder), [prior, next]);
});
