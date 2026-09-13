import { cp, lstat, mkdir, readlink, readdir, realpath, symlink, unlink } from 'node:fs/promises';
import path from 'node:path';

function inside(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

async function canonicalDestination(destination) {
  const missing = [];
  let ancestor = destination;
  while (true) {
    try {
      return path.join(await realpath(ancestor), ...missing.reverse());
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      const parent = path.dirname(ancestor);
      if (parent === ancestor) throw error;
      missing.push(path.basename(ancestor));
      ancestor = parent;
    }
  }
}

/** Copy a selected directory once. The caller stops writers before copying. */
export async function snapshot({ source, destination }) {
  if (typeof source !== 'string' || typeof destination !== 'string' || !source || !destination) {
    throw new TypeError('snapshot requires source and destination paths');
  }
  const sourcePath = await realpath(source);
  if (!(await lstat(sourcePath)).isDirectory()) throw new Error('snapshot source must be a directory');
  const destinationPath = await canonicalDestination(path.resolve(destination));
  if (inside(sourcePath, destinationPath) || inside(destinationPath, sourcePath)) {
    throw new Error('snapshot source and destination must be separate directories');
  }
  try {
    await lstat(path.resolve(destination));
    throw new Error('snapshot destination already exists');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }

  // Preserve safe relative links; remap paths that would escape the copy.
  // Reject external targets so editing the snapshot cannot follow one upstream.
  const remappedLinks = [];
  async function examine(directory) {
    for (const item of await readdir(directory, { withFileTypes: true })) {
      if (item.name === '.git') continue;
      const current = path.join(directory, item.name);
      if (item.isSymbolicLink()) {
        const target = await realpath(current);
        if (!inside(sourcePath, target) || path.relative(sourcePath, target).split(path.sep).includes('.git')) {
          throw new Error(`snapshot refuses a link outside copied files: ${current}`);
        }
        const value = await readlink(current);
        const copiedLink = path.join(destinationPath, path.relative(sourcePath, current));
        if (path.isAbsolute(value) || !inside(destinationPath, path.resolve(path.dirname(copiedLink), value)) || value.split(path.sep).includes('.git')) {
          remappedLinks.push([path.relative(sourcePath, current), path.relative(sourcePath, target), path.isAbsolute(value)]);
        }
      } else if (item.isDirectory()) {
        await examine(current);
      } else if (!item.isFile()) {
        throw new Error(`snapshot supports ordinary files, directories and internal links: ${current}`);
      }
    }
  }
  await examine(sourcePath);
  await mkdir(path.dirname(destinationPath), { recursive: true });
  // mkdir reserves the destination; failed copies remain visible for inspection.
  await mkdir(destinationPath);
  for (const entry of await readdir(sourcePath)) {
    if (entry === '.git') continue;
    await cp(path.join(sourcePath, entry), path.join(destinationPath, entry), {
      recursive: true,
      force: false,
      errorOnExist: true,
      preserveTimestamps: true,
      verbatimSymlinks: true,
      filter: current => path.basename(current) !== '.git',
    });
  }
  for (const [link, target, absolute] of remappedLinks) {
    const copiedLink = path.join(destinationPath, link);
    const copiedTarget = path.join(destinationPath, target);
    await unlink(copiedLink);
    await symlink(absolute ? copiedTarget : path.relative(path.dirname(copiedLink), copiedTarget) || '.', copiedLink);
  }
  return { source: sourcePath, destination: destinationPath };
}
