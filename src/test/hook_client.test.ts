/**
 * Unit 3 — Node hook-client: payload-builder parity, fail-open contract,
 * and a live end-to-end run against a real coordinator (subprocess, the
 * bin_shims.test.ts style).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { AddressInfo } from "node:net";
import { ArtifactRegistry } from "../registry.js";
import { PolicyRef } from "../policy.js";
import { SessionRegistry } from "../sessions.js";
import { createServer } from "../server.js";
import {
  buildPreRead,
  buildPreEdit,
  buildPostEdit,
  buildSessionStop,
  buildPreBash,
  buildPreGrep,
  SkipHook,
} from "../hook_client.js";
import { readPortFromPidFile } from "../hook_client_transport.js";

const SID = "44444444-4444-4444-8444-444444444444";
const HOOK_CLIENT_JS = join(dirname(fileURLToPath(import.meta.url)), "..", "hook_client.js");

function makeWorkspace(): { root: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), "hookclient-test-"));
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

// ------------------------------------------------------------- builders

test("buildPreRead: workspace-relative path + raw-bytes disk hash; unreadable → omitted", () => {
  const { root, cleanup } = makeWorkspace();
  try {
    const abs = join(root, "plan.md");
    // Non-UTF8-safe bytes: the hash must be over RAW bytes.
    const bytes = Buffer.from([0xe2, 0x9a, 0xa0, 0x0d, 0x0a, 0xff, 0x00, 0x41]);
    writeFileSync(abs, bytes);
    const body = buildPreRead({ session_id: SID, tool_input: { file_path: abs } }, root);
    assert.deepEqual(body, {
      session_id: SID,
      path: "plan.md",
      content_hash: createHash("sha256").update(bytes).digest("hex"),
    });
    // Unreadable file → content_hash omitted (never a crash).
    const missing = buildPreRead(
      { session_id: SID, tool_input: { file_path: join(root, "gone.md") } },
      root,
    );
    assert.deepEqual(missing, { session_id: SID, path: "gone.md" });
  } finally {
    cleanup();
  }
});

test("builders: outside-root path / missing fields → SkipHook", () => {
  const { root, cleanup } = makeWorkspace();
  try {
    assert.throws(
      () => buildPreEdit({ session_id: SID, tool_input: { file_path: "/etc/passwd" } }, root),
      SkipHook,
    );
    assert.throws(() => buildPreEdit({ tool_input: { file_path: join(root, "a.md") } }, root), SkipHook);
    assert.throws(() => buildPreBash({ session_id: SID, tool_input: { command: "   " } }), SkipHook);
    assert.throws(
      () => buildPreGrep({ session_id: SID, tool_input: { path: 42 } }, root),
      SkipHook,
    );
  } finally {
    cleanup();
  }
});

test("buildPostEdit: tool_response hash preferred; success defaults true; failure skips disk hash", () => {
  const { root, cleanup } = makeWorkspace();
  try {
    const abs = join(root, "plan.md");
    writeFileSync(abs, "content");
    const given = "a".repeat(64);
    const withHash = buildPostEdit(
      { session_id: SID, tool_input: { file_path: abs }, tool_response: { content_hash: given } },
      root,
    );
    assert.deepEqual(withHash, { session_id: SID, path: "plan.md", success: true, content_hash: given });

    const failed = buildPostEdit(
      { session_id: SID, tool_input: { file_path: abs }, tool_response: { success: false } },
      root,
    );
    assert.deepEqual(failed, { session_id: SID, path: "plan.md", success: false });
  } finally {
    cleanup();
  }
});

test("buildPreGrep: absolute → workspace-relative; './' stripped; empty passes through", () => {
  const { root, cleanup } = makeWorkspace();
  try {
    assert.deepEqual(buildPreGrep({ session_id: SID, tool_input: { path: join(root, "docs") } }, root), {
      session_id: SID,
      search_root: "docs",
    });
    assert.deepEqual(buildPreGrep({ session_id: SID, tool_input: { path: "./docs" } }, root), {
      session_id: SID,
      search_root: "docs",
    });
    assert.deepEqual(buildPreGrep({ session_id: SID, tool_input: {} }, root), {
      session_id: SID,
      search_root: "",
    });
  } finally {
    cleanup();
  }
});

test("SB-25 thread: a CC agent_id is carried into the body; absent → absent", () => {
  assert.deepEqual(buildSessionStop({ session_id: SID, agent_id: "sub-1" }), {
    session_id: SID,
    agent_id: "sub-1",
  });
  assert.deepEqual(buildSessionStop({ session_id: SID }), { session_id: SID });
});

// ------------------------------------------------------- pid-file parsing

test("readPortFromPidFile: 2-line Python format AND 3-line Node format; never needs backend=", () => {
  const { root, cleanup } = makeWorkspace();
  try {
    const pidFile = join(root, "server.pid");
    writeFileSync(pidFile, "12345\n54321\n"); // Python 2-line
    assert.equal(readPortFromPidFile(pidFile), 54321);
    writeFileSync(pidFile, "12345\n54321\nbackend=node\n"); // Node 3-line
    assert.equal(readPortFromPidFile(pidFile), 54321);
    writeFileSync(pidFile, "12345\n"); // 1 line → unusable
    assert.equal(readPortFromPidFile(pidFile), null);
    writeFileSync(pidFile, "12345\n99999\n"); // out of range
    assert.equal(readPortFromPidFile(pidFile), null);
  } finally {
    cleanup();
  }
});

// ------------------------------------------- fail-open contract (subprocess)

function runClient(args: string[], stdin: string, cwd: string): { stdout: string; status: number | null } {
  const r = spawnSync(process.execPath, [HOOK_CLIENT_JS, ...args], {
    input: stdin,
    cwd,
    encoding: "utf8",
    timeout: 10000,
  });
  return { stdout: r.stdout, status: r.status };
}

test("fail-open: coordinator down / bad stdin / unknown sub → '{}' + exit 0, always", () => {
  const { root, cleanup } = makeWorkspace();
  try {
    // A git repo with NO coordinator running.
    spawnSync("git", ["init", "-q"], { cwd: root });
    const down = runClient(["pre-edit", "--root", root], JSON.stringify({ session_id: SID, tool_input: { file_path: join(root, "a.md") } }), root);
    assert.equal(down.status, 0);
    assert.equal(down.stdout.trim(), "{}");

    const badJson = runClient(["pre-read", "--root", root], "not json {", root);
    assert.equal(badJson.status, 0);
    assert.equal(badJson.stdout.trim(), "{}");

    const badSub = runClient(["no-such-sub", "--root", root], "{}", root);
    assert.equal(badSub.status, 0);
    assert.equal(badSub.stdout.trim(), "{}");

    const emptyStdin = runClient(["session-stop", "--root", root], "", root);
    assert.equal(emptyStdin.status, 0);
    assert.equal(emptyStdin.stdout.trim(), "{}");
  } finally {
    cleanup();
  }
});

// ------------------------------------------------- live end-to-end

test("end-to-end: pre-bash through the real client against a live coordinator", async () => {
  const root = mkdtempSync(join(tmpdir(), "hookclient-e2e-"));
  const secret = "s".repeat(32);
  try {
    const registry = new ArtifactRegistry(join(root, ".coherence", "state.db"));
    const policy = PolicyRef.load(root);
    const sessions = new SessionRegistry();
    const server = createServer({
      secret,
      startedAtMs: Date.now(),
      version: "test",
      registry,
      policy,
      sessions,
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    const port = (server.address() as AddressInfo).port;
    // Write the coordinator discovery files the client resolves.
    mkdirSync(join(root, ".coherence"), { recursive: true });
    writeFileSync(join(root, ".coherence", "server.pid"), `${process.pid}\n${port}\nbackend=node\n`);
    writeFileSync(join(root, ".coherence", "hook.secret"), `${secret}\n`);

    // Seed a stale artifact: peer commits CLAUDE.md v2, our session never read it.
    const id = registry.resolveOrRegisterArtifact("CLAUDE.md", "1".repeat(64));
    const peer = sessions.registerSession("55555555-5555-5555-8555-555555555555");
    registry.acquireExclusive(id, peer, 10);
    registry.commit(id, peer, "2".repeat(64), 11);

    const cc = JSON.stringify({ session_id: SID, tool_input: { command: "cat CLAUDE.md" } });
    // MUST be an async spawn: spawnSync would block this event loop, and the
    // in-process coordinator could never answer the child's request (deadlock
    // → child timeout → half-open socket wedges server.close()).
    const r = await new Promise<{ stdout: string; status: number | null }>((resolveRun) => {
      const child = spawn(process.execPath, [HOOK_CLIENT_JS, "pre-bash", "--root", root], {
        cwd: root,
        stdio: ["pipe", "pipe", "ignore"],
      });
      let stdout = "";
      child.stdout.on("data", (c: Buffer) => (stdout += c.toString("utf8")));
      child.on("close", (status) => resolveRun({ stdout, status }));
      child.stdin.write(cc);
      child.stdin.end();
    });
    assert.equal(r.status, 0);
    const body = JSON.parse(r.stdout) as Record<string, unknown>;
    assert.equal(body.status, "stale");
    assert.deepEqual(body.stale_paths, ["CLAUDE.md"]);

    await new Promise<void>((r2) => server.close(() => r2()));
    registry.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("buildSubagentStop: agent_id REQUIRED (absence must never release the parent)", async () => {
  const { buildSubagentStop } = await import("../hook_client.js");
  assert.deepEqual(buildSubagentStop({ session_id: SID, agent_id: "sub-1" }), {
    session_id: SID,
    agent_id: "sub-1",
  });
  assert.deepEqual(buildSubagentStop({ session_id: SID, agentId: "sub-2" }), {
    session_id: SID,
    agent_id: "sub-2",
  });
  assert.throws(() => buildSubagentStop({ session_id: SID }), SkipHook);
});
