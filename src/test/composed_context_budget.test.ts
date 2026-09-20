/**
 * The composed `additionalContext` byte budget on an admit path.
 *
 * WHY THIS FILE EXISTS. Python asserts its composed admit payload at
 * `<= 10240` bytes (tests/test_claude_code_coordinator_server.py:1025) — a
 * figure that is itself 240 bytes too generous, see the constant below.
 * Node had no equivalent, and that gap is what let a proposed fix ship a
 * notice-block bound (PR #150) whose COMPOSED payload still measured ~10.5 KB
 * — the bound was on one section, but the ceiling applies to the whole
 * `additionalContext`, and the co-tenants (stale-read or collision warning,
 * deferred re-grounding) are a runtime quantity a per-section constant cannot
 * know. Nothing in this repo would have failed.
 *
 * These tests measure the real thing: a real server, real preemptions over
 * HTTP, and the bytes that actually leave `/hooks/pre-read`. They do not call
 * the renderer directly, because calling the renderer directly is precisely how
 * the composed overrun was missed.
 *
 * Two tests, deliberately different in kind:
 *   1. A GUARD mirroring Python's: a realistic notice count stays under the
 *      ceiling. Passes today; catches a future change that inflates any section.
 *   2. A CHARACTERISATION of the known defect: above ~80 notices the composed
 *      payload EXCEEDS the ceiling, because the admit-path notice render is
 *      unbounded (tracked on Cohexa-ai/agent-coherence-plugin#138). It asserts
 *      the current, broken reality so that the fix cannot land silently: when
 *      the composed payload is bounded, this test FAILS and must be inverted.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";

import { ArtifactRegistry } from "../registry.js";
import { PolicyRef } from "../policy.js";
import { SessionRegistry } from "../sessions.js";
import { createServer } from "../server.js";

const SECRET = "s".repeat(32);

/**
 * The ceiling is 10,000, and it is the PLATFORM's, not this repo's.
 *
 * Every hook's `additionalContext` is passed through one function in the
 * Claude Code bundle before it reaches the model:
 *
 *   async function kee(e, r, n, {threshold: s = xJr, storageV5: a} = {}) {
 *     if (e.length <= s) return e;              // under: delivered verbatim
 *     let o = await B$(e, `hook-${r}-${n}`, w_(), a);   // over: to disk
 *     ...
 *   }
 *
 * with `xJr = 1e4`. Both `additionalContext` call sites pass no `threshold`,
 * so the default applies. Over it the prose is persisted to a file and the
 * model receives a 2,000-byte preview plus a path instead of the notice —
 * not a truncation, but not the coherence prose either. (A separate
 * aggregate budget, `oqt = uir * $_e` = 25000 * 4, governs batched dispatch
 * and is not this limit.)
 *
 * Two consequences worth stating, because both were previously guessed:
 *
 *   - The platform compares `e.length`, i.e. UTF-16 code units. These tests
 *     compare UTF-8 BYTES, which for this prose (`⚠`, `•`, `—` are all
 *     multi-byte) is the STRICTER measure. That is deliberate: erring tight
 *     is safe, erring loose is not.
 *   - 10,240 is 10 KiB where the platform means 10,000. An earlier revision
 *     of this comment rationalised the 10,240/10,000 split as a principled
 *     difference between the admit and session-start surfaces. There is no
 *     such difference — both surfaces go through `kee` with the same default.
 *     `src/test/session_start.test.ts:336`, `:583` already assert the right
 *     number; this file was the outlier, and Python's `<= 10240` still is.
 */
const COMPOSED_CONTEXT_CEILING_BYTES = 10_000;

