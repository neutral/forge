import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Communicator, nativeWorkerOptions } from './codex.mjs';
import { bindWorker, readDirectionBinding } from './direction.mjs';

const defaultForgeCommand = [process.execPath, fileURLToPath(new URL('../apps/cli/forge.mjs', import.meta.url))];
const operatingGuide = fileURLToPath(new URL('../spec/OPERATING.md', import.meta.url));

function nonemptyString(value, label) {
  if (typeof value !== 'string' || !value.trim() || value.includes('\0')) {
    throw new TypeError(`${label} must be a nonempty string without NUL bytes`);
  }
  return value;
}

const shellQuote = value => `'${value.replaceAll("'", "'\\''")}'`;

function workerInstructions(direction, workerId, forgeCommand, text) {
  const progress = [...forgeCommand, 'progress', '--direction', direction.folder, '--worker', workerId,
    '--text', 'Your own concise account of progress, results, questions or remaining uncertainty.']
    .map(shellQuote).join(' ');
  return `Forge Direction: ${JSON.stringify(direction.folder)}.
Read Forge's operating guide at ${JSON.stringify(operatingGuide)} through your own tools and follow its Worker guidance.
Read the Direction's goal at ${JSON.stringify(path.join(direction.folder, 'goal.md'))} and its checklist at ${JSON.stringify(path.join(direction.folder, 'checklist'))} through your own tools.
Work in ${JSON.stringify(direction.workspace)}${direction.container === null ? '' : ` in container ${JSON.stringify(direction.container)}`}. Keep code, artifacts, command output and raw logs in the container.
To record PROGRESS in your Direction, write your own paraphrased account locally with this command, replacing the example text:
${progress}
Native commentary and final replies are not PROGRESS records. No periodic PROGRESS is required.

Director STEER follows verbatim:
${text}`;
}

/** Deliver STEER directly to the Direction's selected Worker; never queue it. */
export async function steerDirection(connection, folder, options = {}) {
  if (!connection || typeof connection.request !== 'function') throw new TypeError('A native host connection is required');
  nonemptyString(folder, 'Direction folder');
  if (!options || typeof options !== 'object' || Array.isArray(options)) throw new TypeError('STEER options must be an object');
  const { text, fresh = false, model, sandbox, approvalPolicy, forgeCommand = defaultForgeCommand } = options;
  nonemptyString(text, 'STEER text');
  if (typeof fresh !== 'boolean') throw new TypeError('fresh must be a boolean');
  for (const [key, value] of Object.entries({ model, sandbox, approvalPolicy })) {
    if (value !== undefined) nonemptyString(value, key);
  }
  if (!fresh && [model, sandbox, approvalPolicy].some(value => value !== undefined)) {
    throw new TypeError('model, sandbox and approvalPolicy require an explicitly fresh Worker');
  }
  if (!Array.isArray(forgeCommand) || forgeCommand.length === 0) throw new TypeError('forgeCommand must be a nonempty argv array');
  for (const value of forgeCommand) nonemptyString(value, 'forgeCommand argument');

  const direction = await readDirectionBinding(folder, { includeWorkers: false });
  let communicator;
  if (fresh) {
    const created = await Communicator.create(connection, {
      cwd: direction.workspace,
      ...nativeWorkerOptions({ model, sandbox, approvalPolicy }),
    });
    communicator = created.communicator;
    try {
      await bindWorker(direction.folder, communicator.threadId, { tolerateGoalError: true, maxGoalBytes: 1, includeWorkers: false }, communicator.attachOptions);
    } catch (cause) {
      const error = new Error(`Created Worker ${communicator.threadId}, but could not bind it to Direction ${direction.folder}: ${cause.message}`, { cause });
      Object.assign(error, { direction: direction.folder, workerId: communicator.threadId, threadId: communicator.threadId, createdWorker: true });
      throw error;
    }
  } else {
    if (!direction.workerId) throw new Error('Direction has no selected Worker; use an explicitly fresh STEER to start one');
    communicator = new Communicator(connection, direction.workerId, nativeWorkerOptions(direction.hostOptions));
  }
  try {
    const outcome = await communicator.send(workerInstructions(direction, communicator.threadId, forgeCommand, text));
    return { ...outcome, direction: direction.folder, workerId: communicator.threadId, fresh };
  } catch (error) {
    Object.assign(error, { direction: direction.folder, workerId: communicator.threadId, fresh, createdWorker: fresh });
    throw error;
  }
}

/** Stop the selected Worker through its saved native binding. */
export async function stopDirection(connection, folder, options = {}) {
  if (!connection || typeof connection.request !== 'function') throw new TypeError('A native host connection is required');
  nonemptyString(folder, 'Direction folder');
  if (!options || typeof options !== 'object' || Array.isArray(options)) throw new TypeError('Stop options must be an object');
  const { mode = 'request', reason = '' } = options;
  if (!['request', 'interrupt'].includes(mode)) throw new TypeError('Stop mode must be request or interrupt');
  if (typeof reason !== 'string' || reason.includes('\0')) throw new TypeError('Stop reason must be a string without NUL bytes');
  const direction = await readDirectionBinding(folder, { includeWorkers: false });
  if (!direction.workerId) throw new Error('Direction has no selected Worker');
  const communicator = new Communicator(connection, direction.workerId, nativeWorkerOptions(direction.hostOptions));
  try {
    const outcome = mode === 'interrupt' ? await communicator.interrupt()
      : await communicator.send(`Stop development. Cease initiating further development when this order is received. Perform only immediate settling actions needed to leave the current operation stoppable, then yield. Further development requires an explicit continuation instruction.\n${reason}`);
    return { ...outcome, direction: direction.folder, workerId: direction.workerId };
  } catch (error) {
    Object.assign(error, { direction: direction.folder, workerId: direction.workerId, createdWorker: false });
    throw error;
  }
}
