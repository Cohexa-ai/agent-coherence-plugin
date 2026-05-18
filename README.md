# agent-coherence (Claude Code plugin)

**Status: v0.1 private alpha** (active build, started 2026-05-13). Marketplace catalog listing is held until v0.1.1 (Node MESI-subset coordinator, hard 4-week deadline from v0.1 ship). See [release sequence](#release-sequence) below.

## What it does

Surfaces stale-spec collisions across parallel Claude Code sessions sharing a workspace.

Two parallel sessions can read the same `plan.md` at v1, work independently in their per-session worktrees, and produce PRs that reflect incompatible interpretations because the planner already published v2. Worktrees prevent direct file collisions but not stale-spec collisions.

This plugin watches tracked artifacts (CLAUDE.md, AGENTS.md, `docs/specs/`, `docs/plans/`, `docs/brainstorms/`, `plan.md`/`task.md`/`spec.md`) across Agent View, multi-terminal sessions, and Task-tool subagents. When one session is about to act on an artifact another session has updated, the plugin injects a warning into the agent's own context via `additionalContext`. The agent reads the warning alongside the file and decides what to do — typically re-read before acting.

**Coverage scope (verified against `claude` v2.1.131 on 2026-05-17 via internal Phase E.0 probe procedure)**:
- Agent View ✓
- Multi-terminal (multiple `claude` processes in the same workspace) ✓
- Task-tool subagents — subagent hooks fire under the parent's session_id, so warnings surface to the parent's context ✓
- `claude agents` subcommand — on v2.1.131 the subcommand is a management UI, not a session spawner; not in v0.1 scope

**v0.1 ships warn-only.** Strict mode (`permissionDecision: "deny"`) is deferred to v0.2 — empirical testing showed it needs per-(session, path) retry counters and varied-reason templating to avoid model retry loops.

**Validation signal**: [anthropics/claude-code#59309](https://github.com/anthropics/claude-code/issues/59309) (filed 2026-05-13) plus three documented duplicates (#40459, #19471, #29423 over 6 months) confirm the failure shape and that Anthropic isn't fixing it at the platform layer.

**Launch-gate evidence (2026-05-18)**: N=40 × 2 consecutive hard-gate runs against live `claude` v2.1.131, model `haiku` — both runs scored **100%** with degenerate_rate **5% / 0%** (instrumentation gate is <10%). 35 / 33 scenarios produced the re-read warning; 3 / 7 produced acknowledgement; **zero** ignored across N=80 trials. Harness: `tests/integration/test_warn_mode_behavior_change.py` in [hipvlady/agent-coherence](https://github.com/hipvlady/agent-coherence). PR with the harness fix that made the gate reliably runnable: [#27](https://github.com/hipvlady/agent-coherence/pull/27).

## Install (v0.1 private alpha — invite-only)

v0.1 is an **alpha**. ~10 hand-picked installers from discovery calls and ecosystem engagements. Two-step install for v0.1 (Python coordinator + Claude Code plugin); collapses to one-click in v0.1.1 (Node MESI-subset coordinator).

```bash
# Step 1 — install the Python library that provides the coordinator + hook client.
# The plugin entry points ship in agent-coherence ≥ 0.8.0a1 (pre-release on PyPI,
# released 2026-05-18). The `>=0.8.0a1` specifier opts pip into the pre-release.
pip install "agent-coherence>=0.8.0a1"

# Verify the required console scripts landed on PATH
command -v agent-coherence-coordinator
command -v agent-coherence-hook-client

# Step 2 — register this repo as a Claude Code marketplace, then install the plugin
claude plugin marketplace add hipvlady/agent-coherence-plugin
claude plugin install agent-coherence@agent-coherence
```

After install, restart any running `claude` sessions in your workspace so the new SessionStart hook fires.

> **Pre-release note.** `0.8.0a1` is the first PyPI release that ships
> `agent-coherence-coordinator` and `agent-coherence-hook-client` (the
> earlier `0.7.x` line was the LangGraph/CrewAI/AutoGen drop-in only).
> The `>=0.8.0a1` specifier opts pip into the pre-release; a stable
> `0.8.0` follows once the alpha cohort signs off. Release page:
> [hipvlady/agent-coherence v0.8.0a1](https://github.com/hipvlady/agent-coherence/releases/tag/v0.8.0a1).

### Scope (v0.1)

- macOS / Linux / WSL2 — native Windows deferred to v0.2 (`fcntl` constraint, see below).
- Single workspace, single host — cross-machine and cross-vendor coverage are the hosted MCP roadmap (Path B), not this plugin.
- Warn-only, no auto-merge, no auto-revert.

### What you'll see

When the plugin detects a stale read, a warning appears in the agent's own context — invisible to you in the terminal by default. You'll notice it through agent behavior: the agent says "I see another session updated this, let me re-read" or similar before acting.

For visibility, run with `--include-hook-events --output-format stream-json` (debug mode):

```bash
claude --include-hook-events --output-format stream-json "your prompt"
```

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

| Version | Surface | When |
|---|---|---|
| **v0.1** | Private alpha. Direct install via `claude plugin install <git url>`. NO marketplace catalog listing. | 2026-05 |
| **v0.1.1** | Marketplace catalog enabling. Node MESI-subset coordinator collapses install to one-click. Hard 4-week deadline from v0.1 ship. | 2026-06 |
| **v0.2** | Strict mode (`permissionDecision: "deny"`) with retry counters + varied-reason templating. Polish for cohort 2 of discovery. | TBD |

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

## v0.1 known limitations

| Issue | Impact | When it matters |
|---|---|---|
| [Watchdog races (A6, A7)](https://github.com/hipvlady/agent-coherence-plugin/issues/1) | Stale reads can be silently suppressed under sustained concurrent load | Shared CI runners, stress tests, >10 parallel sessions. Not normal single-developer use. v0.1.1 design pass will close. |
| [Lifecycle hardening deferrals (L1–L5)](https://github.com/hipvlady/agent-coherence-plugin/issues/2) | Edge cases around `rm -rf .coherence/`, in-flight handler truncation, 30-process thundering herd, idle-shutdown stop semantics | Operational rare cases (CI fleets, manual `.coherence/` cleanup mid-session). Default single-developer interactive use unaffected. |
| Native Windows not supported | `fcntl` lock primitive is POSIX-only | Use WSL2 on Windows. v0.2 ships an `os.O_EXCL` fallback. |
| Strict mode (`permissionDecision: "deny"`) deferred to v0.2 | v0.1 warns but never blocks | Hard guardrails for "agent MUST re-read before edit" not available yet. Empirical retry-loop hazard on v2.1.131 forced this deferral. |
| HTTP-type hooks not viable on v2.1.131 (internal Phase E.0 probe 2A) | hooks.json URL templating fails strict-URL schema validation at load time | v0.1 ships command-type hooks via `agent-coherence-hook-client` — works on v2.1.131. If a future CC version supports URL templating, an HTTP-type variant can be added as a perf optimization. |
| `claude agents` subcommand not in coverage scope | The v2.1.131 subcommand is a management UI, not a session spawner; no PreToolUse hooks to capture | Use Agent View, multi-terminal, or Task-tool subagents (all in scope). If a future CC version exposes a session spawner via `claude agents`, file an issue and we'll re-probe coverage. |

## License

Apache-2.0. See [LICENSE](LICENSE).

## Links

- Underlying library: [hipvlady/agent-coherence](https://github.com/hipvlady/agent-coherence)
- Discovery / book a call: https://agent-coherence.dev/code
- Issue tracker: https://github.com/hipvlady/agent-coherence-plugin/issues
