# Changelog

## 0.1.0

Initial release.

- Store each Worker's goal, ordinary checklist documents, native binding, and
  authored PROGRESS in a persistent Direction. Read saved progress without invoking
  a Worker.
- Send STEER directly to the saved Codex Worker, or explicitly select a fresh
  Worker. Request cooperative stop, native turn interruption, and explicit
  continuation while preserving the host's actual control scope.
- Inspect goals, checklist files, stored progress, and workspace Git changes in a
  container cockpit. Several Directions can share a workspace and container.
- Install the `forge` command and shared library from `@neutral/forge`. Build a
  runtime-free application payload or standalone native archive with prebuilt
  cockpit assets, operating guides, specifications, and license notices.
- Provision an explicitly selected persistent Worker container using the Docker
  or Compose recipe. Controller installation, container creation, and native host
  authentication remain separate operations.

### Compatibility and support

Forge requires Node.js 24 or newer with `node:sqlite`. Native bundles pin Node
24.18.0; the Worker recipe pins Codex CLI 0.153.4. Container selection requires the
controller's exact Forge version, application metadata schema 1, and layout 1.
Directions use canonical goal and checklist files with SQLite for routing and
authored PROGRESS; unsupported storage fails visibly.

Native recipes cover macOS and Linux on arm64 and x64. Windows is not a supported
npm or native bundle target. Cross-assembly does not establish target execution or
authenticated Worker behavior. See [installation](docs/install.md#native-bundles-and-application-payload)
for platform scope and [verification](docs/verification.md) for installed and actual
host checks. Native turn interruption does not guarantee that already-running tools
have stopped.
