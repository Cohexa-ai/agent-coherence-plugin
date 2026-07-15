/**
 * Unit 5 — backend dispatcher + universal hook-client shim + Node-first CLI
 * shims (zero-Python exposure seam). Subprocess style per bin_shims.test.ts.
 *
 * The dispatcher itself is exercised with stubbed bootstrap scripts (we
 * assert WHICH bootstrap it selects, not the bootstrap's own behavior).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, cpSync, chmodSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const PLUGIN_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

/**
 * Build an isolated plugin-root copy whose ensure-coordinator{,-node} are
 * stubs that print which one ran. Returns the stub root.
 */
function makeStubbedPluginRoot(): { root: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), "dispatch5-"));
  mkdirSync(join(root, "bin"), { recursive: true });
  cpSync(join(PLUGIN_ROOT, "bin", "ensure-coordinator-dispatch"), join(root, "bin", "ensure-coordinator-dispatch"));
  for (const [name, marker] of [
    ["ensure-coordinator", "PYTHON-BOOTSTRAP"],
    ["ensure-coordinator-node", "NODE-BOOTSTRAP"],
  ] as const) {
    const p = join(root, "bin", name);
    writeFileSync(p, `#!/usr/bin/env bash\necho ${marker}\n`, "utf8");
    chmodSync(p, 0o755);
  }
  chmodSync(join(root, "bin", "ensure-coordinator-dispatch"), 0o755);
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

function runDispatch(stubRoot: string, cwd: string, env: Record<string, string | undefined>) {
  return spawnSync("bash", [join(stubRoot, "bin", "ensure-coordinator-dispatch")], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, COHERENCE_COORDINATOR_BACKEND: undefined, ...env } as NodeJS.ProcessEnv,
    timeout: 10000,
  });
}

test("dispatcher: default (no config) selects the Python bootstrap", () => {
  const { root, cleanup } = makeStubbedPluginRoot();
  const ws = mkdtempSync(join(tmpdir(), "dispatch5-ws-"));
  try {
    spawnSync("git", ["init", "-q"], { cwd: ws });
    const r = runDispatch(root, ws, {});
    assert.equal(r.stdout.trim(), "PYTHON-BOOTSTRAP");
  } finally {
    cleanup();
    rmSync(ws, { recursive: true, force: true });
  }
});

test("dispatcher: .coherence/coordinator_backend=node selects the Node bootstrap", () => {
  const { root, cleanup } = makeStubbedPluginRoot();
  const ws = mkdtempSync(join(tmpdir(), "dispatch5-ws-"));
  try {
    spawnSync("git", ["init", "-q"], { cwd: ws });
    mkdirSync(join(ws, ".coherence"), { recursive: true });
    writeFileSync(join(ws, ".coherence", "coordinator_backend"), "node\n", "utf8");
    const r = runDispatch(root, ws, {});
    assert.equal(r.stdout.trim(), "NODE-BOOTSTRAP");
  } finally {
    cleanup();
    rmSync(ws, { recursive: true, force: true });
  }
});

test("dispatcher: env override beats the file; unknown values fall back to python", () => {
  const { root, cleanup } = makeStubbedPluginRoot();
  const ws = mkdtempSync(join(tmpdir(), "dispatch5-ws-"));
  try {
    spawnSync("git", ["init", "-q"], { cwd: ws });
    mkdirSync(join(ws, ".coherence"), { recursive: true });
    writeFileSync(join(ws, ".coherence", "coordinator_backend"), "python\n", "utf8");
    const env = runDispatch(root, ws, { COHERENCE_COORDINATOR_BACKEND: "node" });
    assert.equal(env.stdout.trim(), "NODE-BOOTSTRAP");
    const unknown = runDispatch(root, ws, { COHERENCE_COORDINATOR_BACKEND: "cobol" });
    assert.equal(unknown.stdout.trim(), "PYTHON-BOOTSTRAP");
  } finally {
    cleanup();
    rmSync(ws, { recursive: true, force: true });
  }
});

test("hook-client shim: routes to the Node client (fail-open '{}' when coordinator absent)", () => {
  const ws = mkdtempSync(join(tmpdir(), "dispatch5-ws-"));
  try {
    spawnSync("git", ["init", "-q"], { cwd: ws });
    const r = spawnSync("bash", [join(PLUGIN_ROOT, "bin", "hook-client"), "session-stop"], {
      cwd: ws,
      encoding: "utf8",
      input: JSON.stringify({ session_id: "44444444-4444-4444-8444-444444444444" }),
      env: { ...process.env, CLAUDE_PLUGIN_ROOT: PLUGIN_ROOT },
      timeout: 10000,
    });
    assert.equal(r.status, 0);
    assert.equal(r.stdout.trim(), "{}"); // no coordinator running → Node client fail-open
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test("hook-client shim: no node + no python client → '{}' floor, exit 0", () => {
  const ws = mkdtempSync(join(tmpdir(), "dispatch5-ws-"));
  try {
    // Absolute /bin/bash: the scrubbed PATH must apply INSIDE the script
    // (hiding node + the Python client), not to resolving bash itself.
    const r = spawnSync("/bin/bash", [join(PLUGIN_ROOT, "bin", "hook-client"), "pre-read"], {
      cwd: ws,
      encoding: "utf8",
      input: "{}",
      env: { PATH: "/nonexistent", CLAUDE_PLUGIN_ROOT: PLUGIN_ROOT } as NodeJS.ProcessEnv,
      timeout: 10000,
    });
    assert.equal(r.status, 0);
    assert.equal(r.stdout.trim(), "{}");
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test("CLI shim Probe 0: agent-coherence-status resolves to the Node CLI", () => {
  const ws = mkdtempSync(join(tmpdir(), "dispatch5-ws-"));
  try {
    // No coordinator running → the Node CLI (unlike the hook-client) signals
    // failure with exit 2 + an actionable stderr. Proves Probe 0 selected it
    // (the Python-script fallback would exit 127-style through probe errors).
    const r = spawnSync("bash", [join(PLUGIN_ROOT, "bin", "agent-coherence-status"), "--root", ws], {
      cwd: ws,
      encoding: "utf8",
      env: { ...process.env, CLAUDE_PLUGIN_ROOT: PLUGIN_ROOT },
      timeout: 10000,
    });
    assert.equal(r.status, 2);
    assert.match(r.stderr, /agent-coherence-status: no coordinator running/);
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});
