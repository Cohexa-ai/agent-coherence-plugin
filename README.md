# agent-coherence (Claude Code plugin)

[![CI](https://github.com/hipvlady/agent-coherence-plugin/actions/workflows/ci.yml/badge.svg)](https://github.com/hipvlady/agent-coherence-plugin/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/release/hipvlady/agent-coherence-plugin)](https://github.com/hipvlady/agent-coherence-plugin/releases)
[![License](https://img.shields.io/github/license/hipvlady/agent-coherence-plugin)](LICENSE)
[![Library](https://img.shields.io/pypi/v/agent-coherence?label=agent-coherence)](https://pypi.org/project/agent-coherence/)

**Coherence for the prose subset of project rules that can't be expressed as policy.**

CLAUDE.md is your project's prose contract — what to track, what to escalate, what to never touch. Most of those rules can't be expressed as `permissions.deny` or `.claude/settings.json` because they're about *state*, not *tools*: "this spec is now v3, your branch is editing v1", "the planner reorganized the auth section while you weren't looking", "session B just committed a change to the file you're about to write." `agent-coherence` is the runtime layer that makes those state changes visible across parallel Claude Code sessions sharing the same workspace.

## Philosophy

**Worktrees prevent file collisions, not stale-spec collisions.** Two parallel Claude Code sessions can both read `plan.md` at v1, work independently in their per-session worktrees, and produce pull requests that reflect incompatible interpretations of v1 — even though the planner published v2 hours ago. The git surface stays clean; the model's understanding goes stale silently.

`agent-coherence` exists because that failure shape is structural — CLAUDE.md tool restrictions don't propagate to subagents, context compaction weakens rule adherence, and multi-session coordination has no platform-level synchronization primitive. Anthropic has confirmed this twice on the record: the official position is that **[hooks are the deterministic-behavior seam](#how-it-works)**, and CLAUDE.md / `.claudeignore` are guidance, not constraints. This plugin lives in that seam.

The design bias: surface stale state to the agent itself via `additionalContext`, let the agent decide. The agent reads the warning alongside the file and almost always re-reads before acting. The 2026-05-18 launch gate measured **100% re-read-or-acknowledged rate across N=80 trials**, zero ignored.

## What it does

Watches tracked artifacts (CLAUDE.md, AGENTS.md, `DECISIONS.md`, `docs/specs/`, `docs/plans/`, `docs/brainstorms/`, `plan.md` / `task.md` / `spec.md`) across:

- Agent View ✓
- Multi-terminal (multiple `claude` processes in the same workspace) ✓
- Task-tool subagents (subagent hooks fire under the parent's `session_id`; warnings surface to the parent's context) ✓

Verified against `claude` v2.1.131 (2026-05-17 via internal Phase E.0 probe). The `claude agents` subcommand on v2.1.131 is a management UI, not a session spawner — out of coverage scope.

When one session is about to act on an artifact another session has updated, the plugin injects a warning into the agent's own context via `additionalContext`. The agent sees:

> ⚠ Stale read: `docs/plans/feature-x.md` was updated by session `90b1dfd3` at `2026-05-23T13:42:18Z`. Current version is v3; you previously saw v1. Consider re-reading `docs/plans/feature-x.md` before acting on stale assumptions.

For tool-class rules that *can* be expressed as policy ("use rg, not grep"; "never sudo"; "no python -c"), run `agent-coherence-migrate-rules` or the stricter `agent-coherence-migrate-deny` — they propose `permissions.deny` entries derived from prose in CLAUDE.md. `permissions.deny` is structurally stronger than runtime hook denies: the runtime enforces it before the model can choose which tool to invoke.

**Validation signal:** [anthropics/claude-code#59309](https://github.com/anthropics/claude-code/issues/59309) (filed 2026-05-13) plus three documented duplicates (#40459, #19471, #29423) confirm the failure shape across 6 months. Anthropic's position is "use hooks" — that's exactly what this plugin does.

## Quick example

A typical cycle takes about 30 seconds. Set up the plugin in a workspace, then watch the agent re-read after a peer commit:

```text
# Terminal 1 (session A)
claude
> Read docs/plans/feature-x.md and summarize the steps.

# Terminal 2 (session B, same workspace)
claude
> Edit docs/plans/feature-x.md to add a "v2: dual-write migration" step at the top.
> (B's session commits the edit; coordinator invalidates A's cached view)

# Back to Terminal 1 (session A)
> Now implement the first step you summarized earlier.

# Agent A receives a stale-read warning in its own context:
#   ⚠ Stale read: docs/plans/feature-x.md was updated by session <B-short> at <ts>.
#   Re-read docs/plans/feature-x.md before acting on stale assumptions.
# Agent A re-reads the file first, sees the new v2 step, and revises its plan.
```

To watch the warning fire live (it's invisible by default — it goes into the agent's context, not your terminal):

```bash
claude --include-hook-events --output-format stream-json "Read docs/plans/feature-x.md"
```

## Commands

| Surface | What it does | When to use |
|---|---|---|
| `/agent-coherence:status` | Show tracked artifacts, current versions, sessions × MESI state | Daily sanity check; pre-commit verification |
| `/agent-coherence:track <path>` | Add a path to the coordinator's tracked set | When the operator wants stale-read coverage on a new file |
| `/agent-coherence:untrack <path>` | Remove a path from coordination | When the operator wants to silence warnings on intentionally-divergent files |
| `agent-coherence-coordinator` | Spawn / inspect the lazy-spawned local HTTP coordinator | Manual recovery; backend-switch via `--prepare-for-migration` |
| `agent-coherence-status` | CLI form of `/agent-coherence:status`; supports `--detail metrics` + `--self-test` | Post-install validation (`--self-test`); dashboard scraping (`--detail metrics`) |
| `agent-coherence-hook-client` | Subprocess called by the plugin's command-type hooks | Internal — not for direct invocation |
| `agent-coherence-migrate-rules` | Scan CLAUDE.md for prose tool-class rules; propose + optionally `--apply` `permissions.deny` entries | First-pass migration of `"use rg, not grep"`-style rules to enforceable policy |
| `agent-coherence-migrate-deny` *(v0.9.0+)* | Stricter sibling: STDOUT-only, symlink-contained, never invokes an LLM, never writes settings.json | Security-sensitive workspaces; CI-driven migration where auto-apply is not acceptable |

Slash commands shell out to the corresponding console scripts; calling the CLI directly works identically. `bin/ensure-coordinator` uses the same path internally.

## Getting started

After install (next section), the post-install validation step:

```bash
agent-coherence-status --self-test
```

Runs a four-step pre-read → pre-edit → post-edit → stale-pre-read sequence against a live coordinator. Exit 0 on pass; non-zero with an actionable diagnostic on fail. This is the single best signal that the install actually wired up the hooks correctly.

First-time experience: on your first Read of a tracked file in a workspace, you'll see no behavior change — the coordinator records the artifact in SQLite and grants your session a SHARED MESI state. The plugin only surfaces warnings when a *peer* session commits a change you haven't seen yet. Easiest way to test end-to-end: open two terminals in the same repo (sections [Quick example](#quick-example) above).

## Install

### Claude Code

```text
/plugin marketplace add hipvlady/agent-coherence-plugin
/plugin install agent-coherence@agent-coherence
```

The marketplace add resolves to the latest published release. To pin a specific version: `/plugin marketplace add hipvlady/agent-coherence-plugin@v0.2.0`.

You also need the Python library that provides the coordinator + hook client:

```bash
pip install "agent-coherence>=0.8.0"

# Verify the required console scripts landed on PATH
command -v agent-coherence-coordinator
command -v agent-coherence-hook-client
```

After install, restart any running `claude` sessions in your workspace so the new `SessionStart` hook fires.

> **Library compatibility.** `agent-coherence>=0.8.0` is the first stable PyPI
> release that ships `agent-coherence-coordinator` and `agent-coherence-hook-client`
> (the earlier `0.7.x` line was the LangGraph/CrewAI/AutoGen drop-in only). v0.2
> strict mode requires `agent-coherence>=0.9.0` once published; warn-mode (the
> default) works against `>=0.8.0`. Release page:
> [hipvlady/agent-coherence](https://github.com/hipvlady/agent-coherence/releases).

### Other targets (Cursor, Codex, Copilot, etc.)

**Not supported in v0.2.** The plugin's hook surface is Claude-Code-specific (`PreToolUse` / `PostToolUse` / `SessionStart` / `Stop` hook taxonomy from `hooks.json`). Multi-target support is tracked for v0.3 behind a converter-layer plan modeled on [EveryInc/compound-engineering-plugin](https://github.com/EveryInc/compound-engineering-plugin)'s `@every-env/compound-plugin` shape but adapted to the hook-coordinator architecture.

### Scope (v0.2)

- macOS / Linux / WSL2 — native Windows deferred (`fcntl` constraint, see v0.2 known limitations below).
- Single workspace, single-user, single-host workstation — not for shared developer machines, CI runners with multiple developers, or cross-host coordination. Cross-machine and cross-vendor coverage is the hosted MCP roadmap (Path B), not this plugin.

## Strict mode (v0.2)

By default, the plugin is **warn-only** — when a peer session has invalidated a tracked artifact, the agent receives a warning via `additionalContext` and decides whether to re-read. v0.1.1's measured 100% re-read-or-acknowledged rate (N=80) means warn mode is sufficient for most workspaces.

For operators who want a hard guardrail (typically: CI / multi-developer setups where the cost of a silent stale-edit is high), v0.2 ships **strict mode**: per-artifact opt-in via `.coherence/strict_mode.yaml` that flips `permissionDecision: "deny"` on stale-read attempts.

```yaml
# .coherence/strict_mode.yaml — same shape as tracked.yaml + ignored.yaml
- CLAUDE.md
- docs/plans/feature-x.md
- "docs/specs/**/*.md"
```

What happens when a strict + tracked artifact is read stale:

- The PreToolUse hook returns `{"hookSpecificOutput": {"permissionDecision": "deny", "permissionDecisionReason": "Stale read denied: ..."}}`.
- The model receives the deny + a static reason text. Per Phase 0 H1 falsification, the reason is byte-identical across retries (varied text actually *worsens* opus, which reads it as a prompt-injection pattern).
- The model exits its bounded retry loop (typically 2-5 attempts per Phase 0) and surfaces the deny to the operator.
- The agent's MESI state stays INVALID — retries see the same deny until the operator intervenes (re-reads via the Read tool to take a fresh SHARED grant).

**Strict mode is operator opt-in per artifact. Never global.** A literal `**` in `strict_mode_paths` triggers a startup warning (the coordinator counts matching tracked artifacts; default threshold is 50). The plugin will never silently lock down a workspace.

For tool-class restrictions (`grep` → `rg`, no `python -c`, no `sudo`), the structurally stronger primitive is `permissions.deny` at the configuration layer. `agent-coherence-migrate-deny` (v0.9.0+) is the security-hardened helper: STDOUT-only (never writes settings.json), symlink-contained (canonical-path containment check refuses files outside the workspace root), never invokes an LLM. Operator reviews the output and pastes into `.claude/settings.local.json`.

```bash
agent-coherence-migrate-deny --workspace . | jq
```

**Strict mode is Python-coordinator-only in v0.2.** Workspaces using the Node coordinator (via `coherence.coordinator_backend = "node"`) stay warn-mode. v0.3 brings the strict-mode wire shape to the Node coordinator behind the multi-target converter plan.

## Configuration

The coordinator creates `.coherence/` at your repo root automatically. Inside it:

| File | Purpose | Auto-gitignored |
|---|---|---|
| `state.db` | SQLite-WAL artifact state. Per-artifact MESI state, versions, SHA-256 content hashes. **Never** raw file content (KTD-13). | ✓ |
| `hook.secret` | Bearer token for hook auth, mode `0600`. 32 random bytes hex-encoded. | ✓ |
| `server.pid` | Coordinator process discovery (`<pid>\n<port>\nbackend=...\n`). | ✓ |
| `tracked.yaml` | Your opt-in patterns (gitignore-style globs). Commit if you want the tracked set to apply across team checkouts. | Operator's choice |
| `ignored.yaml` | Your opt-out patterns. Same. | Operator's choice |
| `strict_mode.yaml` *(v0.9.0+)* | Per-artifact strict-mode opt-in. Same shape. Same intersection semantics with `tracked_paths`. | Operator's choice |
| `audit.log` *(v0.9.0+)* | Append-only JSONL of strict-mode denial events. Mode `0600`. Denials only — no command bodies, no user content. | ✓ |

**Note on `allowedHttpHookUrls`**: hooks are *command-type* (the `agent-coherence-hook-client` subprocess makes the HTTP call internally), not Claude Code's HTTP-type hooks. The `allowedHttpHookUrls` Claude Code policy does NOT apply to this plugin — no allowlist changes are required to install.

## How it works

A lazy-spawned local HTTP coordinator at the parent repo root (`<repo>/.coherence/`) wraps a SQLite-WAL state store implementing the MESI cache-coherence protocol. Plugin hooks are **command-type** (not HTTP-type — Claude Code v2.1.131's hooks.json schema validator rejects URLs containing env-var templates at load time, per internal Phase E.0 probe 2A); each hook invokes `agent-coherence-hook-client` which reads `.coherence/server.pid` for the port + `.coherence/hook.secret` for the bearer token, then POSTs the hook payload to the coordinator. PreToolUse fires for every `Read`, `Edit`, `Write`, `Bash`, `Grep`; PostToolUse commits writes and triggers peer invalidations; Stop releases any uncommitted EXCLUSIVE grants at end-of-turn. All HTTP traffic is `127.0.0.1`-bound. Coordinator idle-shuts after 15 minutes; SQLite state rehydrates on next spawn.

## Architecture

Two processes:

- **Claude Code** (the host) — invokes the plugin's command-type hooks at every tool-use boundary.
- **Coordinator** (lazy-spawned subprocess at `<repo>/.coherence/`) — HTTP server bound to `127.0.0.1:<random>`, backed by SQLite-WAL. Implements a MESI cache-coherence subset over a small JSON wire contract.

Two coordinator backends:

- **Python** — canonical, full feature set. Ships in the `agent-coherence` library on PyPI. Has v0.2 strict mode.
- **Node** — MESI subset for one-click marketplace install. Ships in this plugin's `dist/`. Warn-mode only in v0.2.

Both backends speak the same HTTP wire contract; the [`tests/protocol_corpus/`](https://github.com/hipvlady/agent-coherence/tree/main/tests/protocol_corpus) suite in the library repo catches drift. Switch backends safely via `agent-coherence-coordinator --prepare-for-migration`. The canonical design lives in the library's `docs/plans/` directory.

## Local development

```bash
git clone https://github.com/hipvlady/agent-coherence-plugin
cd agent-coherence-plugin
npm ci
npm run build
npm test
```

To test your local checkout against your normal Claude Code session, add a shell alias:

```bash
alias cce='claude --plugin-dir ~/Code/agent-coherence-plugin'
```

Run `cce` instead of `claude` to load the local plugin alongside your production install. Your normal plugin install stays untouched.

For development against a pushed branch (review, cross-machine testing), point `--plugin-dir` at the worktree path:

```bash
git worktree add ~/Code/agent-coherence-plugin-pr feat/some-branch
claude --plugin-dir ~/Code/agent-coherence-plugin-pr
```

For protocol-corpus tests against both Python and Node backends:

```bash
cd ~/Code/agent-coherence       # the library checkout
npm run build --prefix ~/Code/agent-coherence-plugin
pytest -m protocol_corpus
```

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| Agents still hit stale-spec collisions silently | `pip install agent-coherence` step missed, or `agent-coherence-hook-client` not on PATH | Confirm `which agent-coherence-coordinator agent-coherence-hook-client` both resolve. If `pip install` succeeded but binaries aren't found, check that your shell's PATH includes the install prefix's `bin/` (e.g. `~/.local/bin` for user installs). |
| Plugin load failure / silent no-op | Coordinator backend not installed | Run `claude --include-hook-events --output-format stream-json "echo test"` and look for `plugin_errors` in the init event. If `hook-load-failed` appears, the plugin's hooks.json references commands not on PATH. |
| Stale-warning shown when worktrees just have different branches checked out | Filesystem-state semantics: divergent content on first observation surfaces as `hash_differs` (KTD-9) | Expected behavior. Add the path to `ignored.yaml` if the divergence is intentional. |
| Frequent acquire/release events in `agent-coherence-status` | Per-turn Stop-hook release of uncommitted grants. Normal end-of-turn behavior. | No action. Telemetry counter `intra_task_acquire_release_total` quantifies. |
| `state.db` corrupted | Power loss during WAL checkpoint, or SQLite version mismatch | `rm .coherence/state.db` — next coordinator spawn starts fresh |
| Coordinator process won't die | Stale `server.pid` after crash | `rm .coherence/server.pid` to clear the lock; next hook fires re-spawn |
| `hook.secret` compromised | Same-user attack or accidental leak | Stop all sessions, `rm -rf .coherence/`, restart Claude Code. v0.2.x will support hot rotation without restart. |
| *(v0.2 strict mode)* agent keeps retrying after strict deny | Expected. The model exits the retry loop after 2-5 attempts per Phase 0 finding. | No action — the deny IS the signal. The operator sees the deny in the transcript and can decide how to proceed. |
| *(v0.2 strict mode)* `agent-coherence-migrate-deny` exits with "NOT a descendant" | Symlink-containment check refused: the CLAUDE.md / AGENTS.md canonical path escapes the workspace root | Verify with `realpath CLAUDE.md`. If the symlink is intentional and points inside the workspace, the canonical-path check still rejects — the helper is intentionally strict. Use `agent-coherence-migrate-rules` for the looser flow. |

## v0.2 known limitations

| Issue | Impact | When it matters |
|---|---|---|
| Native Windows not supported | `fcntl` lock primitive is POSIX-only | Use WSL2 on Windows. v0.2.x ships an `os.O_EXCL` fallback. |
| Strict mode requires Python coordinator backend | Node coordinator stays warn-mode in v0.2 | Set `coherence.coordinator_backend = "python"` in plugin settings for any workspace using `strict_mode.yaml`. v0.3 brings strict mode to Node. |
| Hot `hook.secret` rotation not supported | v0.2 ships stop-rotate-restart procedure | If the secret is compromised, follow the troubleshooting row above. v0.2.x will add hot rotation. |
| Bypass class: interpreters not in detector list | `ruby -e`, `node -e`, `perl -pe < file` can read tracked-strict artifacts | Operator-supplied `permissions.deny` rule per language. The `bash_path_detector` is intentionally curated; obfuscated bypass is documented as out-of-scope. |
| Bypass class: shell-redirect reads | `tee /dev/null < tracked.md` reads the file but isn't a `cat tracked.md` invocation | **NOT closed by `permissions.deny`** (no platform syntax for shell-redirect file arguments). Terminal limitation. |
| Bypass class: diff-as-reader | `diff /dev/null tracked.md` reads the file content | Adding `diff`/`cmp` to `bash_path_detector` list is on the v0.2.x backlog. |
| HTTP-type hooks not viable on v2.1.131 (internal Phase E.0 probe 2A) | hooks.json URL templating fails strict-URL schema validation at load time | v0.2 ships command-type hooks via `agent-coherence-hook-client` — works on v2.1.131. If a future Claude Code version supports URL templating, an HTTP-type variant can be added as a perf optimization. |
| `claude agents` subcommand not in coverage scope | The v2.1.131 subcommand is a management UI, not a session spawner; no PreToolUse hooks to capture | Use Agent View, multi-terminal, or Task-tool subagents (all in scope). |
| Single-user, single-host workstation only | Trust boundary is the OS user; `hook.secret` mode 0600 is the load-bearing fence | Not suitable for shared developer machines, CI runners with multiple developers, or cross-host coordination. |

### Resolved in v0.2

- **Strict mode** (`permissionDecision: "deny"`) per Phase 0 H4 routing-confirmation. Per-artifact opt-in via `.coherence/strict_mode.yaml`. Multi-tool surface (Read / Edit / Write / Bash / Grep) prevents the model from routing around denied Read via `bash cat plan.md`.
- **`TERMINAL_DENIAL_CLASSES` structural invariant** — code paths emitting `permissionDecision: "allow"` route through a single `emit_allow` helper that refuses to convert strict-mode denials. Parameterized integration test + AST-based meta-test guard against future regression.
- **`agent-coherence-migrate-deny` CLI** — STDOUT-only, symlink-contained sibling to v0.1.1's `agent-coherence-migrate-rules`.
- **Strict-mode telemetry** — `strict_mode_denials_total`, `strict_mode_routed_around_via_bash_total`, `audit_log_mode_drift_total` counters in `/status?detail=metrics`. Minimal denial-only `.coherence/audit.log` JSONL surface.
- **Cross-implementation protocol corpus** — Python ↔ Node coordinator wire-shape parity tests in the library repo, run as a dedicated CI job.

## FAQ

### Do I need to opt every file into strict mode?

No. Strict mode is per-artifact opt-in via `.coherence/strict_mode.yaml`. Most operators leave it empty — warn mode (the default for every tracked artifact) measured 100% re-read-or-acknowledged in the N=80 launch gate. Strict mode is for the small set of artifacts where the cost of a silent stale-edit is unacceptable.

### Does it phone home?

No. The plugin makes **zero outbound HTTP requests**. The coordinator binds only to `127.0.0.1` and never connects to any external service. `agent-coherence-status` is the only telemetry surface and it is operator-pulled, never plugin-pushed. See [PRIVACY.md](PRIVACY.md) for the full statement.

### Why isn't it on npm?

The plugin's `package.json` is `"private": true` by design. Distribution is via the Claude Code marketplace catalog, not npm. Marketplace install is one-click; npm publication would just be a redundant distribution channel. Revisit if v0.3 multi-target work needs npm as a distribution surface for the converter-layer.

### Can I use it with Cursor / Codex / Copilot?

Not in v0.2. The plugin's hook surface is Claude-Code-specific. Multi-target support is tracked for v0.3 behind a converter-layer plan. The closest reference shape is [EveryInc/compound-engineering-plugin](https://github.com/EveryInc/compound-engineering-plugin), which ships skills + agents (not hooks) and uses a Bun-based converter.

### How do I upgrade from v0.1.1?

Two steps:

1. **Rotate the `hook.secret`.** v0.1.1 secrets were generated under the warn-mode threat model; v0.2's strict-mode hard guardrails warrant a fresh secret. Procedure: stop any running `claude` sessions in your workspace → `rm <repo>/.coherence/hook.secret` → restart any `claude` session, which lazy-spawns the coordinator and generates a fresh secret. Documented as **mandatory** in [docs/RELEASE.md](docs/RELEASE.md).
2. **Bump the plugin install.** `/plugin install agent-coherence@agent-coherence` re-resolves the latest published tag from the marketplace catalog.

Strict mode is opt-in — your existing workspaces stay warn-only until you add patterns to `.coherence/strict_mode.yaml`.

### Where do I see all the operator commands?

See the [Commands](#commands) table above. Slash commands shell out to the corresponding console scripts the library installs.

### How do I report a security issue?

See [SECURITY.md](SECURITY.md). Preferred channel is GitHub's "Report a vulnerability" feature on the [security tab](https://github.com/hipvlady/agent-coherence-plugin/security); fallback is `security@agent-coherence.dev`. 72h response-time SLA.

### Where is release history?

[GitHub Releases](https://github.com/hipvlady/agent-coherence-plugin/releases) is the canonical surface. [CHANGELOG.md](CHANGELOG.md) at the repo root mirrors it in Keep-a-Changelog format.

## About Contributions

PRs are welcome. The posture is **maintainer-curated**, not auto-merge:

- Bug reports + reproductions: 72h triage SLA. Use the [bug report template](.github/ISSUE_TEMPLATE/bug_report.md).
- Feature requests: no SLA. Use the [feature request template](.github/ISSUE_TEMPLATE/feature_request.md) or open a [GitHub Discussion](https://github.com/hipvlady/agent-coherence-plugin/discussions) to talk it through first.
- Install-troubleshooting questions: use the [install-troubleshooting template](.github/ISSUE_TEMPLATE/install_troubleshooting.md) — it asks for the diagnostic info that lets the maintainer repro in <5 min.
- PRs: reviewed via `gh pr view` + Claude-assisted review (mirror of the workflow this repo uses on its own changes). Expect 1-3 review cycles before merge; never auto-merged. Include tests for new behavior, update tests for changed behavior.

See [CONTRIBUTING.md](CONTRIBUTING.md) for the pre-PR checklist + branching convention. [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md) (Contributor Covenant 2.1) applies to all participants in Issues / Discussions / PRs.

## Release

Per-release procedure is documented in [docs/RELEASE.md](docs/RELEASE.md) (operator runbook — pre-flight setup, version bump, tag push, hot-fix path). Releases follow [SemVer 2.0](https://semver.org/spec/v2.0.0.html); the canonical version-tag history is in [CHANGELOG.md](CHANGELOG.md).

The broad-beta launch-readiness rubric (BB1-BB8 gates that must clear before each tag push) is in [docs/BROAD_BETA.md](docs/BROAD_BETA.md).

## License

Apache-2.0. See [LICENSE](LICENSE).

## Links

- Underlying library: [hipvlady/agent-coherence](https://github.com/hipvlady/agent-coherence)
- Discovery / book a call: [agent-coherence.dev/plugin](https://agent-coherence.dev/plugin)
- Issue tracker: [github.com/hipvlady/agent-coherence-plugin/issues](https://github.com/hipvlady/agent-coherence-plugin/issues)
- Discussions: [github.com/hipvlady/agent-coherence-plugin/discussions](https://github.com/hipvlady/agent-coherence-plugin/discussions)
- Security: [SECURITY.md](SECURITY.md)
- Privacy: [PRIVACY.md](PRIVACY.md)
- Contributing: [CONTRIBUTING.md](CONTRIBUTING.md)
- Code of Conduct: [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md)
