/**
 * Version single-source-of-truth regression guard.
 *
 * The coordinator's served version (surfaced in /health + /status for
 * version-skew diagnostics) is read from package.json at runtime by
 * src/version.ts — replacing a hand-maintained constant that silently
 * drifted (stuck at 0.1.1 through the 0.2.x/0.3.x releases).
 *
 * These tests pin the two things that could break the read:
 *   1. Path resolution — version.ts resolves ../package.json relative to its
 *      own compiled location (dist/version.js → repo root; same shape as the
 *      ${CLAUDE_PLUGIN_DATA} tree staged by bin/ensure-coordinator-node). A
 *      change to outDir nesting or the provisioning layout breaks this loudly.
 *   2. Value shape — a real release semver, not a fallback or empty string.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { readPackageVersion } from "../version.js";

test("readPackageVersion returns the version declared in package.json", () => {
  // Resolve the manifest independently (from dist/test/, two levels up) so a
  // resolution bug in version.ts can't cancel out of the comparison.
  const manifest = JSON.parse(
    readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
  ) as { version?: unknown };
  assert.equal(typeof manifest.version, "string");
  assert.equal(readPackageVersion(), manifest.version);
});

test("readPackageVersion yields a semver-shaped release version", () => {
  assert.match(readPackageVersion(), /^\d+\.\d+\.\d+/);
});
