# Release Playbook

Operator runbook for cutting a release of the `agent-coherence` Claude Code plugin.

This document is intentionally copy-pasteable. Each fenced block is the exact command an operator runs. Run them in order; do not paraphrase.

The repository uses a two-branch model:

| Branch | Role |
|---|---|
| `main` | Release target. Tagged for `v*` releases. Protected. |
| `dev` | Integration branch for in-flight features. Protected (status checks only, no review required). |

Feature work happens on topic branches (`feat/*`, `fix/*`, `docs/*`, `refactor/*`) which target `dev`. Releases are cut by merging `dev → main` and tagging the merge commit on `main`.

---

## 1. Pre-flight (one-time setup)

These commands set up the `dev` integration branch and the branch/tag protection rules. Run them once when bootstrapping the repository (or when re-bootstrapping after an admin reset).

You need:

- `gh` authenticated as a repo admin
- A clean local checkout at `/Users/vladparakhin/projects/agent-coherence-plugin`

### Create the `dev` integration branch on origin

```bash
cd /Users/vladparakhin/projects/agent-coherence-plugin
git checkout main && git pull --ff-only origin main
git checkout -b dev && git push -u origin dev
```

### Configure branch protection on `main`

Require PR review + status checks (`typecheck`, `test`, `build`). Strict mode means the PR branch must be up to date with `main` before merging.

```bash
gh api -X PUT repos/hipvlady/agent-coherence-plugin/branches/main/protection \
  --input - <<'JSON'
{
  "required_status_checks": {
    "strict": true,
    "contexts": ["typecheck", "test", "build"]
  },
  "enforce_admins": false,
  "required_pull_request_reviews": {
    "required_approving_review_count": 1,
    "dismiss_stale_reviews": true
  },
  "restrictions": null
}
JSON
```

### Configure branch protection on `dev`

Require status checks only. No review required — `dev` is a fast-moving integration branch.

```bash
gh api -X PUT repos/hipvlady/agent-coherence-plugin/branches/dev/protection \
  --input - <<'JSON'
{
  "required_status_checks": {
    "strict": true,
    "contexts": ["typecheck", "test", "build"]
  },
  "enforce_admins": false,
  "required_pull_request_reviews": null,
  "restrictions": null
}
JSON
```

### Configure tag protection ruleset for `refs/tags/v*`

Only admins can push release tags. Deletion and non-fast-forward updates are blocked.

```bash
gh api -X POST repos/hipvlady/agent-coherence-plugin/rulesets \
  --input - <<'JSON'
{
  "name": "Protect v* tags",
  "target": "tag",
  "enforcement": "active",
  "conditions": {
    "ref_name": {
      "include": ["refs/tags/v*"],
      "exclude": []
    }
  },
  "rules": [
    {"type": "deletion"},
    {"type": "non_fast_forward"}
  ]
}
JSON
```

---

## 2. Per-release procedure

Replace `X.Y.Z` with the target version (e.g. `0.1.2`) throughout.

1. **Open the `dev → main` PR.** Title is `release: vX.Y.Z` so it's easy to find in the PR history.

   ```bash
   gh pr create --base main --head dev --title "release: vX.Y.Z"
   ```

   Verify CI is green on every required job (`typecheck`, `test`, `build`) before continuing.

2. **Merge with rebase.** Rebase preserves the commit identity so the tag in step 7 points at the same SHA that existed on `dev`.

   ```bash
   gh pr merge --rebase
   ```

3. **Sync local `main`.**

   ```bash
   git checkout main && git pull --ff-only origin main
   ```

