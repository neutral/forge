import { cp, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Distribution and npm regressions exercise a copy of this public source checkout.
export async function prepareRelease(output) {
  const root = fileURLToPath(new URL('../../', import.meta.url));
  await mkdir(output);
  for (const name of ['package.json', 'README.md', 'CHANGELOG.md', 'CONTRIBUTING.md', 'LICENSE', 'LICENSE.0BSD',
    'LICENSE.CC0-1.0', 'library', 'apps', 'docs', 'spec', 'distribution', 'examples']) {
    await cp(path.join(root, name), path.join(output, name), { recursive: true, errorOnExist: true, force: false });
  }
}
