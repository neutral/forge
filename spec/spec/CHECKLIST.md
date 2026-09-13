# Checklist documents

A Check is something the Director or Worker wants the work to satisfy or establish.
A checklist is their shared authored material describing those concerns and results.
A sentence, unchanged source definition, reference, exact command, or detailed
explanation can all be useful. A verifier or implementation need not exist first.

## Document form

The Direction's canonical checklist folder is defined by
[Direction](DIRECTION.md#canonical-storage). A standalone document reader MAY
accept another selected folder. Files MAY use Markdown or retain their supplied
format. A file can contain one concern, several Checks, source references, or a
mixture.

Forge MUST NOT require a title, ID, source, selection reason, status enum, command,
evidence field, prescribed headings, or one-file-per-Check layout. It MUST NOT
reject or diagnose useful rough or incomplete definitions as invalid, or force their
normalization. Templates are optional.

This plain list supplies useful starting concerns without claiming any result:

```markdown
- [ ] Saved changes remain readable after restarting the product.
- [ ] Satisfy the Checks associated with the supplied repository record.
- [ ] Run `npm test` and address the failures relevant to this work.
```

Either party can enrich a concern in the same document:

```markdown
- [ ] Saved changes remain readable after restarting the product.
  Include new and overwritten values. Compare the reopened values with those
  recorded before restart.
```

Forge MUST preserve supplied file contents when presenting documents. An explicit
caller-requested edit MAY replace a selected document. Ordinary filesystem errors
describe access problems, not Check validity.

Reading, selecting, or editing checklist material MUST NOT execute its commands,
fetch its references, invoke CI, or dispatch an agent. Check definitions and
assessments MUST remain readable without consulting Direction database records.
[Workspace](WORKSPACE.md) owns persistence and repository access.

## Assessment and results

The Director and Worker own assembly, source selection, discovery, inclusion,
exclusion, interpretation, and assessment. They use repository tools to resolve
references and discover associated Checks. Originating systems retain ownership of
their definitions. Forge MUST NOT perform those tasks on either party's behalf.

When an exact assessment procedure is supplied, the Worker MUST follow it and
interpret its result against the concern. Otherwise the Worker chooses useful tests,
experiments, product use, inspection, or reasoning. Forge MUST NOT execute a Check,
interpret assessment output, infer a pass from an exit code, or decide that a
proposition is established. It presents supplied assessments.

Checkboxes and status words carry their ordinary authored meaning. Forge MUST NOT
treat counts or percentages as measures of useful progress, conceal excluded or
unresolved concerns, relabel partial work to fit reduced investment, or present
missing applicability information as current. The parties MUST keep unclear or
untouched concerns unresolved. They SHOULD make changed criteria and excluded
concerns visible in ordinary files or notes.

Notes can explain source selection, results, judgment, limits, and useful next work.
No status enum or report format is required. Ending investment leaves unresolved
concerns and useful partial work with their existing meaning.

## Information requests and verification

A new checklist explanation is requested through
[STEER](COMMUNICATOR.md#information-and-answers), which owns information-request scope.

Document tests MUST cover plain lists, unchanged source definitions, references,
enriched concerns, free-form files, and optional commands without normalization.
Routing tests MUST establish pass-through without project-tool invocation. Operated
Worker verification separately establishes interpretation, discovery from a supplied
reference, and assessment of a concern supplied without a command.
