# Broad-Beta Launch Playbook

Operator runbook for the v0.2 broad-beta launch of the `agent-coherence` Claude Code plugin. Replaces the v0.1.1 closed-cohort G12 gating per the 2026-05-23 plan deepening — broad-beta launches against the publicly-installable marketplace baseline established by v0.1.1.

This document is intentionally copy-pasteable. Each fenced block is the exact command an operator runs. Run them in order; do not paraphrase.

The release procedure itself lives in [`docs/RELEASE.md`](RELEASE.md); this document covers the **broad-beta-specific gates that must clear before each pre-broad-beta tag push**, the **14-day post-launch monitoring window**, and the **rollback runbook** if a launch-blocking issue surfaces.

## When this document applies

Use this playbook for tags that introduce a new public surface that broad-beta operators will install (notable: `v0.2.0` strict-mode launch). Do NOT use this playbook for patch tags (e.g. `v0.2.1`) that fix a regression in already-shipped behavior — those follow [`docs/RELEASE.md`](RELEASE.md) Section 2 (per-release procedure) or Section 3 (hot-fix procedure).

---

## 1. Pre-tag gates (BB1 – BB8)

All 8 gates must be GREEN before pushing the tag. Failure of any gate is a held-tag, not a documented-limitation. Re-run the failing gate after fixing the underlying issue.

