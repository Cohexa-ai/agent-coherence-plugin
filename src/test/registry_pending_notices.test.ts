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
const PREEMPTER_2 = "c".repeat(32);
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

test("a same-second re-preemption names the NEW preempter, not the first one", () => {
  const { registry, cleanup } = makeRegistry();
  try {
    // The victim is preempted, re-arms, and is preempted again by a DIFFERENT
    // session inside the same whole second. Timestamps are whole seconds
    // (`nowUnix()` floors), so the two preemptions are indistinguishable by
    // time — and the upsert's guard was a strict `>`, which declines an equal
    // timestamp and leaves the row naming the session that is no longer the
    // preempter. The rendered bullet then attributes the preemption to the
    // wrong session, which is the operator's only record of who took the
    // grant.
    //
    // Reachable on the strict-mode path specifically: `pre_bash.ts` re-grants
    // SHARED, then returns the deny BEFORE `drainNoticeText`, so the row from
    // the first preemption is still queued when the second one lands.
    const id = registry.resolveOrRegisterArtifact("docs/plans/contended.md", HASH_1);
    registry.grantShared(id, VICTIM, 5000);
    registry.acquireExclusive(id, PREEMPTER, 5000);
    registry.grantShared(id, VICTIM, 5000); // the strict-path re-arm
    registry.acquireExclusive(id, PREEMPTER_2, 5000);

    const notices = registry.peekPendingNoticesForAgent(VICTIM);
    assert.equal(notices.length, 1, "one artifact must still mean one notice row");
    assert.equal(
      notices[0]?.preempterAgentId,
      PREEMPTER_2,
      "the notice must name the session that actually holds the grant now",
    );
  } finally {
    cleanup();
  }
});

test("an out-of-order older preemption still cannot overwrite a newer notice", () => {
  const { registry, cleanup } = makeRegistry();
  try {
    // The guard the `>` was there for. Relaxing it to `>=` must keep this:
    // a strictly OLDER timestamp is still refused, so only same-second
    // last-write-wins changed.
    const id = registry.resolveOrRegisterArtifact("docs/plans/ordered.md", HASH_1);
    registry.grantShared(id, VICTIM, 7000);
    registry.acquireExclusive(id, PREEMPTER, 7000);
    registry.grantShared(id, VICTIM, 6000);
    registry.acquireExclusive(id, PREEMPTER_2, 6000); // older: must not win

    const notices = registry.peekPendingNoticesForAgent(VICTIM);
    assert.equal(notices[0]?.preempterAgentId, PREEMPTER);
    assert.equal(notices[0]?.preemptedAtUnixTs, 7000);
  } finally {
    cleanup();
  }
});
