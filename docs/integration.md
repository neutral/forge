# Forge application integration

The [Distribution contract](../spec/spec/DISTRIBUTION.md) owns packaging and
launch requirements. This guide describes layout version 1. IntentForge can consume
this versioned payload with one compatible Node runtime. Integrators supply their
landing page and service composition.

## Identity and installed paths

The npm package is `@neutral/forge` for macOS and Linux. It installs the application
under `application/` inside the package and exposes `forge` plus its library exports through package
metadata. The paths below are relative to that application root. Standalone and
container payloads use the same layout directly at their installation root.

Forge `0.1.0` uses Node `24.0.0` or newer with the built-in `node:sqlite` module.
Standalone bundles pin Node `24.18.0`. Earlier Node 24 versions may emit an experimental SQLite warning;
disabling SQLite is incompatible. Node `24.18.0` includes SQLite `3.53.1`. The Worker recipe pins Codex CLI `0.153.4`
and installs its native dependencies for the container's target architecture.
The application has no npm runtime dependencies.

`forge-0.1.0-application.tar.gz` contains the runtime-free application directory.
The native archive `forge-0.1.0-OS-ARCH.tar.gz` contains that application and the
platform's Node binary. `forge-application.json` declares schema version 1, layout
version 1, name, and version. `release.json` records component identities, and `SHA256SUMS` records artifact
checksums. Each installation also has file checksums; native bundles add
`forge-distribution.json` with Node source and executable identities. Verify the selected artifact before installing it.

| Path relative to application root | Purpose |
| --- | --- |
| `bin/forge` | Relocatable command launcher. |
| `cli/forge.mjs` | Command adapter. |
| `src/` | Shared library, with package exports for `@neutral/forge`, `@neutral/forge/workspace`, `@neutral/forge/direction`, and `@neutral/forge/cockpit`. |
| `web/` | Prebuilt browser assets. |
| `runtime/worker-entry.mjs` | Native host and cockpit startup adapter. |
| `runtime/node` | Bundled Node in standalone distributions only. |
| `guides/`, `spec/` | Operating guidance and contracts. |
| `package.json`, `forge-application.json` | Application and installed-layout identities. |
| License files | Forge and bundled component notices. |

Install the complete application under `/opt/forge` in a container. Put
`/opt/forge/bin` on `PATH`. The launcher uses the bundled runtime when present;
a runtime-free installation uses `FORGE_NODE` when set, then `node` on `PATH`.
Set `FORGE_NODE` to an absolute compatible shared runtime executable when needed.
Do not combine binaries or native dependencies from different target platforms.

For a local npm dependency, import `@neutral/forge` or its `/workspace`, `/direction`,
and `/cockpit` exports. For a standalone or container payload, use its explicit
`src/` module path. Putting `bin/forge` on `PATH` does not change Node's package
resolution. The [installation guide](install.md#use-the-library) gives an npm example.

## Commands and services

The native controller exposes `forge --help`, `forge --version`, and
`forge open --container NAME [--no-browser]`. It uses Docker CLI access to inspect
and address the explicitly selected existing container. The returned URL follows
actual published cockpit ports. Worker Direction commands retain `--container NAME`;
all paths in those commands are container paths. Selection requires exactly the same
Forge version as the controller, metadata schema version `1`, and layout version `1`
at `/opt/forge/forge-application.json`.

`forge open` supports local Docker endpoints using `unix://` or `npipe://`. A remote
Docker context can still run explicit `--container` commands, but the operator opens
its cockpit on that Docker host explicitly. For a wildcard publication (`0.0.0.0`
or `::`), `open` uses a loopback URL and leaves the container's published access scope
unchanged. The recipe's loopback publication supplies the secure default.

Inside a container, run the startup adapter in the foreground with a compatible
Node executable:

```sh
FORGE_CONTAINER=forge-worker FORGE_WORKSPACE=/workspace FORGE_DIRECTIONS=/workspace/.forge/directions \
CODEX_HOME=/var/lib/forge/codex FORGE_BIND=0.0.0.0 FORGE_PORT=4310 \
node /opt/forge/runtime/worker-entry.mjs
```

Set `FORGE_CONTAINER` to the selected container's actual name. Supply Codex
`0.153.4` on `PATH`. The adapter starts `codex app-server --listen
ws://127.0.0.1:4500` and the cockpit. The app-server endpoint remains loopback inside
the container and is not published. The recipe explicitly selects
`FORGE_SANDBOX=danger-full-access` and `FORGE_APPROVAL_POLICY=never`. Omitted policy
variables retain native host defaults. Do not copy the recipe's execution policy to
a native host installation.

The startup adapter defaults to `FORGE_BIND=127.0.0.1` and `FORGE_PORT=4310`.
`FORGE_BIND=0.0.0.0` is an explicit container serving option; publish it only on the
host's loopback interface, such as `127.0.0.1:4310:4310`. The standalone cockpit
command also defaults to local access. Neither service startup nor the adapter opens
a browser or starts a Worker. Direct host adapter diagnosis outside the selected
container requires the explicit `--native-host` option on `steer`, `stop`, and
`cockpit`; it retains the native host's ordinary defaults. Direct cockpit service startup is available as:

```sh
FORGE_CONTAINER=forge-worker forge cockpit --workspace /workspace --directions /workspace/.forge/directions \
  --bind 0.0.0.0 --port 4310
```

The adapter emits a JSON `cockpit_listening` record to stdout. Startup failures and
service-exit diagnostics go to stderr. Codex stdout and stderr append to
`$CODEX_HOME/app-server.log`; this is operational output, separate from PROGRESS.
The command adapter writes JSON operation results and handled operation errors to
stdout; failed commands exit nonzero. Launcher failures and process diagnostics use
stderr.

A successful `GET /api/session` response is the recipe's HTTP readiness check. It does not
establish Codex authentication, Worker delivery, or completion. Authenticate through
ordinary `codex login --device-auth` in the selected container, inspect
`codex login status`, and restart that container's services when required.

The startup adapter handles `SIGTERM` and `SIGINT`, closes the cockpit, and forwards
the signal to the Codex child. It applies a bounded shutdown interval before closing
remaining HTTP connections and killing a surviving host process. Run it under the
container's init process (`docker run --init` or Compose `init: true`). This shutdown
controls services; native Worker interruption retains its documented separate scope.

## Writable and persistent storage

| Location | Required treatment |
| --- | --- |
| `/opt/forge` | Application files; suitable for a read-only installation. |
| `/workspace` | Explicitly selected writable project mount; retains source, Directions, checklist documents, SQLite routing and PROGRESS, artifacts, and raw output. |
| `/var/lib/forge/codex` | Writable persistent native-state mount; retains authentication, conversations, and app-server log. |
| Temporary directories and tooling caches | Writable according to the selected container environment; preserve unique work in the persistent mounts. |

`FORGE_WORKSPACE`, `FORGE_DIRECTIONS`, and `CODEX_HOME` select alternate locations.
The operator supplies mounts and file permissions. An application replacement does
not migrate or delete state. Preserve both persistent mounts and saved container
configuration; only one container should write a retained Codex state volume at a
time. Container start, stop, pause, replacement, and disposal remain explicit
operator operations described in the [installation guide](install.md).

Build and check the separate application before later composition. A successful
shared-runtime import or help command establishes that operation only; exercise
container access and actual host journeys before claiming their behavior.