async function makeServer() {
  const tmp = mkdtempSync(join(tmpdir(), "composed-ctx-"));
  const registry = new ArtifactRegistry(join(tmp, ".coherence", "state.db"));
  const server = createServer({
    secret: SECRET,
    startedAtMs: Date.now(),
    version: "test",
    registry,
    policy: PolicyRef.load(tmp),
    sessions: new SessionRegistry(),
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
  return { post, cleanup };
}

/**
 * Drive N real preemptions against one victim, then read the composed
 * `additionalContext` its next pre-read carries. Mirrors the shape of
 * Python's test: the victim takes a grant on each path, a distinct attacker
 * preempts each one, and the victim's next hook drains every notice at once.
 */
async function composedContextAfterPreemptions(
  n: number,
  pathLen: number,
): Promise<{ text: string; bullets: string[] }> {
  const { post, cleanup } = await makeServer();
  try {
    const pad = Math.max(1, pathLen - 14);
    // `docs/plans/**/*.md` is in DEFAULT_TRACKED_PATTERNS, so no policy call.
    const paths = Array.from({ length: n }, (_, i) => `docs/plans/${String(i).padStart(pad, "x")}.md`);
    const victim = "11111111-1111-4111-8111-111111111111";
    for (const p of paths) await post("/hooks/pre-edit", { session_id: victim, path: p });
    for (let i = 0; i < n; i++) {
      const attacker = `2222${String(i).padStart(4, "0")}-2222-4222-8222-222222222222`;
      await post("/hooks/pre-edit", { session_id: attacker, path: paths[i] });
    }
    // Arm deferred re-grounding through the REAL session-start endpoint, so the
    // measured payload carries all three co-tenants rather than two. This is
    // not decoration: re-grounding was the LARGEST co-tenant in the overrun
    // that motivated this file, and a fixture without it measures the section
    // least likely to cause the problem. Mirrors `armReground` in
    // src/test/deferred_reground_unit8.test.ts.
    await post("/hooks/session-start", { session_id: victim });

    const body = await post("/hooks/pre-read", { session_id: victim, path: paths[0] });
    const hso = body["hookSpecificOutput"] as { additionalContext?: string } | undefined;
    assert.ok(hso?.additionalContext, "a preempted victim's pre-read must carry additionalContext");
    const text = hso.additionalContext;

    // Every assertion below depends on the fixture having actually preempted.
    // A silent setup failure yields a small payload, which would make the
    // guard pass vacuously and the overrun test fail for the wrong reason —
    // so prove the three sections are present before measuring anything.
    assert.match(text, /Post-compaction re-grounding/, "re-grounding co-tenant missing from the fixture");
    assert.match(text, /⚠ Stale read/, "stale-read co-tenant missing from the fixture");
    const bullets = text.split("\n").filter((l) => l.startsWith("  • "));
    assert.equal(bullets.length, n, `expected ${n} notice bullets, got ${bullets.length}`);
    return { text, bullets };
  } finally {
    await cleanup();
  }
}

test("composed additionalContext: a realistic preemption load stays under the ceiling", async () => {
  // Python's own fixture size. Passes with wide headroom today; the value is
  // that it fires if ANY section — notices, the stale warning, re-grounding —
  // ever grows enough to threaten the composed ceiling in the common case.
  const { text } = await composedContextAfterPreemptions(20, 60);
  const bytes = Buffer.byteLength(text, "utf8");
  assert.ok(
    bytes <= COMPOSED_CONTEXT_CEILING_BYTES,
    `composed additionalContext should fit the ${COMPOSED_CONTEXT_CEILING_BYTES}-byte ceiling; got ${bytes}`,
  );
  // And it must actually be the multi-notice shape, or the guard is vacuous.
  // (The helper already pinned the bullet count and all three co-tenants.)
  assert.match(text, /20 of your EXCLUSIVE grants/);
});

test("KNOWN GAP (#138): the composed payload is unbounded and exceeds the ceiling at scale — invert this when fixed", async () => {
  // This asserts the DEFECT, on purpose. The admit-path notice render has no
  // bound, so a large enough preemption pile-up pushes the composed
  // additionalContext past what the hook surface carries. Measured on the
  // real path: 80 notices with 60-char paths -> ~10.6 KB. The point of
  // pinning it: the fix cannot land silently. When a composed-payload bound
  // exists, this assertion fails, and the author must flip it to `<=` and
  // fold it into the guard above — at which moment #138 closes.
  const { text, bullets } = await composedContextAfterPreemptions(80, 60);
  const bytes = Buffer.byteLength(text, "utf8");

  // The helper already asserted all 80 bullets are present. That ordering is
  // load-bearing: `bytes > ceiling` ALONE would stay green under a renderer
  // capped at 79 notices, or under some OTHER section bloating while the
  // notice render was fixed — both of which leave #138 open with CI passing.
  // The overrun only counts as evidence of THIS defect if nothing was dropped.
  assert.ok(
    bytes > COMPOSED_CONTEXT_CEILING_BYTES,
    `expected the KNOWN overrun (> ${COMPOSED_CONTEXT_CEILING_BYTES}) with all 80 notices ` +
      `rendered; got ${bytes}. If this now fits, the admit-path render has been bounded: ` +
      `invert this test, fold it into the guard above, and close #138.`,
  );

  // The overrun is by whole notices, never by a mangled one, so a future bound
  // that drops WHOLE bullets is distinguishable from a platform that truncates
  // at a byte offset. Anchored to the LAST bullet specifically: an unanchored
  // match is satisfied by any of the other 79 and would pass on a mangled tail.
  assert.match(
    bullets[bullets.length - 1] ?? "",
    /^ {2}• docs\/plans\/[x0-9]+\.md preempted by session 2222\d{4} at \d{4}-\d{2}-\d{2}T[0-9:.+-]+$/,
  );
});
