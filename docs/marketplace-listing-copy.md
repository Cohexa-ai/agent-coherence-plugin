# Marketplace listing copy (v0.1.1 submission prep)

**Status**: pre-written copy for the v0.1.1 marketplace catalog submission.
v0.1 ships as a two-step install — `pip install "agent-coherence>=0.8.0a1"`
from PyPI (the library publishes the coordinator + hook-client entry
points as of 2026-05-18) plus `claude plugin marketplace add` for this
repo (per [release sequence in README](../README.md#release-sequence)).
v0.1.1 ships the Node MESI-subset coordinator and submits this listing.

**Format**: this file is structured for the Claude Code marketplace's
expected fields. Copy verbatim into the submission form / PR.

---

## Listing name

agent-coherence

## Short tagline (≤ 100 chars)

> Catches stale-spec collisions across parallel Claude Code sessions before they produce divergent PRs.

## One-paragraph description (≤ 300 chars)

> Two sessions read the same plan.md at v1, then a planner publishes v2 — and your parallel agents ship incompatible PRs. agent-coherence detects this BEFORE the act, injects a warning into the agent's context, and lets the agent decide to re-read. macOS / Linux / WSL2. Warn-only in v0.1.

## Long description (marketplace detail page)

### The problem

Parallel Claude Code sessions sharing a workspace don't see each other's writes to spec files. Two sessions can both read `plan.md` at version 1, work independently in per-session git worktrees, and produce pull requests that reflect incompatible interpretations of v1 — even though the planner published v2 hours ago.

Worktrees prevent direct file collisions. They don't prevent **stale-spec collisions**.

This isn't a niche concern. Filed in May 2026 as
[anthropics/claude-code#59309](https://github.com/anthropics/claude-code/issues/59309)
with three documented duplicates over 6 months (#40459, #19471,
#29423). The failure shape is structural: CLAUDE.md tool restrictions
don't propagate to subagents; context compaction weakens rule
adherence; multi-session coordination has no platform-level
synchronization primitive.

### The fix

`agent-coherence` watches tracked artifacts (CLAUDE.md, AGENTS.md, `docs/specs/`, `docs/plans/`, `docs/brainstorms/`, `plan.md` / `task.md` / `spec.md`) across Agent View, multi-terminal sessions, and Task-tool subagents. When one session is about to act on an artifact another session has updated, the plugin injects a warning into the agent's own context via `additionalContext`.

The agent sees:

> ⚠ Stale read: docs/plans/feature-x.md was updated by session 90b1dfd3 at 2026-05-17T13:42:18Z. Current version is v3; you previously saw v1. Consider re-reading docs/plans/feature-x.md before acting on stale assumptions.

The agent decides what to do — typically re-read before acting. No platform fix needed. No model retraining.

### What's in v0.1

- **Coverage**: Agent View ✓, multi-terminal ✓, Task-tool subagents ✓ (verified against claude v2.1.131)
- **Warn-only**: injects context; never blocks the user's tool call (strict mode deferred to v0.2 per empirical retry-loop hazard)
- **Local-first**: a lazy-spawned HTTP coordinator at `<repo>/.coherence/` wraps SQLite-WAL state. No external services. No telemetry beyond what `agent-coherence-status` shows you.
- **Race-safe**: 10-process concurrent spawn race covered by test, fcntl-locked port-file write fence, race-safe idle shutdown
- **Auth**: shared-secret Bearer token on `127.0.0.1` with Host-header allowlist (DNS-rebind mitigation)
- **Storage hygiene**: state.db has NO `content` column (KTD-13) — only `content_hash`, so accidentally committing `.coherence/state.db` doesn't disclose file content. Auto-gitignored.

### What's NOT in v0.1 (transparent scope)

- Native Windows (use WSL2; v0.2 ships `os.O_EXCL` fallback)
- Strict mode (`permissionDecision: "deny"` blocks the tool call) — empirical retry-loop hazard on v2.1.131 forced deferral to v0.2
- `claude agents` subcommand on v2.1.131 — the subcommand is a management UI, not a session spawner; out of scope
- Cross-host / cross-vendor coordination (hosted MCP roadmap, not this plugin)

### Install

```bash
# v0.1.1 path (when published):
pip install agent-coherence

# Add the marketplace + install
claude plugin marketplace add hipvlady/agent-coherence-plugin
claude plugin install agent-coherence@agent-coherence
```

Measured install time: 27s end-to-end (R1 target: <30s).

After install, restart any running `claude` sessions in your workspace so the SessionStart hook fires.

### Validation

Run with hook events visible to see warnings as they fire:

```bash
claude --include-hook-events --output-format stream-json "your prompt"
```

### Discovery / book a call

[agent-coherence.dev/code](https://agent-coherence.dev/code)

### Source

- Plugin: https://github.com/hipvlady/agent-coherence-plugin
- Underlying library: https://github.com/hipvlady/agent-coherence
- Issue tracker: https://github.com/hipvlady/agent-coherence-plugin/issues

### License

Apache-2.0

---

## Tags / categories

- `developer-tools`
- `multi-agent`
- `coherence`
- `parallel-sessions`
- `worktree`
- `stale-read`
- `mesi`
- `cache-coherence`

## Screenshot / asset list

1. `docs/demos/agent-coherence-stale-read.gif` — 60s recording per
   `docs/demos/2026-05-17-stale-read-demo-script.md` (the demo script).
2. `docs/demos/install-time-measurement.png` (optional) — terminal
   screenshot showing 27s end-to-end install for the R1 claim.
3. `docs/demos/status-table-example.png` (optional) — terminal screenshot
   showing `agent-coherence-status` output with observed artifacts +
   sessions in MESI state.

## Required-by-marketplace fields (to fill at submission)

| Field | Value |
|---|---|
| Plugin name | agent-coherence |
| Version | 0.1.1 (NOT 0.1.0-alpha.1 — that's the direct-install version) |
| Min Claude Code version | 2.1.131 |
| Max Claude Code version | (open) |
| Author | Vlad Parakhin <vlad@agent-coherence.dev> |
| Source URL | https://github.com/hipvlady/agent-coherence-plugin |
| Marketplace URL | https://github.com/hipvlady/agent-coherence-plugin |
| License | Apache-2.0 |
| Categories | developer-tools, multi-agent |

## Submission checklist

- [x] Library published to PyPI as `agent-coherence>=0.8.0a1` (drops
      `pip install` from git+ to standard PyPI; measured install time
      ≈ 3s in fresh py3.13 venv, 2026-05-18 AS-phpmac walkthrough)
- [ ] Demo asset recorded and committed under `docs/demos/`
- [x] N=40 launch gate run completed (per Unit 9) with score ≥70% —
      2026-05-18, two consecutive runs against live `claude` v2.1.131:
      Run #1 re-read=35 / ack=3 / ignored=0 / degenerate=2, score=100%,
      degenerate_rate=5%, 14:36 wall. Run #2 re-read=33 / ack=7 /
      ignored=0 / degenerate=0, score=100%, degenerate_rate=0%, 17:07
      wall. Harness fix that made the gate reliably runnable:
      [hipvlady/agent-coherence#27](https://github.com/hipvlady/agent-coherence/pull/27)
- [ ] AS-phpmac walkthrough re-run on a fresh machine against PyPI
      install path
- [ ] At least 3 alpha installers have completed onboarding without
      hitting blockers
- [ ] CHANGELOG.md updated with v0.1.1 release notes
- [ ] plugin.json version bumped from 0.1.0-alpha.1 → 0.1.1
- [ ] marketplace.json plugin entry version bumped to match
