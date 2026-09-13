# First Direction

Follow [installation](install.md) to prepare and authenticate a separately selected
Worker container. Open its cockpit:

```sh
npx @neutral/forge@0.1.0 open --container forge-worker
```

Create a Direction with a goal. Copy the [greeting example](../examples/greeting/README.md)
into a separate workspace for a small first exercise. Supply its checklist to the
Direction and explicitly start a fresh Worker. Later STEER goes to that saved Worker.

Read the goal, checklist, saved PROGRESS, and workspace diff as work develops.
Reading these views does not invoke a Worker. Ask for an explanation through STEER
when useful. The Director selects the changes to integrate using ordinary Git tools.

[Operating Forge](../spec/OPERATING.md) explains responsibilities and command
examples. The [cockpit guide](cockpit.md) describes views and controls, and
[verification](verification.md) distinguishes source checks from actual host journeys.
