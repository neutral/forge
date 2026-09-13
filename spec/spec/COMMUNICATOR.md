# Communicator

The Communicator delivers STEER directly from the Director to a selected Worker
through an existing agent host. STEER supplies instructions, context, questions,
answers, or a cooperative stop order. The Worker records its account through
[PROGRESS](DIRECTION.md#progress); it does not deliver a message to the Director.

## STEER and Worker selection

The Director selects a Direction and supplies instruction text. STEER addresses its
existing Worker unless the Director explicitly requests a fresh Worker. An existing
Worker receives STEER through its native conversation. A fresh Worker receives the
supplied context in a new native conversation associated with that Direction.

The binding MUST preserve the selected conversation for subsequent STEER. A missing
or unusable context MUST produce an error. Forge MUST NOT silently replace the
Worker, reconstruct a substitute context, or dispatch an independent reviewer.
An explicit request for a fresh Worker does not imply reconstruction of the former
Worker's understanding. The Director selects the context for the new Worker.

STEER MUST use the host's direct delivery route. The Worker MUST NOT need to poll its
Direction for instructions. Direction metadata locates the Worker; SQLite does not
queue, deliver, or acknowledge STEER. A CLI, chat control, or native tool MAY expose
this operation. Human and agent access MUST preserve the same meaning.

STEER carries ordinary instruction text. Forge MUST NOT require a Worker response
taxonomy. Worker control through the public CLI MUST use a Direction's saved binding.

At initial dispatch, the Director supplies a goal, with optional checklist material,
definitions, references, or additional operating guidance. The binding MUST supply
the location of Forge's packaged operating guide in ordinary Worker instructions.
It also supplies the Direction location and the Worker's identifier for storing
PROGRESS. The Worker consults the guide, canonical Direction documents, and project
material through its own tools. Forge MUST NOT compile semantic context or retrieve
repository-system material.

## Information and answers

Reading stored PROGRESS follows [Direction](DIRECTION.md#progress) and never invokes
an agent. If the Director wants a new explanation, it sends STEER to the Worker.
The instruction can ask about checklist status, a topic, or a question left in
PROGRESS. A reply reference can associate the resulting account with that request.

A checklist explanation uses the Worker's context and available material to explain
Checks, results, unresolved work, and partial scope. It distinguishes recorded notes
from current judgment when relevant. A topic explanation uses the same accumulated
understanding. An information request permits supporting inspection; it does not
instruct a new verification campaign or further development.

The Director answers Worker questions through direct STEER. An answer alone does
not instruct continuation after a stop. Stored questions, accounts, and host events
MUST NOT trigger automatic assignments, agent dispatch, checklist reassessment, or
another development phase.

## Stop and continuation

A cooperative stop sends an order through the host's normal STEER delivery route.
Once received, the Worker MUST give it priority over further development, stop
initiating development, and yield. Only immediate settling actions needed to leave
the current operation stoppable are permitted. A brief PROGRESS entry is optional
when the host permits it. The Director chooses how long to allow the response.
Priority after receipt does not promise immediate delivery.

Native interruption MUST invoke the host's actual interruption control for the
selected Worker invocation immediately, independently of a conversational reply.
The binding MUST document the control's scope, its effect on running tools, and its
limits. [Docker pause](WORKSPACE.md#persistence-and-controls) is a separate
whole-container control and does not establish native Worker interruption.

The binding MUST report the host's actual outcome and preserve its scope. Submitted
STEER, interruption requests, host-confirmed interruptions, and host errors are
distinct outcomes. Submission MUST NOT be presented as proof that execution stopped.
Worker accounts MUST NOT be treated as execution evidence, completion certification,
or acceptance.

After either stop mode, an information request permits only the account and
supporting inspection. The binding MUST support STEER for an information request
and explicit continuation in the saved conversation after interruption. The Worker
MUST resume development only after explicit continuation direction. An explicitly
fresh Worker follows its supplied instructions. These meanings do not create a
Forge eligibility or permission state machine.

## Delivery and acceptance

The binding MUST preserve normal host delivery behavior and expose delayed,
unavailable, failed, or unusable-context outcomes as the host establishes them.
A missing account MUST NOT trigger reconstruction or retry orchestration. The
[workspace contract](WORKSPACE.md#inspection-integration-and-disposal) preserves
independent access and prohibits automatic disposal.

Claims that a binding satisfies this contract MUST be supported by actual
operated-host journeys:

- Create a Direction, explicitly start its Worker, and inspect useful saved work.
- Expose equivalent human command and agent callable access to the operations.
- Interpret a plain list, unchanged definition, reference, and enriched concern;
  discover and assess Checks through the Worker's own tools.
- Write PROGRESS without a connected Director and retrieve it without invoking the
  Worker or exposing raw output.
- Deliver follow-up STEER to the conversation that performed the work and record
  an attributed answer to an information request.
- Record a Worker question and deliver a Director answer through STEER.
- Explicitly select a fresh Worker with supplied context while preserving previous
  Worker associations and accounts.
- Use separate Directions in one container without a Forge coordination protocol.
- Cooperatively stop, distinguishing submission from the Worker's response.
- Natively interrupt active work, documenting the result and running-tool scope
  while saved files remain available.
- Request information after interruption in the saved conversation, then explicitly
  continue development.
- Use the binding without intermediate reports, acknowledgments, or a completion
  handshake; expose host or context failure while files remain independently available.

Binding tests MUST verify faithful routing without invoking Atlas, Intent, project
verification, or a replacement agent. Unit tests and mocked transports do not
establish operated-host outcomes. Binding documentation MUST distinguish
contract requirements, demonstrated behavior, and remaining limits. Low-level native
conversation inspection MAY remain available for diagnosis; native conversation
output is not stored PROGRESS.
