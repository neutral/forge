# Codex app-server binding

Forge binds Direction control to Codex CLI 0.153.4. The supplied container runs the
native host on its internal `ws://127.0.0.1:4500` address. See
[setup](install.md) for installation, authentication, host defaults,
and persistent storage.

## Direct STEER

A fresh STEER calls `thread/start`, saves the returned Worker handle and selected
native settings in the Direction, then calls `turn/start`. Follow-up STEER resumes
that exact conversation and calls `turn/start` when idle or `turn/steer` with the
expected native turn ID when active. Forge neither queues instructions in SQLite
nor silently reconstructs or replaces a Worker.

The Worker receives ordinary instruction text, pointers to its goal and checklist,
the packaged operating guide, and a local command for authoring PROGRESS. Forge
requires no structured response envelope. The guide is
`/opt/forge/guides/operate.md` in the Worker image; other installations resolve
it relative to the package. The Worker reads context through its own tools.

A successful call reports `message_submitted`, request and Worker identifiers, and
the native turn ID. This establishes submission, not execution or completion.
`--wait` observes the submitted turn's completion and reports its compact status;
a failed native turn exits nonzero. Native completion does not establish checklist
satisfaction or create a PROGRESS record.

Errors retain the selected Worker and request identity when known. Inspect that
binding before another action: Forge does not retry dispatch. Explicit fresh
selection preserves earlier accounts and attribution and does not stop an earlier
Worker.

## Native settings

Direction bindings retain explicitly selected model, sandbox, and approval settings
and reapply them on continuation and stop. Omitted settings follow host defaults.
A Direction uses its saved host URL; the CLI rejects a differing override.

Forge does not answer native approval requests automatically, and the cockpit has
no approval dialog. A policy requiring interactive decisions needs a native client
or an operator using `CodexConnection.respond(id, result)`. Configuration belongs in
[container setup](install.md#worker-container).

## PROGRESS and inspection

The Worker appends its account with local `forge progress`. The Director reads it
without attaching to a Worker. Native commentary, tool output, and final replies
remain native conversation content. The [Direction contract](../spec/spec/DIRECTION.md)
owns account attribution, persistence, and supported storage.

Direct `steer`, `stop`, and `cockpit` commands outside a selected container require
explicit `--native-host` for advanced host-adapter diagnosis. The normal native
controller route is `--container NAME`; the recipe supplies `FORGE_CONTAINER` for
commands run inside its container.

These low-level host diagnostics are advanced operations. Native installation does
not select them as the Worker route. Use explicit `--container NAME` for Worker
Direction commands from the native controller.

`forge read --url HOST --thread WORKER_ID` and `forge watch --url HOST --thread
WORKER_ID` expose native conversation data for diagnosis. They neither author
PROGRESS nor control a Worker. Keep raw output outside Git.

## Stop and continuation

Direction-based stop uses the saved Worker, host, and settings independently of
goal or checklist access. Invalid routing metadata still fails visibly.

`stop --mode request` sends an ordinary stop instruction. Its immediate result is
`message_submitted`; delivery timing does not establish an execution cutoff.
`stop --mode interrupt` calls native `turn/interrupt`. An accepted request reports
`interrupt_requested`; a subsequent native event can establish an interrupted turn.
Neither result guarantees that already-running foreground or detached tools stopped.

A later information request is STEER asking the saved Worker for an account and
supporting inspection. Further development follows explicit continuation. The
[Communicator contract](../spec/spec/COMMUNICATOR.md#stop-and-continuation)
owns these scopes. Docker controls affect the whole container; their operational
use is described in [setup](install.md#preserve-and-replace).

## Library access

The CLI and cockpit use the same Direction control functions. The installed
application exposes them through `src/index.mjs` beneath its installation root.
For the container installation at `/opt/forge`, use the explicit module path:

```js
import { CodexConnection, readDirectionBinding, steerDirection, stopDirection } from '/opt/forge/src/index.mjs';

const folder = '/workspace/.forge/directions/example';
const binding = await readDirectionBinding(folder);
const connection = await CodexConnection.connect(binding.hostUrl);
try {
  await steerDirection(connection, folder, {
    text: 'Explain the remaining checklist concerns and record PROGRESS.',
  });
  await stopDirection(connection, folder, { mode: 'request' });
} finally {
  connection.close();
}
```

Adjust the import for a different installation location. Adding `bin/forge` to
`PATH` makes the command available; Node resolves module imports separately.

`Communicator` retains native create, attach, plain-text send, read, and interrupt
operations for adapters. It supplies no separate authoring taxonomy or lifecycle.
The [verification procedure](verification.md) distinguishes automated
routing checks from actual host behavior.
