# Releasing Forge

Maintainers publish `@neutral/forge` manually to the public npm registry using the
exact tarball that passed local qualification.

## Qualify the package

Use the finalized public source checkout with version `0.1.0` in `package.json`
and its completed changelog entry. To produce a qualification output, select a
fresh directory outside the checkout:

```sh
cd /absolute/forge-source
npm test
npm run check
node distribution/verify-package.mjs --source /absolute/forge-source --output /absolute/forge-package-check
```

The qualifier packs the application and installs that exact tarball in isolated
directories outside the checkout. It checks the commands, public library exports,
browser assets, Direction storage, operating guidance, specifications, and licenses.
It retains `neutral-forge-0.1.0.tgz`, `report.json`, the package inventory, and logs.
Preserve this output and use the same tarball for publication.

Inspect `report.json` for a passed result, package name `@neutral/forge`, version
`0.1.0`, and the performed checks and limits. Compare the archive's SHA-256 with
`artifacts[0].sha256` in that report:

```sh
shasum -a 256 /absolute/forge-package-check/neutral-forge-0.1.0.tgz
```

On Linux, `sha256sum` can compute the same checksum. If the archive changed, or the
source requires a fix, qualify the corrected source into a new output directory.

## Publish the checked tarball

Sign in with an npm account authorized to create and publish `@neutral/forge` in
the `neutral` organization:

```sh
npm login --registry https://registry.npmjs.org/
```

Complete npm's interactive authentication and any required two-factor prompts.
See the [npm login command](https://docs.npmjs.com/cli/v11/commands/npm-login/).

Publish the checked archive explicitly:

```sh
npm publish /absolute/forge-package-check/neutral-forge-0.1.0.tgz --access public --tag latest --registry https://registry.npmjs.org/
```

Inspect the result before retrying a failed command. A published package name and
version cannot be reused, even after unpublishing. See the
[npm publish command](https://docs.npmjs.com/cli/v11/commands/npm-publish/).

## Native artifacts and installed checks

The separate **Native bundles** workflow assembles the four documented native
targets and uploads archives, checksums, and `release.json` as Actions artifacts.
It exercises help and version for Linux x64 on its Ubuntu runner. It does not
publish npm packages, create a GitHub release, or upload release assets to a
GitHub release. A maintainer can attach the selected native artifacts and their
checksums to the matching GitHub release.

After publication, check the registry installation with the released version:

```sh
npx @neutral/forge@0.1.0 --version
npx @neutral/forge@0.1.0 --help
```

Controller installation and Worker container provisioning remain separate. Follow
[installation](install.md) for the selected container and [verification](verification.md)
for actual host, interruption, and persistence journeys. Publishing an artifact
does not establish those behaviors.
