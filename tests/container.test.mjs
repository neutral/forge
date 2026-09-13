import assert from 'node:assert/strict';
import test from 'node:test';
import { containerArguments, containerCockpit, inContainer, inspectContainer, openContainer } from '../library/container.mjs';
import { version } from '../library/version.mjs';

const application = { schemaVersion: 1, name: 'forge', version, layoutVersion: 1 };

function fixture({ metadata = application, state, ports, env = ['FORGE_PORT=4400'], endpoint = 'unix:///var/run/docker.sock', service = application, failure } = {}) {
  const calls = [];
  const inspection = { Id: 'selected-container-id', State: state ?? { Running: true, Status: 'running' },
    Config: { Env: env }, NetworkSettings: { Ports: ports ?? { '4400/tcp': [{ HostIp: '127.0.0.1', HostPort: '15430' }] } } };
  const run = async args => {
    calls.push(args);
    if (args[0] === 'inspect') return { stdout: JSON.stringify([inspection]) };
    if (args[0] === 'exec') {
      assert.deepEqual(args, ['exec', inspection.Id, 'cat', '/opt/forge/forge-application.json']);
      if (failure) throw new Error(failure);
      return { stdout: JSON.stringify(metadata) };
    }
    if (args[0] === 'context') return { stdout: JSON.stringify([{ Endpoints: { docker: { Host: endpoint } } }]) };
    assert.fail(`Unexpected Docker operation: ${args[0]}`);
  };
  const fetch = async (url, options) => {
    calls.push(['GET', url]);
    assert.equal(options.redirect, 'error');
    assert.ok(options.signal instanceof AbortSignal);
    return { ok: true, json: async () => ({ application: service, token: 'PRIVATE_SESSION_TOKEN' }) };
  };
  return { calls, inspection, options: { run, fetch, env: {} } };
}

test('opening inspects the immutable container ID and actual published port with only read operations', async () => {
  const sample = fixture();
  const result = await openContainer('worker-1', { ...sample.options, browser: false, open: () => assert.fail('browser disabled') });
  assert.deepEqual(result, { container: 'worker-1', containerId: 'selected-container-id', url: 'http://127.0.0.1:15430', version, browser: 'disabled' });
  assert.deepEqual(sample.calls, [
    ['inspect', '--type', 'container', '--', 'worker-1'],
    ['exec', 'selected-container-id', 'cat', '/opt/forge/forge-application.json'],
    ['context', 'inspect'], ['GET', 'http://127.0.0.1:15430/api/session'],
  ]);
  assert.equal(JSON.stringify(result).includes('PRIVATE_SESSION_TOKEN'), false);
});

test('stopped, paused, restarting and dead selections fail before entering the container', async () => {
  for (const state of [
    { Running: false, Status: 'exited' }, { Running: true, Paused: true, Status: 'paused' },
    { Running: true, Restarting: true, Status: 'restarting' }, { Running: true, Dead: true, Status: 'dead' },
  ]) {
    const sample = fixture({ state });
    await assert.rejects(openContainer('worker-1', sample.options), /unavailable/);
    assert.equal(sample.calls.length, 1);
  }
});

test('a missing container or incompatible payload remains visible without replacement or dispatch', async () => {
  await assert.rejects(inspectContainer('missing', { run: async args => {
    assert.equal(args[0], 'inspect');
    throw new Error('No such container: missing');
  } }), /No such container/);
  for (const metadata of [{ ...application, version: '999.0.0' }, { ...application, name: 'other' },
    { ...application, layoutVersion: 2 }, { ...application, schemaVersion: 2 }, null]) {
    const sample = fixture({ metadata });
    await assert.rejects(inContainer('worker-1', ['progress', '--direction', '/workspace/direction'], sample.options), /incompatible/);
    assert.equal(sample.calls.length, 2);
  }
  const sample = fixture({ failure: 'No such file or directory' });
  await assert.rejects(containerCockpit('worker-1', sample.options), /no readable compatible Forge installation/);
  assert.equal(sample.calls.length, 2);
});

