# Direction

A Direction is the durable place from which a Worker develops. It holds the goal,
checklist, Worker association, and Worker-authored PROGRESS. Its lifetime is
independent of a native Worker conversation or Director connection.

Each Worker has its own Direction. The Director selects the Direction's folder,
workspace, container, and agent host. Several Directions MAY use the same container
and workspace. Their goals and progress remain separate. The
[core specification](../SPEC.md#ownership) owns the Director's judgment about
independent work; Direction storage does not enforce that judgment.

## Canonical storage

A Direction has this layout in persistent container storage:

```text
<direction>/
  goal.md
  checklist/
  direction.sqlite
```

`goal.md` contains the authored goal. `checklist/` contains ordinary checklist
documents governed by [Checklist](CHECKLIST.md). These files are canonical. Forge
MUST NOT duplicate their contents into database fields or require database records
for individual Checks.

`direction.sqlite` holds the workspace, container, and host binding; the current
Worker and prior Worker associations, including explicitly selected native model,
sandbox, and approval settings; and ordered PROGRESS records. It contains
routing metadata and authored accounts, not authoritative assessments or execution
evidence. Forge MUST NOT add a STEER inbox, delivery queue, or Worker polling protocol.
[Communicator](COMMUNICATOR.md) owns direct STEER delivery.

The binding MUST preserve the association with the selected native Worker. An
explicitly fresh Worker becomes the Direction's selected Worker for later STEER.
Earlier associations and their PROGRESS retain their attribution. Selecting a fresh
Worker MUST NOT silently interrupt, destroy, or dispose of an earlier Worker or
its saved work.

Explicit native settings belong to the Worker association. The binding MUST
preserve them for later STEER and stop operations, including after reconnect or
service restart. An omitted setting follows the configured native host default;
Forge MUST NOT invent a previously selected value. These settings are host routing
metadata and MUST NOT become a Check schema or a Direction scope policy.

Forge MUST preserve stored documents and PROGRESS across ordinary connection and
process lifetimes. Related database updates MUST commit atomically. Missing or
unusable storage MUST produce an access error; Forge MUST NOT silently initialize
replacement state. Creation is an explicit operation.

The current SQLite contract uses application ID `0x464f5247` and schema version
`2`. Every database read and write MUST require that exact application ID and
version and the required storage columns. Forge MUST reject unsupported storage
without changing its contents. Forge MUST NOT migrate a database or substitute
fields from another storage format.

Reading the saved binding for Worker control MUST be independent of goal and
checklist access. Missing or unreadable authored documents MUST NOT block control
through an intact binding. Binding reads MUST still validate the selected Worker
record and native settings. [Cockpit](COCKPIT.md#reading-and-steering) owns the
presentation of document access errors alongside available information.

## PROGRESS

PROGRESS is an account deliberately authored and stored by the Worker. Its body is
ordinary language. It can describe work, findings, questions, Check assessments,
limits, or useful next actions and refer to files in the container. It is the
Worker's paraphrase of its position, not a copy of raw tool output or a transcript.

Each record has a stable ordering identifier, the reporting Worker identifier, a
recorded time, and a body. An optional reply reference identifies the STEER request
being answered. These fields support retrieval and attribution; they MUST NOT
impose a Check schema, status enum, or structured handoff.

The Worker writes PROGRESS locally to its Direction. Writing MUST require no
Director connection, message delivery, acknowledgment, or response. Forge MUST NOT
convert native commentary, final responses, turn completion, or tool output into
PROGRESS automatically. A native host event and a Worker-authored account are
distinct information.

Progress retrieval MUST read stored records without invoking or contacting a Worker.
The Director can read the latest record or records after a selected ordering
identifier. Reading MUST NOT consume records, acknowledge them, change Worker
state, or imply the accounts remain current. A fresh Worker can consult earlier
accounts; their claims remain attributed to their original author.

Recording PROGRESS is discretionary. Forge MUST NOT require periodic reports,
polling, response deadlines, a final report, or a completion handshake. Missing
PROGRESS MUST NOT gate work, inspection, or integration. A stored question awaits
the Director's judgment; it does not dispatch another agent or establish a workflow.

## Verification

Storage tests MUST cover reopening a Direction, independent Direction records,
attribution across an explicit Worker change, ordered retrieval, and preservation
of authored documents. They MUST cover rejection of unsupported storage on reads
and writes while preserving database contents, authored files, and attributed
PROGRESS. They MUST establish that reading PROGRESS needs no host
connection and that native events do not create PROGRESS records.

An operated-host journey separately establishes that a Worker can write PROGRESS
while the Director is disconnected, retain work in its container, and later receive
direct STEER. [Communicator](COMMUNICATOR.md#delivery-and-acceptance) owns the full
binding demonstration and its limits.
