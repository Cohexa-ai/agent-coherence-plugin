/**
 * bash_path_detector — direct unit coverage (previously only exercised
 * incidentally via single-file `cat FILE` route tests) + the ReDoS latency
 * regression that guards the negative-lookbehind in PATHLIKE_RE.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { detectTrackedPaths } from "../hooks/bash_path_detector.js";

const trackAll = () => true;

test("detectTrackedPaths: basic reader commands + quotes + pipelines", () => {
  const md = (p: string) => p.endsWith(".md");
  assert.deepEqual(detectTrackedPaths("cat CLAUDE.md", md), ["CLAUDE.md"]);
  assert.deepEqual(detectTrackedPaths("cat 'my docs/a.md'", md), ["my docs/a.md"]);
  // `foo` is grep's pattern, not a path — filtered out by the isTracked gate.
  assert.deepEqual(detectTrackedPaths("grep foo docs/a.md | head docs/b.md", md), [
    "docs/a.md",
    "docs/b.md",
  ]);
});

test("detectTrackedPaths: isTracked gate honored for extensioned tokens", () => {
  const onlyMd = (p: string) => p.endsWith(".md");
  assert.deepEqual(detectTrackedPaths("cat notes.txt plan.md", onlyMd), ["plan.md"]);
});

test("ReDoS regression: a 16KB dot-free eval body returns fast (negative-lookbehind guard)", () => {
  // The eval-body scan runs PATHLIKE_RE over the captured `python3 -c "..."`
  // body. Before the lookbehind was restored, a dot-free 16KB body drove
  // near-quadratic backtracking (~0.5–1.5s), blocking the single-threaded
  // coordinator. Bound generously to stay non-flaky on slow CI while still
  // catching a quadratic regression (which was seconds, not tens of ms).
  const adversarial = `python3 -c "${"a".repeat(16 * 1024)}"`;
  const start = process.hrtime.bigint();
  const out = detectTrackedPaths(adversarial, trackAll);
  const elapsedMs = Number(process.hrtime.bigint() - start) / 1e6;
  assert.deepEqual(out, []); // dot-free body → PATHLIKE_RE finds no candidate
  assert.ok(elapsedMs < 250, `detectTrackedPaths took ${elapsedMs.toFixed(1)}ms — possible ReDoS regression`);
});
