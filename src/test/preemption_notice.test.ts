/**
 * Preemption-notice parity — recording predicate + prose bytes.
 *
 * The prose here is a wire contract with the Python coordinator
 * (`_build_preemption_text` in coordinator_server.py), which is the reference
 * implementation. It is also the whole signal that tells a model its edit was
 * stranded outside the coordinator's version, so a reworded header or a
 * dropped closing line is a user-visible regression, not cosmetics.
 *
 * The protocol corpus (tests/protocol_corpus in the library repo) asserts these
 * same bytes end-to-end against BOTH backends, but only for the deterministic
 * single-notice shapes. The plural, overflow-cap, sort-order and sweep-sentinel
 * branches need timestamps fixed by hand, so they are pinned here.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ArtifactRegistry } from "../registry.js";
import { MESIState } from "../states.js";
import { SWEEP_RECLAMATION_PREEMPTER_ID } from "../agent_id.js";
import { preemptionNoticeText, type RenderableNotice } from "../hook_payloads.js";

function makeRegistry(): { registry: ArtifactRegistry; cleanup: () => void } {
  const tmp = mkdtempSync(join(tmpdir(), "notice-test-"));
  const registry = new ArtifactRegistry(join(tmp, "state.db"));
  return {
    registry,
    cleanup: () => {
      registry.close();
      rmSync(tmp, { recursive: true, force: true });
    },
  };
}

const AGENT_A = "a".repeat(32);
const AGENT_B = "b".repeat(32);
const HASH_1 = "1".repeat(64);

/** 2026-05-23T10:00:00.000Z — fixed so the rendered ISO strings are literals. */
const TS_BASE = 1779530400;

function notice(overrides: Partial<RenderableNotice> = {}): RenderableNotice {
  return {
    artifactPath: "plan.md",
    preempterAgentId: AGENT_B,
    preempterSessionShort: "66666666",
    preemptedAtUnixTs: TS_BASE,
    ...overrides,
  };
}

const CLOSING_LINE =
  "Re-read affected files before continuing if you need the latest " +
  "coordinator-tracked version, or proceed knowing your edits remain " +
  "local-only until you re-acquire and commit.";

// ---------------------------------------------------------------------------
// Recording predicate (Divergence A)
// ---------------------------------------------------------------------------

test("acquireExclusive records a notice for an EXCLUSIVE victim", () => {
  const { registry, cleanup } = makeRegistry();
  try {
    const id = registry.resolveOrRegisterArtifact("plan.md", HASH_1);
    registry.acquireExclusive(id, AGENT_B, 50);
    registry.acquireExclusive(id, AGENT_A, 100);

    assert.equal(registry.getAgentState(id, AGENT_B), MESIState.INVALID);
    const notices = registry.popPendingNoticesForAgent(AGENT_B);
    assert.equal(notices.length, 1);
    assert.equal(notices[0]!.preempterAgentId, AGENT_A);
  } finally {
    cleanup();
  }
});

test("acquireExclusive records NO notice for a SHARED victim", () => {
  const { registry, cleanup } = makeRegistry();
  try {
    const id = registry.resolveOrRegisterArtifact("plan.md", HASH_1);
    registry.grantShared(id, AGENT_B, 50);
    const invalidated = registry.acquireExclusive(id, AGENT_A, 100);

    // Still invalidated — a SHARED reader's view really did go stale.
    assert.deepEqual(invalidated, [AGENT_B]);
    assert.equal(registry.getAgentState(id, AGENT_B), MESIState.INVALID);
    // But no notice: it held no write grant, so nothing of its was stranded.
    assert.deepEqual(registry.popPendingNoticesForAgent(AGENT_B), []);
  } finally {
    cleanup();
  }
});

test("commit invalidates a SHARED peer WITHOUT queueing a notice", () => {
  const { registry, cleanup } = makeRegistry();
  try {
    const id = registry.resolveOrRegisterArtifact("plan.md", HASH_1);
    registry.grantShared(id, AGENT_B, 50);
    registry.acquireExclusive(id, AGENT_A, 100);
    // B went INVALID at acquire; re-grant so commit() sees a live SHARED peer.
    registry.grantShared(id, AGENT_B, 110);
    const { invalidatedPeers } = registry.commit(id, AGENT_A, "2".repeat(64), 120);

    assert.deepEqual(invalidatedPeers, [AGENT_B]);
    assert.deepEqual(registry.popPendingNoticesForAgent(AGENT_B), []);
  } finally {
    cleanup();
  }
});

