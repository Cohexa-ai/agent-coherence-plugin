/**
 * Byte budget on admit-path preemption prose.
 *
 * WHY THIS IS NOT THE CAP THAT WAS DEFERRED. The cap discussed on
 * Cohexa-ai/agent-coherence-plugin#138 is a COUNT cap — render three, delete
 * forty — and it is unsafe here because `popPendingNoticesForAgent` deletes
 * every row before the caller renders, so a count cap destroys thirty-seven
 * notices that would otherwise have been shown. It needs a bounded consume and
 * a reclaimer Node does not have.
 *
 * A BYTE budget is a different thing and does not carry that cost. It engages
 * only when the rendered text would exceed what the hook surface can carry —
 * which is exactly the case where the platform already truncates at an
 * arbitrary point, and where the rows are already gone because the pop deleted
 * them before the render. So it loses nothing that is not already lost; it
 * replaces a silent arbitrary cut with a bounded one that says what happened.
 * Below the budget nothing changes at all, which is the property these tests
 * exist to pin.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  NOTICE_PROSE_MAX_BYTES,
  preemptionNoticeText,
} from "../hook_payloads.js";

function notices(n: number, pathLen = 60): Array<{
  artifactPath: string;
  preempterSessionShort: string;
  preemptedAtUnixTs: number;
}> {
  return Array.from({ length: n }, (_, i) => ({
    artifactPath: "docs/plans/" + String(i).padStart(Math.max(1, pathLen - 14), "x") + ".md",
    preempterSessionShort: "f2f7eab3",
    preemptedAtUnixTs: 1748088000 + i,
  }));
}

test("notice prose: below the budget the render is byte-for-byte unchanged", () => {
  // The load-bearing property. A guard that alters the common case is a
  // behaviour change to a surface held at cross-backend parity; this one must
  // not be. Ten notices is far under any plausible budget.
  const small = notices(10);
  const text = preemptionNoticeText(small);
  assert.ok(
    Buffer.byteLength(text, "utf8") < NOTICE_PROSE_MAX_BYTES,
    "fixture must sit under the budget or it tests the wrong branch",
  );
  // Every path must appear: nothing dropped, nothing summarised.
  for (const n of small) assert.ok(text.includes(n.artifactPath), `dropped ${n.artifactPath}`);
  assert.doesNotMatch(text, /omitted/i, "no overflow line below the budget");
});

test("notice prose: a render that would exceed the budget is bounded", () => {
  const text = preemptionNoticeText(notices(400));
  assert.ok(
    Buffer.byteLength(text, "utf8") <= NOTICE_PROSE_MAX_BYTES,
    `expected <= ${NOTICE_PROSE_MAX_BYTES} bytes, got ${Buffer.byteLength(text, "utf8")}`,
  );
});

test("notice prose: the bound holds across path lengths and counts", () => {
  // The count at which the budget bites depends on path length, so pin the
  // INVARIANT (never exceeds) rather than any threshold count.
  for (const pathLen of [20, 60, 120, 200]) {
    for (const n of [50, 200, 1000]) {
      const bytes = Buffer.byteLength(preemptionNoticeText(notices(n, pathLen)), "utf8");
      assert.ok(
        bytes <= NOTICE_PROSE_MAX_BYTES,
        `pathLen=${pathLen} n=${n} produced ${bytes} bytes`,
      );
    }
  }
});

test("notice prose: truncation says how many it dropped, and does not claim they are queued", () => {
  const text = preemptionNoticeText(notices(400));
  assert.match(text, /omitted/i, "a truncated render must say so");

  // The session-start overflow line promises the remainder "surface on your
  // next tracked-file operation". That is true there because session-start
  // PEEKS. Here the pop already deleted them, so the same words would be a
  // lie — the exact defect PR #140 fixed on the other overflow line.
  assert.doesNotMatch(text, /still queued/i);
  assert.doesNotMatch(text, /next tracked-file operation/i);
});

test("notice prose: the intro still reports the TRUE total, not the rendered count", () => {
  // An operator told "3 grants were revoked" when forty were is worse off than
  // one told forty and shown three.
  const text = preemptionNoticeText(notices(400));
  assert.match(text, /400/, "intro must carry the true total");
});

test("notice prose: truncation keeps the newest, because the registry orders newest-first", () => {
  // selectPendingNoticesForAgent returns ORDER BY preempted_at_unix_ts DESC,
  // so a prefix is the most recent — the most informative for the next
  // decision. Taking a prefix is therefore the correct truncation.
  const ordered = notices(400).reverse(); // index 399 newest first
  const text = preemptionNoticeText(ordered);
  assert.ok(text.includes(ordered[0]!.artifactPath), "the first (newest) notice must survive");
  assert.ok(
    !text.includes(ordered[ordered.length - 1]!.artifactPath),
    "the oldest must be the one dropped",
  );
});

test("notice prose: no multi-byte character is split by the bound", () => {
  // The prose carries ⚠, • and — . Truncating at a byte offset could split a
  // UTF-8 sequence; dropping whole bullets cannot. Round-tripping through a
  // strict decoder proves it.
  const text = preemptionNoticeText(notices(400, 120));
  const buf = Buffer.from(text, "utf8");
  assert.equal(new TextDecoder("utf-8", { fatal: true }).decode(buf), text);
});
