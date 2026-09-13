import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { once } from 'node:events';
import test from 'node:test';

const entry = fileURLToPath(new URL('../distribution/worker-entry.mjs', import.meta.url));
const quote = value => `'${value.replaceAll("'", "'\\''")}'`;
async function unusedPort() {
  const listener = net.createServer();
  listener.listen(0, '127.0.0.1');
  await once(listener, 'listening');
  const port = listener.address().port;
  await new Promise(resolve => listener.close(resolve));
  return port;
}

for (const explicitPolicy of [false, true]) test(`startup preserves ${explicitPolicy ? 'explicit recipe policy' : 'native defaults'} and shuts down its services`, { timeout: 15000 }, async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'forge startup '));
  t.after(() => rm(root, { recursive: true, force: true }));
  const bin = path.join(root, 'bin');
  const workspace = path.join(root, 'workspace');
  const state = path.join(root, 'state');
  await Promise.all([mkdir(bin), mkdir(workspace)]);
  const captured = path.join(root, 'args.json');
  const host = path.join(root, 'host.mjs');
  await writeFile(host, `import {writeFileSync} from 'node:fs';
writeFileSync(process.env.FORGE_TEST_CAPTURE, JSON.stringify({args:process.argv.slice(2),home:process.env.CODEX_HOME}));
process.on('SIGTERM',()=>{console.log('host termination received');process.exit(0)});
setInterval(()=>{},1000);
`);
  await writeFile(path.join(bin, 'codex'), `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(host)} "$@"\n`, { mode: 0o755 });
  const env = { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}`, CODEX_HOME: state,
    FORGE_WORKSPACE: workspace, FORGE_TEST_CAPTURE: captured, FORGE_PORT: String(await unusedPort()) };
  delete env.FORGE_BIND;
  delete env.FORGE_SANDBOX;
  delete env.FORGE_APPROVAL_POLICY;
  if (explicitPolicy) Object.assign(env, { FORGE_SANDBOX: 'danger-full-access', FORGE_APPROVAL_POLICY: 'never', FORGE_BIND: '0.0.0.0' });
  const child = spawn(process.execPath, [entry], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  const exited = once(child, 'exit');
  t.after(async () => { if (child.exitCode === null && child.signalCode === null) { child.kill('SIGTERM'); await exited; } });
  let stderr = '';
  child.stderr.on('data', value => { stderr += value; });
  const ready = await new Promise((resolve, reject) => {
    let text = '';
    child.stdout.on('data', chunk => {
      text += chunk;
      if (text.includes('\n')) {
        try { resolve(JSON.parse(text.split('\n')[0])); } catch (error) { reject(error); }
      }
    });
    child.once('error', reject);
    child.once('exit', code => reject(new Error(`startup exited ${code}: ${stderr}`)));
  });
  assert.equal(ready.host, explicitPolicy ? '0.0.0.0' : '127.0.0.1');
  assert.equal(ready.port, Number(env.FORGE_PORT));
  const session = await fetch(`${ready.url}/api/session`).then(r => r.json());
  assert.equal(session.application.name, 'forge');
  assert.equal(session.workspace, await realpath(workspace));
  let record;
  for (let attempt = 0; attempt < 100; attempt++) {
    try { record = JSON.parse(await readFile(captured, 'utf8')); break; }
    catch (error) { if (error.code !== 'ENOENT') throw error; await new Promise(resolve => setTimeout(resolve, 20)); }
  }
  assert.equal(record.home, state);
  assert.deepEqual(record.args, ['app-server', '--listen', 'ws://127.0.0.1:4500',
    ...(explicitPolicy ? ['-c', 'sandbox_mode="danger-full-access"', '-c', 'approval_policy="never"'] : [])]);
  child.kill('SIGTERM');
  assert.deepEqual(await exited, [0, null]);
  assert.match(await readFile(path.join(state, 'app-server.log'), 'utf8'), /host termination received/);
  await assert.rejects(fetch(`${ready.url}/api/session`));
  assert.equal(await readFile(captured, 'utf8').then(JSON.parse).then(r => r.home), state);
});
