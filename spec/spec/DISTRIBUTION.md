# Distribution

A Forge application payload contains the runtime implementation, command adapter,
prebuilt cockpit, container startup adapter, operating guides, contracts, metadata,
and license notices. A standalone native bundle contains that payload and its
supported Node runtime. A container image can install the same versioned payload
with one compatible shared runtime.

## Payload and launch contract

The application payload MUST be usable after relocation outside its source checkout.
It MUST preserve the public library entry points. It MUST NOT require development
configuration, tests, sibling repositories, Atlas, or Intent. Platform-dependent
dependencies MUST match the declared target platform.

The installed layout has `src/`, `cli/`, `web/`, `runtime/`, `guides/`, `spec/`,
`bin/forge`, `package.json`, and `forge-application.json` at one application root.
The identity file MUST declare `schemaVersion`, `layoutVersion`, `name`, and `version`.
Packaging metadata MUST identify components and checksums. These describe artifacts;
they MUST NOT acquire execution-evidence or completion authority.

The npm distribution uses the package identity `@neutral/forge`. It MUST expose the
`forge` command and public library entry points, and include the application payload,
operating guidance, contracts, and license notices. Installation MUST NOT require
the source checkout or a separate application build. Package metadata MAY place the
application beneath the package root while preserving its installed layout.

The standalone bundle MUST supply a pinned supported Node runtime, required runtime
license notices, and a `forge` launcher that works without Node or npm on `PATH`.
The application payload MUST also be available separately for installation with a
compatible shared Node runtime. Its launch contract MUST document Node and agent-host
requirements, installed paths, commands, writable state, and persistent storage.

## Native controller and container selection

Native installation describes where Forge's controller is installed. Worker execution
remains in the explicitly selected container under [Workspace](WORKSPACE.md).
Installing or opening Forge MUST NOT start Worker development or silently select,
create, replace, or dispose of a container. Container-directed paths MUST denote
paths inside the selected container; the controller MUST NOT reinterpret host paths.

Opening a selected container's cockpit MUST inspect its actual state, compatibility,
and published port mapping. An unavailable, incompatible, or unreachable selection
MUST fail visibly. The command MUST provide an accessible URL when opening a browser
is unavailable and MUST support an explicit browser-free invocation. It MUST NOT
change saved Worker routing or initiate STEER.

The installed native command MUST keep secure local service defaults and ordinary
host execution and approval defaults. Container-specific settings MUST be explicit
in the container recipe. A standalone bundle MUST NOT bundle or silently install a
Docker engine. The installation guide MUST state Docker and host prerequisites.

## Services and persistence

The payload MUST support unattended container startup with explicit binding and
ports, declared writable state, and no host browser launch. Startup documentation
MUST distinguish service readiness, native authentication, and Worker outcomes.
The service adapter MUST document stdout, stderr, graceful shutdown, and child-process
termination. Container serving options MUST NOT broaden a native host endpoint by
default.

Installation, upgrade, replacement, and removal MUST preserve project content,
Directions, PROGRESS, authentication, and native conversations unless the operator
explicitly chooses disposal. Container lifecycle remains an ordinary operator action
under [Workspace](WORKSPACE.md#persistence-and-controls).

## Compatibility and verification

Distribution documentation MUST identify versioned components, supported runtime
requirements, the buildable OS and architecture matrix, and actually exercised
artifacts. Declared additional targets MUST have reproducible build recipes and be
labeled untested until their artifacts are exercised.

Native verification MUST exercise help, version, relocation, paths with spaces,
container selection failures, actual cockpit access, and read-only container commands
with Node and npm absent from `PATH`. The separate payload MUST run using the declared
shared Node runtime. Claims about native delivery, interruption, continuation, or
persistence additionally require the journeys owned by
[Communicator](COMMUNICATOR.md#delivery-and-acceptance).
