import { readdir, readFile, lstat } from 'node:fs/promises';
import path from 'node:path';

/** Present only explicitly selected checklist files as bytes. No parsing or execution. */
export async function readChecklist(folder = 'forge/checklist') {
  const root = path.resolve(folder);
  if ((await lstat(root)).isSymbolicLink()) throw new Error('Choose the real checklist folder, not a symlink');
  const files = [];
  async function visit(directory) {
    for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const filename = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) { files.push({ path: path.relative(root, filename), skipped: 'symbolic link' }); continue; }
      if (entry.isDirectory()) await visit(filename);
      else if (entry.isFile()) files.push({ path: path.relative(root, filename), bytes: await readFile(filename) });
    }
  }
  await visit(root);
  return files;
}
