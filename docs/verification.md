# Verifying Forge

Use Node.js 24 or newer for source checks:

```sh
npm test
npm run check
git diff --check
```

The automated suite exercises Direction storage, checklist documents, subprocesses,
HTTP, Git, browser events, and mocked native routing. Record commands, selected
artifacts, results, and material limits.

## Source and storage

Check imports, CLI help and version from an unrelated directory, cockpit assets,
and Direction reads. Test valid and unsupported storage independently. Compare
database and authored file bytes around rejected operations. Cover attribution,
ordering, reopening, persisted native settings, and control with unavailable
documents. Review local documentation links and runtime paths after layout changes.

## Actual host and container

Exercise native routing, instructions, settings, and interruption through the
actual selected host before claiming those behaviors. Follow the
[Communicator journeys](../spec/spec/COMMUNICATOR.md#delivery-and-acceptance) and
[cockpit checks](../spec/spec/COCKPIT.md#access-and-verification). Record the
Forge and host versions, container and storage selection, performed actions,
observed outcomes, and uncertainty.

Use the [greeting exercise](../examples/greeting/README.md) for a small development
journey. Copy it into a separately selected workspace and supply its checklist to
a Direction. Inspect saved work and deliberately authored PROGRESS independently
of native conversation events. Exercise the specific container controls whose
persistence behavior is being assessed.

The manual `tests/operated-host.mjs` probe uses an existing idle Direction Worker
and its saved host, settings, and workspace. It asks that Worker to run a short
foreground Python command and writes uniquely named markers. Run the observer in
the same filesystem and process environment as the Worker:

```sh
node tests/operated-host.mjs --direction /workspace/.forge/directions/example \
  --probe interrupt --output /workspace/runtime-observations.jsonl
```

Select `--probe cooperative` to exercise a stop order. The probe waits for foreground
output, requests stop, records compact native outcomes, and checks for subsequent
development writes. The interruption probe observes the foreground command's own
completion marker. PID inspection and native events each establish their actual
scope. Retain compact observations and workspace files for independent inspection;
keep raw transcripts and credentials in their runtime storage.

Requirements describe the behavior to exercise. Automated results establish their
executed cases, and actual host and container results establish the particular
journeys observed. Repeat the relevant checks when those behaviors change.

## Installed distributions

Qualify the npm package from a source checkout with:

```sh
node distribution/verify-package.mjs --source /absolute/forge-source --output /absolute/new-package-check
```

The qualifier packs the application and installs that exact archive outside the
checkout. Inspect its report, archive identity, package inventory, and command,
library, browser-asset, and Direction checks. Use the locally packed artifact as
the registry substitute; these checks establish installed behavior independently of
publication. The [release guide](releases.md) describes publishing the checked
archive.

Build into fresh output directories with the source `distribution/build.mjs` recipe.
Record the exact Forge, Node, and host identities, platform, and artifact checksums.
Run native help, version, and imports outside the source checkout, after relocation,
and in paths containing spaces with Node and npm absent from `PATH`. Run the separate
application under the declared compatible shared Node runtime.

Exercise missing, unavailable, stopped, paused, incompatible, and unreachable
container selections. Check actual state and published mappings. Use a separately
selected test container and fixture workspace for cockpit browser access, URL
fallback, and read-only Direction, checklist, and PROGRESS commands. These reads and
opening must preserve Worker invocation state. Exercise unattended service startup,
bind and port selection, stdout/stderr, graceful shutdown, and retained storage.

Use only authorized test credentials for authenticated host journeys. If they are
unavailable, report delivery, Worker interpretation, interruption, and continuation
as unverified. HTTP readiness and storage checks establish their own limited scope.
Preserve test containers and unique work until explicitly authorized disposal.
Cross-built artifacts remain untested until exercised on their target platform.
