# Forge Specification

Forge gives each Worker a Direction and a persistent container in which to develop
software. The Director steers the Worker directly and reads its stored progress
when useful. The Director controls investment and integration through ordinary tools.

## Requirement language

The key words **MUST**, **MUST NOT**, **REQUIRED**, **SHOULD**, **SHOULD NOT**, and
**MAY** are normative only when uppercase and follow BCP 14. This convention applies
to this document and the contracts under `spec/`.

## Scope and ownership

This document owns Forge's purpose, responsibilities, and product boundary.
[Direction](spec/DIRECTION.md) owns Direction storage, Worker associations, and
PROGRESS. [Checklist](spec/CHECKLIST.md) owns Check meaning, document handling, and
assessment responsibilities. [Communicator](spec/COMMUNICATOR.md) owns direct STEER
delivery, native routing, stop, continuation, and binding verification.
[Workspace](spec/WORKSPACE.md) owns snapshots, persistence, repository access, and
container controls. [Cockpit](spec/COCKPIT.md) owns the container's Director interface.
[Distribution](spec/DISTRIBUTION.md) owns application payloads, native bundles,
installation, and service launch requirements.
[Operating Forge](OPERATING.md) applies those contracts to Director and Worker use.
Each rule has one owner.

Forge consists of Directions, operating guidance, a Communicator, and a small
Director cockpit. An implementation binds them to an existing agent host and
ordinary development containers. A CLI or native agent tool can expose the same operations.
Forge has an independently usable application payload and standalone native distribution.
IntentForge can install that same versioned payload with a compatible shared runtime.
Native installation locates the controller; Workers execute in an explicitly selected container.

## Ownership

| Actor | Responsibility |
| --- | --- |
| Director | The human or agent that supplies goals, chooses Workers and investment, steers the work, reads progress, and decides what to integrate. |
| Worker | The agent that develops from its Direction, maintains Checks, and records results and limits. |
| Forge | Direction storage, direct instruction delivery, and thin host, document, and container conveniences. |
| Repository tools | Direct Director and Worker access to project guidance, source definitions, tests, CI, and selected systems. |
| Product | Its own behavior, tests, services, and observability. |

A goal can be rough. The Worker interprets it using the repository and its tools.
The Director or Worker assembles the checklist and chooses how to assess its Checks.
Each Worker works from its own Direction. Several Directions can share a container
and workspace. The Director judges whether their goals are sufficiently independent;
Forge does not enforce non-overlap or require coordination between Workers. The
Director inspects saved work independently and selects changes for ordinary Git or
copy integration.

## Binding and demonstration

The selected host binding delivers STEER to an existing Worker or starts a fresh
Worker when explicitly requested. Workers write PROGRESS to their own Directions.
Reading those records requires no Worker invocation. The binding supplies native
interruption and explicit continuation in the saved context.
[Communicator](spec/COMMUNICATOR.md#delivery-and-acceptance) defines the required
operated-host journeys. Binding documentation describes delivery behavior and
control scope.

Unit tests establish only the behavior they exercise. Mocked transports do not
establish host interruption, Worker interpretation, or container survival. Claims
about software usefulness, steering effort, or comparative value require separate
observations.

## Strict boundaries

Forge MUST NOT introduce:

- A process engine: assignments, Attempts, Activities, mandatory phases, operation
  eligibility, admission, acceptance workflows, or sequential checklist gates.
- An evidence or recovery platform: execution receipts, authoritative observations,
  environment inventories, digest-bound evidence, automatic result invalidation,
  snapshot ledgers, or recovery state machines.
- A context compiler or required agent hierarchy: complete semantic context bundles,
  structured handoffs, or prescribed planner, worker, and reviewer roles.
- Completion or merge authority: certification of completion, authorization to
  develop, publication, merging, or a semantic permission system beyond the selected
  resource and execution controls.
- An investment watchdog: monitoring time, tokens, or spend to decide when work stops,
  or requiring the Worker to receive or manage an investment allowance.
- A transplanted development process runtime and its authority, evidence, protocol,
  or interface machinery, or orchestration services added to anticipate future scale.

The Director chooses and monitors investment externally. Ending investment does not
establish a Check or change the meaning of partial work. A feature crossing any
product boundary MUST receive an explicit product decision; implementation convenience
or a defect does not authorize that change.
