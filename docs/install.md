# Installing Forge

Forge installs from npm and runs with an explicitly selected Worker container.

## Install from npm

On macOS or Linux, use Node.js 24 or newer and npm. Windows is not a supported npm
installation target.

```sh
npx @neutral/forge@0.1.0 --version
npx @neutral/forge@0.1.0 --help
```

Use `npx @neutral/forge@0.1.0` for each Forge invocation. In other guides, host-side
examples written as `forge ...` can use `npx @neutral/forge@0.1.0 ...`. The npm package
includes the command, shared library, prebuilt cockpit, operating guides, contracts,
and container startup adapter. It uses the Node runtime on your machine and has no
runtime dependencies to install separately. Continue with
[Worker container setup](#worker-container). The
[source build instructions](#build-from-source) cover local commands and standalone
bundles. [IntentForge](https://github.com/neutral/intentforge) combines the portfolio
using the versioned application payload with one compatible shared Node runtime.

### Use the library

Install the package in the application that imports it:

```sh
npm install @neutral/forge@0.1.0
```

```js
import { version, readDirection, readProgress } from '@neutral/forge';
import { snapshot } from '@neutral/forge/workspace';
```

The package also exports `@neutral/forge/direction` and `@neutral/forge/cockpit`.
An npx invocation does not install a local library dependency; install locally for
these imports.

## Native command

Choose the standalone archive for the host OS and architecture. Check its checksum
against the release's `SHA256SUMS`, then extract the complete directory:

```sh
mkdir -p "$HOME/.local/share/forge" "$HOME/.local/bin"
tar -xzf forge-0.1.0-darwin-arm64.tar.gz -C "$HOME/.local/share/forge"
ln -s "$HOME/.local/share/forge/forge-0.1.0-darwin-arm64/bin/forge" "$HOME/.local/bin/forge"
"$HOME/.local/bin/forge" --version
"$HOME/.local/bin/forge" --help
```

Use the archive name for your platform. Add `$HOME/.local/bin` to `PATH` if needed.
The example leaves an existing command link intact. The launcher works after moving
the complete installation, including into a path with spaces; update its link after
moving it. The bundle includes Node `24.18.0`, so the command needs neither Node nor
npm installed separately.

## Worker container

Docker Engine or Docker Desktop with its CLI is a separate prerequisite. Install and
configure Docker through its normal platform procedure. Forge supplies its command
and Worker recipe; the selected container supplies Worker execution. Container use
requires a compatible Forge payload, the selected native agent host, its authorized
credentials, persistent mounts, and the project's development tools.

The source includes an independently usable Worker recipe. From a Forge source
checkout, build and create a separately named container:

```sh
docker build -f distribution/worker.Dockerfile -t forge-worker:0.1.0 .
docker run --detach --init --name forge-worker \
  --env FORGE_CONTAINER=forge-worker \
  --mount type=bind,source=/absolute/path/to/project,target=/workspace \
  --mount type=volume,source=forge-worker-codex,target=/var/lib/forge/codex \
  --publish 127.0.0.1:4310:4310 forge-worker:0.1.0
```

Select an existing project directory and distinct container and volume names. Quote
a complete `--mount` argument if its source path contains spaces. The image assembles
the versioned application at `/opt/forge`, using Node `24.18.0` and Codex CLI `0.153.4`.
It includes Git, ripgrep, and Python 3; extend the recipe for project-specific tools.
It starts the native host and cockpit, leaving Worker dispatch to explicit STEER.

The source also includes `distribution/compose.yaml`. Select its absolute path with
`docker compose -f`, and set `FORGE_SOURCE` to the absolute Forge source checkout and
`FORGE_WORKSPACE` to the absolute project checkout. Set a distinct
`COMPOSE_PROJECT_NAME` and inspect `docker compose config` before creating services.
Preserve that configuration for subsequent operations.

Authenticate the selected container through the native host's normal login flow:

```sh
docker exec -it forge-worker codex login --device-auth
docker exec forge-worker codex login status
docker restart forge-worker
npx @neutral/forge@0.1.0 open --container forge-worker
```

Use only credentials authorized for that environment. The cockpit is published on
host loopback. The native app-server listens at `ws://127.0.0.1:4500` inside the
container. HTTP readiness establishes cockpit access; authentication and Worker
execution need their own checks.

The recipe explicitly sets `FORGE_BIND=0.0.0.0`, `FORGE_PORT=4310`,
`FORGE_SANDBOX=danger-full-access`, and `FORGE_APPROVAL_POLICY=never` inside the
container. Workers can use its writable workspace, services, and network without
interactive host approval. Directions sharing the container share this access.
The recipe mounts only the selected workspace and native state. Change execution
settings explicitly when creating the container; ordinary native host defaults
remain in effect outside the recipe. The [host guide](codex-binding.md#native-settings)
describes saved settings and approval handling.

## Select and inspect

Use npx with the existing container name:

```sh
npx @neutral/forge@0.1.0 open --container forge-worker
npx @neutral/forge@0.1.0 open --container forge-worker --no-browser
npx @neutral/forge@0.1.0 show --container forge-worker --direction /workspace/.forge/directions/example
npx @neutral/forge@0.1.0 progress --container forge-worker --direction /workspace/.forge/directions/example --latest
```

Opening inspects the container's actual state, installed identity, and published
cockpit mapping. An unavailable or incompatible selection returns an error. The
command prints the accessible URL if a browser cannot open; `--no-browser` requests
that URL without a browser attempt. Opening only inspects and displays saved work.
Create a Direction and explicitly send STEER using the [operating guide](../spec/OPERATING.md)
when ready to start a Worker. Every path passed with `--container` denotes a path
inside that container. The selected installation must match the controller's exact
Forge version, metadata schema `1`, and layout `1` in
`/opt/forge/forge-application.json`.

`forge open` accepts local Docker endpoints using `unix://` or `npipe://`. Remote
Docker contexts still support explicit container-directed commands; access their
published cockpit on that Docker host explicitly. For a wildcard publication
(`0.0.0.0` or `::`), the command selects a loopback URL and leaves the existing
publication's access scope unchanged. The supplied recipe publishes on host loopback.

## Preserve and replace

The `/workspace` mount retains project files, Directions, checklist documents,
SQLite routing, PROGRESS, and work artifacts. The `/var/lib/forge/codex` volume
retains authentication, native conversations, and `app-server.log`. Preserve both.

Use ordinary `docker stop`, `start`, `pause`, and `unpause` with the selected name.
These controls affect every Worker and service in the container. Starting services
provides access to retained work; development resumes through explicit continuation.
The recipe has no automatic restart or disposal.

A rebuilt image or edited configuration does not alter an existing container's
mounts, ports, or policies. Container replacement is an explicit operator action.
To keep the old container, stop it and create a distinctly named replacement with
the selected workspace and retained native volume. Allow only one container to
write that native state at a time. Keep the saved configuration for each container.

To use another Forge version with npx, replace `@0.1.0` with that version. Keep the
selected controller version aligned with the Worker container's Forge payload.

For a native bundle, upgrade by extracting a new versioned directory, checking its
version and help, and changing the command link. Retain the old installation until
the replacement is checked. Container upgrades remain separate. Remove the native
command by deleting its link and selected installation directory. Projects, state
volumes, and containers remain separately retained until explicit disposal.

## Build from source

Clone the public source and use Node.js 24 or newer:

```sh
git clone https://github.com/neutral/forge.git
cd forge
npm test
npm run check
node apps/cli/forge.mjs --help
```

The command runs directly from its JavaScript source. To build and run the
same npm package from the checkout:

```sh
npm pack
npx --package ./neutral-forge-0.1.0.tgz forge --version
npx --package ./neutral-forge-0.1.0.tgz forge --help
```

`npm pack` assembles the application automatically. The archive includes its runtime
files and documentation; installation does not need the source checkout. Use the
recipes below to build a standalone bundle or application payload.

### Native bundles and application payload

| Target | Artifact recipe | Status |
| --- | --- | --- |
| macOS arm64 | `darwin-arm64` | Untested until exercised on that target. |
| macOS x64 | `darwin-x64` | Untested until exercised on that target. |
| Linux arm64 | `linux-arm64` | Untested until exercised on that target. |
| Linux x64 | `linux-x64` | Untested until exercised on that target. |

Each recipe pins Node `24.18.0` for its platform. Its baseline is macOS `13.5` or
newer, or Linux kernel `4.18` or newer with glibc `2.28` or newer, following
[Node platform requirements](https://github.com/nodejs/node/blob/v24.18.0/BUILDING.md#platform-list).
Runtime requirements and artifact qualification have separate scopes. Windows has no
bundle recipe.
From source, assemble into a fresh output directory:

```sh
node distribution/build.mjs --source /absolute/forge-source --output /absolute/new-release
node distribution/build.mjs --source /absolute/forge-source --output /absolute/new-linux-release --target linux-arm64
node distribution/build.mjs --source /absolute/forge-source --output /absolute/new-application --application-only
```

The builder emits application and selected native directories and `.tar.gz` archives,
`release.json`, and `SHA256SUMS`. Archive timestamps use `SOURCE_DATE_EPOCH`,
defaulting to `0`, with stable file ordering and ownership. The optional
`--node-archive /absolute/node-v24.18.0-TARGET.tar.gz` uses a local download after
checking its pinned checksum. Identical inputs and timestamps produce identical
archives. Cross-assembly establishes artifact construction;
run an artifact on its declared platform before claiming platform behavior. The
separate application requires Node `24.0.0` or newer with built-in `node:sqlite`,
which may emit an experimental warning on earlier Node 24 versions. The [integration guide](integration.md)
describes layout, launch, runtime identity, service settings, and persistent state.

The source CI recipe at `.github/workflows/native.yml` assembles all four native
targets on Ubuntu and exercises the Linux x64 archive on that runner. It provides
no execution check for the other three targets. Qualify artifacts using actual
reported CI and platform results; the presence of a workflow is not a run result.
