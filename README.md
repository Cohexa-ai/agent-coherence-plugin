# agent-coherence (Claude Code plugin)

**Status: v0.1 private alpha** (active build, started 2026-05-13). Marketplace catalog listing is held until v0.1.1 (Node MESI-subset coordinator, hard 4-week deadline from v0.1 ship). See [release sequence](#release-sequence) below.

## What it does

Surfaces stale-spec collisions across parallel Claude Code sessions sharing a workspace.

Two parallel sessions can read the same `plan.md` at v1, work independently in their per-session worktrees, and produce PRs that reflect incompatible interpretations because the planner already published v2. Worktrees prevent direct file collisions but not stale-spec collisions.

This plugin watches tracked artifacts (CLAUDE.md, AGENTS.md, `docs/specs/`, `docs/plans/`, `docs/brainstorms/`, `plan.md`/`task.md`/`spec.md`) across Agent View, `claude agents`, and multi-terminal sessions. When one session is about to act on an artifact another session has updated, the plugin injects a warning into the agent's own context via `additionalContext`. The agent reads the warning alongside the file and decides what to do — typically re-read before acting.

**v0.1 ships warn-only.** Strict mode (`permissionDecision: "deny"`) is deferred to v0.2 — empirical testing showed it needs per-(session, path) retry counters and varied-reason templating to avoid model retry loops.

**Validation signal**: [anthropics/claude-code#59309](https://github.com/anthropics/claude-code/issues/59309) (filed 2026-05-13) plus three documented duplicates (#40459, #19471, #29423 over 6 months) confirm the failure shape and that Anthropic isn't fixing it at the platform layer.

## Install (v0.1 private alpha — invite-only)

v0.1 is an **alpha**. ~10 hand-picked installers from discovery calls and ecosystem engagements. Two steps for v0.1; collapses to one-click in v0.1.1 (Node rewrite).

```bash
# Step 1 — install the Python library that provides the coordinator console script
pip install agent-coherence

# Step 2 — install this Claude Code plugin
claude plugin install git@github.com:hipvlady/agent-coherence-plugin.git
```

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

A lazy-spawned local HTTP coordinator at the parent repo root (`<repo>/.coherence/`) wraps a SQLite-WAL state store implementing the MESI cache-coherence protocol. PreToolUse hooks POST to the coordinator on every `Read`, `Edit`, `Write`; PostToolUse hooks commit writes and trigger peer invalidations; the Stop hook releases any uncommitted EXCLUSIVE grants at end-of-turn. All HTTP traffic is `127.0.0.1`-bound with shared-secret Bearer auth (`.coherence/hook.secret`, mode `0600`). Coordinator idle-shuts after 15 minutes; SQLite state rehydrates on next spawn. See the underlying library: [agent-coherence](https://github.com/hipvlady/agent-coherence).

## Commands

| Slash command | Description |
|---|---|
| `/agent-coherence status` | Show tracked artifacts, current versions, sessions × MESI state |
| `/agent-coherence track <path>` | Add a path to the coordinator's tracked set |
| `/agent-coherence untrack <path>` | Remove a path from coordination |

## Configuration

The coordinator creates `.coherence/` at your repo root automatically. Inside it:

- `state.db` — SQLite-WAL artifact state. Auto-gitignored.
- `hook.secret` — Bearer token for hook auth, mode `0600`. Auto-gitignored.
- `tracked.yaml` — your opt-in patterns (gitignore-style globs). Commit this if you want the tracked set to apply across team checkouts.
- `ignored.yaml` — your opt-out patterns. Same.

**Note**: hooks fire HTTP requests to `http://127.0.0.1:<port>/...`. If your organization enforces `allowedHttpHookUrls`, you may need to allowlist `http://127.0.0.1:*/*` in your Claude Code settings.

## Release sequence

| Version | Surface | When |
|---|---|---|
| **v0.1** | Private alpha. Direct install via `claude plugin install <git url>`. NO marketplace catalog listing. | 2026-05 |
| **v0.1.1** | Marketplace catalog enabling. Node MESI-subset coordinator collapses install to one-click. Hard 4-week deadline from v0.1 ship. | 2026-06 |
| **v0.2** | Strict mode (`permissionDecision: "deny"`) with retry counters + varied-reason templating. Polish for cohort 2 of discovery. | TBD |

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| Agents still hit stale-spec collisions silently | `pip install agent-coherence` step missed | Confirm `which agent-coherence-coordinator` resolves on PATH |
| Hook traffic blocked | `allowedHttpHookUrls` policy excludes localhost | Allowlist `http://127.0.0.1:*/*` in Claude Code settings |
| Stale-warning shown when worktrees just have different branches checked out | Filesystem-state semantics: divergent content on first observation surfaces as `hash_differs` (KTD-9) | Expected behavior. Add the path to `ignored.yaml` if the divergence is intentional. |
| Frequent acquire/release events in `agent-coherence-status` | Per-turn Stop-hook release of uncommitted grants. Normal end-of-turn behavior, not a bug. | No action. Telemetry counter `intra_task_acquire_release_count` will quantify this in v0.1.1. |
| `state.db` corrupted | Power loss during WAL checkpoint, or SQLite version mismatch | `rm .coherence/state.db` — next coordinator spawn starts fresh |
| Coordinator process won't die | Stale `server.pid` after crash | `rm .coherence/server.pid` to clear the lock, next hook fires re-spawn |
| `hook.secret` compromised | Same-user attack or accidental leak | Stop all sessions, `rm -rf .coherence/`, restart any Claude Code session. v0.2 will support hot rotation without restart. |

## v0.1 known limitations

| Issue | Impact | When it matters |
|---|---|---|
| [Watchdog races](docs/known-issues/2026-05-17-watchdog-races.md) (A6, A7) | Stale reads can be silently suppressed under sustained concurrent load | Shared CI runners, stress tests, >10 parallel sessions. Not normal single-developer use. v0.1.1 design pass will close. |
| Native Windows not supported | `fcntl` lock primitive is POSIX-only | Use WSL2 on Windows. v0.2 ships an `os.O_EXCL` fallback. |
| Strict mode (`permissionDecision: "deny"`) deferred to v0.2 | v0.1 warns but never blocks | Hard guardrails for "agent MUST re-read before edit" not available yet. Empirical retry-loop hazard on v2.1.131 forced this deferral. |
| `claude agents` background sessions untested | Hooks may or may not fire from background subprocess sessions | Smoke test deferred to alpha installer feedback. If you use `claude agents` and the coordinator doesn't see those sessions, [file an issue](https://github.com/hipvlady/agent-coherence-plugin/issues). |

## License

Apache-2.0. See [LICENSE](LICENSE).

## Links

- Underlying library: [hipvlady/agent-coherence](https://github.com/hipvlady/agent-coherence)
- Discovery / book a call: https://agent-coherence.dev/code
- Issue tracker: https://github.com/hipvlady/agent-coherence-plugin/issues
