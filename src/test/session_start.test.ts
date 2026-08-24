/**
 * SB-10 U6 — POST /hooks/session-start: post-compaction re-grounding.
 *
 * Node mirror of the Python endpoint landed in agent-coherence 2bd756c
 * (`_handle_session_start` + `_build_session_start_context`). Prose lines
 * are byte-pinned here on purpose: the Python coordinator renders these
 * exact strings and the protocol corpus byte-matches them. Any wording
 * change must land in BOTH backends plus the corpus fixtures.
 *
 * Seeding note (documented divergence): the Node registry queues preemption
 * notices for ALL non-INVALID victims of an exclusive acquire — including
 * SHARED readers — while Python only notifies preempted M∪E writers.
 * Scenarios that pin notice-free payloads therefore drain the victim's
 * queue after seeding (the victim's next admit hook would have done so).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { ArtifactRegistry } from "../registry.js";
import { PolicyRef } from "../policy.js";
import { SessionRegistry } from "../sessions.js";
import { createServer } from "../server.js";
import {
  SESSION_START_HEADER,
  SESSION_START_GRANT_LINE_TEMPLATE,
  SESSION_START_STALE_LINE_TEMPLATE,
  SESSION_START_TOUCHED_LINE_TEMPLATE,
  SESSION_START_OVERFLOW_LINE_TEMPLATE,
  SESSION_START_SUBAGENT_PREFIX_TEMPLATE,
  SESSION_START_CLOSING_LINE,
  emitSessionStart,
} from "../hook_payloads.js";

const SECRET = "s".repeat(32);
const SID_A = "44444444-4444-4444-8444-444444444444";
const SID_B = "55555555-5555-5555-8555-555555555555";
const SID_C = "66666666-6666-4666-8666-666666666666";
const SID_D = "77777777-7777-4777-8777-777777777777";
const HASH_1 = "1".repeat(64);
const HASH_2 = "2".repeat(64);

const SS_HEADER = "Post-compaction re-grounding (agent-coherence):";
const SS_CLOSING =
  "Versions are as of this re-grounding; a more recent read supersedes this notice.";

async function makeServer() {
  const tmp = mkdtempSync(join(tmpdir(), "session-start-test-"));
  const dbPath = join(tmp, ".coherence", "state.db");
  const registry = new ArtifactRegistry(dbPath);
  const policy = PolicyRef.load(tmp);
  const sessions = new SessionRegistry();
  const server = createServer({
    secret: SECRET,
    startedAtMs: Date.now(),
    version: "test",
    registry,
    policy,
    sessions,
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const port = (server.address() as AddressInfo).port;
  const post = async (path: string, body: unknown) => {
    const res = await fetch(`http://127.0.0.1:${port}${path}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${SECRET}`,
        Host: "127.0.0.1",
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  };
  const cleanup = () =>
    new Promise<void>((r) => {
      server.close(() => {
        registry.close();
        rmSync(tmp, { recursive: true, force: true });
        r();
      });
    });
  return { registry, sessions, dbPath, post, cleanup };
}

function sessionStartText(body: Record<string, unknown>): string {
  const hso = body.hookSpecificOutput as Record<string, unknown>;
  return hso.additionalContext as string;
}

// ------------------------------------------------------------ byte parity

test("session-start: the seven prose constants byte-match the Python source (KTD8)", () => {
  assert.equal(SESSION_START_HEADER, "Post-compaction re-grounding (agent-coherence):");
  assert.equal(
    SESSION_START_GRANT_LINE_TEMPLATE,
    "At compaction you held {state} on {path} (v{version}) — re-acquire " + "before writing.",
  );
  assert.equal(
    SESSION_START_STALE_LINE_TEMPLATE,
    "{path} advanced to v{current} past your last-observed v{last} — " +
      "re-read before relying on it.",
  );
  assert.equal(SESSION_START_TOUCHED_LINE_TEMPLATE, "{path} is at v{current}.");
  assert.equal(
    SESSION_START_OVERFLOW_LINE_TEMPLATE,
    "Plus {count} more — run agent-coherence-status for the full picture.",
  );
  assert.equal(SESSION_START_SUBAGENT_PREFIX_TEMPLATE, "Subagent {name}:");
  assert.equal(
    SESSION_START_CLOSING_LINE,
    "Versions are as of this re-grounding; a more recent read supersedes " + "this notice.",
  );
  // Every dash is U+2014 EM DASH with surrounding spaces — never a hyphen
  // (guards against editor/tooling dash substitution).
  assert.ok(SESSION_START_GRANT_LINE_TEMPLATE.includes(" — "));
  assert.ok(SESSION_START_STALE_LINE_TEMPLATE.includes(" — "));
  assert.ok(SESSION_START_OVERFLOW_LINE_TEMPLATE.includes(" — "));
  assert.ok(!SESSION_START_GRANT_LINE_TEMPLATE.includes(" - "));
});

test("emitSessionStart: envelope carries hookEventName + additionalContext only", () => {
  const out = emitSessionStart({ additionalContext: "hello" });
  assert.deepEqual(out, { hookEventName: "SessionStart", additionalContext: "hello" });
});

// ------------------------------------------------------------ validation

test("session-start: malformed session_id → 400", async () => {
  const { post, cleanup } = await makeServer();
  try {
    const r = await post("/hooks/session-start", { session_id: "not-a-uuid" });
    assert.equal(r.status, 400);
    assert.deepEqual(r.body, { error: "missing session_id" });
  } finally {
    await cleanup();
  }
});

// ------------------------------------------------------------ empty session

test("session-start: empty session → {} and compact-pending NOT set (R5)", async () => {
  const { sessions, post, cleanup } = await makeServer();
  try {
    const r = await post("/hooks/session-start", { session_id: SID_A });
    assert.equal(r.status, 200);
    assert.deepEqual(r.body, {});
    assert.equal(sessions.consumeCompactPending(SID_A), false);
  } finally {
    await cleanup();
  }
});

// ------------------------------------------------------------ grant lines

test("session-start: held EXCLUSIVE renders the event-anchored grant line; wrapper shape pinned (R3/KTD8)", async () => {
  const { registry, sessions, post, cleanup } = await makeServer();
  try {
    const id = registry.resolveOrRegisterArtifact("plan.md", HASH_1);
    const agentA = sessions.registerSession(SID_A);
    registry.acquireExclusive(id, agentA, 10);

    const r = await post("/hooks/session-start", { session_id: SID_A });
    assert.equal(r.status, 200);
    // Whole-body deepEqual pins the wrapper: hookSpecificOutput is the ONLY
    // top-level key; hookEventName + additionalContext the only inner keys.
    assert.deepEqual(r.body, {
      hookSpecificOutput: {
        hookEventName: "SessionStart",
        additionalContext:
          SS_HEADER +
          "\n" +
          "At compaction you held EXCLUSIVE on plan.md (v1) — re-acquire before writing." +
          "\n" +
          SS_CLOSING,
      },
    });
  } finally {
    await cleanup();
  }
});

test("session-start: non-empty payload arms compact-pending; consume is test-and-clear; expire drops (KTD5)", async () => {
  const { registry, sessions, post, cleanup } = await makeServer();
  try {
    const id = registry.resolveOrRegisterArtifact("CLAUDE.md", HASH_1);
    registry.grantShared(id, sessions.registerSession(SID_A), 10);

    const r = await post("/hooks/session-start", { session_id: SID_A });
    assert.equal(r.status, 200);
    assert.notDeepEqual(r.body, {});
    assert.equal(sessions.consumeCompactPending(SID_A), true);
    assert.equal(sessions.consumeCompactPending(SID_A), false);

    // Expire drops an unconsumed flag (parent-Stop wiring lands in the
    // deferred-delivery unit; the primitive is pinned here).
    sessions.markCompactPending(SID_A);
    sessions.expireCompactPending(SID_A);
    assert.equal(sessions.consumeCompactPending(SID_A), false);
  } finally {
    await cleanup();
  }
});

// ------------------------------------------------------------ stale line

test("session-start: peer advanced past last-observed renders the stale line with both versions (R4/R7)", async () => {
  const { registry, sessions, post, cleanup } = await makeServer();
  try {
    const id = registry.resolveOrRegisterArtifact("plan.md", HASH_1);
    const agentA = sessions.registerSession(SID_A);
    registry.grantShared(id, agentA, 10); // A observed v1
    const agentB = sessions.registerSession(SID_B);
    registry.acquireExclusive(id, agentB, 20); // A → INVALID (last_observed stays 1)
    registry.commit(id, agentB, HASH_2, 30); // v2, last_writer = B
    // Node queues the SHARED victim a preemption notice (Python: M∪E only);
    // drain it so this scenario pins the pure stale-line payload.
    registry.popPendingNoticesForAgent(agentA);

    const r = await post("/hooks/session-start", { session_id: SID_A });
    assert.equal(r.status, 200);
    const text = sessionStartText(r.body);
    assert.equal(
      text,
      SS_HEADER +
        "\n" +
        "plan.md advanced to v2 past your last-observed v1 — re-read before relying on it." +
        "\n" +
        SS_CLOSING,
    );
    // B's E/M grant belongs to B's session — never rendered for A; and the
    // whole payload is timestamp-free (KTD8).
    assert.ok(!text.includes("At compaction you held"));
    assert.ok(!text.includes("+00:00"));
  } finally {
    await cleanup();
  }
});

test("session-start: own last-writer renders the plain version line, never the stale flag (R7/KTD4)", async () => {
  const { registry, sessions, dbPath, post, cleanup } = await makeServer();
  try {
    const id = registry.resolveOrRegisterArtifact("plan.md", HASH_1);
    const agentA = sessions.registerSession(SID_A);
    registry.grantShared(id, agentA, 10);
    const agentB = sessions.registerSession(SID_B);
    registry.acquireExclusive(id, agentB, 20);
    registry.commit(id, agentB, HASH_2, 30); // v2 > A's last-observed v1
    registry.popPendingNoticesForAgent(agentA);

    // Seam: make A itself the recorded last writer. The natural flow advances
    // the writer's own last_observed in the same transaction (KTD4's FIRST
    // layer), so the second layer is only reachable by flipping last_writer
    // directly — mirrors the Python test's monkeypatched last_writer_for.
    const seam = new Database(dbPath);
    seam.prepare("UPDATE artifacts SET last_writer_id = ? WHERE id = ?").run(agentA, id);
    seam.close();

    const r = await post("/hooks/session-start", { session_id: SID_A });
    assert.equal(r.status, 200);
    const text = sessionStartText(r.body);
    assert.equal(text, SS_HEADER + "\n" + "plan.md is at v2." + "\n" + SS_CLOSING);
    assert.ok(!text.includes("advanced to"));
  } finally {
    await cleanup();
  }
});

test("session-start: NULL last-observed row is admitted, never flagged (R7 — no 0-sentinel)", async () => {
  const { registry, sessions, dbPath, post, cleanup } = await makeServer();
  try {
    const id = registry.resolveOrRegisterArtifact("plan.md", HASH_1);
    const agentB = sessions.registerSession(SID_B);
    registry.acquireExclusive(id, agentB, 10);
    registry.commit(id, agentB, HASH_2, 20); // v2
    const agentA = sessions.registerSession(SID_A);
    // A gets an INVALID row that never observed bytes — the pre-U5 row shape
    // (last_observed_version stays NULL). Only reachable via direct SQL: every
    // Node non-INVALID upsert records atomically.
    const seam = new Database(dbPath);
    seam
      .prepare("INSERT INTO agent_states (artifact_id, agent_id, state) VALUES (?, ?, 'INVALID')")
      .run(id, agentA);
    seam.close();

    const r = await post("/hooks/session-start", { session_id: SID_A });
    assert.equal(r.status, 200);
    const text = sessionStartText(r.body);
    assert.equal(text, SS_HEADER + "\n" + "plan.md is at v2." + "\n" + SS_CLOSING);
    assert.ok(!text.includes("advanced to"));
  } finally {
    await cleanup();
  }
});

// ------------------------------------------------------------ overflow cap

test("session-start: 5 artifacts → 3 verbatim + 'Plus 2 more' overflow, under 10KB (R5)", async () => {
  const { registry, sessions, post, cleanup } = await makeServer();
  try {
    const agentA = sessions.registerSession(SID_A);
    for (const n of ["a", "b", "c", "d", "e"]) {
      const id = registry.resolveOrRegisterArtifact(`docs/plans/${n}.md`, HASH_1);
      registry.grantShared(id, agentA, 10);
    }

    const r = await post("/hooks/session-start", { session_id: SID_A });
    assert.equal(r.status, 200);
    const text = sessionStartText(r.body);
    assert.equal(
      text,
      [
        SS_HEADER,
        "At compaction you held SHARED on docs/plans/a.md (v1) — re-acquire before writing.",
        "At compaction you held SHARED on docs/plans/b.md (v1) — re-acquire before writing.",
        "At compaction you held SHARED on docs/plans/c.md (v1) — re-acquire before writing.",
        "Plus 2 more — run agent-coherence-status for the full picture.",
        SS_CLOSING,
      ].join("\n"),
    );
    assert.ok(!text.includes("docs/plans/d.md"));
    assert.ok(!text.includes("docs/plans/e.md"));
    assert.ok(Buffer.byteLength(text, "utf8") < 10_000);
  } finally {
    await cleanup();
  }
});

// ------------------------------------------------------------ notices

test("session-start: pending preemption notice rendered READ-ONLY — appears in payload AND stays drainable (R3/R6)", async () => {
  const { registry, sessions, post, cleanup } = await makeServer();
  try {
    const id = registry.resolveOrRegisterArtifact("AGENTS.md", HASH_1);
    const agentA = sessions.registerSession(SID_A);
    registry.grantShared(id, agentA, 10);
    const agentB = sessions.registerSession(SID_B);
    registry.acquireExclusive(id, agentB, 20); // queues A a notice; A → INVALID

    const r = await post("/hooks/session-start", { session_id: SID_A });
    assert.equal(r.status, 200);
    const text = sessionStartText(r.body);
    assert.equal(text.split("\n")[0], SS_HEADER);
    // Notice block renders AFTER the header, BEFORE artifact lines.
    const noticeAt = text.indexOf("silently revoked");
    const touchedAt = text.indexOf("AGENTS.md is at v1.");
    assert.ok(noticeAt !== -1, "notice prose must render in the payload");
    assert.ok(touchedAt !== -1, "the invalidated row still renders its version line");
    assert.ok(noticeAt < touchedAt, "notices render before artifact lines");

    // Read-only proof #1: the queue still holds the notice.
    assert.equal(registry.peekPendingNoticesForAgent(agentA).length, 1);
    // Read-only proof #2: the next admit hook still surfaces AND consumes it.
    const rr = await post("/hooks/pre-read", { session_id: SID_A, path: "AGENTS.md" });
    assert.equal(rr.status, 200);
    const hso = rr.body.hookSpecificOutput as Record<string, unknown>;
    assert.ok((hso.additionalContext as string).includes("silently revoked"));
    assert.equal(registry.peekPendingNoticesForAgent(agentA).length, 0);
  } finally {
    await cleanup();
  }
});

// ------------------------------------------------------------ subagents

test("session-start: parent lines first, then subagent group under its prefix; released grant → touched line (KTD8)", async () => {
  const { registry, sessions, post, cleanup } = await makeServer();
  try {
    const cid = registry.resolveOrRegisterArtifact("CLAUDE.md", HASH_1);
    registry.grantShared(cid, sessions.registerSession(SID_A), 10);
    const pid = registry.resolveOrRegisterArtifact("plan.md", HASH_1);
    const agentW = sessions.registerSession(SID_A, "worker-1");
    registry.acquireExclusive(pid, agentW, 20);

    const r = await post("/hooks/session-start", { session_id: SID_A });
    assert.equal(r.status, 200);
    assert.equal(
      sessionStartText(r.body),
      [
        SS_HEADER,
        "At compaction you held SHARED on CLAUDE.md (v1) — re-acquire before writing.",
        "Subagent worker-1:",
        "At compaction you held EXCLUSIVE on plan.md (v1) — re-acquire before writing.",
        SS_CLOSING,
      ].join("\n"),
    );

    // Stop the subagent — its E grant releases (row goes INVALID); the row
    // is still touched, rendered without a flag.
    await post("/hooks/session-stop", { session_id: SID_A, agent_id: "worker-1" });
    const r2 = await post("/hooks/session-start", { session_id: SID_A });
    assert.equal(
      sessionStartText(r2.body),
      [
        SS_HEADER,
        "At compaction you held SHARED on CLAUDE.md (v1) — re-acquire before writing.",
        "Subagent worker-1:",
        "plan.md is at v1.",
        SS_CLOSING,
      ].join("\n"),
    );
  } finally {
    await cleanup();
  }
});

test("session-start: a group fully swallowed by the overflow cap renders NO subagent prefix (R5/KTD8)", async () => {
  const { registry, sessions, post, cleanup } = await makeServer();
  try {
    const agentA = sessions.registerSession(SID_A);
    for (const n of ["a", "b", "c"]) {
      const id = registry.resolveOrRegisterArtifact(`docs/plans/${n}.md`, HASH_1);
      registry.grantShared(id, agentA, 10);
    }
    const pid = registry.resolveOrRegisterArtifact("plan.md", HASH_1);
    const agentW = sessions.registerSession(SID_A, "worker-1");
    registry.acquireExclusive(pid, agentW, 20);

    const r = await post("/hooks/session-start", { session_id: SID_A });
    assert.equal(r.status, 200);
    const text = sessionStartText(r.body);
    assert.equal(
      text,
      [
        SS_HEADER,
        "At compaction you held SHARED on docs/plans/a.md (v1) — re-acquire before writing.",
        "At compaction you held SHARED on docs/plans/b.md (v1) — re-acquire before writing.",
        "At compaction you held SHARED on docs/plans/c.md (v1) — re-acquire before writing.",
        "Plus 1 more — run agent-coherence-status for the full picture.",
        SS_CLOSING,
      ].join("\n"),
    );
    assert.ok(!text.includes("Subagent"), "swallowed group must not render its prefix");
  } finally {
    await cleanup();
  }
});

// ------------------------------------------------------------ determinism

test("session-start: two identical calls are byte-identical (KTD8 — no timestamps, stable sort)", async () => {
  const { registry, sessions, post, cleanup } = await makeServer();
  try {
    const cid = registry.resolveOrRegisterArtifact("CLAUDE.md", HASH_1);
    const agentA = sessions.registerSession(SID_A);
    registry.grantShared(cid, agentA, 10);
    const pid = registry.resolveOrRegisterArtifact("plan.md", HASH_1);
    const agentB = sessions.registerSession(SID_B);
    registry.acquireExclusive(pid, agentB, 20);
    registry.commit(pid, agentB, HASH_2, 30); // A never touched plan.md — no line, no notice
    const xid = registry.resolveOrRegisterArtifact("docs/plans/x.md", HASH_1);
    registry.grantShared(xid, agentA, 40);

    const first = await post("/hooks/session-start", { session_id: SID_A });
    const second = await post("/hooks/session-start", { session_id: SID_A });
    assert.equal(sessionStartText(first.body), sessionStartText(second.body));
    assert.ok(!sessionStartText(first.body).includes("+00:00"));
  } finally {
    await cleanup();
  }
});

// ------------------------------------------------------------ breadcrumb

test("session-start: R8 breadcrumb fires only for a never-seen session in a nonempty workspace", async () => {
  const { registry, sessions, post, cleanup } = await makeServer();
  const captured: string[] = [];
  const original = process.stderr.write;
  process.stderr.write = ((chunk: string | Uint8Array): boolean => {
    captured.push(String(chunk));
    return true;
  }) as typeof process.stderr.write;
  try {
    // (a) never-seen session + EMPTY workspace → no breadcrumb.
    await post("/hooks/session-start", { session_id: SID_C });
    assert.ok(!captured.join("").includes("never-seen session"));

    // Seed workspace state with an unrelated session.
    const id = registry.resolveOrRegisterArtifact("CLAUDE.md", HASH_1);
    registry.grantShared(id, sessions.registerSession(SID_B), 10);

    // (b) never-seen session + NONEMPTY workspace → breadcrumb.
    captured.length = 0;
    await post("/hooks/session-start", { session_id: SID_D });
    assert.ok(captured.join("").includes("never-seen session"));

    // (c) already-seen session + nonempty workspace → no breadcrumb.
    captured.length = 0;
    await post("/hooks/session-start", { session_id: SID_D });
    assert.ok(!captured.join("").includes("never-seen session"));
  } finally {
    process.stderr.write = original;
    await cleanup();
  }
});
