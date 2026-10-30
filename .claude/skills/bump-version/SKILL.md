---
name: bump-version
description: Bump the RedditGrab extension version, build the Firefox distribution zips, and create the GitHub release. Use when the user asks to bump version, release, ship, publish, or prepare a new version of the extension.
---

# Bump Version

Releasing a new version of RedditGrab. `package.json` is the single source of truth — WXT auto-reads it for `manifest.version`, and the sidebar footer reads it via `browser.runtime.getManifest().version` at runtime.

This fork is **Firefox-only** and is **not published to a store**. There is no Chrome zip and no Chrome Web Store step.

## Steps

Given a target version `X.Y.Z` (semver — patch for bug fixes, minor for features):

1. **Verify clean tree** — releases should be a dedicated branch with only the version bump.
2. **Create branch** named `X.Y.Z` (matches the project's existing convention — see `git log --oneline` for past version commits like `1.0.13`, `1.0.12`).
3. **Bump `package.json`** — update the `"version"` field. That's the only file to touch.
4. **Verify nothing else references the old version** — quick sanity grep:
   ```
   Grep pattern="<previous-version>" path=<repo> (excluding node_modules and pnpm-lock.yaml)
   ```
   `pnpm-lock.yaml` may legitimately contain `1.0.X`-looking strings inside dep versions (e.g. `filesize@11.0.13`) — ignore those. If anything else hardcodes the version, that's a regression — the work to consolidate to package.json was done in PR #26 and shouldn't be undone.
5. **Commit** with message `X.Y.Z` (bare version number, matches existing convention).
6. **Push the branch** and open a PR titled `X.Y.Z`. Body briefly lists what's included (referenced PRs/issues).
7. **Build the zips:**
   ```
   pnpm zip   # → .output/redditgrab-X.Y.Z-firefox.zip + redditgrab-X.Y.Z-sources.zip
   ```
8. **Confirm filenames** include the new version. If WXT emits `redditgrab-<old>-...zip`, the bump didn't take — recheck `package.json`.
9. **Check the package still passes review tooling:**
   ```
   npx web-ext lint --source-dir .output/firefox-mv2
   ```
   Expect **0 errors**. The handful of `UNSAFE_VAR_ASSIGNMENT` / `DANGEROUS_EVAL` warnings come from bundled React and the ffmpeg workers and are expected.
10. **Merge the PR**, then **create the GitHub release** with both zips attached:
    ```
    gh release create vX.Y.Z -R ERasnier/redditgrab \
      --title "X.Y.Z" \
      --notes "<release notes>" \
      .output/redditgrab-X.Y.Z-firefox.zip \
      .output/redditgrab-X.Y.Z-sources.zip
    ```
11. **Report the zip paths and release URL** to the user.

## Signing

The build is unsigned. To install it permanently on stock Firefox it must be signed as unlisted (self-distributed) through AMO:

```
pnpm sign --api-key=$AMO_JWT_ISSUER --api-secret=$AMO_JWT_SECRET
```

The signed `.xpi` lands in `web-ext-artifacts/`. Unlisted versions are signed by Mozilla but never appear in the store. The sources zip exists because AMO requires source for build-tool-generated code.

**The gecko id in `wxt.config.ts` is still the upstream author's.** If signing has never been done from this fork, change it first or AMO will reject the submission.

Alternatively, no signing is needed on Firefox ESR, Developer Edition or Nightly with `xpinstall.signatures.required` set to `false`.

## Verification before reporting "done"

- [ ] `package.json` shows new version
- [ ] `.output/redditgrab-<new>-firefox.zip` exists
- [ ] `.output/redditgrab-<new>-sources.zip` exists (AMO requires this for source review)
- [ ] `web-ext lint` reports 0 errors
- [ ] PR merged
- [ ] GitHub release created with both assets attached

## Notes

- **`wxt.config.ts` does NOT specify `version`** — WXT auto-reads it from `package.json`. If you ever feel the urge to add `version:` to the manifest config, don't. That's the bug we just fixed.
- **`wxt.config.ts` pins `browser: "firefox"` and `manifestVersion: 2`**, so a bare `pnpm build` / `pnpm zip` produces the Firefox bundle. There are no `:firefox` script variants any more.
- **The sidebar UI version** comes from `browser.runtime.getManifest().version` at runtime in `components/sidebar-footer.tsx`. Don't hardcode it again.
- **Pre-release suffixes:** WXT handles `1.3.0-alpha2` style versions correctly — strips the suffix into `version_name` and uses the clean number for `version`. Use this for beta releases if needed.
