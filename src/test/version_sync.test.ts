/**
 * Manifest version-sync guard tests — tools/check_versions_synced.js, the
 * surface tools/check_release_readiness.js consumes as its fourth check.
 *
 * Origin: v0.3.1 shipped with .claude-plugin/marketplace.json still at 0.3.0.
 * PR #95 bumped package.json and plugin.json only; the pre-commit hook that
 * runs the sync check is advisory, nothing in CI enforced it, and the release
 * workflow compared the tag against package.json alone. These tests pin the
 * enforced contract:
 *   1. Drift across the three manifests → exit 1 naming every file=version.
 *   2. Sync → exit 0, silent (pre-commit contract).
 *   3. A manifest missing its version field → exit 1 naming the file.
 *   4. RELEASE_TAG=v<version> passes; any other RELEASE_TAG fails; unset
 *      RELEASE_TAG skips only the tag comparison.
 *   5. The REAL repo manifests are in sync (the regression this file is for —
 *      this test fails on the exact tree v0.3.1 was tagged from).
 *   6. evaluateVersionSync() is importable without executing the CLI entry
 *      point (how check_release_readiness.js consumes it).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// __dirname at runtime is dist/test/; plugin root is two levels up
const __filename = fileURLToPath(import.meta.url);
const PLUGIN_ROOT = resolve(dirname(__filename), "..", "..");
const TOOL = join(PLUGIN_ROOT, "tools", "check_versions_synced.js");

interface ManifestVersions {
  pkg?: string;
  plugin?: string;
  marketplace?: string;
}

/** Write the three manifests under root; omit a version by leaving its field out. */
function writeManifests(root: string, versions: ManifestVersions): void {
  mkdirSync(join(root, ".claude-plugin"), { recursive: true });
  writeFileSync(
    join(root, "package.json"),
    JSON.stringify({ name: "fixture", ...(versions.pkg !== undefined && { version: versions.pkg }) }),
  );
  writeFileSync(
    join(root, ".claude-plugin", "plugin.json"),
    JSON.stringify({ name: "fixture", ...(versions.plugin !== undefined && { version: versions.plugin }) }),
  );
  writeFileSync(
    join(root, ".claude-plugin", "marketplace.json"),
    JSON.stringify({
      plugins: [{ name: "fixture", ...(versions.marketplace !== undefined && { version: versions.marketplace }) }],
    }),
  );
}

/** Run the checker CLI; root=null runs it against the real repo. */
function runChecker(
  root: string | null,
  releaseTag?: string,
): { status: number; stdout: string; stderr: string } {
  const env = { ...process.env };
  delete env["RELEASE_TAG"];
  if (releaseTag !== undefined) env["RELEASE_TAG"] = releaseTag;
  const result = spawnSync(process.execPath, [TOOL, ...(root === null ? [] : [root])], {
    encoding: "utf-8",
    env,
    timeout: 10000,
  });
  return {
    status: result.status ?? -1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

function withFixture(versions: ManifestVersions, run: (root: string) => void): void {
  const root = mkdtempSync(join(tmpdir(), "version-sync-"));
  try {
    writeManifests(root, versions);
    run(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("version drift across the three manifests → exit 1 naming every file=version", () => {
  withFixture({ pkg: "0.3.1", plugin: "0.3.1", marketplace: "0.3.0" }, (root) => {
    const res = runChecker(root);
    assert.equal(res.status, 1);
    assert.match(res.stderr, /version drift/);
    assert.match(res.stderr, /package\.json=0\.3\.1/);
    assert.match(res.stderr, /\.claude-plugin\/marketplace\.json=0\.3\.0/);
  });
});

test("synced manifests → exit 0, silent", () => {
  withFixture({ pkg: "1.2.3", plugin: "1.2.3", marketplace: "1.2.3" }, (root) => {
    const res = runChecker(root);
    assert.equal(res.status, 0);
    assert.equal(res.stdout, "");
    assert.equal(res.stderr, "");
  });
});

test("manifest missing its version field → exit 1 naming the file", () => {
  withFixture({ pkg: "1.2.3", plugin: "1.2.3" }, (root) => {
    const res = runChecker(root);
    assert.equal(res.status, 1);
    assert.match(res.stderr, /missing version field/);
    assert.match(res.stderr, /\.claude-plugin\/marketplace\.json/);
  });
});

test("RELEASE_TAG matching v<version> → exit 0", () => {
  withFixture({ pkg: "1.2.3", plugin: "1.2.3", marketplace: "1.2.3" }, (root) => {
    const res = runChecker(root, "v1.2.3");
    assert.equal(res.status, 0);
    assert.equal(res.stderr, "");
  });
});

test("RELEASE_TAG differing from v<version> → exit 1 naming both", () => {
  withFixture({ pkg: "1.2.3", plugin: "1.2.3", marketplace: "1.2.3" }, (root) => {
    const res = runChecker(root, "v9.9.9");
    assert.equal(res.status, 1);
    assert.match(res.stderr, /tag v9\.9\.9 does not match manifest version 1\.2\.3/);
  });
});

test("regression: the real repo manifests are in sync", () => {
  const res = runChecker(null);
  assert.equal(res.status, 0, `real-repo manifests drifted:\n${res.stderr}`);
  assert.equal(res.stderr, "");
});

interface SyncModule {
  evaluateVersionSync(rootDir: string, tag?: string): { ok: boolean; detail: string };
}

test("evaluateVersionSync is importable without executing the CLI", async () => {
  const mod = (await import(pathToFileURL(TOOL).href)) as SyncModule;
  withFixture({ pkg: "0.3.1", plugin: "0.3.1", marketplace: "0.3.0" }, (root) => {
    const drifted = mod.evaluateVersionSync(root, undefined);
    assert.equal(drifted.ok, false);
    assert.match(drifted.detail, /version drift/);
  });
  withFixture({ pkg: "1.2.3", plugin: "1.2.3", marketplace: "1.2.3" }, (root) => {
    assert.equal(mod.evaluateVersionSync(root, "v1.2.3").ok, true);
    assert.equal(mod.evaluateVersionSync(root, "v0.0.1").ok, false);
    const noTag = mod.evaluateVersionSync(root, undefined);
    assert.equal(noTag.ok, true);
    assert.match(noTag.detail, /tag check skipped/);
  });
});
