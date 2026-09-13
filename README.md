# Forge

Forge is a workspace for directing sustained software development with agents.
A goal can begin as a rough idea, an unresolved problem, or a change you want to
see. An agent works through it using the repository and its tools: investigating
the problem, developing code, checking results, and recording what remains
uncertain. Forge gives that effort a persistent development container and a
durable home for its goal, checklist, and progress, keeping the purpose of the
work available as the implementation and your understanding evolve.

From a small cockpit, you can inspect saved progress, read checklist documents,
review workspace changes, and send instructions directly to the same agent.
Reading saved progress does not require another agent response. You choose where
to invest further attention, when to change course, and which changes to integrate
through ordinary development tools. The agent carries the development effort
forward, while you retain responsibility for its direction and the decisions
that follow.

The **Director** is the human or agent directing the work; the **Worker** is the
agent developing it. Each Worker has a **Direction**: a goal, ordinary checklist
documents, and stored **PROGRESS**. **STEER** sends the Director's instructions
directly to the selected Worker through its agent host.

## Install

On macOS or Linux, use Node.js 24 or newer and npm:

```sh
npx @neutral/forge@0.1.0 --help
npx @neutral/forge@0.1.0 --version
```

Use `npx @neutral/forge@0.1.0` for each Forge invocation. The package supplies
the command, shared library, prebuilt cockpit, operating guides, and specifications.

## Build from source

```sh
git clone https://github.com/neutral/forge.git
cd forge
npm test
npm run check
node apps/cli/forge.mjs --help
```

The JavaScript command runs directly from source. The
[installation guide](docs/install.md#build-from-source) also covers building the
npm package, standalone bundles, and application payload.

## Run Forge

Create a Worker environment with the [Forge container recipe](docs/install.md#worker-container),
then select it explicitly:

```sh
npx @neutral/forge@0.1.0 open --container forge-worker
```

Installation places the controller on your machine; Workers execute in the
selected container. Docker and authorized native-host credentials are separate
prerequisites. The runtime-free [application payload](docs/integration.md) supports
a compatible shared Node runtime. [IntentForge](https://github.com/neutral/intentforge)
is the recommended route for the whole portfolio and can use that same payload.

Open the cockpit, create a Direction with a goal, and explicitly start its Worker.
Send later instructions to that saved Worker. Inspect checklist documents, stored
PROGRESS, and the workspace diff as the work develops. The Director chooses goals,
attention, and the changes to integrate using ordinary repository tools.

## Documentation and feedback

- [Installation](docs/install.md): npm, source builds, Worker setup, and preservation.
- [Integration](docs/integration.md): shared payload and service launch contract.
- [Operating guide](spec/OPERATING.md): Director and Worker responsibilities.
- [Cockpit guide](docs/cockpit.md): inspect a Direction and send instructions.
- [Host binding](docs/codex-binding.md): native routing and control outcomes.
- [Specification](spec/README.md): the product and its contracts.
- [Verification](docs/verification.md): local checks and actual host journeys.
- [Releases](docs/releases.md): package checks and npm publishing.

The source uses Node.js 24 or newer. Run `npm test` and `npm run check` from the
repository root. Shared modules live in `library/`, adapters and browser assets in `apps/`, and
assembly recipes in `distribution/`. Tests live in `tests/`, with a small
development exercise in `examples/greeting/`. Start with the
[first Direction guide](docs/getting-started.md). Read the [contribution policy](CONTRIBUTING.md)
before sending feedback.

Forge is available under [CC0-1.0 or 0BSD](LICENSE), at your choice.
