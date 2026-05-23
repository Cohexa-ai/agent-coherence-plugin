# agent-coherence (Claude Code plugin)

**Coherence for the prose subset of project rules that can't be expressed as policy.**

CLAUDE.md is your project's prose contract — what to track, what to escalate, what to never touch. Most of those rules can't be expressed as `permissions.deny` or `.claude/settings.json` because they're about *state*, not *tools*: "this spec is now v3, your branch is editing v1", "the planner reorganized the auth section while you weren't looking", "session B just committed a change to the file you're about to write." `agent-coherence` is the runtime layer that makes those state changes visible across parallel Claude Code sessions sharing the same workspace.

**Status: v0.1.1 alpha** (Node coordinator + marketplace catalog listing). v0.1 shipped private alpha 2026-05-18; v0.1.1 collapses the two-step install to one-click. See [release sequence](#release-sequence) below.

## What it does

Two parallel sessions can read the same `plan.md` at v1, work independently in their per-session worktrees, and produce PRs that reflect incompatible interpretations — because the planner already published v2. Worktrees prevent direct file collisions but not stale-spec collisions.

This plugin watches tracked artifacts (CLAUDE.md, AGENTS.md, `DECISIONS.md`, `docs/specs/`, `docs/plans/`, `docs/brainstorms/`, `plan.md`/`task.md`/`spec.md`) across Agent View, multi-terminal sessions, and Task-tool subagents. When one session is about to act on an artifact another session has updated, the plugin injects a warning into the agent's own context via `additionalContext`. The agent reads the warning alongside the file and decides what to do — typically re-read before acting.

For tool-class rules that *can* be expressed as policy ("use rg, not grep"; "never sudo"; "no python -c"), run `agent-coherence-migrate-rules` (v0.1.1) — the helper proposes `permissions.deny` entries derived from prose in CLAUDE.md. `permissions.deny` is structurally stronger than runtime hook denies: the runtime enforces it before the model can choose which tool to invoke.

**Coverage scope (verified against `claude` v2.1.131 on 2026-05-17 via internal Phase E.0 probe procedure)**:
- Agent View ✓
- Multi-terminal (multiple `claude` processes in the same workspace) ✓
- Task-tool subagents — subagent hooks fire under the parent's session_id, so warnings surface to the parent's context ✓
- `claude agents` subcommand — on v2.1.131 the subcommand is a management UI, not a session spawner; not in v0.1 scope

**v0.1 ships warn-only.** Strict mode (`permissionDecision: "deny"`) is deferred to v0.2 — empirical testing showed it needs per-(session, path) retry counters and varied-reason templating to avoid model retry loops.

**Validation signal**: [anthropics/claude-code#59309](https://github.com/anthropics/claude-code/issues/59309) (filed 2026-05-13) plus three documented duplicates (#40459, #19471, #29423 over 6 months) confirm the failure shape and that Anthropic isn't fixing it at the platform layer.

**Launch-gate evidence (2026-05-18)**: N=40 × 2 consecutive hard-gate runs against live `claude` v2.1.131, model `haiku` — both runs scored **100%** with degenerate_rate **5% / 0%** (instrumentation gate is <10%). 35 / 33 scenarios produced the re-read warning; 3 / 7 produced acknowledgement; **zero** ignored across N=80 trials. Harness: `tests/integration/test_warn_mode_behavior_change.py` in [hipvlady/agent-coherence](https://github.com/hipvlady/agent-coherence). PR with the harness fix that made the gate reliably runnable: [#27](https://github.com/hipvlady/agent-coherence/pull/27).

## Install

v0.1.1 ships the Node MESI-subset coordinator and the public marketplace catalog listing. Two install paths coexist — the Python coordinator (full feature set, alpha cohort) and the Node coordinator (one-click marketplace install). Pick one via `coherence.coordinator_backend` in plugin settings; both ship the same HTTP wire contract, the same `hook.secret` exchange, and the same `server.pid` lazy-spawn semantics. Switch backends safely with `agent-coherence-coordinator --prepare-for-migration`.

```bash
# Step 1 — install the Python library that provides the coordinator + hook client.
# The plugin entry points ship in agent-coherence ≥ 0.8.0 (stable on PyPI,
# released 2026-05-23 alongside this plugin v0.1.1 cut).
pip install "agent-coherence>=0.8.0"

# Verify the required console scripts landed on PATH
command -v agent-coherence-coordinator
command -v agent-coherence-hook-client

# Step 2 — register this repo as a Claude Code marketplace, then install the plugin
claude plugin marketplace add hipvlady/agent-coherence-plugin@v0.1.1
claude plugin install agent-coherence@agent-coherence
```

After install, restart any running `claude` sessions in your workspace so the new SessionStart hook fires.

> **Library compatibility.** `agent-coherence>=0.8.0` is the first stable PyPI
> release that ships `agent-coherence-coordinator` and `agent-coherence-hook-client`
> (the earlier `0.7.x` line was the LangGraph/CrewAI/AutoGen drop-in only; the
> `0.8.0a1` pre-release was the marketplace-cohort alpha). Release page:
> [hipvlady/agent-coherence v0.8.0](https://github.com/hipvlady/agent-coherence/releases/tag/v0.8.0).

### Scope (v0.1.1)

- macOS / Linux / WSL2 — native Windows deferred to v0.2 (`fcntl` constraint, see below).
- Single workspace, single-user, single-host workstation — not for shared developer machines, CI runners with multiple developers, or cross-host coordination. Cross-machine and cross-vendor coverage are the hosted MCP roadmap (Path B), not this plugin.
- Warn-only, no auto-merge, no auto-revert. Tool-class rules expressible as policy use `agent-coherence-migrate-rules` (KTD-E v0.2 will combine `permissions.deny` + multi-tool runtime hooks).

### What you'll see

When the plugin detects a stale read, a warning appears in the agent's own context — invisible to you in the terminal by default. You'll notice it through agent behavior: the agent says "I see another session updated this, let me re-read" or similar before acting.

For visibility, run with `--include-hook-events --output-format stream-json` (debug mode):

```bash
claude --include-hook-events --output-format stream-json "your prompt"
```

## Branching strategy

Feature work targets `dev`; release merges promote `dev → main` and tag from `main`. The canonical guidance lives in [CLAUDE.md](CLAUDE.md) at the repo root — `gh pr create` defaults to `--base dev` unless the PR is the release merge.

## How it works (one paragraph)

A lazy-spawned local HTTP coordinator at the parent repo root (`<repo>/.coherence/`) wraps a SQLite-WAL state store implementing the MESI cache-coherence protocol. Plugin hooks are **command-type** (not HTTP-type — Claude Code v2.1.131's hooks.json schema validator rejects URLs containing env-var templates at load time, per the internal Phase E.0 probe 2A finding); each hook invokes `agent-coherence-hook-client` which reads `.coherence/server.pid` for the port + `.coherence/hook.secret` for the bearer token, then POSTs the hook payload to the coordinator. PreToolUse fires for every `Read`, `Edit`, `Write`; PostToolUse commits writes and triggers peer invalidations; Stop releases any uncommitted EXCLUSIVE grants at end-of-turn. All HTTP traffic is `127.0.0.1`-bound. Coordinator idle-shuts after 15 minutes; SQLite state rehydrates on next spawn. See the underlying library: [agent-coherence](https://github.com/hipvlady/agent-coherence).

## Commands

| Slash command | Description |
|---|---|
| `/agent-coherence:status` | Show tracked artifacts, current versions, sessions × MESI state |
| `/agent-coherence:track <path>` | Add a path to the coordinator's tracked set |
| `/agent-coherence:untrack <path>` | Remove a path from coordination |

Slash commands shell out to the corresponding `agent-coherence-{status,track,untrack}` console scripts the library installs. If you prefer plain shell, calling the CLI directly works identically (and is also what `bin/ensure-coordinator` uses internally).

## Configuration

The coordinator creates `.coherence/` at your repo root automatically. Inside it:

- `state.db` — SQLite-WAL artifact state. Auto-gitignored.
- `hook.secret` — Bearer token for hook auth, mode `0600`. Auto-gitignored.
- `tracked.yaml` — your opt-in patterns (gitignore-style globs). Commit this if you want the tracked set to apply across team checkouts.
- `ignored.yaml` — your opt-out patterns. Same.

**Note on `allowedHttpHookUrls`**: v0.1 hooks are *command-type* (the `agent-coherence-hook-client` subprocess makes the HTTP call internally), not Claude Code's HTTP-type hooks. The `allowedHttpHookUrls` Claude Code policy does NOT apply to this plugin — no allowlist changes are required to install.

## Release sequence

- **v0.1.1** (current) — Node MESI-subset coordinator + self-hosted marketplace catalog listing. One-click install via `/plugin marketplace add hipvlady/agent-coherence-plugin`.
- **v0.2** (next) — strict mode (`permissions.deny` + multi-tool runtime hooks per the v0.2 Phase 0 H4 finding), native Windows, security@ alias.

Per-release procedure: see [docs/RELEASE.md](docs/RELEASE.md) (operator runbook — pre-flight setup, version bump, tag push, hot-fix path).

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| Agents still hit stale-spec collisions silently | `pip install agent-coherence` step missed, or `agent-coherence-hook-client` not on PATH | Confirm `which agent-coherence-coordinator agent-coherence-hook-client` both resolve. If `pip install` succeeded but binaries aren't found, check that your shell's PATH includes the install prefix's `bin/` directory (e.g. `~/.local/bin` for user installs). |
| Plugin load failure / silent no-op | Coordinator backend not installed | Check `claude --include-hook-events --output-format stream-json "echo test"` for `plugin_errors` in the init event. If "hook-load-failed" appears, the plugin's hooks.json references commands not on PATH. |
| Stale-warning shown when worktrees just have different branches checked out | Filesystem-state semantics: divergent content on first observation surfaces as `hash_differs` (KTD-9) | Expected behavior. Add the path to `ignored.yaml` if the divergence is intentional. |
| Frequent acquire/release events in `agent-coherence-status` | Per-turn Stop-hook release of uncommitted grants. Normal end-of-turn behavior, not a bug. | No action. Telemetry counter `intra_task_acquire_release_count` will quantify this in v0.1.1. |
| `state.db` corrupted | Power loss during WAL checkpoint, or SQLite version mismatch | `rm .coherence/state.db` — next coordinator spawn starts fresh |
| Coordinator process won't die | Stale `server.pid` after crash | `rm .coherence/server.pid` to clear the lock, next hook fires re-spawn |
| `hook.secret` compromised | Same-user attack or accidental leak | Stop all sessions, `rm -rf .coherence/`, restart any Claude Code session. v0.2 will support hot rotation without restart. |

## v0.1.1 known limitations

Items genuinely deferred past v0.1.1. Anything not listed has been resolved on `dev` (Unit 4 / Unit 5 / Unit 6 / Unit 8 of the v0.1.1 plan).

| Issue | Impact | When it matters |
|---|---|---|
| Native Windows not supported | `fcntl` lock primitive is POSIX-only | Use WSL2 on Windows. v0.2 ships an `os.O_EXCL` fallback. |
| Strict mode (`permissionDecision: "deny"`) deferred to v0.2 | v0.1.1 warns but never blocks | Hard guardrails for "agent MUST re-read before edit" not available yet. v0.2 design combines `permissions.deny` (terminal — model cannot route around) + multi-tool runtime hooks for advisory warnings, after the v0.2 Phase 0 falsifiability experiment confirmed the H4 routing mechanism. For the tool-class subset (`grep` → `rg`, `python -c`, `sudo`), use `agent-coherence-migrate-rules` to derive `permissions.deny` entries from CLAUDE.md prose today. |
| HTTP-type hooks not viable on v2.1.131 (internal Phase E.0 probe 2A) | hooks.json URL templating fails strict-URL schema validation at load time | v0.1.1 ships command-type hooks via `agent-coherence-hook-client` — works on v2.1.131. If a future CC version supports URL templating, an HTTP-type variant can be added as a perf optimization. |
| `claude agents` subcommand not in coverage scope | The v2.1.131 subcommand is a management UI, not a session spawner; no PreToolUse hooks to capture | Use Agent View, multi-terminal, or Task-tool subagents (all in scope). If a future CC version exposes a session spawner via `claude agents`, file an issue and we'll re-probe coverage. |
| Single-user, single-host workstation only | Trust boundary is the OS user; `hook.secret` mode 0600 is the load-bearing fence | Not suitable for shared developer machines, CI runners with multiple developers, or cross-host coordination. Cross-host / multi-vendor coverage is the hosted MCP roadmap (Path B), not this plugin. |

### Resolved in v0.1.1

- **Watchdog races (A6, A7)** — KTD-G ships queue-depth gate (HTTP 503 on overflow) + handler concurrency semaphore + observable `watchdog_timeouts_total` / `watchdog_queue_overflows_total` / `handler_concurrency_overflows_total` counters in `/status`.
- **Lifecycle L1 — inode race on external `rm -rf`** — KTD-H inode revalidation per retry iteration in `ensure_coordinator`; bounded re-open budget defends against pathological churn.
- **Lifecycle L2 — in-flight handler truncated on shutdown** — KTD-I in-flight semaphore drain on `coordinator.shutdown()` with bounded 5s timeout (observable HTTP 500 on overflow beats silent client hang).
- **Multi-tool routing (H4) gap** — KTD-N extends hook coverage from `Read`/`Edit`/`Write` to `Read`/`Edit`/`Write`/`Bash`/`Grep` with file-path-aware Bash detection.
- **Telemetry observability** — KTD-J adds per-endpoint + product-signal counters surfaced via `/status?detail=metrics` and `agent-coherence-status --detail metrics`; post-install validation via `agent-coherence-status --self-test`.
- **Backend-switch safety** — `agent-coherence-coordinator --prepare-for-migration` atomically releases all M/E grants + shuts down before switching the Python ↔ Node backend.

## License

Apache-2.0. See [LICENSE](LICENSE).

## Links

- Underlying library: [hipvlady/agent-coherence](https://github.com/hipvlady/agent-coherence)
- Discovery / book a call: https://agent-coherence.dev/code
- Issue tracker: https://github.com/hipvlady/agent-coherence-plugin/issues
