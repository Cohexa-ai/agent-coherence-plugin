# Changelog

All notable changes to the `agent-coherence` Claude Code plugin are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions adhere to [SemVer 2.0](https://semver.org/spec/v2.0.0.html).

Alpha — APIs and the `hooks.json` wire shape may change before `v1.0`.

The canonical release-notes surface is [GitHub Releases](https://github.com/Cohexa-ai/agent-coherence-plugin/releases); this file mirrors that history in a structured format for operators who prefer a single browsable timeline.

## [Unreleased]

### Added

- **Zero-Python Node coordinator.** The Node backend is now self-sufficient — a fresh install on a machine with no Python yields a complete working setup: all six hooks via a Node hook-client, the `track`/`untrack`/`status` CLIs, five previously Python-only routes (`/hooks/pre-bash`, `/hooks/pre-grep`, `/hooks/post-edit-cas`, `/policy/track`, `/policy/untrack`), and **strict mode** at byte-parity with Python. A backend dispatcher selects the coordinator via `COHERENCE_COORDINATOR_BACKEND` or a `.coherence/coordinator_backend` file (default `python`, unchanged). `engines.node` is pinned to the Node ABI range with `better-sqlite3` prebuilts so `npm install` never needs node-gyp (hence Python).
- **Composite subagent identity (SB-25).** A Claude Code subagent's hook payload carries the parent's `session_id`; the coordinator now folds the payload's `agent_id` into a composite identity so subagents are first-class coherence peers — correct attribution, sibling-collision detection, and a `SubagentStop`-scoped grant release. Absent/malformed `agent_id` resolves to the parent identity (an absent OR malformed id on subagent-stop is a no-op, never a parent-scoped release).

### Fixed

- **subagent-stop could release the parent's grants on a malformed `agent_id`.** A present-but-malformed `agent_id` passed the client's non-empty check, was nulled server-side, and degraded to a parent-scoped release. The client now shape-validates the id (both Node and Python) and the coordinator fails closed on a present-but-invalid id.
- **A subagent's own just-committed file was strict-denied as a "foreign edit."** The self-commit-lag suppression compared a derived session string against the parent `session_id`; it now compares the raw writer identity against the caller's composite agent id (both backends).
- **ReDoS in the Bash tracked-path detector.** The Node port had dropped Python's negative-lookbehind, so an adversarial dot-free command drove near-quadratic regex backtracking that blocked the single-threaded coordinator; the lookbehind is restored.
- **Unbounded `git` calls in coordinator discovery.** `findCoordinatorRoot` now bounds every `git` invocation with a 5s timeout (matching Python), preserving the always-exit-0 fail-open contract when `git` hangs.
- **`artifactNamesUnderPrefix` directory-boundary bug.** A bare prefix over-matched sibling directories (`docs/specs` → `docs/specs-internal/`) and returned nothing for a `.` search root (silently skipping the whole pre-grep stale check); it now mirrors Python's normalization (empty/`.`/`./` → all; trailing-slash boundary; exact-match UNION).
- **Policy-path validation gaps + wire divergence.** `/policy/track`/`untrack` now reject control characters (closing a YAML newline-injection vector), leading backslash, and over-long paths, with rejection reason strings byte-identical to Python (both now corpus-guarded).
- **Cross-runtime migration-ledger collision on the shared `state.db` ([#55](https://github.com/Cohexa-ai/agent-coherence-plugin/issues/55)).** The Node coordinator now fails closed when it opens a `state.db` written under the sibling Python coordinator's ledger, instead of running its own v3 migration on it (which added `agent_states.deadline_tick` and stamped `user_version=3`, after which the Python coordinator refused to reopen its own store). Detection mirrors the Python guard: a foreign `registry_meta.schema_runtime` stamp, the Python-only `artifact_versions` table, or the Python `artifacts.owner_generation` fence column raise a typed `CrossRuntimeSchemaError` (`reason = "cross_runtime_schema"`) before any migration runs. Node now stamps `registry_meta.schema_runtime = "node"` on create and back-fills it on migrate, so detection is symmetric from both sides. `user_version == 1` remains indistinguishable by design (the Node v1 schema mirrors Python v1 byte-for-byte).

### Changed

- **Removed destructive `rm state.db` recovery advice.** Now that the shared store holds durable retained version content and live coordination state, the schema-mismatch error, the v2 shape-mismatch error, and the README troubleshooting rows no longer advise deleting `state.db` / `.coherence/`; the secret-rotation step removes only `.coherence/hook.secret`.

## [0.2.2] — 2026-06-02

**Docs/chore housekeeping — public-repo hygiene.** No runtime, hook, or packaged-artifact changes; the coordinator and all console scripts are unchanged. This release only adjusts what the public marketplace repo tracks and tidies the README.

### Changed

- README: split the console-scripts reference into slash-command vs. library-script surfaces, and corrected the version labels and license badge.

### Removed

- Dropped maintainer-internal material from public version control (kept locally): `CLAUDE.md`, `docs/BROAD_BETA.md`, `docs/BROAD_BETA_ANNOUNCEMENT.md`, `docs/RELEASE.md`, `docs/marketplace-listing-copy.md`, and `docs/demos/2026-05-17-stale-read-demo-script.md`. These are operational notes that should not ship in the public repo.

## [0.2.1] — 2026-05-26

**Operator-console shims + install-troubleshooting patch.**

### Added

- **PATH-resolver `bin/` shims** for the operator-facing console scripts (`agent-coherence-status`, `-track`, `-untrack`, `-migrate-deny`, `ensure-coordinator`), so bare invocations resolve even when the project virtualenv isn't active in the operator's shell. ([#43](https://github.com/hipvlady/agent-coherence-plugin/pull/43))

### Documentation

- README allowlist troubleshooting for the per-command permission prompts on the console scripts. ([#42](https://github.com/hipvlady/agent-coherence-plugin/pull/42))
- Bug 8 troubleshooting now points at the filed upstream issue (anthropics/claude-code#62616).

### Licensing

- Added the Apache-2.0 `LICENSE` file to back the manifest's license declaration. ([#30](https://github.com/hipvlady/agent-coherence-plugin/pull/30), [#31](https://github.com/hipvlady/agent-coherence-plugin/pull/31))

## [0.2.0] — 2026-05-24 (broad-beta launch)

**Broad-beta milestone.** The 2026-05-23 plan deepening flipped the v0.1.1 G12 alpha-cohort gating to "open broad beta with explicit risk acceptance" — v0.1.1 has been publicly installable from the marketplace catalog and no cohort blockers have surfaced via the catalog smoke installs. v0.2 ships strict mode atop that baseline.

### Added — strict mode

- **Per-artifact strict-mode opt-in** via `.coherence/strict_mode.yaml` (same shape as `tracked.yaml` + `ignored.yaml`). Intersection semantics with `tracked_paths` per KTD-O; a path is in strict mode iff it is tracked AND matches at least one strict-mode glob. Default empty preserves v0.1.1 warn-mode for every artifact.
- **Hook handler decision-flip** across all 4 PreToolUse handlers (Read, Edit / Write via shared `Edit|Write` matcher, Bash, Grep). When (strict + tracked + invalidated), the hook returns `permissionDecision: "deny"` with a static reason text byte-stable across retries per KTD-P / Phase 0 H1 falsification.
- **`TERMINAL_DENIAL_CLASSES` structural invariant** in the library coordinator — any code path emitting `permissionDecision: "allow"` must route through `emit_allow()` which refuses to convert strict-mode denials. Parameterized integration test + AST-based meta-test guard against future regression.
- **`agent-coherence-migrate-deny` console script** (v0.9.0+) — stricter sibling to v0.1.1's `agent-coherence-migrate-rules`. STDOUT-only (never writes settings.json), symlink-contained (canonical-path containment check refuses files outside the workspace root), never invokes an LLM. Under-emit bias: only canonical phrasings trigger.
- **Strict-mode telemetry** — `strict_mode_denials_total`, `strict_mode_routed_around_via_bash_total` (Phase 0 H4 routing pattern detector with 30s window), `audit_log_mode_drift_total` counters surfaced via `/status?detail=metrics`. Minimal denial-only audit log appended as JSONL to `.coherence/audit.log` (mode 0o600, no schema_version, no command bodies, no user content).

### Added — broad-beta launch package

- **README depth-parity overhaul** (149 → 335 lines) following the EveryInc/compound-engineering-plugin section sequence: Philosophy + Quick Example + expanded Commands table + Strict Mode + Architecture + Local Development + FAQ + About Contributions. Plugin README is the broad-beta launch surface for first-time operators.
- **`docs/BROAD_BETA.md`** — BB1-BB8 launch-readiness rubric (replaces the v0.1.1 G12 alpha-cohort hold), 14-day post-launch monitoring procedure, rollback runbook.
- **Canonical un-pinned install** — `/plugin marketplace add Cohexa-ai/agent-coherence-plugin` resolves to the latest published catalog tag. Pinned-version install (`@v0.2.0`) documented as the secondary path for operators who need version stability.
- **Public-feedback intake hardening** — 3 issue templates (bug / feature / install-troubleshooting), 4 seeded Discussion templates, `security@agent-coherence.dev` alias provisioned (closes the v0.1.1 SECURITY.md `TODO (v0.2)` item), CODE_OF_CONDUCT.md (Contributor Covenant 2.1), CONTRIBUTING.md (maintainer-curated PR posture, 72h triage SLA on bugs), PRIVACY.md (explicit no-telemetry).
- **`CHANGELOG.md` at repo root** (this file) — Keep-a-Changelog format, mirrors GitHub Releases for operators who want a single browsable timeline.

### Changed

- **`hook.secret` rotation is MANDATORY on v0.2 upgrade** per KTD-W. Secrets generated under v0.1.1's warn-mode threat model gate v0.2's strict-mode hard guardrails — inherited entropy is insufficient to bridge the upgrade. Documented in [docs/RELEASE.md](docs/RELEASE.md) section 4 and the README FAQ. Procedure: stop running `claude` sessions → `rm <repo>/.coherence/hook.secret` → restart any `claude` session, which lazy-spawns the coordinator and generates a fresh 32-byte secret.
- **`.claude-plugin/marketplace.json` description** — removed "Warn-only in v0.1.1" framing now that v0.2 ships strict mode.

### Backend compatibility

- **Strict mode is Python-coordinator-only in v0.2.** Workspaces using `coherence.coordinator_backend = "node"` stay warn-mode. v0.3 brings the strict-mode wire shape to the Node coordinator behind the multi-target converter plan.
- Library version requirement: `agent-coherence>=0.8.0` for warn mode; `agent-coherence>=0.9.0` for strict mode (the v0.9.0 library release ships the wire-shape additions).

### Known limitations

See the README [v0.2 known limitations](README.md#v02-known-limitations) table for the full list. Most-relevant for broad-beta operators:

- Native Windows still requires WSL2 (`fcntl` constraint).
- Bypass classes: interpreters outside the `bash_path_detector` list (`ruby -e`, `node -e`, `perl -pe`), shell-redirect reads (`tee < file`), and `diff /dev/null file` patterns can read strict-tracked artifacts. The migration helper closes the interpreter class via `permissions.deny`; shell-redirect and diff-as-reader are terminal limitations or v0.2.x backlog.

## [0.1.1] — 2026-05-23

**Marketplace cohort listing.** Promotes the v0.1.0-alpha.1 private alpha to a publicly-installable marketplace catalog entry. Single-command install via `/plugin marketplace add Cohexa-ai/agent-coherence-plugin@v0.1.1` + `/plugin install agent-coherence@agent-coherence`. Ships with full 78-finding ce-review remediation pass against the library.

### Added — Node MESI-subset coordinator

- **One-click marketplace install** via the Node coordinator backend (`coherence.coordinator_backend = "node"`). Mirrors the Python coordinator's HTTP wire contract; both backends share the `hook.secret` exchange and `server.pid` lazy-spawn semantics. Switch via `agent-coherence-coordinator --prepare-for-migration` for safe Python ↔ Node transitions.
- **Multi-tool hook routing (H4 mitigation)** — `hooks.json` matchers cover `Read`, `Edit|Write`, `Bash`, `Grep`. Closes the model-routing-around-Read pattern Phase 0 confirmed (model retries denied Read 2-5 times then falls back to `bash cat plan.md`).
- **AC-02 + AC-03 wire-shape parity** — Node and Python coordinators emit aligned `/status` shapes: `coordinator_uptime_seconds` (canonical name, full-word `_seconds` suffix), `sessions[].agent_name` + `sessions[].states` (per-agent MESI snapshot).

### Added — operator-facing tooling

- **`agent-coherence-status --self-test`** — post-install 4-step pre-read → pre-edit → post-edit → stale-pre-read smoke. Exit 0 on pass, 3 with actionable diagnostic on fail. The single-best signal that the install wired up hooks correctly.
- **`agent-coherence-coordinator --prepare-for-migration`** — atomic draining state that releases all M/E grants + rejects new pre-edit (HTTP 503) + shuts down. Eliminates silent data-loss races when switching Python ↔ Node backends.

### Security

- **Bearer-token auth** on every coordinator endpoint with constant-time comparison (`crypto.timingSafeEqual` / `hmac.compare_digest`). Token stored as `<repo>/.coherence/hook.secret` mode `0600`, created atomically via `O_WRONLY | O_CREAT | O_EXCL`.
- **Host-header allowlist** (`localhost` / `127.0.0.1` only) rejects DNS-rebinding from non-loopback origins before token comparison.
- **R12 three-tier `/status` disclosure** — default `minimal` tier is safe to paste in bug reports (no absolute paths, no PIDs, no session identifiers); `?detail=metrics` adds telemetry; `?detail=full` requires `Coherence-Local-Operator: true` opt-in header for the elevated tier.
- **R21 64KB request body cap** + **R11 bounded `O_EXCL` retry** on empty-secret recovery (fail-closed after 5 attempts).
- **CycloneDX SBOM** attached to every GitHub Release via `release.yml`.

### Plugin coexistence

- `package.json` is `"private": true` by design. Distribution is via the Claude Code marketplace catalog, not npm. The plugin is consumed via `/plugin marketplace add Cohexa-ai/agent-coherence-plugin@v0.1.1`, which clones the tagged Git ref directly.

## [0.1.0-alpha.1] — 2026-05-18

**Private alpha — direct-install (not marketplace catalog).**

Initial Python-coordinator-only release for the ~10 hand-picked alpha cohort. Two-step install (`pip install agent-coherence>=0.8.0a1` + `claude plugin install --from-dir <checkout>`). Plugin and library coexist in the cohort installer's environment.

### Added

- **Warn-only stale-read warnings** via the Python coordinator's `additionalContext` injection on PreToolUse (Read / Edit / Write surfaces; Bash / Grep added in v0.1.1).
- **Lazy-spawned local HTTP coordinator** at `<repo>/.coherence/` wrapping SQLite-WAL. 15-minute idle-shutdown; SQLite state rehydrates on next spawn.
- **MESI cache-coherence subset** — single-writer-multi-reader semantics on tracked artifacts. Cross-session invalidation on commit.
- **Phase 0 falsifiability experiment scaffolding** (`docs/probes/2026-05-19-ktd-e-falsifiability/`) — set the stage for the v0.2 strict-mode design (H4 confirmed, H1 + H3 falsified).
