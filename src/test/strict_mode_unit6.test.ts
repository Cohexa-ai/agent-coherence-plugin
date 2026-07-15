/**
 * Unit 6 — Node strict mode (zero-Python plan capstone).
 *
 * The acceptance contracts, per the plan review:
 * 1. BYTE-STABLE deny text — hard-coded expected strings (incl. the Python
 *    isoformat() semantics: +00:00 offset, variable-precision microseconds,
 *    zero-fraction case) and the <unknown> sentinel (never [:8]-sliced).
 * 2. The pre-read 2×2 gate truth table — (None, matches) must NOT deny.
 * 3. KTD-U terminal denial — emitAllow throws on the strict class.
 * 4. KTD-T stickiness — a denied pre-read re-denies (no SHARED re-grant).
 * 5. Empty strict_mode.yaml → warn-only (v0.1.1 default preserved).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { ArtifactRegistry } from "../registry.js";
import { PolicyRef } from "../policy.js";
import { SessionRegistry } from "../sessions.js";
import { createServer } from "../server.js";
import {
  emitAllow,
  emitStrictDeny,
  pythonIsoUtc,
  STRICT_MODE_DENY_REASON_TEMPLATE,
  type StaleSummary,
} from "../hook_payloads.js";

const SID_A = "44444444-4444-4444-8444-444444444444";
const SID_B = "55555555-5555-5555-8555-555555555555";
const HASH_1 = "1".repeat(64);
const HASH_2 = "2".repeat(64);

// ------------------------------------------------------------ byte parity

test("pythonIsoUtc: +00:00 offset, 6-digit microseconds, zero-fraction omits them", () => {
  // Fractional: Python datetime.fromtimestamp(1748088000.123456, tz=utc).isoformat()
  assert.equal(pythonIsoUtc(1748088000.123456), "2025-05-24T12:00:00.123456+00:00");
  // Zero fraction: no fractional part at all.
  assert.equal(pythonIsoUtc(1748088000), "2025-05-24T12:00:00+00:00");
  // Trailing-zero microseconds keep 6-digit padding (Python: .120000).
  assert.equal(pythonIsoUtc(1748088000.12), "2025-05-24T12:00:00.120000+00:00");
});

test("emitStrictDeny: byte-identical reason (real writer, fractional ts) + no additionalContext key", () => {
  const summary: StaleSummary = {
    path: "docs/plan.md",
    current_version: 3,
    prior_version_seen_by_session: 2,
    last_writer_session_id: SID_B,
    last_writer_at_unix_ts: 1748088000.123456,
    warning_generated_at_unix_ts: 999,
    hash_differs: false,
  };
  const out = emitStrictDeny({ source: "pre_read_strict_deny", summary });
  assert.deepEqual(out, {
    hookEventName: "PreToolUse",
    permissionDecision: "deny",
    permissionDecisionReason:
      "Stale read denied: docs/plan.md was updated by session 55555555 " +
      "at 2025-05-24T12:00:00.123456+00:00. Re-read docs/plan.md via the Read tool before " +
      "proceeding. This denial is structural (v0.2 strict mode); retrying " +
      "the same operation will produce the same denial.",
  });
  assert.equal("additionalContext" in out, false);
});

test("emitStrictDeny: <unknown> sentinel preserved verbatim (never sliced to '<unknow')", () => {
  const summary: StaleSummary = {
    path: "plan.md",
    current_version: 1,
    prior_version_seen_by_session: null,
    last_writer_session_id: "",
    last_writer_at_unix_ts: 1748088000,
    warning_generated_at_unix_ts: 999,
    hash_differs: true,
  };
  const out = emitStrictDeny({ source: "pre_read_strict_deny", summary });
  assert.match(out.permissionDecisionReason!, /by session <unknown> at 2025-05-24T12:00:00\+00:00\./);
  assert.doesNotMatch(out.permissionDecisionReason!, /<unknow[^n]/);
});

test("template placeholder set is locked (KTD-P)", () => {
  const placeholders = [...STRICT_MODE_DENY_REASON_TEMPLATE.matchAll(/\{(\w+)\}/g)].map((m) => m[1]);
  assert.deepEqual(placeholders, ["path", "last_writer_short", "last_writer_ts_iso", "path"]);
});

test("KTD-U: emitAllow refuses to convert a terminal denial class", () => {
  assert.throws(
    () => emitAllow({ source: "test", denialClass: "permissions_deny_strict_mode" }),
    /KTD-U security invariant/,
  );
  // Non-terminal allow works and omits additionalContext when absent.
  const quiet = emitAllow({ source: "test" });
  assert.deepEqual(quiet, { hookEventName: "PreToolUse", permissionDecision: "allow" });
});

// -------------------------------------------------------- gate truth table

async function makeStrictServer(strictPatterns: string[]) {
  const tmp = mkdtempSync(join(tmpdir(), "strict6-test-"));
  mkdirSync(join(tmp, ".coherence"), { recursive: true });
  if (strictPatterns.length > 0) {
    writeFileSync(
      join(tmp, ".coherence", "strict_mode.yaml"),
      strictPatterns.map((p) => `- ${p}`).join("\n") + "\n",
      "utf8",
    );
  }
  const registry = new ArtifactRegistry(join(tmp, ".coherence", "state.db"));
  const policy = PolicyRef.load(tmp);
  const sessions = new SessionRegistry();
  const secret = "s".repeat(32);
  const server = createServer({
    secret,
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
        Authorization: `Bearer ${secret}`,
        Host: "127.0.0.1",
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
    return (await res.json()) as Record<string, unknown>;
  };
  const cleanup = () =>
    new Promise<void>((r) => {
      server.close(() => {
        registry.close();
        rmSync(tmp, { recursive: true, force: true });
        r();
      });
    });
  return { registry, sessions, post, cleanup };
}

function decision(body: Record<string, unknown>): string | undefined {
  return (body.hookSpecificOutput as Record<string, unknown> | undefined)?.permissionDecision as
    | string
    | undefined;
}

test("pre-read strict gate truth table: INVALID→deny; (None,differs)→deny; (None,matches)→allow; sticky re-deny", async () => {
  const { registry, sessions, post, cleanup } = await makeStrictServer(["CLAUDE.md"]);
  try {
    // Seed: peer B commits v2 with HASH_2.
    const id = registry.resolveOrRegisterArtifact("CLAUDE.md", HASH_1);
    const agentB = sessions.registerSession(SID_B);
    registry.acquireExclusive(id, agentB, 10);
    registry.commit(id, agentB, HASH_2, 11);

    // (None, hash matches current) → warn-mode allow (NOT deny) — the
    // truth-table cell a wholesale-broadened gate would break.
    const nullMatch = await post("/hooks/pre-read", {
      session_id: SID_A,
      path: "CLAUDE.md",
      content_hash: HASH_2,
    });
    assert.equal(decision(nullMatch), "allow");

    // The (None→allow) path re-granted SHARED to A; a peer commit now makes A INVALID.
    registry.acquireExclusive(id, agentB, 20);
    registry.commit(id, agentB, HASH_1, 21);

    // INVALID → deny, regardless of hash.
    const invalidDeny = await post("/hooks/pre-read", {
      session_id: SID_A,
      path: "CLAUDE.md",
      content_hash: HASH_1,
    });
    assert.equal(decision(invalidDeny), "deny");
    assert.equal(invalidDeny.status, "stale");

    // KTD-T sticky: the deny did NOT re-grant SHARED — an identical retry re-denies
    // with byte-identical reason text.
    const retry = await post("/hooks/pre-read", {
      session_id: SID_A,
      path: "CLAUDE.md",
      content_hash: HASH_1,
    });
    assert.equal(decision(retry), "deny");
    assert.equal(
      (retry.hookSpecificOutput as Record<string, unknown>).permissionDecisionReason,
      (invalidDeny.hookSpecificOutput as Record<string, unknown>).permissionDecisionReason,
    );

    // (None, hash differs) → deny: a fresh session C reading stale bytes.
    const SID_C = "66666666-6666-6666-8666-666666666666";
    const nullDiffers = await post("/hooks/pre-read", {
      session_id: SID_C,
      path: "CLAUDE.md",
      content_hash: HASH_2, // current is HASH_1 after B's second commit
    });
    assert.equal(decision(nullDiffers), "deny");
  } finally {
    await cleanup();
  }
});

test("empty strict_mode.yaml → warn-only default preserved (INVALID reader gets allow+warn)", async () => {
  const { registry, sessions, post, cleanup } = await makeStrictServer([]);
  try {
    const id = registry.resolveOrRegisterArtifact("CLAUDE.md", HASH_1);
    const agentB = sessions.registerSession(SID_B);
    registry.acquireExclusive(id, agentB, 10);
    registry.commit(id, agentB, HASH_2, 11);
    const r = await post("/hooks/pre-read", {
      session_id: SID_A,
      path: "CLAUDE.md",
      content_hash: HASH_1,
    });
    assert.equal(decision(r), "allow");
    assert.equal(r.status, "stale");
  } finally {
    await cleanup();
  }
});

test("pre-edit strict gate is INVALID-only: first-time editor acquires; preempted editor denied {ok:false}", async () => {
  const { registry, sessions, post, cleanup } = await makeStrictServer(["CLAUDE.md"]);
  try {
    const id = registry.resolveOrRegisterArtifact("CLAUDE.md", HASH_1);
    // First-time editor (state None) on a strict artifact → normal acquire.
    const first = await post("/hooks/pre-edit", { session_id: SID_A, path: "CLAUDE.md" });
    assert.equal(first.ok, true);
    // Peer B preempts + commits → A INVALID.
    const preempt = await post("/hooks/pre-edit", { session_id: SID_B, path: "CLAUDE.md" });
    assert.equal(preempt.ok, true);
    const agentB = sessions.registerSession(SID_B);
    registry.commit(id, agentB, HASH_2, 30);
    // A (INVALID) edits again → strict deny with ok:false.
    const denied = await post("/hooks/pre-edit", { session_id: SID_A, path: "CLAUDE.md" });
    assert.equal(denied.ok, false);
    assert.equal(decision(denied), "deny");
    assert.equal(denied.status, "stale");
  } finally {
    await cleanup();
  }
});

test("pre-bash strict short-circuit: strict stale path → deny with stale_paths", async () => {
  const { registry, sessions, post, cleanup } = await makeStrictServer(["CLAUDE.md"]);
  try {
    const id = registry.resolveOrRegisterArtifact("CLAUDE.md", HASH_1);
    const agentB = sessions.registerSession(SID_B);
    registry.acquireExclusive(id, agentB, 10);
    registry.commit(id, agentB, HASH_2, 11);
    const r = await post("/hooks/pre-bash", { session_id: SID_A, command: "cat CLAUDE.md" });
    assert.equal(decision(r), "deny");
    assert.equal(r.status, "stale");
    assert.deepEqual(r.stale_paths, ["CLAUDE.md"]);
    assert.equal("summary" in r, false); // pre-bash deny body carries no summary key
  } finally {
    await cleanup();
  }
});

test("SHARED-hash arm: foreign out-of-band edit denies; recent self-commit lag suppresses", async () => {
  const { registry, sessions, post, cleanup } = await makeStrictServer(["CLAUDE.md"]);
  try {
    const id = registry.resolveOrRegisterArtifact("CLAUDE.md", HASH_1);
    // A becomes a SHARED holder via a clean read (hash matches).
    const fresh = await post("/hooks/pre-read", {
      session_id: SID_A,
      path: "CLAUDE.md",
      content_hash: HASH_1,
    });
    assert.equal(decision(fresh), "allow");
    // Foreign out-of-band edit: A still SHARED, but disk hash now differs
    // and A is NOT the last writer → deny (pre_read_shared_hash_deny).
    const foreign = await post("/hooks/pre-read", {
      session_id: SID_A,
      path: "CLAUDE.md",
      content_hash: HASH_2,
    });
    assert.equal(decision(foreign), "deny");

    // Self-commit lag: B holds SHARED after its own commit_cas WIN (<5s ago);
    // B's disk still has old bytes → suppressed (allow), not denied.
    const agentB = sessions.registerSession(SID_B);
    registry.grantShared(id, agentB, 40);
    const win = registry.commitCas(id, agentB, 1, HASH_2, 41);
    assert.equal(win.kind, "win");
    const lag = await post("/hooks/pre-read", {
      session_id: SID_B,
      path: "CLAUDE.md",
      content_hash: HASH_1, // stale disk bytes ≠ canonical HASH_2
    });
    // Suppression falls through to the plain fresh response (no deny, no
    // hookSpecificOutput) — same as Python's warn-mode fall-through.
    assert.equal(lag.status, "fresh");
    assert.equal(decision(lag), undefined);
  } finally {
    await cleanup();
  }
});
