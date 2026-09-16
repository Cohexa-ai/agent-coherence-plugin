/**
 * Pending-notice queue ordering (registry level).
 *
 * The rendered prose implicitly claims the notices it shows are the most
 * recent ones, and every capped renderer sorts newest-first by hand before
 * slicing. The SELECT underneath had no ORDER BY, so it returned rows in
 * `artifact_id` ASCII order — and artifact ids are `randomUUID()`, i.e.
 * uncorrelated with preemption time. That is harmless only while every
 * caller drains and renders the whole queue; the moment a caller consumes a
 * bounded slice it would delete a different set than it displayed. Python
 * pins the same order in `sqlite_registry.pop_pending_notices`
 * (`ORDER BY preempted_at_unix_ts DESC, artifact_id DESC`).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ArtifactRegistry } from "../registry.js";

function makeRegistry(): { registry: ArtifactRegistry; cleanup: () => void } {
  const tmp = mkdtempSync(join(tmpdir(), "notices-test-"));
  const registry = new ArtifactRegistry(join(tmp, "state.db"));
  return {
    registry,
    cleanup: () => {
      registry.close();
      rmSync(tmp, { recursive: true, force: true });
    },
  };
}

const VICTIM = "a".repeat(32);
const PREEMPTER = "b".repeat(32);
const HASH_1 = "1".repeat(64);

/** Queue one notice for VICTIM on a fresh artifact, preempted at `ts`. */
function queueNotice(registry: ArtifactRegistry, name: string, ts: number): void {
  const id = registry.resolveOrRegisterArtifact(name, HASH_1);
  registry.grantShared(id, VICTIM, ts);
  registry.acquireExclusive(id, PREEMPTER, ts);
}

test("pending notices come back newest-first, not in artifact-id order", () => {
  const { registry, cleanup } = makeRegistry();
  try {
    // Twelve, inserted oldest-first. Artifact ids are random UUIDs, so an
    // unordered SELECT returns them in an order uncorrelated with time; the
    // chance it happens to match newest-first is 1/12!, which is why this
    // count rather than two or three.
    for (let i = 0; i < 12; i++) queueNotice(registry, `docs/plans/p${i}.md`, 1000 + i);

    const seen = registry.peekPendingNoticesForAgent(VICTIM);
    assert.equal(seen.length, 12);
    assert.deepEqual(
      seen.map((n) => n.preemptedAtUnixTs),
      [1011, 1010, 1009, 1008, 1007, 1006, 1005, 1004, 1003, 1002, 1001, 1000],
    );
  } finally {
    cleanup();
  }
});

test("equal timestamps break the tie on artifact_id descending", () => {
  const { registry, cleanup } = makeRegistry();
  try {
    // Same instant for all three: the tiebreak is the only thing deciding
    // order, so a missing second sort key shows up here and nowhere else.
    for (const name of ["a.md", "b.md", "c.md"]) queueNotice(registry, name, 2000);

    const ids = registry.peekPendingNoticesForAgent(VICTIM).map((n) => n.artifactId);
    assert.equal(ids.length, 3);
    assert.deepEqual(ids, [...ids].sort().reverse());
  } finally {
    cleanup();
  }
});

test("popPendingNoticesForAgent returns the same order it deletes", () => {
  const { registry, cleanup } = makeRegistry();
  try {
    for (let i = 0; i < 12; i++) queueNotice(registry, `docs/plans/q${i}.md`, 3000 + i);

    const popped = registry.popPendingNoticesForAgent(VICTIM);
    assert.deepEqual(
      popped.map((n) => n.preemptedAtUnixTs),
      [3011, 3010, 3009, 3008, 3007, 3006, 3005, 3004, 3003, 3002, 3001, 3000],
    );
    assert.equal(registry.peekPendingNoticesForAgent(VICTIM).length, 0);
  } finally {
    cleanup();
  }
});
