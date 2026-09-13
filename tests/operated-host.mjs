// Explicit manual host probe. It uses an existing idle Direction Worker and
// starts and stops one foreground command. It is outside npm test.
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { CodexConnection, Communicator, nativeWorkerOptions } from '../library/codex.mjs';
import { readDirectionBinding } from '../library/direction.mjs';
import { steerDirection, stopDirection } from '../library/steer.mjs';

const { values } = parseArgs({ options: {
  direction: { type: 'string' }, probe: { type: 'string' }, output: { type: 'string' },
} });
for (const key of ['direction', 'probe', 'output']) assert.ok(values[key], `--${key} is required`);
assert.ok(['cooperative', 'interrupt'].includes(values.probe), '--probe must be cooperative or interrupt');
const direction = await readDirectionBinding(values.direction, { includeWorkers: false });
assert.ok(direction.workerId, 'The Direction must have an explicitly selected Worker');
const output = path.resolve(values.output);
const observations = [];
const record = event => { const observed = { observedAt: new Date().toISOString(), ...event }; observations.push(observed); console.log(JSON.stringify(observed)); };
const compactOutcome = ({ host, ...outcome }) => outcome;
const connection = await CodexConnection.connect(direction.hostUrl);
const communicator = new Communicator(connection, direction.workerId, nativeWorkerOptions(direction.hostOptions));
const runId = Date.now();
const marker = `FORGE_${values.probe.toUpperCase()}_${runId}_RUNNING`;
const stopFile = `.forge-probe-${runId}-after-command.txt`;
const foregroundFinishedFile = `.forge-probe-${runId}-foreground-finished.txt`;
let activeTurn;
let stopOutcome;
let stopPromise;
let foregroundPID;
let outputTail = '';
let completedResolve;
const completedTurns = new Map();
const completed = new Promise(resolve => { completedResolve = resolve; });
const observationTimeout = setTimeout(() => completedResolve('timeout'), 180_000);
connection.on('notification', event => {
  if (event.params?.threadId !== direction.workerId) return;
  if (event.method === 'turn/completed') {
    const { id, status, error } = event.params.turn;
    const turn = { id, status, ...(error && { error: error.message }) };
    completedTurns.set(id, turn);
    if (id === activeTurn) completedResolve(turn);
  }
  if (!stopPromise && event.method === 'item/commandExecution/outputDelta') {
    outputTail = (outputTail + String(event.params.delta)).slice(-512);
    const match = outputTail.match(new RegExp(`${marker} pid=(\\d+)\\r?\\n`));
    if (!match) return;
    foregroundPID = Number(match[1]);
    stopPromise = (async () => {
      record({ type: 'foreground_output_observed', marker, pid: foregroundPID });
      stopOutcome = await stopDirection(connection, direction.folder, {
        mode: values.probe === 'interrupt' ? 'interrupt' : 'request',
        reason: 'Cooperative stop probe: stop before the post-command development file is written. Further development needs explicit continuation.',
      });
      record({ type: 'stop_call_outcome', ...compactOutcome(stopOutcome) });
    })();
    stopPromise.catch(error => {
      record({ type: 'stop_call_failed', error: error.message });
      completedResolve('stop_failed');
    });
  }
});
connection.on('hostRequest', event => record({ type: 'host_request', id: event.id, method: event.method, threadId: event.params?.threadId }));
connection.on('transportError', error => record({ type: 'transport_error', error: error.message }));
connection.on('protocolError', error => record({ type: 'protocol_error', error: error.message }));
connection.on('disconnected', () => completedResolve('disconnected'));
try {
  const initial = await communicator.read();
  assert.equal(initial.thread.turns.some(turn => turn.status === 'inProgress'), false, 'Worker must be idle before this explicit probe');
  const seconds = values.probe === 'interrupt' ? 12 : 6;
  // Delay first output so the native host can attach its command output stream.
  const command = `python3 -u -c 'import os,time; from pathlib import Path; time.sleep(1); print("${marker} pid="+str(os.getpid()),flush=True); time.sleep(${seconds}); Path("${foregroundFinishedFile}").write_text("foreground command reached its end"); print("FOREGROUND_FINISHED",flush=True)'`;
  const result = await steerDirection(connection, direction.folder, { text: `Explicitly continue this same Worker after any earlier stop for this small host-control experiment only. Run exactly this foreground command using exec_command with yield_time_ms 10000, without detaching it: ${command}\nIf it completes normally and no stop order has arrived, write ${stopFile} containing "development continued". Do not start other development. If stopped, follow the stop instruction and do not write that file. Keep the command foreground so the Director can observe the host control; report its actual outcome honestly.` });
  activeTurn = result.turnId;
  if (completedTurns.has(activeTurn)) completedResolve(completedTurns.get(activeTurn));
  record({ type: 'development_call_outcome', ...compactOutcome(result) });
  const turn = await completed;
  if (stopPromise) await stopPromise;
  record({ type: 'observed_turn_completion', turn });
  assert.notEqual(turn, 'timeout', 'No completed turn observed before probe observer timeout; no control guarantee established');
  assert.notEqual(turn, 'disconnected', 'Host disconnected');
  assert.ok(stopOutcome, 'No slow foreground output observed; stop probe was not executed');
  if (values.probe === 'interrupt') assert.equal(turn.status, 'interrupted');
  if (foregroundPID) {
    let alive;
    try { process.kill(foregroundPID, 0); alive = true; }
    catch (error) { alive = error.code === 'ESRCH' ? false : `unknown: ${error.code}`; }
    record({ type: 'foreground_process_after_turn', pid: foregroundPID, alive });
  }
  await assert.rejects(readFile(path.join(direction.workspace, stopFile)), { code: 'ENOENT' }, 'Worker wrote the post-command development file despite stop');
  record({ type: 'post_command_write_absent', path: stopFile });
  if (values.probe === 'interrupt') {
    // Observe the command's natural deadline without sending further Worker instructions.
    await new Promise(resolve => setTimeout(resolve, (seconds + 2) * 1000));
    let content;
    try { content = await readFile(path.join(direction.workspace, foregroundFinishedFile), 'utf8'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    record({ type: 'foreground_completion_after_interruption', completed: content !== undefined, path: foregroundFinishedFile });
  }
} finally {
  clearTimeout(observationTimeout);
  connection.close();
  await writeFile(output, observations.map(event => JSON.stringify(event)).join('\n') + '\n');
}
