# Cross-host coherence: prior-art survey

**Status:** Research note. No implementation commitment; nothing here changes v0.5.0 behavior.
**Date:** 2026-08-28
**Question:** Which existing open-source projects have already solved the parts of cross-host coherence this plugin would need, and what should be read rather than rebuilt?

Cross-host coordination is explicitly out of scope for the plugin ([SECURITY.md](../../SECURITY.md), "Out of scope"; [PRIVACY.md](../../PRIVACY.md)) and routed to the hosted MCP roadmap (Path B). This note is input to that roadmap, not a proposal to widen the plugin.

---

## 0. Negative result: `pi-subagents` is not a cross-host pattern

This branch started from the question of whether the `pi` coding agent's subagent extension could be used as a cross-hosting reference. It cannot.

- `pi` itself ships **no** subagents. The subagent layer is [`tintinweb/pi-subagents`](https://github.com/tintinweb/pi-subagents), a third-party extension (~1k stars, 213 forks) — real traction inside `pi`'s ecosystem, not a broadly deployed platform.
- Subagents run as isolated sessions **inside the same `pi` process**, background by default, queued against a concurrency limit.
- Persistence is the local filesystem: `.pi/subagent-*`, transcripts under `$TMPDIR/pi-subagents-<uid>/…`.
- The "cross-extension RPC" (`subagents:rpc:spawn|stop|consume` over `pi.events`) is an **in-process event bus** so other `pi` extensions can drive subagents without importing the package. Cross-*extension*, not cross-*host*. No sockets, no shared database, no remote execution.

Search summaries conflate "cross-extension" with "cross-host". They are unrelated.

The one transferable idea: isolated runs use **git worktrees with auto-commit-on-completion**, so state hands off through git rather than through the bus. Git is already a distributed protocol, so that pattern does survive a host boundary. Nothing else does.

---

## 1. The invariant that does not survive a host boundary

The correctness argument today rests on a **single serialization point**: one SQLite file, WAL, one loopback coordinator.

| Local mechanism | Where | What breaks cross-host |
|---|---|---|
| Single-writer MESI invariant | `checkSingleWriter` in [`src/invariants.ts`](../../src/invariants.ts), enforced inside the same `BEGIN IMMEDIATE` as the mutation ([`src/registry.ts`](../../src/registry.ts)) | `BEGIN IMMEDIATE` stops buying mutual exclusion. It becomes distributed mutual exclusion. |
| Loopback-only bind | `BIND_HOST = "127.0.0.1"` ([`src/server.ts:41`](../../src/server.ts)), locked code-level invariant, no operator override ([`src/coordinator.ts`](../../src/coordinator.ts)) | The invariant is the security model. Removing it removes the model. |
| Shared-secret auth | `hook.secret` mode 0600 + Host-header allowlist ([`src/auth.ts`](../../src/auth.ts)) | Works because the filesystem *is* the trust boundary. No shared FS across hosts; the DNS-rebinding allowlist becomes meaningless. |
| Agent identity | `sessionToAgentId` = uuid5 over `ccs-agent:claude-session-<sid>[:subagent-<subid>]` ([`src/agent_id.ts`](../../src/agent_id.ts)) | No host component. Cannot distinguish two hosts, cannot locate an agent. Identity must become `(host, session, subagent)`. The coordinator already *logs* `hostname()` without folding it in. |
| Liveness | `heartbeats(agent_id, last_tick)` ([`src/migrations/v1_initial.ts`](../../src/migrations/v1_initial.ts)) + `agent_states.deadline_tick` ([`src/migrations/v3_watchdog_deadline.ts`](../../src/migrations/v3_watchdog_deadline.ts)) | A dead pid is locally observable. Across hosts, crash and partition are indistinguishable — needs lease expiry plus a fencing token, not liveness detection. |
| Staleness comparand | `agent_states.last_observed_version` ([`src/migrations/v4_last_observed.ts`](../../src/migrations/v4_last_observed.ts)) | Already a degenerate per-agent version vector. This is the piece that generalizes most cleanly. |

**The seam that matters.** The advisory path (`additionalContext`, no `permissionDecision` — enforced by the type union in [`src/hook_payloads.ts`](../../src/hook_payloads.ts)) and the strict path (`permissionDecision: "deny"`, per-artifact `strict_mode.yaml`) have *different* distributed requirements:

- **Advisory needs no consensus.** Version vectors over a gossip or pull layer suffice, and it degrades correctly under partition: a warning is missed, the agent re-reads anyway.
- **Strict needs real distributed exclusion.** A deny that is wrong under partition either blocks legitimate work or admits two writers.

Splitting cross-host work along that seam is the highest-leverage decision available. It permits shipping cross-host advisory coherence long before cross-host strict mode is solved.

---

## 2. Tier 1 — The registry going cross-host

### [`vlcn-io/cr-sqlite`](https://github.com/vlcn-io/cr-sqlite) — CRDT SQLite (3.8k ★, 48 open issues)

Closest structural match to the advisory tier. Opt a table in with `SELECT crsql_as_crr('table')`; causality tracked via `site_id` + `col_version`/`db_version` + `cl`/`seq`.

- **Read:** how `crsql_as_crr` rewrites schema. Our `src/migrations/` would need the same shape.
- **Watch:** commit history runs Dec 2023 → Jun 2024, then a **~26-month gap**, then resumes Aug 2026 (latest 2026-08-10, macOS/Android packaging fixes). Alive, but the gap is a real dependency risk.
- **Limits the authors state:** CRR inserts are 2.5× slower than plain SQLite inserts (reads unchanged); counter and rich-text CRDTs "still being implemented"; "Approach 2" — the causal event log with *configurable conflict resolution*, which is what a coherence protocol actually wants — is deferred to v2 and unimplemented.
- **Verdict:** read the design; do not take the dependency yet.

### [`rqlite`](https://rqlite.io/docs/faq/) / [`dqlite`](https://canonical.com/lxd/docs/latest/reference/dqlite-internals/) / LiteFS — consensus SQLite

The strict tier. rqlite (Go, single binary) has the most candid documentation of the three and is explicit that it is "a distributed database, not a replication system." dqlite uses C-Raft and is battle-tested inside LXD. LiteFS is FUSE-based and uses Consul for leader election — verify its current maintenance status before betting on it.

**The learning:** all three converge on *single writer (leader), read-only replicas*. That is `checkSingleWriter` lifted to a cluster. They chose leadership over multi-writer specifically to avoid what cr-sqlite must do. Our fork in the road, already explored twice, by people who wrote down why.

---

## 3. Tier 2 — Leases and fencing (cross-host strict mode)

### [Jepsen: etcd 3.4.3](https://jepsen.io/analyses/etcd-3.4.3) + [etcd-io/etcd#11456](https://github.com/etcd-io/etcd/issues/11456)

**Highest-value single read on this list.**

Kingsbury reliably induced the loss of **~18% of acknowledged updates** using etcd mutexes with 2s lease TTLs against processes pausing every 5s. Cause: the lock API did not re-check lease validity after waiting on a contended lock, so a client could be told it held a lock whose lease had already expired.

This is precisely the failure `deadline_tick` walks into once hosts are separated: a paused agent resumes and commits against an expired grant. Locally we are safe because a dead pid is observable.

**The pattern to adopt:** leases establish ownership; **fencing tokens enforce it at the resource**. etcd uses the revision number as the token. `checkSingleWriter` is our resource-layer validator — cross-host it must accept and compare a monotonic token, not merely inspect a post-mutation state map. Read `clientv3/concurrency` (Session/Mutex) alongside the Jepsen report.

---

## 4. Tier 3 — Cross-host conflict detection, already specified

### [Syncthing Block Exchange Protocol v1](https://docs.syncthing.net/specs/bep-v1.html)

The cleanest published spec of the advisory tier. Version vector entries are `(first 64 bits of device ID, counter)`; `(Folder, Name, Version)` uniquely identifies content at a point in time; genuine divergence (`[A:2,B:1]` vs `[A:1,B:2]`) saves the loser as `.sync-conflict-*` rather than guessing a winner. Our advisory warnings are this, minus the file materialization.

### [Mutagen](https://mutagen.io/documentation/synchronization/)

Three-way merge against the last agreed-upon ancestor, in short cycles triggered by filesystem change. Also built for *remote, ephemeral* sync over SSH — the transport story a cross-host coordinator needs. [Issue #42](https://github.com/mutagen-io/mutagen/issues/42) (open since 2018) documents why "just declare a canonical endpoint" is harder than it looks.

### [Automerge](https://github.com/automerge/automerge)

Sync protocol ([arXiv:2012.00472](https://arxiv.org/abs/2012.00472)) keeps per-peer state tracking the other side's heads plus in-flight messages, with V1/V2 message encodings so first sync is cheap. Relevant if we gossip version vectors rather than centralizing them.

---

## 5. Tier 4 — LSP, the cheapest high-signal analogue

[LSP](https://microsoft.github.io/language-server-protocol/specifications/lsp/3.17/specification/) already ships a mature advisory-staleness protocol with our exact design: monotonic per-document version integers, servers discarding stale results by version correlation. See [#584 "Protocol consistency guarantees are subtly incorrect"](https://github.com/microsoft/language-server-protocol/issues/584) and [#229](https://github.com/Microsoft/language-server-protocol/issues/229).

**The caution to extract:** the documented failure mode is a client that does *not* increment the version, which silently breaks the server's stale-discard logic — see [anthropics/claude-code#64239](https://github.com/anthropics/claude-code/issues/64239) for a live instance. Any cross-host peer that under-reports `last_observed_version` degrades our warnings to silence, and nothing in the protocol detects it. That argues for making version reporting **verifiable rather than trusted** — a direction our existing cross-runtime lineage stamp (`CROSS_RUNTIME_SCHEMA_REASON`, [`src/migrations.ts`](../../src/migrations.ts)) already gestures at.

---

## 6. Tier 5 — Agent-domain neighbors (watch, do not copy)

[`smtg-ai/claude-squad`](https://github.com/smtg-ai/claude-squad) (~5.8k ★; tmux + worktrees + TUI), [`dagger/container-use`](https://github.com/dagger/container-use) (4k ★, 47 open issues; MCP server + Dagger containers + git branches), [`nwiizo/ccswarm`](https://github.com/nwiizo/ccswarm), Crystal, Vibe Kanban, Conductor.

**The learning is negative, and it is the useful kind.** The ecosystem converged on git worktrees as *the* isolation primitive within roughly eighteen months and stopped there. container-use's README does not address what happens when agents work on overlapping state — isolation *is* the entire answer on offer. This is the gap the plugin fills, and it means the cross-host mechanism must be borrowed from distributed systems, not from agent tooling.

Their open issues are, in effect, a free requirements document for where isolation-only breaks down.

---

## 7. Tier 6 — Path B (hosted coordinator)

[Temporal's LangGraph plugin](https://temporal.io/blog/temporal-langgraph-plugin-durable-execution) and the surrounding "checkpoints are not durable execution" argument. The framing that matters: a LangGraph run lives in one process, so if the process dies the run dies with it; checkpointers save state *between* nodes, not *inside* one.

**Implication for Path B:** if a hosted coordinator holds grants, grant *release* needs durable-execution semantics. Otherwise a crashed host leaks an `EXCLUSIVE` indefinitely and no amount of heartbeating recovers it cleanly — the release path, not the acquire path, is where the durability requirement lands.

---

## 8. Reading order

1. [Jepsen: etcd 3.4.3](https://jepsen.io/analyses/etcd-3.4.3) — why the lease/watchdog design fails cross-host
2. [Syncthing BEP v1](https://docs.syncthing.net/specs/bep-v1.html) — the advisory tier, fully specified
3. [rqlite FAQ](https://rqlite.io/docs/faq/) — the cost of leadership, stated plainly
4. [cr-sqlite](https://github.com/vlcn-io/cr-sqlite) schema design — the cost of multi-writer
5. [container-use](https://github.com/dagger/container-use) open issues — where isolation-only breaks down

The first two will likely change the design. The last one confirms the positioning.

## 9. What to watch

- **cr-sqlite dormancy.** A second multi-year gap would make it unusable as a dependency regardless of technical fit.
- **LiteFS maintenance.** Confirm status before evaluating; the Consul dependency is also a deployment cost.
- **Version-reporting integrity.** The LSP failure mode is the one that fails *silently* in our design. Any cross-host protocol draft should address it explicitly.
- **Protocol-corpus parity.** Wire-shape drift between implementations is already a P0 regression class ([CONTRIBUTING.md](../../CONTRIBUTING.md), "Architecture references"). A cross-host wire protocol multiplies that surface; the existing corpus discipline is the precedent to extend, and is something none of the surveyed agent-domain tools have.