4. **Bump the version in three places.** All three must stay in sync — Unit 8's pre-commit hook will reject a commit where they drift.

   - `package.json` → `"version": "X.Y.Z"`
   - `.claude-plugin/plugin.json` → `"version": "X.Y.Z"`
   - `.claude-plugin/marketplace.json` → `plugins[0].version` (note the array path: it's nested inside the first entry of the `plugins` array, not at the manifest root)

5. **Regenerate the lockfile (recommended).** Keeps `package-lock.json`'s own `"version"` field aligned with the bump.

   ```bash
   npm install --package-lock-only
   ```

6. **Commit and push.**

   ```bash
   git add package.json .claude-plugin/plugin.json .claude-plugin/marketplace.json package-lock.json
   git commit -m "chore(release): bump to vX.Y.Z"
   git push origin main
   ```

7. **Create the annotated tag.** Use `-a` so the tag carries metadata (tagger, date, message) — lightweight tags are harder to audit.

   ```bash
   git tag -a vX.Y.Z -m "vX.Y.Z: <one-line summary>"
   ```

8. **Push the tag.**

   ```bash
   git push origin vX.Y.Z
   ```

9. **Watch the Actions tab.** The tag push triggers `release.yml`, which runs three jobs:

   - **preflight** — sanity checks (tag format, branch alignment)
   - **build** — `npm ci`, typecheck, test, build, SBOM generation
   - **github-release** — creates the GitHub Release with the build artifacts attached

   Common failure modes:

   - **Preflight fails:** usually means the tag was pushed without a corresponding `main` commit, or the tag name doesn't match `vX.Y.Z`.
   - **Build fails on version check:** the tag's version doesn't match `package.json`'s `"version"` field. Re-check step 4.

10. **Smoke check from a fresh install.** From a clean `claude` install (no prior marketplace state):

    ```bash
    claude
    # inside Claude Code:
    /plugin marketplace add hipvlady/agent-coherence-plugin@vX.Y.Z
    /plugin install agent-coherence@agent-coherence
    ```

    Confirm the plugin loads (no errors on `SessionStart`, hooks visible in `/hooks`).

---

## 3. Hot-fix procedure

Use this when a critical security or correctness fix must land on `main` immediately, bypassing the `dev` integration step.

1. **Branch from `main`** (not `dev` — `dev` may contain unreleased work you don't want to ship with the hot-fix):

   ```bash
   git checkout main && git pull --ff-only origin main
   git checkout -b hotfix/<short-name>
   ```

2. **Apply the fix, push, open PR against `main`.** Note in the PR body that this is a hot-fix bypassing the `dev` integration step so reviewers understand why it isn't coming through the normal path.

   ```bash
   git push -u origin hotfix/<short-name>
   gh pr create --base main --title "fix: <short summary>" --body "Hot-fix bypassing dev. <reason>."
   ```

3. **Merge after CI green + review.** Same protection rules as a normal release PR — the merge cannot bypass required status checks.

4. **Tag if a release is warranted.** Follow section 2 steps 4–10 (version bump, commit, tag, push tag, smoke check).

5. **Forward-merge into `dev`.** Critical — otherwise the next `dev → main` PR will look like it's re-introducing the hot-fix as a divergence (or worse, revert it during a rebase).

   ```bash
   git checkout dev && git pull --ff-only origin dev
   git merge main
   git push origin dev
   ```

---

## Notes

### Why no `npm publish`?

`package.json` is marked `"private": true`. The plugin is consumed via `/plugin marketplace add hipvlady/agent-coherence-plugin@vX.Y.Z`, which clones the tagged Git ref directly — not via the npm registry. The Node coordinator artifact is built into `dist/` on each user's machine via `npm ci` on first `SessionStart`, so there's nothing to publish to a package registry.

### Why SBOM in releases?

Supply-chain transparency. The release attaches a CycloneDX JSON SBOM generated by `@cyclonedx/cyclonedx-npm` in `release.yml`'s `build` job. Operators downloading a release can verify the dependency tree they're getting matches what the build produced.

### Why no Trusted Publishers OIDC?

Trusted Publishers OIDC is for publishing to PyPI/npm without a long-lived API token. Since we don't publish to a package registry (see above), there's no token to protect. The release artifact lives only on GitHub Releases, and `softprops/action-gh-release@v2` uses the auto-provisioned `GITHUB_TOKEN`, which is already scoped per-workflow and can't escape the action's run.
