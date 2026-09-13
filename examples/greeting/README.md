# Greeting starter

This small Node program supplies a development task for the standard Forge Worker
image. It has no dependencies. Copy this directory into an independent workspace
and improve greeting whitespace handling from the supplied checklist.

`greeting.mjs` currently interpolates a name without trimming it. `greet.mjs` joins
command arguments with spaces and prints the greeting. Its initial test covers
named and default greetings; the checklist concerns remain unassessed.

```sh
node greet.mjs Ada
node --test greeting.test.mjs
```

The `forge/checklist/` files supply a plain list, a reference to an unchanged source
definition, and an enriched concern. Keep development work and assessment results
in the copied workspace. The separate manual host-control probe does not depend on this program.
