# Cockpit

The cockpit is a small Director interface served by a running development container.
It exposes one or more Directions, their stored contents and PROGRESS, the current
target Git diff, and direct STEER. It applies the existing contracts without adding
a coordination protocol.

## Reading and steering

The operator selects the workspace and Direction locations exposed by the cockpit.
The interface MAY list Directions within an explicitly selected parent folder. It
MUST preserve their separate goals, Worker associations, and progress attribution.

Opening or refreshing the cockpit MUST read stored material without invoking a
Worker. Progress follows [Direction](DIRECTION.md#progress); checklist presentation
follows [Checklist](CHECKLIST.md#document-form). Each view reads the material it
displays. Goal and checklist access errors MUST appear in their corresponding views
alongside available binding information. Stored PROGRESS MUST remain independently
readable when authored documents are unavailable. An unavailable document MUST NOT
appear as an empty document. The cockpit MUST preserve validation of the selected
Direction and its routing information.

A Git diff describes current saved changes. The default view is **Uncommitted
changes**, comparing the working tree with its current `HEAD`, including staged
changes and separately presented untracked files. The Director MAY select an
ordinary Git reference for another comparison.
The cockpit MUST identify the selected comparison and reject an unusable reference.
Forge MUST NOT capture or infer a starting reference for a Direction. A shared diff
MUST NOT be attributed to one Worker, used to infer Check results, or treated as
completion evidence.

Sending STEER is an explicit Director action. It follows
[Communicator](COMMUNICATOR.md#steer-and-worker-selection), including the explicit
choice to start a fresh Worker. The interface MUST distinguish direct host outcomes
from stored Worker accounts. It MUST NOT use its database as an instruction inbox or
turn interface refreshes into agent requests.

The cockpit MAY initialize a Direction from a supplied goal and binding. Initialization
does not dispatch a Worker; dispatch requires explicit STEER. It MUST NOT add
assignments, work-scope validation, required reporting, or coordination between
Directions. Its purpose is to help the Director inspect and direct work.

## Access and verification

The selected binding MUST document how to start and reach the cockpit.
[Distribution](DISTRIBUTION.md#native-controller-and-container-selection) owns native
container selection and browser opening. The local
container recipe MUST publish access only on host loopback by default. Running a
container does not imply that its cockpit is reachable while paused or stopped.
The interface MUST restrict file inspection and Git operations to the selected
workspace and Direction locations.

The cockpit serves trusted local Directors. The binding MUST document its native
execution and approval settings and whether an interface can answer host approval
requests. Loopback access controls do not establish user authentication, independent
tenant isolation, or separation between Workers sharing a container.

Verification MUST exercise Direction selection, stored progress retrieval, current
diff display, and explicit STEER through the running interface. Read-only requests
MUST be checked to leave the Worker uninvoked. An interface mock does not establish
native STEER delivery or container persistence.
