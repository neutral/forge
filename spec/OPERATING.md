# Operating Forge

This guide applies the [core specification](SPEC.md) to Director and Worker use.
The selected [host binding](../docs/codex-binding.md) documents native commands,
delivery behavior, and control limits.

## Director

Choose a goal, source snapshot, and persistent development container. Initialize a
Direction in that container, with its own folder and goal. Put useful initial
concerns in its `checklist/` folder or leave assembly to the Worker. Several
Directions can use the same container and workspace. Choose goals that appear
sufficiently independent and handle conflicts if that judgment proves wrong.
Forge introduces no coordination protocol between Workers.

Start a Worker explicitly with STEER. Supply its instructions, relevant context,
and applicable project guidance. Forge supplies the location of its packaged
operating guide, the Direction location, and the reporting identifier. Other
definitions and references remain available through the repository and its tools.
Forge does not retrieve Atlas or Intent material.

Read PROGRESS from the Direction when useful. These are stored Worker accounts;
reading them does not ask the Worker for an update. Send STEER directly to its
existing Worker when a new explanation, answer, or change in direction is useful.
Select a fresh Worker explicitly when new context is appropriate. That selection
retains earlier accounts and does not stop the previous Worker.

Choose and monitor time, attention, token, cost, and repair investment externally.
Inspect saved work, checklist documents, and project knowledge directly. No periodic
exchange is required. Use a cooperative stop when the Worker can settle its current
operation and yield. Use native interruption to request interruption of its active
invocation. Distinguish the host's result from the Worker's account. Container pause
and stop affect every Direction using that container.

After a stop, a request for information permits an account and supporting
inspection. Give explicit continuation direction to resume development. Resume a
separately paused container before work that needs it. Inspect and integrate selected
changes through ordinary Git or copying. Delete saved work only by an explicit
operator action.

## Worker

Read the goal and checklist in your Direction and develop toward the supplied
instructions. Consult implementation, project guidance, and repository tools
directly. Develop code, project knowledge, Checks, and useful product observability
as understanding grows. Work and raw output stay in the container.

Complete the checklist where possible. Discover associated or missing Checks and
strengthen weak definitions when useful. A plain concern or reference is enough to
begin. Preserve source definitions and make meaningful criteria changes visible in
ordinary files or notes.

Follow an exact command or procedure when supplied and assess its result against the
concern. Otherwise choose tests, inspection, product use, experiments, reasoning, or
a useful combination. Distinguish judgment from recorded results when relevant.
Unchecked work remains unresolved when investment ends. No status enum or Check
report format is required.

Write PROGRESS in your Direction when useful. Paraphrase work, findings, material
questions, unresolved concerns, and useful next actions. Refer to saved files where
helpful; keep raw logs and artifacts in the container. Use the supplied Worker
identifier, and use the STEER request identifier when answering a particular request.
Writing an account does not contact the Director or await delivery. Resolve ordinary
ambiguity using available context; leave questions that materially affect the work
in PROGRESS. No periodic reporting or final report is required.

Receive instructions directly through the agent host. Do not poll the Direction for
STEER. Explain checklist status or topics using your working context and available
files when asked, distinguishing recorded results from new judgment. An information
request alone does not instruct a verification campaign. Earlier Worker accounts
remain their authors' claims; do not present them as your own verification.

On receiving a cooperative stop order, cease initiating development and yield. Take
only immediate settling actions needed to leave the current operation stoppable.
A short PROGRESS entry is optional when the host permits it. After either stop mode,
answer information requests with supporting inspection and resume development only
on explicit continuation direction. An account does not establish execution cutoff.

## Command path

These command shapes run through the selected container binding. Replace the example
container name and paths with the selected environment. The binding documentation
owns installation and configuration details.

```sh
forge init --container forge-worker --direction /workspace/.forge/directions/example \
  --workspace /workspace --text 'Develop the supplied goal.'
forge steer --container forge-worker --direction /workspace/.forge/directions/example \
  --fresh --text "Read Forge's operating guide at /opt/forge/guides/operate.md, then read your Direction and applicable project guidance and begin the work."
forge progress --container forge-worker --direction /workspace/.forge/directions/example --latest
forge steer --container forge-worker --direction /workspace/.forge/directions/example \
  --text 'Explain what remains unresolved in your checklist; record PROGRESS.'
forge show --container forge-worker --direction /workspace/.forge/directions/example
```

Inside the container, the Worker records an account with its supplied identifier:

```sh
forge progress --direction /workspace/.forge/directions/example --worker WORKER_ID \
  --text 'Describe the work, results, and remaining limitations here.'
```

PROGRESS records are ordinary language with ordering, time, author, and optional
reply metadata. Native host commentary and final responses do not become PROGRESS
unless the Worker explicitly writes an account to its Direction.

## Cockpit

The running container can serve a small Director interface. Select a Direction to
read its goal, checklist, and PROGRESS, inspect the target Git diff, or send STEER.
Reading and refreshing the page do not invoke a Worker. A shared workspace diff
shows saved changes without attributing them to a particular Direction. Start with
Uncommitted changes against the current `HEAD`, or select an ordinary Git reference.
Forge does not create an implicit starting reference for a Direction.

Start the server inside the container when it is not already part of its startup:

```sh
forge cockpit --workspace /workspace --directions /workspace/.forge/directions \
  --bind 0.0.0.0 --port 4310
```

Select the existing container from the native installation:

```sh
forge open --container forge-worker
forge open --container forge-worker --no-browser
```

Opening inspects the actual container and its published cockpit port. It starts no
Worker. `--no-browser` returns the URL for manual access. The
[binding documentation](../docs/codex-binding.md) describes setup. Container pause or
stop also suspends access to the cockpit.
