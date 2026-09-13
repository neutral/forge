import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { readChecklist } from '../library/checklist.mjs';

async function temporary(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'forge-checklist-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

test('reading varied checklist material preserves original bytes without requiring Check fields', async t => {
  const root = await temporary(t);
  const files = new Map([
    ['plain.md', Buffer.from('- [ ] Preserve authored files.\r\n- [ ] Reopen after restart.\r\n')],
    ['unchanged/source.yaml', Buffer.from('concern: preserve values\nprocedure: null\nlimits: [unknown]\n')],
    ['references.txt', Buffer.from('project:persistence\nhttps://example.invalid/check-definition\n')],
    ['enriched.md', Buffer.from('- [ ] Survive interruption.\n  Include writes before and after commit.\n  Status: inconclusive; this is a judgment.\n')],
    ['rough', Buffer.from('Would another developer understand it?')],
    ['empty', Buffer.alloc(0)],
    ['supplied-format.bin', Buffer.from([0, 0xff, 0xfe, 0x80, 0x41])],
  ]);
  for (const [relative, bytes] of files) {
    await mkdir(path.dirname(path.join(root, relative)), { recursive: true });
    await writeFile(path.join(root, relative), bytes);
  }
  const presented = await readChecklist(root);
  assert.equal(presented.length, files.size);
  for (const file of presented) {
    assert.ok(files.has(file.path), `unexpected path ${file.path}`);
    assert.ok(Buffer.isBuffer(file.bytes));
    assert.deepEqual(file.bytes, files.get(file.path));
    assert.deepEqual(await readFile(path.join(root, file.path)), files.get(file.path));
    assert.equal(file.skipped, undefined);
  }
});

test('commands and references remain inert source text when files are presented', async t => {
  const root = await temporary(t);
  const marker = path.join(root, 'executed');
  const source = `Run: touch '${marker}'\n\n\`$(touch '${marker}')\`\nsource: file:///unavailable/intent/check.md\nhttps://example.invalid/check\n`;
  await writeFile(path.join(root, 'commands.md'), source);
  const presented = await readChecklist(root);
  assert.equal(presented[0].bytes.toString(), source);
  assert.deepEqual(await readdir(root), ['commands.md']);
});

test('only the selected folder is read and linked files remain explicitly skipped', async t => {
  const root = await temporary(t);
  const selected = path.join(root, 'selected');
  const external = path.join(root, 'external');
  await mkdir(selected);
  await mkdir(external);
  await writeFile(path.join(selected, 'concern.txt'), 'Rough material is sufficient.');
  await writeFile(path.join(external, 'outside.md'), 'Not selected.');
  await symlink(path.join(external, 'outside.md'), path.join(selected, 'linked-file'));
  await symlink(external, path.join(selected, 'linked-folder'));
  await symlink(path.join(root, 'missing'), path.join(selected, 'broken-link'));
  const presented = await readChecklist(selected);
  assert.equal(presented.length, 4);
  assert.equal(presented.find(file => file.path === 'concern.txt').bytes.toString(), 'Rough material is sufficient.');
  for (const name of ['linked-file', 'linked-folder', 'broken-link']) {
    assert.deepEqual(presented.find(file => file.path === name), { path: name, skipped: 'symbolic link' });
  }
  assert.ok(presented.every(file => !file.path.includes('outside.md')));
  await symlink(selected, path.join(root, 'selected-alias'));
  await assert.rejects(readChecklist(path.join(root, 'selected-alias')), /real checklist folder/);
});

test('empty folders are usable and missing paths report filesystem access failure', async t => {
  const root = await temporary(t);
  assert.deepEqual(await readChecklist(root), []);
  await assert.rejects(readChecklist(path.join(root, 'missing')), { code: 'ENOENT' });
  await writeFile(path.join(root, 'ordinary-file'), 'Not a folder.');
  await assert.rejects(readChecklist(path.join(root, 'ordinary-file')), { code: 'ENOTDIR' });
});