| Gate | What it asserts | How to verify |
|---|---|---|
| **BB1** — Strict-mode launch gate green twice consecutively per model | Multi-model launch-gate matrix passes on `{haiku, sonnet, opus}` × 2 runs. Per-model score ≥70%, degenerate rate <10%. | In the library repo: `pytest -m launch_gate_strict` (~30-45 min wall × ~$8-13 per run; run twice consecutively). |
| **BB2** — README depth-parity review signed off | Section sequence + tone + link integrity all green. The README is the broad-beta launch surface for first-time operators. | Manual review: open [README.md](../README.md) in a markdown previewer and walk top-to-bottom. Confirm every cross-link resolves. |
| **BB3** — Public-feedback intake hardened | Issue templates polished (bug + feature + install-troubleshooting), GitHub Discussions enabled with seeded categories, `security@agent-coherence.dev` alias provisioned + tested, CODE_OF_CONDUCT.md + CONTRIBUTING.md + PRIVACY.md adopted. | `gh api repos/hipvlady/agent-coherence-plugin --jq '.has_discussions'` returns `true`. `ls .github/ISSUE_TEMPLATE/` shows 3 templates + `config.yml`. Send a test email to `security@agent-coherence.dev`; receive within 5 min. |
| **BB4** — Live marketplace-add smoke from fresh `claude` install | Fresh Claude Code install (no prior marketplace state) → `/plugin marketplace add hipvlady/agent-coherence-plugin` + `/plugin install agent-coherence@agent-coherence` round-trip succeeds. SessionStart hook fires; `/hooks` lists all 5 PreToolUse matchers (Read / Edit / Write / Bash / Grep). | Operator runs against a clean macOS or Linux env. Capture the output of `agent-coherence-status` post-install. |
| **BB5** — `agent-coherence-status --self-test` green on fresh install | Coordinator spawns, secret generates, /status responds, 4-step pre-read → pre-edit → post-edit → stale-pre-read smoke passes. | `agent-coherence-status --self-test` exits 0. |
| **BB6** — Protocol corpus green on both backends | Cross-implementation wire-shape parity tests pass in the library repo. Strict-mode fixtures pass Python-only (Node coordinator doesn't ship strict mode in v0.2). | In the library repo: `pytest -m protocol_corpus -q`. CI job `Protocol Corpus (Python ↔ Node parity)` must be green on the release branch. |
| **BB7** — CHANGELOG.md entry for the target version finalized | `[Unreleased]` section moved to `[X.Y.Z] — YYYY-MM-DD` with a populated date. Upgrade-from-previous-version procedure (KTD-W `hook.secret` rotation for v0.2.0) prominently documented. | `grep -A 2 '^## \[X.Y.Z\]' CHANGELOG.md` shows the version + date. |
| **BB8** — Landing page updated | `agent-coherence.dev/plugin/` reflects the new version's availability + status. Install block matches the canonical un-pinned command. | Manual visual check against the landing-page snapshot in `docs/demos/`. |

If any gate fails, fix the underlying issue and re-run that gate only. Do NOT proceed to tag-push with a known-yellow gate.

---

## 2. Tag-push checklist (after gates green)

Per [`docs/RELEASE.md`](RELEASE.md) section 2, with broad-beta-specific additions:

1. Confirm all 8 BB gates from section 1 are green and timestamped.
2. Confirm the [Unreleased] CHANGELOG section is fully migrated to `[X.Y.Z]` with a date.
3. Bump version in `package.json` + `.claude-plugin/plugin.json` + `.claude-plugin/marketplace.json` per RELEASE.md section 2 step 4.
4. Commit + push the version bump on `main`.
5. **Set a calendar event for Day +14** before pushing the tag (so the 14-day monitoring window is operator-owned, not forgotten).
6. Push the annotated tag.
7. Watch `release.yml` complete successfully.
8. **Open the broad-beta announcement** within 1 hour of the tag push (Unit 11 in the v0.2 plan — landing page update + GitHub Release body curation + operator-driven social).

---

## 3. Post-launch 14-day monitoring window

Starts the moment the v0.2.0 tag is published. During this window:

| Item | Cadence | Action |
|---|---|---|
| **Bug-report triage SLA** | Daily | Acknowledge new GitHub Issues within 72h. P0 (data-corrupting or auth-bypassing) → patch within 7 days via the hot-fix procedure. |
| **Issues + Discussions sweep** | Daily | Scan for net-new install-failure patterns. Cross-reference against the README troubleshooting table; add a new row if a pattern recurs ≥3 times. |
| **PyPI install metrics** | Daily | Watch `pip install agent-coherence` install counts via [pypistats.org/packages/agent-coherence](https://pypistats.org/packages/agent-coherence). Compare against the 7-day pre-launch baseline. A sudden drop suggests the install path broke. |
| **Coordinator-failure forensics** | As-needed | If a user posts a stack trace involving `coordinator_server.py` / `lifecycle.py`, ask for `agent-coherence-status --detail metrics` output + the relevant `.coherence/audit.log` window (denials-only; safe to paste). |
| **security@ alias monitoring** | Real-time | Maintainer email checks the `security@agent-coherence.dev` alias as part of regular inbox triage. Any security-class report → 72h response per the SLA in SECURITY.md. |

### Rollback trigger conditions

Trigger the rollback (section 4 below) if any of these fire:

- **≥3 independent reports** of the same correctness-class issue (different reporters, different workspaces).
- **Any security-class issue** (auth bypass, secret exposure, file-content disclosure).
- **Install-success-rate drops >50%** vs the 7-day pre-launch baseline (signals the install path broke for the broad-beta install matrix).

Do NOT trigger rollback for:

- Feature requests (those land in `[Unreleased]` for the next minor version).
- Single-user install issues (those land in the troubleshooting table).
- Strict-mode false-positives in non-strict workspaces (those mean `strict_mode.yaml` was misconfigured — README docs the threshold guard).

---

## 4. Rollback runbook

Use this if a rollback trigger from section 3 fires.

### Step 1 — Decision

Maintainer decides rollback within 4h of trigger. Document the decision (which trigger fired, evidence) in a GitHub Issue labeled `rollback`.

### Step 2 — Delete the tag

```bash
cd /Users/vladparakhin/projects/agent-coherence-plugin
git tag -d v0.2.0
git push --delete origin v0.2.0
```

The marketplace catalog's `marketplace.json` on `main` already points at `0.2.0`; the next step reverts that.

### Step 3 — Revert the version bump commit on `main`

```bash
git checkout main && git pull --ff-only origin main
git revert <SHA-of-version-bump-commit> --no-edit
git push origin main
```

The marketplace `add` command will now resolve to the previous tag (v0.1.1).

### Step 4 — Mark the GitHub Release as draft

```bash
gh release edit v0.2.0 --draft
```

This removes the release from the public Releases list (the deleted tag also removes the release-page link, but explicitly drafting the release prevents anyone with a cached link from downloading the SBOM / build artifacts).

### Step 5 — Add a README banner

Add a temporary banner at the top of README.md:

```markdown
> **v0.2.0 rolled back YYYY-MM-DD.** A blocker surfaced post-launch (see #ISSUE). Pinning to v0.1.1 is recommended until v0.2.1 ships.
```

Commit + push. The banner stays until the fix lands and a re-launch happens.

### Step 6 — Open the rollback issue + PR

Open a GitHub Issue labeled `rollback` + `incident` documenting:

- Which trigger fired
- The evidence (reporter usernames, issue numbers, install metric snapshots)
- The remediation plan (fix, target re-launch tag)
- Whether the `[Unreleased]` CHANGELOG block needs revision before re-launch

Open a tracking PR with the actual fix. The fix lands per `docs/RELEASE.md` section 3 (hot-fix procedure) or via normal `dev → main` if the fix is non-urgent.

### Step 7 — Re-launch criteria

Before re-tagging (typically as `v0.2.1`):

- The original trigger condition no longer holds (e.g., 0 reports of the rolled-back issue against a test install of the patched build).
- BB1-BB8 gates re-run and green against the patched build.
- README banner removed.
- Monitoring-window calendar event reset.

---

## 5. Calendar template (operator self-reminder)

Set these events when planning a broad-beta launch:

| Day | Event |
|---|---|
| Day −7 | Start BB1 (strict-mode launch gate, twice consecutively). Allow buffer for retries. |
| Day −3 | BB2 README review. |
| Day −2 | BB3 community-docs hardening. |
| Day −1 | BB4-BB6 (live install smoke + protocol corpus + self-test). |
| Day 0 | Tag push + Unit 11 announcement (CHANGELOG.md finalized, landing page updated, GitHub Release body curated). |
| Day +1 | First check-in. Issues / Discussions sweep. PyPI install-metrics baseline. |
| Day +3 | Mid-window check-in. |
| Day +7 | Mid-window check-in. P0 patch (if needed) deadline. |
| Day +14 | Window closes. If no rollback fired and no P0 patch outstanding, broad-beta is a success — file the closing summary in `docs/demos/` for future reference. |

---

## Notes

### Why "broad-beta" and not "GA"?

The v0.2 plan's positioning lock keeps the README + landing-page first paragraph on the v0.1.1 KTD-M one-liner. `v0.2.0` ships strict mode + the broad-beta launch package; it does NOT promote to "general availability" (1.0). The plugin stays in the SemVer `0.x.y` line until either (a) the wire contract stabilizes for ≥6 months across 3+ minor versions, or (b) the multi-target converter (v0.3) lands and exercises the contract across non-Claude-Code hosts. Whichever happens first becomes the GA gate.

### Why not a closed cohort (G12-style)?

The 2026-05-23 plan deepening flipped the v0.1.1 G12 alpha-cohort gating from "hold" to "open broad beta with explicit risk acceptance." Rationale:

- v0.1.1 has been publicly installable from the marketplace catalog for ≥7 days at v0.2.0 launch.
- No cohort blockers surfaced via the catalog smoke installs in that window.
- Strict mode's value proposition (hard guardrails for CI / multi-developer workspaces) needs broad signal to validate — a closed 2/10 cohort can't generate that signal.
- Rollback is technically possible (this document's section 4) but socially expensive — accept that risk in exchange for the broad-signal upside.

If the operator decides to override the broad-beta lock back to a closed cohort for a specific tag (e.g., a structurally-risky `v0.3.0` multi-target launch), document the override in the tag's GitHub Release body + skip BB2 + BB3 + BB8 in favor of a closed-cohort-specific rubric.
