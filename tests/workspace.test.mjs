import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readlink, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { snapshot } from '../library/workspace.mjs';

async function temporary(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'forge-workspace-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

test('snapshot copies opaque authored material and uncommitted files without upstream git metadata', async t => {
  const root = await temporary(t);
  const source = path.join(root, 'source');
  const destination = path.join(root, 'workspaces', 'copy');
  await mkdir(path.join(source, '.git'), { recursive: true });
  await mkdir(path.join(source, 'forge', 'checklist'), { recursive: true });
  const definition = Buffer.from('No prescribed fields.\r\n- [ ] preserve old roots\r\n');
  await writeFile(path.join(source, 'forge', 'checklist', 'rough.txt'), definition);
  await writeFile(path.join(source, '.git', 'config'), 'upstream metadata');
  await writeFile(path.join(source, 'untracked.txt'), 'original');
  await snapshot({ source, destination });
  assert.deepEqual(await readFile(path.join(destination, 'forge', 'checklist', 'rough.txt')), definition);
  assert.equal((await readdir(destination)).includes('.git'), false);
  await writeFile(path.join(destination, 'untracked.txt'), 'worker edit');
  assert.equal(await readFile(path.join(source, 'untracked.txt'), 'utf8'), 'original');
});

test('snapshot refuses existing destinations and aliases nested in the source', async t => {
  const root = await temporary(t);
  const source = path.join(root, 'source');
  const existing = path.join(root, 'existing');
  await mkdir(source);
  await mkdir(existing);
  await writeFile(path.join(existing, 'keep'), 'user content');
  await symlink(source, path.join(root, 'alias'));
  await assert.rejects(snapshot({ source, destination: existing }), /already exists/);
  await assert.rejects(snapshot({ source, destination: path.join(root, 'alias', 'nested') }), /separate directories/);
  assert.equal(await readFile(path.join(existing, 'keep'), 'utf8'), 'user content');
});

test('snapshot excludes nested Git administration files and directories while retaining their source', async t => {
  const root = await temporary(t);
  const source = path.join(root, 'source');
  const destination = path.join(root, 'copy');
  await mkdir(path.join(source, 'nested-worktree'), { recursive: true });
  await mkdir(path.join(source, 'nested-repository', '.git'), { recursive: true });
  await writeFile(path.join(source, 'nested-worktree', '.git'), `gitdir: ${root}/external/.git\n`);
  await writeFile(path.join(source, 'nested-worktree', 'source.go'), 'package example\n');
  await writeFile(path.join(source, 'nested-repository', '.git', 'config'), 'repository administration');
  await writeFile(path.join(source, 'nested-repository', '.gitignore'), '*.out\n');
  await snapshot({ source, destination });
  assert.deepEqual(await readdir(path.join(destination, 'nested-worktree')), ['source.go']);
  assert.deepEqual(await readdir(path.join(destination, 'nested-repository')), ['.gitignore']);
  assert.equal(await readFile(path.join(destination, 'nested-worktree', 'source.go'), 'utf8'), 'package example\n');
  assert.equal(await readFile(path.join(source, 'nested-worktree', '.git'), 'utf8'), `gitdir: ${root}/external/.git\n`);
});

test('snapshot keeps internal links in the copy and rejects links that could mutate upstream', async t => {
  const root = await temporary(t);
  const source = path.join(root, 'source');
  const destination = path.join(root, 'copy');
  await mkdir(source);
  await writeFile(path.join(source, 'file'), 'original');
  await symlink('file', path.join(source, 'relative'));
  await symlink(path.join(source, 'file'), path.join(source, 'absolute'));
  const copied = await snapshot({ source, destination });
  assert.equal(await readlink(path.join(destination, 'relative')), 'file');
  assert.equal(await readlink(path.join(destination, 'absolute')), path.join(copied.destination, 'file'));
  await writeFile(path.join(destination, 'absolute'), 'copied edit');
  assert.equal(await readFile(path.join(source, 'file'), 'utf8'), 'original');
  await symlink(root, path.join(source, 'external'));
  await assert.rejects(snapshot({ source, destination: path.join(root, 'rejected') }), /outside copied files/);
  assert.equal((await readdir(root)).includes('rejected'), false);
});

test('relative links that leave and reenter the source are remapped into the destination', async t => {
  const root = await temporary(t);
  const source = path.join(root, 'source');
  const destination = path.join(root, 'copy');
  await mkdir(source);
  await writeFile(path.join(source, 'file'), 'upstream');
  await symlink('../source/file', path.join(source, 'reenter'));
  await symlink(source, path.join(root, 'alias'));
  await symlink('../alias/file', path.join(source, 'external-route'));
  await snapshot({ source, destination });
  for (const name of ['reenter', 'external-route']) {
    assert.equal(await readlink(path.join(destination, name)), 'file');
    await writeFile(path.join(destination, name), name);
    assert.equal(await readFile(path.join(destination, 'file'), 'utf8'), name);
    assert.equal(await readFile(path.join(source, 'file'), 'utf8'), 'upstream');
  }
});

test('links into excluded nested Git administration are rejected before any copy is made', async t => {
  const root = await temporary(t);
  const source = path.join(root, 'source');
  const destination = path.join(root, 'copy');
  await mkdir(path.join(source, 'nested', '.git'), { recursive: true });
  await writeFile(path.join(source, 'nested', '.git', 'config'), 'upstream metadata');
  await symlink('nested/.git/config', path.join(source, 'metadata-alias'));
  await assert.rejects(snapshot({ source, destination }), /outside copied files/);
  assert.equal((await readdir(root)).includes('copy'), false);
});
