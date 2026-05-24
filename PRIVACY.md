# Privacy

**The `agent-coherence` Claude Code plugin does not transmit any data off your machine.** This document is the explicit privacy statement that the broad-beta launch surface relies on.

## What the plugin does NOT do

- **No phone home.** The plugin makes zero outbound HTTP requests in v0.2.x. The coordinator binds only to `127.0.0.1` and never connects to any external service.
- **No usage analytics.** No counts of how often you invoke a hook, what files you track, which strict-mode patterns you set, which models you use, or anything else is ever transmitted off your machine.
- **No error reporting service.** Errors land in your local `.coherence/` logs and (if a crash happens) the Claude Code session's normal log surface. Nothing is sent to Sentry / Bugsnag / Rollbar / any external telemetry collector.
- **No third-party tracking.** No analytics SDKs are bundled. No CDN-loaded resources. No fingerprinting.

If you ever observe an outbound network request originating from the plugin or the spawned coordinator, **that's a bug** — please report it via `security@agent-coherence.dev` or the [GitHub security tab](https://github.com/hipvlady/agent-coherence-plugin/security).

## What the plugin DOES touch (all local)

| Surface | Where it lives | What's in it |
|---|---|---|
| Coordinator socket | `127.0.0.1:<random>` — loopback only | HTTP requests from the hook client to the local coordinator. Never reaches the network interface. |
| `.coherence/state.db` | `<repo>/.coherence/state.db` | Per-artifact MESI state, version numbers, SHA-256 content hashes (`content_hash`). **Never** raw file content (KTD-13 invariant). |
| `.coherence/hook.secret` | `<repo>/.coherence/hook.secret` | 32-byte random bearer token, file mode `0o600`. Authenticates the hook client to the coordinator. Never transmitted off your machine. |
| `.coherence/server.pid` | `<repo>/.coherence/server.pid` | Coordinator process discovery (`<pid>\n<port>\nbackend=node|python\n`). Read by the hook client to find the coordinator. |
| `.coherence/tracked.yaml` / `ignored.yaml` / `strict_mode.yaml` | `<repo>/.coherence/` | Operator-authored glob patterns. Optional. Commit if you want them to apply across team checkouts. |
| `.coherence/audit.log` *(v0.2+)* | `<repo>/.coherence/audit.log` | Append-only JSONL of strict-mode denial events. Mode `0o600`. Per-event payload: ISO timestamp, artifact path, session UUID, tool surface name, decision marker (`"strict_deny"`). **No** command bodies, **no** user content, **no** content hashes. |

All of the above stays on your local disk. The `.coherence/` directory is auto-gitignored so a careless `git add .` doesn't commit it.

## `agent-coherence-status` is operator-pulled, not plugin-pushed

The only telemetry surface is the `/status` endpoint on the local coordinator, exposed via:

- `agent-coherence-status` (or `agent-coherence-status --detail metrics` for the metrics tier)
- Slash command `/agent-coherence:status` (which shells out to the same console script)

The plugin never pushes telemetry. The operator pulls it on demand. The `?detail=minimal` tier (default) is safe to paste in bug reports — no absolute paths, no PIDs, no session identifiers. The `?detail=full` tier requires the `Coherence-Local-Operator: true` header to opt into the elevated disclosure (workspace root, coordinator PID).

## What you choose to share

If you open a bug report or paste `--detail metrics` output in a Discussion, *you* are choosing to share that information with the maintainer + anyone reading the public thread. The plugin doesn't make that choice for you. The default-minimal `/status` shape is designed to be safe-to-share so that operator-driven debugging doesn't accidentally leak workspace structure.

The strict-mode `.coherence/audit.log` (v0.2+) records denial events. Pasting an audit-log window in a bug report shares the **paths** of the artifacts that hit a strict-deny + the **timestamps** + the **session UUIDs** + the **tool surface** (Read / Edit / Write / Bash / Grep). It does NOT share the file contents, command bodies, or any model output. If the artifact path itself is sensitive (e.g., reveals an internal project name), redact it before sharing.

## Coordinator backends

| Backend | What's at the trust boundary |
|---|---|
| Python (`coherence.coordinator_backend = "python"`) | The Python coordinator process runs as the same OS user as your `claude` session. Loopback HTTP only. SQLite-WAL writes only to `<repo>/.coherence/state.db`. |
| Node (`coherence.coordinator_backend = "node"`) | The Node coordinator process runs as the same OS user. Same loopback-HTTP constraint. Same SQLite-WAL surface (via `better-sqlite3`). |

Both backends have identical privacy properties. The choice is operational (which language runtime is on your machine), not privacy-relevant.

## Cross-host / cross-vendor coordination

Cross-machine and cross-vendor coverage (multiple workstations, or Cursor + Claude Code on the same workstation) is the **hosted MCP roadmap** (Path B), not this plugin. This plugin is single-host single-user by design. If you eventually use the hosted MCP service, it will ship a separate privacy statement covering its own data-handling surface — this document covers only the plugin.

## Updates to this document

Material changes to data handling will land in the [CHANGELOG.md](CHANGELOG.md) `Security` subsection of the relevant release. The "no phone home" invariant is locked — any change that would add outbound network traffic requires a major version bump (≥1.0.0) and an explicit opt-in.
