# Distribution recipes

Forge source retains `library/` and `apps/`. `application-layout.json` declares
which source files enter the installed application and each required path rewrite.
The builder refuses missing or additional code files and changed rewrite counts.
Installed application paths follow the [distribution contract](../spec/spec/DISTRIBUTION.md).

From a source checkout, use Node 24 or newer:

```sh
npm test
npm run check
npm pack
node distribution/build.mjs --source /absolute/forge-source --output /absolute/new-application --application-only
node distribution/build.mjs --source /absolute/forge-source --output /absolute/new-native --target darwin-arm64
```

`npm pack` assembles `neutral-forge-0.1.0.tgz`, including the application and
documentation. The native builder records artifact checksums and runtime identity.
Read [installation](../docs/install.md) for the target matrix and Worker recipe,
[integration](../docs/integration.md) for the shared payload, and
[verification](../docs/verification.md) for installed and actual host checks.
The [release guide](../docs/releases.md) describes package qualification and npm
publishing.
