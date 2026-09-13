# Forge specification

[SPEC.md](SPEC.md) owns Forge's purpose, responsibilities, and product boundary.
[Operating Forge](OPERATING.md) gives the Director and Worker a practical reading
path through the contracts.

- [Direction](spec/DIRECTION.md): canonical goal and checklist files, Worker and
  container associations, and stored Worker-authored PROGRESS.
- [Checklist](spec/CHECKLIST.md): flexible Check definitions, ordinary documents,
  assessment responsibilities, and authored results.
- [Communicator](spec/COMMUNICATOR.md): direct STEER to an existing or explicitly
  fresh Worker, native interruption, and explicit continuation.
- [Workspace](spec/WORKSPACE.md): copied snapshots, shared containers, persistent files,
  direct repository access, and ordinary Docker controls.
- [Distribution](spec/DISTRIBUTION.md): versioned application payloads, standalone
  native bundles, explicit container selection, and service launch requirements.
- [Cockpit](spec/COCKPIT.md): a container-served Director interface for reading
  Directions, inspecting target diffs, and sending direct STEER.

These contracts define transport-independent behavior. The
[Codex binding](../docs/codex-binding.md) documents the selected implementation.
Implementation or test results do not redefine the contracts.

Target projects select and operate their own repository tools. The
[Workspace contract](spec/WORKSPACE.md#snapshot-and-repository-access) defines
Forge's boundary with those tools.