test("notice timestamps are fractional, so two preemptions in one second both discriminate", () => {
  const { registry, cleanup } = makeRegistry();
  try {
    const id = registry.resolveOrRegisterArtifact("plan.md", HASH_1);
    registry.acquireExclusive(id, AGENT_B, 50);
    registry.acquireExclusive(id, AGENT_A, 50);

    const notices = registry.popPendingNoticesForAgent(AGENT_B);
    assert.equal(notices.length, 1);
    // Truncating to whole seconds would make the ON CONFLICT guard
    // (`excluded.preempted_at_unix_ts > …`) drop a same-second re-preemption,
    // and would write an int where Python writes a float in the same column.
    assert.equal(Number.isInteger(notices[0]!.preemptedAtUnixTs), false);
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// Prose bytes (Divergence B)
// ---------------------------------------------------------------------------

test("preemptionNoticeText: empty input renders nothing", () => {
  assert.equal(preemptionNoticeText([]), "");
});

test("preemptionNoticeText: one peer preemption renders Python's three lines", () => {
  assert.equal(
    preemptionNoticeText([notice()]),
    "⚠ Coordinator notice: your EXCLUSIVE grant was preempted:\n" +
      "  • plan.md — preempted/revoked by session 66666666 at 2026-05-23T10:00:00.000Z. " +
      "Any local edit you made to this file will land in your worktree but is NOT " +
      "reflected in the coordinator's version.\n" +
      CLOSING_LINE,
  );
});

test("preemptionNoticeText: sweep reclamation names the sweep, not a session", () => {
  const rendered = preemptionNoticeText([
    notice({ preempterAgentId: SWEEP_RECLAMATION_PREEMPTER_ID, preempterSessionShort: "e91bfe9c" }),
  ]);
  assert.equal(
    rendered,
    "⚠ Coordinator notice: your EXCLUSIVE grant was preempted:\n" +
      "  • plan.md — reclaimed by the coordinator sweep (heartbeat timeout or " +
      "max-hold ceiling) at 2026-05-23T10:00:00.000Z. Any local edit you made to this " +
      "file will land in your worktree but is NOT reflected in the coordinator's " +
      "version. Re-fetch via pre-read and retry.\n" +
      CLOSING_LINE,
  );
  // The sentinel's first eight hex digits must never be printed as a session.
  assert.equal(rendered.includes("by session"), false);
});

test("preemptionNoticeText: notices render newest first", () => {
  const rendered = preemptionNoticeText([
    notice({ artifactPath: "oldest.md", preemptedAtUnixTs: TS_BASE }),
    notice({ artifactPath: "newest.md", preemptedAtUnixTs: TS_BASE + 200 }),
    notice({ artifactPath: "middle.md", preemptedAtUnixTs: TS_BASE + 100 }),
  ]);
  const paths = rendered
    .split("\n")
    .filter((line) => line.startsWith("  • "))
    .map((line) => line.slice(4).split(" ")[0]);
  assert.deepEqual(paths, ["newest.md", "middle.md", "oldest.md"]);
});

test("preemptionNoticeText: beyond three notices, the rest coalesce into one overflow line", () => {
  const rendered = preemptionNoticeText(
    ["a.md", "b.md", "c.md", "d.md", "e.md"].map((artifactPath, i) =>
      notice({ artifactPath, preemptedAtUnixTs: TS_BASE + i }),
    ),
  );
  const bulletLines = rendered.split("\n").filter((line) => line.startsWith("  • "));
  // Three verbatim (newest first: e, d, c) + one overflow line. Unbounded
  // rendering would blow Claude Code's 10KB additionalContext cap once a
  // long-running session accumulates preemptions.
  assert.equal(bulletLines.length, 4);
  assert.equal(
    bulletLines[3],
    "  • Plus 2 more preemptions since your last activity; " +
      "run `/agent-coherence status` (or query GET /status on the coordinator) " +
      "for the full list.",
  );
  assert.equal(rendered.endsWith(CLOSING_LINE), true);
  for (const dropped of ["a.md", "b.md"]) {
    assert.equal(rendered.includes(dropped), false);
  }
});
