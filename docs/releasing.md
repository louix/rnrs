# Releasing

Only `@rnrs/cli`, `@rnrs/runtime` and `@rnrs/surface` are published, all with one version. Example
and lab packages are private and never published; the release tooling refuses any other package.
The framework crates ship inside the npm packages and are not published to crates.io.

## Checks

`node scripts/release.mjs check` (CI runs it on every pull request) packs the three tarballs into
`.generated/release/` and verifies:

- the allowlist, `MIT` license with the repository's `LICENSE`, a README, `repository`
  (`github.com/louix/rnrs`, which trusted publishing matches), public access and no install scripts;
- one version across the packages, `@rnrs/runtime` → `@rnrs/cli` exact, and the `@rnrs/runtime`
  peers of `@rnrs/cli` and `@rnrs/surface` exact; installed dependencies are exact versions;
- every framework version in the source tree: crate versions and the requirements of every crate
  in the repository, the native runtime version (Kotlin and Objective-C++), example package
  versions and peers, packed tarball names in scripts, tests and docs, and generator texts.

It writes `release.json` (sha256 and npm `dist.integrity` of each tarball, the source commit) and
`SHA256SUMS`. It does not contact the registry, so it keeps passing once the version is published.

## Bumping the version

Change the version everywhere the check lists, then run it until it passes. Example packages move
with the framework version.

## Publishing

1. Merge the release commit to `main` and wait for CI, including the iOS simulator job.
2. Tag that commit `vX.Y.Z` and push the tag. The release workflow
   (`.github/workflows/release.yml`):
   - runs CI on the tag (iOS included);
   - checks that the tag's commit is on `main`, packs once, verifies, and compares each package with
     the registry: `absent` packages will be published, an `identical` tarball is skipped, and a
     `different` tarball at the same version fails;
   - waits for approval in the `npm` environment, then publishes the verified artifact in the order
     cli, runtime, surface with OIDC trusted publishing (provenance included), confirming each
     upload's integrity.
3. A manual run of the workflow without `publish` (or from a branch) builds and verifies the same
   way and runs `npm publish --dry-run`. That job has no `id-token` permission.

`@rnrs/runtime` requires the exact `@rnrs/cli` and the CLI peer-requires the exact runtime. npm
publishes each package on its own, so an interrupted release leaves the version temporarily
uninstallable. Re-run the failed publish job, which uses the same artifact, or run the workflow
on the tag with `publish`; both complete the release. Nothing is rolled back or unpublished. If
a published tarball differs from the rebuilt one, the release stops: publish a new patch version
instead.

## One-time setup (maintainer)

- GitHub: a public `louix/rnrs` (provenance requires a public repository), an `npm` environment
  with a required reviewer, and a ruleset that restricts who can create `v*` tags.
- npm: trusted publishers can only be configured for packages that exist
  ([npm trust](https://docs.npmjs.com/cli/v11/commands/npm-trust): "The package you're configuring
  must already exist on the npm registry"). The first version therefore needs one of:
  - **Interactive publish of the verified artifact.** Download `npm-packages` from a dry run on the
    tag, log in with 2FA (`npm login`) and run
    `node scripts/release.mjs publish --dir <artifact> --tag vX.Y.Z --sha <commit>`. npm generates
    provenance only from cloud CI, so this version has none.
  - **Bootstrap token in CI.** Add a short-lived granular token with publish rights to the `npm`
    environment as `NPM_BOOTSTRAP_TOKEN` and run the release. npm falls back to it when OIDC
    fails; `NPM_CONFIG_PROVENANCE` still attaches provenance. Delete the secret and revoke the
    token afterwards.
- Then, for each package:
  `npm trust github <package> --repo louix/rnrs --file release.yml --env npm --allow-publish`
  (npm ≥ 11.15, account 2FA). A new trusted publisher configuration must make its first
  successful publish within 2 days, or it expires
  ([trusted publishers](https://docs.npmjs.com/trusted-publishers#trusted-publisher-configuration-expiry)),
  so configure it shortly before the next release. Afterwards set **Require two-factor
  authentication and disallow tokens** for each package.
