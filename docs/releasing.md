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
  versions and peers, packed tarball names, `@rnrs/<package>@X.Y.Z` install specs and
  `"@rnrs/<package>": "X.Y.Z"` requirements in scripts, tests and docs, and generator texts.

It writes `release.json` (sha256 and npm `dist.integrity` of each tarball, the source commit) and
`SHA256SUMS`. It does not contact the registry, so it keeps passing once the version is published.

## Bumping the version

Change the version everywhere the check lists, then run it until it passes. Example packages move
with the framework version.

## Releasing with npm approval

1. Merge to main and wait for CI. Tag that commit `vX.Y.Z` and push the tag.
2. The release workflow runs CI (including iOS), builds and verifies the three packages, then
   stages those exact artifacts on npm with provenance. It cannot approve publication.
3. Review the staged packages on npm, checking their version and provenance against the release
   commit. Approve cli, runtime and surface with npm 2FA. Until all three are approved, the exact
   dependency versions can make the release temporarily uninstallable.

The workflow log contains each stage ID. You can also review from a logged-in terminal with
npm 11.15.0 or newer:

```bash
npm stage list @rnrs/cli
npm stage list @rnrs/runtime
npm stage list @rnrs/surface
npm stage view <stage-id>
npm stage approve <stage-id>
```

To inspect the bytes, use `npm stage download <stage-id>` and compare the tarball with the
workflow's `npm-packages` artifact and `SHA256SUMS`. Reject an unwanted stage with
`npm stage reject <stage-id>` (also requires 2FA).

Manual workflow runs default to a staging dry run. Select a version tag and enable `stage`
only when you want to upload packages for approval. No command in the workflow approves them.

### Interrupted releases

A staged version reserves its version number. The workflow skips already-published identical
packages and refuses published packages with different integrity, but cannot inspect pending
stages using its OIDC credentials. If staging fails partway through, inspect the pending stages
on npm. Approve the correct ones, or reject them before retrying. Re-run the failed staging job
with the same artifact; rebuilding requires the same pinned Node and npm versions.
Never replace a published version: use a new patch version if its contents must change.

## One-time setup

For each of `@rnrs/cli`, `@rnrs/runtime` and `@rnrs/surface`:

1. Enable npm account 2FA. In package settings choose **Require two-factor authentication and
   disallow tokens**. Revoke any bypass-2FA publishing tokens and remove the GitHub
   `NPM_BOOTSTRAP_TOKEN` secret if it exists.
2. Configure a GitHub trusted publisher for `louix/rnrs`, workflow `release.yml`, environment
   `npm`, with **stage publishing only**. Direct publishing must be disabled. From the CLI:

   ```bash
   npm trust github <package> --repo louix/rnrs --file release.yml --env npm --allow-stage-publish
   ```

   If a trusted publisher already exists, inspect it with `npm trust list <package>`, revoke
   it with `npm trust revoke --id <id> <package>`, then create the stage-only configuration.
3. GitHub's `npm` environment must allow only `v*` tags. A GitHub required reviewer is optional;
   the publication approval happens on npm. Restrict who can create release tags too.

Trusted publishers require an existing npm package. If bootstrapping a new package, download
and verify the release artifact, log in with `npm login`, then run
`node scripts/release.mjs stage --dir <artifact> --tag vX.Y.Z --sha <commit>` and approve on npm.
Local staging has no CI provenance. Configure the trusted publisher after the first publication.
New trust configurations expire if unused for two days; configure them shortly before release.

Provenance links an artifact to its CI source and build; npm's stage approval supplies the human
2FA check. Both are used here. See [npm staging](https://docs.npmjs.com/staged-publishing/) and
[trusted publishers](https://docs.npmjs.com/trusted-publishers/).
