/**
 * Unit 1 — registry.commitCas conflict semantics (zero-Python plan).
 *
 * The WIN / version_mismatch / other_holder / corruption outcomes are the
 * Python-parity contract (sqlite_registry.commit_cas + service D4
 * preconditions). Structurally-unreachable-on-Node reasons
 * (caller_in_transient_state, stale_read_generation) are documented in
 * registry.ts — no test can produce them here by construction.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ArtifactRegistry } from "../registry.js";
import { MESIState } from "../states.js";

function makeRegistry(): { registry: ArtifactRegistry; cleanup: () => void } {
  const tmp = mkdtempSync(join(tmpdir(), "cas-test-"));
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
const HASH_2 = "2".repeat(64);

test("commitCas WIN: matching version, no peer holder → version+1, committer SHARED", () => {
  const { registry, cleanup } = makeRegistry();
  try {
    const id = registry.resolveOrRegisterArtifact("plan.md", HASH_1);
    const out = registry.commitCas(id, AGENT_A, 1, HASH_2, 100);
    assert.equal(out.kind, "win");
    if (out.kind !== "win") return;
    assert.equal(out.artifact.version, 2);
    assert.equal(out.artifact.content_hash, HASH_2);
    assert.equal(out.artifact.last_writer_id, AGENT_A);
    assert.deepEqual(out.invalidatedPeers, []);
    // OCC committer ends SHARED (never MODIFIED — it holds no grant).
    assert.equal(registry.getAgentState(id, AGENT_A), MESIState.SHARED);
  } finally {
    cleanup();
  }
});

test("commitCas WIN invalidates SHARED peers + queues notices", () => {
  const { registry, cleanup } = makeRegistry();
  try {
    const id = registry.resolveOrRegisterArtifact("plan.md", HASH_1);
    registry.grantShared(id, AGENT_B, 50);
    const out = registry.commitCas(id, AGENT_A, 1, HASH_2, 100);
    assert.equal(out.kind, "win");
    if (out.kind !== "win") return;
    assert.deepEqual(out.invalidatedPeers, [AGENT_B]);
    assert.equal(registry.getAgentState(id, AGENT_B), MESIState.INVALID);
    const notices = registry.popPendingNoticesForAgent(AGENT_B);
    assert.equal(notices.length, 1);
    assert.equal(notices[0]!.preempterAgentId, AGENT_A);
  } finally {
    cleanup();
  }
});

test("commitCas version_mismatch: expected < current → conflict, NO mutation", () => {
  const { registry, cleanup } = makeRegistry();
  try {
    const id = registry.resolveOrRegisterArtifact("plan.md", HASH_1);
    // A wins at v1→v2; B (read at v1) loses.
    assert.equal(registry.commitCas(id, AGENT_A, 1, HASH_2, 100).kind, "win");
    const out = registry.commitCas(id, AGENT_B, 1, HASH_1, 101);
    assert.deepEqual(out, { kind: "conflict", reason: "version_mismatch", currentVersion: 2 });
    // No mutation: version + last_writer unchanged, B not transitioned.
    const artifact = registry.getArtifactById(id)!;
    assert.equal(artifact.version, 2);
    assert.equal(artifact.last_writer_id, AGENT_A);
    assert.equal(registry.getAgentState(id, AGENT_B), null);
  } finally {
    cleanup();
  }
});

test("commitCas other_holder: version matches but a peer holds EXCLUSIVE → conflict, NO mutation", () => {
  const { registry, cleanup } = makeRegistry();
  try {
    const id = registry.resolveOrRegisterArtifact("plan.md", HASH_1);
    registry.acquireExclusive(id, AGENT_B, 60);
    const out = registry.commitCas(id, AGENT_A, 1, HASH_2, 100);
    assert.deepEqual(out, { kind: "conflict", reason: "other_holder", currentVersion: 1 });
    assert.equal(registry.getArtifactById(id)!.version, 1);
    assert.equal(registry.getAgentState(id, AGENT_B), MESIState.EXCLUSIVE);
  } finally {
    cleanup();
  }
});

test("commitCas corruption: expected > current → corruption outcome, NO mutation", () => {
  const { registry, cleanup } = makeRegistry();
  try {
    const id = registry.resolveOrRegisterArtifact("plan.md", HASH_1);
    const out = registry.commitCas(id, AGENT_A, 7, HASH_2, 100);
    assert.deepEqual(out, { kind: "corruption", currentVersion: 1 });
    assert.equal(registry.getArtifactById(id)!.version, 1);
  } finally {
    cleanup();
  }
});

test("commitCas rejects an EXCLUSIVE caller (D4: use commit()) — throws, NO mutation", () => {
  const { registry, cleanup } = makeRegistry();
  try {
    const id = registry.resolveOrRegisterArtifact("plan.md", HASH_1);
    registry.acquireExclusive(id, AGENT_A, 60);
    assert.throws(
      () => registry.commitCas(id, AGENT_A, 1, HASH_2, 100),
      /commit_cas_not_allowed.*occ_is_shared_or_invalid_only/,
    );
    assert.equal(registry.getArtifactById(id)!.version, 1);
    assert.equal(registry.getAgentState(id, AGENT_A), MESIState.EXCLUSIVE);
  } finally {
    cleanup();
  }
});

test("commitCas admits an INVALID caller (parity: Python D4 allows S and I)", () => {
  const { registry, cleanup } = makeRegistry();
  try {
    const id = registry.resolveOrRegisterArtifact("plan.md", HASH_1);
    // B acquires E (A → would-be INVALID victim), then B releases without commit.
    registry.grantShared(id, AGENT_A, 40);
    registry.acquireExclusive(id, AGENT_B, 60);
    registry.invalidate(id, AGENT_B, 70, "session_stop");
    // A is INVALID, version unchanged, no M/E holder → Python admits: WIN.
    assert.equal(registry.getAgentState(id, AGENT_A), MESIState.INVALID);
    const out = registry.commitCas(id, AGENT_A, 1, HASH_2, 100);
    assert.equal(out.kind, "win");
    assert.equal(registry.getAgentState(id, AGENT_A), MESIState.SHARED);
  } finally {
    cleanup();
  }
});

test("commitCas missing artifact → throws", () => {
  const { registry, cleanup } = makeRegistry();
  try {
    assert.throws(() => registry.commitCas("f".repeat(32), AGENT_A, 1, HASH_2, 100), /not registered/);
  } finally {
    cleanup();
  }
});

test("commitCas serialized: two OCC writers on one version — exactly one wins", () => {
  const { registry, cleanup } = makeRegistry();
  try {
    const id = registry.resolveOrRegisterArtifact("plan.md", HASH_1);
    const first = registry.commitCas(id, AGENT_A, 1, HASH_2, 100);
    const second = registry.commitCas(id, AGENT_B, 1, HASH_1, 100);
    assert.equal(first.kind, "win");
    assert.deepEqual(second, { kind: "conflict", reason: "version_mismatch", currentVersion: 2 });
  } finally {
    cleanup();
  }
});

test("artifactNamesUnderPrefix: prefix filter, empty prefix = all, LIKE metachars literal", () => {
  const { registry, cleanup } = makeRegistry();
  try {
    registry.resolveOrRegisterArtifact("docs/plans/a.md", HASH_1);
    registry.resolveOrRegisterArtifact("docs/specs/b.md", HASH_1);
    registry.resolveOrRegisterArtifact("plan.md", HASH_1);
    registry.resolveOrRegisterArtifact("docs_v2/c.md", HASH_1);
    assert.deepEqual(registry.artifactNamesUnderPrefix("docs/"), [
      "docs/plans/a.md",
      "docs/specs/b.md",
    ]);
    assert.equal(registry.artifactNamesUnderPrefix("").length, 4);
    assert.deepEqual(registry.artifactNamesUnderPrefix("nomatch/"), []);
    // `_` in the prefix must be literal, not a LIKE wildcard: "docs_" must
    // NOT match "docs/plans/…".
    assert.deepEqual(registry.artifactNamesUnderPrefix("docs_"), ["docs_v2/c.md"]);
  } finally {
    cleanup();
  }
});
