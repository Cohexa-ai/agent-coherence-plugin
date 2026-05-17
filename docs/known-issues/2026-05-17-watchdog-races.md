---
title: v0.1 — Coordinator HTTP server watchdog races
date: 2026-05-17
plan: docs/plans/2026-05-13-001-feat-claude-code-coherence-plugin-v0.1-plan.md
status: known-issue, deferred-to-v0.1.1-design-pass
severity: P1 — real under sustained load, not blocking v0.1 alpha ship
---

# Watchdog races (A6 + A7)

Two architectural concerns surfaced by the Unit 4 adversarial review (subagent
report 2026-05-17, agentId `aa85ea66f658f8913`). Both are correctness gaps
under sustained load, not under the alpha-cohort load profile. Fixing them
requires a real design pass that doesn't fit into the v0.1 Unit 4 commit
without either under-designing or blowing scope. Captured here so the
known-issue framing is explicit rather than a silent omission.

Phpmac and other alpha installers are expected to read this file before
their first install. The README links to this document under "v0.1
limitations."

## A6 — Watchdog late-completion mutates state after the client moved on

**The race:**

1. Hook handler thread calls `run_with_watchdog(work)` which submits `work` to
   the `_watchdog` ThreadPoolExecutor and blocks on `future.result(timeout=4.0)`.
2. SQLite contention (e.g., another session's commit holding the BEGIN
   IMMEDIATE transaction) pushes the call past 4s.
3. Watchdog fires `FuturesTimeout`. The handler returns `200 {status: "fresh",
   degraded: true}` and the client (CC hook runner) proceeds — believing
   nothing was acquired/committed.
4. ~1s later, SQLite unblocks. The background future completes — the
   coordinator state IS mutated (grant acquired, version bumped, etc).
5. Peer sessions now observe state changes that the original caller's
   "degraded" response said never happened. Inconsistency: hook log says
   "degraded to fresh" (no acquire), coordinator state says "agent holds E".

**Worst-case cascade:** in `_handle_session_stop`, a late-completing
`invalidate()` runs AFTER the client moved on. The next session starting a
turn briefly sees the artifact unowned, acquires E, then the prior session's
invalidate fires and revokes the new owner's grant — silently.

**Mitigation in v0.1:** none in code. Documented here.

**Design space for v0.1.1:**

- (a) After `FuturesTimeout`, attach a done-callback that REVERSES any
  late-completing mutation (e.g., if `write()` completed late, immediately
  call `invalidate()`).
- (b) Gate every coordinator mutation by a deadline column in SQL: inside
  the BEGIN IMMEDIATE transaction, check `now() > issued_at_tick +
  HANDLER_TIMEOUT_SEC` and abort the write transactionally. Eliminates
  the late-mutation possibility instead of compensating for it.
- (c) Replace the ThreadPoolExecutor watchdog with a SIGALRM-style
  ceiling on the handler thread itself, since SQLite is already bounded
  by `busy_timeout`. Removes the indirection entirely.

Option (b) is the cleanest because it eliminates the race; option (a) is the
smallest change. Pick during v0.1.1 design.

## A7 — Watchdog pool saturation cascade

**The race:**

1. `_watchdog = ThreadPoolExecutor(max_workers=4)`.
2. 4 concurrent sessions each fire pre-read/pre-edit/post-edit in close
   succession. SQLite contention blocks all 4 workers simultaneously
   inside `service.write` / `service.commit`.
3. 5th, 6th, 7th handler threads arrive (ThreadingHTTPServer has no upper
   bound on handler threads). Each submits to `_watchdog`, which queues
   the task (submit does NOT block on max_workers), then blocks on
   `future.result(timeout=4)`.
4. A queued task that waits ≥1s in the executor queue before starting
   has <4s left for SQLite. But the handler-side watchdog timer starts at
   submit, not at task start — so a queued task that runs for 100ms after
   waiting 3.9s in queue STILL times out the future.
5. Cascade: every queued handler reports `degraded: true` / `status: fresh`.
   Stale reads are silently suppressed under load. The user sees an empty
   audit log and good responses — coherence is gone, but no error fires.

**Mitigation in v0.1:** none in code. Documented here.

**Design space for v0.1.1:**

- (a) Track queue depth explicitly: before `submit()`, check
  `_watchdog._work_queue.qsize()` and reject with 503 once depth > N.
- (b) Bound HTTP handler concurrency at the server (subclass ThreadingMixIn
  to use a Semaphore matched to the watchdog pool size).
- (c) Add a metric `watchdog_timeouts_total` so silent degradation is
  visible in `agent-coherence-status`.
- (d) Increase `max_workers` to ≥ peak concurrent sessions × 2.

(a) + (c) is the smallest defensive pair; (b) is the proper architectural fix.
Pick during v0.1.1 design.

## Why ship v0.1 with these known issues

Both races require sustained concurrent load to manifest. The v0.1 alpha
cohort is ~10 hand-picked installers (see `project_plugin_release_sequence.md`).
Single-developer Claude Code usage produces at most 2–4 concurrent sessions,
each firing hooks at human-prompt rate (seconds apart, not milliseconds).
SQLite + busy_timeout=2000ms absorbs that load without triggering the
watchdog timeout in practice.

The risks ARE real for:
- Shared CI runners with multiple parallel Claude Code agents
- Stress-test scenarios deliberately spamming hook calls
- Future deployments that scale concurrent sessions beyond ~10

For the v0.1 alpha audience, "documented limitation that doesn't trigger in
normal use" is a defensible posture. Phpmac will respect explicit
known-limitation framing more than they'd respect a half-fixed watchdog.

## How to detect if you've hit either issue

A6 symptoms (silent late mutation):
- `agent-coherence-status` shows a session holding M∪E for an artifact
  but that session's hook log shows the matching pre-edit returned
  `degraded: true` / `status: fresh`.
- Peer sessions report stale-read warnings naming a session that the
  warning's recipient session believes never acquired E.

A7 symptoms (pool saturation):
- Hook traffic logs (CC stream-json with `--include-hook-events`) show
  frequent `status: fresh, degraded: true` responses despite the
  coordinator process running normally.
- `agent-coherence-status` shows the coordinator process alive and
  responsive, but stale-read warnings have stopped firing under load.

If you observe either, please file an issue at
https://github.com/hipvlady/agent-coherence-plugin/issues with the
captured logs — the v0.1.1 design pass needs real workload data.
