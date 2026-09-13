# Using the Forge cockpit

The cockpit lets a Director inspect Directions and send STEER to their Workers.
[Container setup](install.md#worker-container) starts it
alongside the native host. From the native installation, run
`forge open --container forge-worker` to inspect and open the selected container's
actual published cockpit address. `--no-browser` prints the URL. Opening starts no Worker. It serves trusted local
Directors; its browser request checks do not provide public multiuser authentication.

## Directions and views

Create a Direction with a name and goal, or open one under the configured parent
folder. Creation writes its goal, empty checklist folder, and SQLite binding. It
does not start a Worker. Select a Direction to inspect its views:

- **Overview** reads the goal and recent Worker-authored PROGRESS. Load earlier
  accounts when needed.
- **Checklist** reads the Direction's checklist files.
- **Git diff** inspects saved changes in the selected workspace.

Automatic refresh reads the selected view's material without invoking a Worker.
An unavailable document produces an error in its view alongside the binding; it
does not appear empty. Stored PROGRESS remains independently readable. Bounded
previews mark truncated content, and canonical files remain available for ordinary
file or CLI inspection. An account's timestamp records when it was written; it
cannot establish that its claims remain current.

Each Direction retains its own goal, checklist, Worker associations, and accounts.
The [Direction contract](../spec/spec/DIRECTION.md) owns their storage and
attribution. Unsupported storage and invalid routing metadata fail visibly.

## Sending STEER

Select the existing Worker or explicitly choose a fresh Worker, write the
instruction, and send it. Drafts survive refreshes and remain associated with their
Direction. Follow-up STEER reaches the saved conversation. Use it to supply context,
answer a question, request information, or explicitly continue development.

The result identifies host submission or an error. Submission does not prove that
the Worker acted. If a fresh Worker was created before a later step failed, inspect
the returned identity and current binding before continuing. Forge does not retry
or replace an unusable Worker automatically. Fresh selection does not stop the
previous Worker.

Selected native settings persist with the Worker. The cockpit has no native
approval dialog; see the [binding guide](codex-binding.md#native-settings) before
selecting a policy that requires interactive decisions.

## Reviewing changes

The Git view initially shows **Uncommitted changes** against current `HEAD`: staged
and unstaged changes, plus untracked files. Choose a branch, tag, or commit to
compare the saved tree with another reference. An unavailable reference produces
an error. Forge saves no implicit starting commit for a Direction.

The diff covers the workspace as a whole, so it cannot attribute changes to a
particular Worker. Workers may edit during inspection. Repository diff drivers,
text conversion, and clean filters are disabled; Direction storage and nested
submodule working changes are omitted. Ordinary Git tools support fuller review.
Without Git history, staged and untracked changes remain available but no existing
commit reference can be selected.

## Command access and controls

The CLI operates on the same Direction. Container-targeted paths are inside that
container:

```sh
forge show --container forge-worker --direction /workspace/.forge/directions/example
forge progress --container forge-worker --direction /workspace/.forge/directions/example --latest
forge steer --container forge-worker --direction /workspace/.forge/directions/example \
  --text 'Explain the remaining checklist concerns and record PROGRESS.'
forge stop --container forge-worker --direction /workspace/.forge/directions/example --mode request
forge stop --container forge-worker --direction /workspace/.forge/directions/example --mode interrupt
```

Use `--fresh` explicitly to start another Worker. The
[binding guide](codex-binding.md#stop-and-continuation) explains stop results and
running-tool limits; [setup](install.md#preserve-and-replace) covers container
controls and persistence. The [cockpit contract](../spec/spec/COCKPIT.md)
owns requirements, and the [verification procedure](verification.md)
describes interface checks.
