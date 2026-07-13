# Marketplace listing copy (v0.2.0 broad-beta refresh)

**Status**: copy refreshed for the v0.2.0 broad-beta launch. v0.2 ships
strict mode (`permissionDecision: "deny"` on stale-read of opted-in
artifacts) on top of v0.1.1's marketplace baseline. The library
prerequisite is now `agent-coherence>=0.8.0` (stable; the earlier
`0.8.0a1` pre-release alias is no longer required — strict mode itself
needs `>=0.9.0` once published). Canonical install drops the `@v0.1.1`
pin per the 2026-05-23 broad-beta canonicalization decision (Unit 9 of
the v0.2 plan).

**Format**: this file is structured for the Claude Code marketplace's
expected fields. Copy verbatim into the submission form / PR.

---

## Listing name

agent-coherence

## Short tagline (≤ 100 chars)

> Coherence for the prose subset of project rules that can't be expressed as policy.

## One-paragraph description (≤ 300 chars)

> CLAUDE.md rules about *state* — "plan.md is v3 now", "session B just edited the file you're about to write" — can't be expressed as permissions.deny. agent-coherence is the runtime layer that surfaces those state changes across parallel Claude Code sessions. macOS / Linux / WSL2. Warn-mode + per-artifact opt-in strict mode (v0.2).

## Long description (marketplace detail page)

### The problem

CLAUDE.md is your project's prose contract — what to track, what to escalate, what to never touch. Most rules in it can't be expressed as `permissions.deny` or `.claude/settings.json` because they're about *state*, not *tools*: "this spec is now v3, your branch is editing v1", "the planner reorganized the auth section while you weren't looking", "session B just committed a change to the file you're about to write."

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

### What's in v0.1.1

- **Coverage**: Agent View ✓, multi-terminal ✓, Task-tool subagents ✓ (verified against claude v2.1.131)
- **Warn-only**: injects context; never blocks the user's tool call (strict mode deferred to v0.2 per empirical retry-loop hazard)
- **Multi-tool routing coverage** (KTD-N): warnings fire on `Read`, `Edit`, `Write`, `Bash` (with file-path-aware command detection), and `Grep` — closes the H4 routing-around-Read gap surfaced by the v0.2 Phase 0 falsifiability experiment.
- **Tool-class rule migration** (R19): `agent-coherence-migrate-rules` proposes `permissions.deny` entries from prose rules in CLAUDE.md ("use rg, not grep"; "never sudo"). `permissions.deny` enforces at the configuration layer — structurally stronger than runtime hook denies.
- **Local-first**: a lazy-spawned HTTP coordinator at `<repo>/.coherence/` wraps SQLite-WAL state. Node MESI-subset coordinator ships in v0.1.1 — one-click install. No external services. No telemetry beyond what `agent-coherence-status` shows you.
- **Race-safe**: 10-process concurrent spawn race covered by test, fcntl-locked port-file write fence, race-safe idle shutdown, KTD-H inode revalidation against external `rm -rf`, KTD-I in-flight handler drain on shutdown.
- **Bounded under load** (KTD-G + KTD-K): per-handler 4s watchdog with queue-depth gate (HTTP 503 on overflow), handler concurrency semaphore matched to pool, SQLite `busy_timeout = 1500ms` derived from the multi-statement transaction budget.
- **Auth**: shared-secret Bearer token on `127.0.0.1` with Host-header allowlist (DNS-rebind mitigation); R21 64 KB request body cap; R12 three-tier `/status` disclosure (default minimal — safe to paste in bug reports).
- **Backend-switch safe**: `agent-coherence-coordinator --prepare-for-migration` atomically releases all grants + shuts down before switching the Python ↔ Node backend.
- **Storage hygiene**: state.db has NO `content` column (KTD-13) — only `content_hash`, so accidentally committing `.coherence/state.db` doesn't disclose file content. Auto-gitignored.

### What's NOT in v0.1.1 (transparent scope)

- Native Windows (use WSL2; v0.2 ships `os.O_EXCL` fallback)
- Strict mode (`permissionDecision: "deny"` blocks the tool call) — empirical retry-loop hazard on v2.1.131 forced deferral to v0.2. v0.2 design combines `permissions.deny` (terminal — model cannot route around) + multi-tool runtime hooks for advisory warnings.
- `claude agents` subcommand on v2.1.131 — the subcommand is a management UI, not a session spawner; out of scope
- Cross-host / cross-vendor coordination (hosted MCP roadmap, not this plugin)
- Multiple developers on the same workstation — v0.1.1 trust boundary is single-user single-host

### Install

```bash
# Library (provides the coordinator + hook client console scripts):
pip install "agent-coherence>=0.8.0"

# Add the marketplace + install (canonical un-pinned form — resolves to
# the latest published tag per the v0.2 broad-beta canonicalization).
claude plugin marketplace add Cohexa-ai/agent-coherence-plugin
claude plugin install agent-coherence@agent-coherence
```

For operators who need to pin a specific version (CI / reproducibility):

```bash
claude plugin marketplace add Cohexa-ai/agent-coherence-plugin@v0.2.0
```

Measured install time: 27s end-to-end (R1 target: <30s).

After install, restart any running `claude` sessions in your workspace so the SessionStart hook fires.

### Upgrading from v0.1.1

Strict mode (v0.2) extends the trust boundary the `hook.secret` token protects. Operators upgrading from v0.1.1 MUST rotate the secret before strict-mode hard guardrails take effect — secrets generated under v0.1.1's warn-only threat model are insufficient to bridge the upgrade. Procedure documented in [`docs/RELEASE.md`](RELEASE.md) section 4 (KTD-W).

### Validation

Run with hook events visible to see warnings as they fire:

```bash
claude --include-hook-events --output-format stream-json "your prompt"
```

### Discovery / book a call

[agent-coherence.dev/code](https://agent-coherence.dev/code)

### Source

- Plugin: https://github.com/Cohexa-ai/agent-coherence-plugin
- Underlying library: https://github.com/Cohexa-ai/agent-coherence
- Issue tracker: https://github.com/Cohexa-ai/agent-coherence-plugin/issues

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
| Source URL | https://github.com/Cohexa-ai/agent-coherence-plugin |
| Marketplace URL | https://github.com/Cohexa-ai/agent-coherence-plugin |
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
      [Cohexa-ai/agent-coherence#27](https://github.com/Cohexa-ai/agent-coherence/pull/27)
- [ ] AS-phpmac walkthrough re-run on a fresh machine against PyPI
      install path
- [ ] At least 3 alpha installers have completed onboarding without
      hitting blockers
- [ ] CHANGELOG.md updated with v0.1.1 release notes
- [ ] plugin.json version bumped from 0.1.0-alpha.1 → 0.1.1
- [ ] marketplace.json plugin entry version bumped to match
