# Releasing dsh-eval

Releases are tag-driven. Pushing `vX.Y.Z` runs the `Release` workflow, which
verifies typechecking, 100% coverage and the packed-tarball smoke test before
publishing `dsh-eval@X.Y.Z` to npm with provenance.

## One-time setup: npm Trusted Publisher

The publishing account uses a security key for 2FA, so the npm CLI cannot
complete a publish and no long-lived token is stored. Configure OIDC once at
<https://www.npmjs.com/package/dsh-eval/access>:

| Field | Value |
|---|---|
| Trusted Publisher | GitHub Actions |
| Organization or user | `hccccc01333` |
| Repository | `dsh-eval` |
| Workflow filename | `release.yml` |
| Environment | leave empty |

Then run the `Release` workflow manually with **Run workflow**. Its `check` job
exchanges this workflow's OIDC identity for npm publish rights without
uploading anything. A green `trusted publisher is wired` line means the next tag
will authenticate. The check must live in `release.yml` because npm matches the
GitHub `job_workflow_ref` against the configured filename.

## Cutting a release

1. Move the `Unreleased` entries in the root `CHANGELOG.md` into a new
   `## X.Y.Z` section with the release date.
2. Set `version` in `packages/eval/package.json` to `X.Y.Z`.
3. Run the local gates from the repository root:

   ```sh
   corepack pnpm --filter dsh-eval typecheck
   corepack pnpm --filter dsh-eval test:coverage
   corepack pnpm --filter dsh-eval test:pack
   ```

4. Commit and push the changelog/version changes to `master`.
5. Tag and push:

   ```sh
   git tag vX.Y.Z
   git push origin vX.Y.Z
   ```

6. Watch the `Release` workflow. It refuses a tag whose version differs from
   the manifest, and skips publishing if that version is already on npm (the
   registry is immutable).
7. Verify <https://www.npmjs.com/package/dsh-eval> shows the new version and a
   provenance attestation.

## If the publish job fails with an auth error

The Trusted Publisher entry is missing or does not match the workflow
identity. Re-check the five fields above and re-run the manual `check` job.
Do not retry the tag publish repeatedly: a successful upload cannot be
replaced, and npm does not allow unpublishing a version.
