# Workspace

A workspace is the persistent source tree used for Worker development and Director
inspection. An ordinary Docker container supplies the selected development
environment. Git or ordinary copying supplies snapshot and integration operations.

## Snapshot and repository access

The Director MUST select the source snapshot or existing workspace explicitly.
Several Workers MAY use the same workspace and container, each from its own
[Direction](DIRECTION.md). Forge MUST NOT synchronize upstream changes into the
workspace, enforce non-overlap, assign file ownership, acquire work-scope locks, or
require coordination between Workers. Director steering reaches each Worker through
the [Communicator](COMMUNICATOR.md).

The project supplies its environment, implementation, tests, guidance, and repository
tools. Worker development, artifacts, and raw output MUST remain in the selected
container's persistent storage. A container binding MUST run development tools in
that container and describe where the agent host and its state reside. A host
working-directory setting alone MUST NOT be presented as container execution.
[Distribution](DISTRIBUTION.md#native-controller-and-container-selection) owns native
installation and explicit container selection.
Binding documentation MUST describe conversation, continuation, and interruption
controls and distinguish any low-level adapter that does not provide this arrangement.

The Director and Worker access project systems directly through repository tools.
Forge MUST NOT poll, read, query, validate, edit, import, wrap, or intermediate Atlas
or Intent or their tools, or launch their Editors. A generic snapshot copy MAY
preserve their files as opaque ordinary files. It MUST NOT interpret those files or
assemble semantic context. The [Communicator](COMMUNICATOR.md#steer-and-worker-selection)
supplies the packaged operating guide's location when starting work.

## Persistence and controls

Authored configuration, checklist documents, and unique work MUST remain in ordinary
persistent files. Unique work and checklist content MUST NOT exist only in a
rebuildable tooling cache. Workspace use and inspection MUST require no evidence
store, recovery journal, snapshot ledger, or generated authority state. [Direction](DIRECTION.md#canonical-storage) owns its SQLite routing
and PROGRESS records. Product databases remain product concerns.

Docker pause freezes execution inside the container; resume continues it. Pause
affects every Worker and service in that container. It neither stops an external
agent host nor controls tools outside the container. Persistent storage remains
available through ordinary filesystem or volume access; in-container commands and
the cockpit require the container to run. Container stop performs ordinary
termination. Native Worker interruption is a separate control with the scope
specified by the selected binding under
[Communicator](COMMUNICATOR.md#stop-and-continuation).

The Director and Worker use terminals, Git, product observability, and repository
tools directly. Forge MAY expose a read-only target Git diff through the
[cockpit](COCKPIT.md). The product supplies its own telemetry. Standard document
tools can display checklist material without executing commands or resolving
references.

## Inspection, integration, and disposal

Saved files MUST remain available after Worker completion, cooperative stop,
interruption, host failure, missing output, or the Director's decision to end
investment. Missing conversation context MUST NOT block independent inspection.
Integration remains the Director's ordinary Git or copy operation.

Forge MUST NOT destroy a workspace automatically. Success, failure, missing messages,
and exhausted investment do not authorize deletion. Disposal requires an explicit
operator action.
