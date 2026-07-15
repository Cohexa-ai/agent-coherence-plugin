/**
 * Unit 1 — appendPolicyYaml + PolicyRef live-reload (zero-Python plan).
 *
 * Contract mirrors Python `_append_policy_yaml`: validation reasons, dedupe
 * (duplicates excluded from `added`), append-preserving-existing, exact
 * byte-cap message. PolicyRef is the stale-by-reference guard: a reload after
 * an append must be visible through the ref with no restart.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  appendPolicyYaml,
  PolicyRef,
  MAX_POLICY_YAML_BYTES,
} from "../policy.js";

function makeRoot(): { root: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), "policy-test-"));
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

test("appendPolicyYaml: fresh file — adds valid paths, rejects traversal/absolute/empty", () => {
  const { root, cleanup } = makeRoot();
  try {
    const yamlPath = join(root, ".coherence", "tracked.yaml");
    const out = appendPolicyYaml(yamlPath, ["notes.md", "/etc/passwd", "../up.md", ""]);
    assert.deepEqual(out.added, ["notes.md"]);
    assert.deepEqual(out.rejected, [
      { path: "/etc/passwd", reason: "absolute path" },
      { path: "../up.md", reason: "contains '..'" },
      { path: "", reason: "empty" },
    ]);
    assert.equal(readFileSync(yamlPath, "utf8"), "- notes.md\n");
  } finally {
    cleanup();
  }
});

test("appendPolicyYaml: dedupe — a fully-duplicate request returns added: []", () => {
  const { root, cleanup } = makeRoot();
  try {
    const yamlPath = join(root, ".coherence", "tracked.yaml");
    appendPolicyYaml(yamlPath, ["notes.md"]);
    const out = appendPolicyYaml(yamlPath, ["notes.md"]);
    assert.deepEqual(out.added, []);
    assert.equal(readFileSync(yamlPath, "utf8"), "- notes.md\n");
  } finally {
    cleanup();
  }
});

test("appendPolicyYaml: appends to existing content without clobbering it", () => {
  const { root, cleanup } = makeRoot();
  try {
    const yamlPath = join(root, ".coherence", "tracked.yaml");
    mkdirSync(join(root, ".coherence"), { recursive: true });
    writeFileSync(yamlPath, "- existing.md\n", "utf8");
    const out = appendPolicyYaml(yamlPath, ["new.md", "existing.md"]);
    assert.deepEqual(out.added, ["new.md"]);
    assert.equal(readFileSync(yamlPath, "utf8"), "- existing.md\n- new.md\n");
  } finally {
    cleanup();
  }
});

test("appendPolicyYaml: byte cap → throws Python's exact message", () => {
  const { root, cleanup } = makeRoot();
  try {
    const yamlPath = join(root, ".coherence", "tracked.yaml");
    const huge = "x".repeat(MAX_POLICY_YAML_BYTES);
    assert.throws(
      () => appendPolicyYaml(yamlPath, [huge]),
      new RegExp(`policy YAML cap of ${MAX_POLICY_YAML_BYTES} bytes would be exceeded`),
    );
  } finally {
    cleanup();
  }
});

test("PolicyRef: reload after an append is visible through the ref (no stale-by-reference)", () => {
  const { root, cleanup } = makeRoot();
  try {
    const ref = PolicyRef.load(root);
    assert.equal(ref.isTracked("notes.md"), false);
    appendPolicyYaml(join(root, ".coherence", "tracked.yaml"), ["notes.md"]);
    // Before reload: the old snapshot still answers.
    assert.equal(ref.isTracked("notes.md"), false);
    ref.reload();
    assert.equal(ref.isTracked("notes.md"), true);
    // Untrack via ignored.yaml: ignore wins ties after reload.
    appendPolicyYaml(join(root, ".coherence", "ignored.yaml"), ["notes.md"]);
    ref.reload();
    assert.equal(ref.isTracked("notes.md"), false);
  } finally {
    cleanup();
  }
});