test('container paths stay literal, support spaces and stdin, and reject relative host interpretation before Docker', async () => {
  const args = ['init', '--workspace=/workspace/a b', '--direction', '/workspace/a b/direction', '--input-file', '-'];
  assert.deepEqual(containerArguments('worker-1', args, 'immutable-id'), ['exec', '-i', '--env', 'FORGE_CONTAINER=worker-1',
    'immutable-id', '/opt/forge/bin/forge', ...args]);
  for (const option of ['direction', 'workspace', 'directions', 'folder', 'input-file']) {
    for (const value of ['relative/file', '~/workspace', 'file:///workspace', 'C:\\workspace']) {
      await assert.rejects(inContainer('worker-1', ['show', `--${option}`, value], {
        run: () => assert.fail('invalid path must fail before Docker'),
      }), /absolute container path/);
    }
  }
});

test('cockpit discovery rejects absent ports, non-loopback mappings, remote endpoints and wrong HTTP service identity', async () => {
  for (const options of [
    { ports: {} }, { ports: { '4400/tcp': null } },
    { ports: { '4400/tcp': [{ HostIp: '192.0.2.1', HostPort: '4310' }] } },
    { env: ['FORGE_PORT=invalid'] }, { endpoint: 'ssh://remote-docker' },
    { service: { ...application, version: '999.0.0' } }, { service: {} },
  ]) {
    const sample = fixture(options);
    await assert.rejects(containerCockpit('worker-1', sample.options));
    assert.equal(sample.calls.some(args => ['run', 'start', 'restart', 'unpause', 'create'].includes(args[0])), false);
  }
  const sample = fixture();
  await assert.rejects(containerCockpit('worker-1', { ...sample.options, fetch: async () => { throw new Error('connection refused'); } }), /unavailable.*connection refused/);
});

test('IPv6 and wildcard published ports map to loopback without guessing the configured container port', async () => {
  for (const [host, expected] of [['::1', '[::1]'], ['::', '[::1]'], ['0.0.0.0', '127.0.0.1']]) {
    const sample = fixture({ env: [], ports: { '4310/tcp': [{ HostIp: host, HostPort: '14310' }] } });
    const result = await containerCockpit('worker-1', sample.options);
    assert.equal(result.url, `http://${expected}:14310`);
  }
});

test('Docker environment overrides preserve local versus remote endpoint scope', async () => {
  const sample = fixture();
  await assert.rejects(containerCockpit('worker-1', { ...sample.options, env: { DOCKER_HOST: 'tcp://remote:2376' } }), /local Docker endpoint/);
  assert.equal(sample.calls.some(args => args[0] === 'context'), false);
  const override = fixture();
  const result = await containerCockpit('worker-1', { ...override.options,
    env: { DOCKER_HOST: 'tcp://remote:2376', DOCKER_CONTEXT: 'desktop-linux' } });
  assert.equal(result.url, 'http://127.0.0.1:15430');
  assert.ok(override.calls.some(args => args.join(' ') === 'context inspect desktop-linux'));
});

test('browser opening is explicit, reports submission scope, and preserves URL fallback on failure', async () => {
  const sample = fixture();
  const opened = [];
  const result = await openContainer('worker-1', { ...sample.options, platform: 'darwin',
    open: async (...args) => opened.push(args) });
  assert.equal(result.browser, 'requested');
  assert.deepEqual(opened[0].slice(0, 2), ['open', ['http://127.0.0.1:15430']]);
  const fallback = await openContainer('worker-1', { ...sample.options, platform: 'linux',
    open: async () => { throw new Error('no browser'); } });
  assert.equal(fallback.browser, 'unavailable');
  assert.equal(fallback.url, result.url);
  assert.match(fallback.message, /Open the URL/);
});
