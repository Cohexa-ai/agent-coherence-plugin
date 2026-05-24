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

Require PR review + the five CI status check contexts. Strict mode means the PR branch must be up to date with `main` before merging.

The context names below MUST match the job display names in `.github/workflows/ci.yml` verbatim — GitHub matches on the `name:` field of each job (and per-matrix variant). Update this list if the workflow's job names change.

```bash
gh api -X PUT repos/hipvlady/agent-coherence-plugin/branches/main/protection \
  --input - <<'JSON'
{
  "required_status_checks": {
    "strict": true,
    "contexts": ["Typecheck", "Tests (Node 18)", "Tests (Node 20)", "Tests (Node 22)", "Build Package"]
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

Require the same five status check contexts. No review required — `dev` is a fast-moving integration branch.

```bash
gh api -X PUT repos/hipvlady/agent-coherence-plugin/branches/dev/protection \
  --input - <<'JSON'
{
  "required_status_checks": {
    "strict": true,
    "contexts": ["Typecheck", "Tests (Node 18)", "Tests (Node 20)", "Tests (Node 22)", "Build Package"]
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

   Verify CI is green on every required job (`Typecheck`, `Tests (Node 18/20/22)`, `Build Package`) before continuing.

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
    # inside Claude Code — un-pinned (canonical) form per the v0.2 broad-beta
    # decision lock; resolves to the latest published tag:
    /plugin marketplace add hipvlady/agent-coherence-plugin
    /plugin install agent-coherence@agent-coherence
    ```

    For operators who need to pin a specific version (CI / reproducibility), use:

    ```bash
    /plugin marketplace add hipvlady/agent-coherence-plugin@vX.Y.Z
    ```

    Confirm the plugin loads (no errors on `SessionStart`, hooks visible in `/hooks`).

11. **Broad-beta gates (v0.2.0 and any later tag introducing a new public surface).** Walk through the BB1-BB8 rubric in [`docs/BROAD_BETA.md`](BROAD_BETA.md) before pushing the tag. The broad-beta playbook also covers the 14-day post-launch monitoring window and the rollback runbook. Skip this step for patch tags that only fix regressions in already-shipped behavior.

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

---

## 4. Upgrade procedure — MANDATORY `hook.secret` rotation on v0.2 (KTD-W)

When an operator upgrades from v0.1.x to v0.2.x (or any future tag that changes the threat model under which the bearer token was issued), the `hook.secret` MUST be rotated before strict-mode hard guardrails take effect. Secrets generated under the old threat model are insufficient to bridge the upgrade — the canonical rationale is in the v0.2 plan KTD-W.

This is an OPERATOR step, not an automated one. The plugin cannot rotate the secret on the operator's behalf without disrupting in-flight `claude` sessions; the operator is the only authority that can decide when it's safe.

### Procedure

```bash
# 1. Stop ALL running `claude` sessions in the workspace.
#    The coordinator is lazy-spawned per-workspace; it will exit when no
#    sessions hold open hook clients.

# 2. Verify no coordinator process is still alive.
cd <repo>
cat .coherence/server.pid 2>/dev/null
# If a PID is listed, kill it:
kill $(head -1 .coherence/server.pid) 2>/dev/null

# 3. Remove the old secret.
rm .coherence/hook.secret

# 4. Restart any `claude` session in the workspace. The first PreToolUse
#    hook fires, which spawns the coordinator, which generates a fresh
#    32-byte secret at .coherence/hook.secret (mode 0o600).

# 5. Verify the new secret landed.
ls -la .coherence/hook.secret
# Expect: -rw------- (mode 0o600), size 64 bytes (32 hex-encoded bytes).

# 6. Confirm hooks fire under the new secret.
agent-coherence-status --self-test
# Expect: exit 0, 4 steps green.
```

### Why this is mandatory, not advisory

v0.1.1's threat model treated the bearer secret as protection against Adversary 1 (same-user co-tenant code) only. v0.2's strict-mode hard guardrails (`permissionDecision: "deny"`) extend the trust boundary the secret protects — a leaked v0.1.1 secret used by a same-user adversary in v0.2 could trigger denials the operator never intended, undermining the operator's strict-mode policy. Rotating ensures the operator's v0.2 deployment runs entirely under a secret minted under v0.2's threat assumptions.

### Hot rotation deferred

`agent-coherence-coordinator --rotate-secret` (rotate without stopping sessions) is a v0.2.x backlog item. v0.2 ships the manual stop-rotate-restart path documented above.

---

## Notes

### Why no `npm publish`?

`package.json` is marked `"private": true`. The plugin is consumed via `/plugin marketplace add hipvlady/agent-coherence-plugin@vX.Y.Z`, which clones the tagged Git ref directly — not via the npm registry. The Node coordinator artifact is built into `dist/` on each user's machine via `npm ci` on first `SessionStart`, so there's nothing to publish to a package registry.

### Why SBOM in releases?

Supply-chain transparency. The release attaches a CycloneDX JSON SBOM generated by `@cyclonedx/cyclonedx-npm` in `release.yml`'s `build` job. Operators downloading a release can verify the dependency tree they're getting matches what the build produced.

### Why no Trusted Publishers OIDC?

Trusted Publishers OIDC is for publishing to PyPI/npm without a long-lived API token. Since we don't publish to a package registry (see above), there's no token to protect. The release artifact lives only on GitHub Releases, and `softprops/action-gh-release@v2` uses the auto-provisioned `GITHUB_TOKEN`, which is already scoped per-workflow and can't escape the action's run.
