/**
 * AC-03 cross-backend /status shape parity tests.
 *
 * The Python coordinator's /status default tier emits:
 *   tracked_artifacts: [{path, version, id}]
 *   sessions: [{agent_name, agent_id, states: {path: state_name}}]
 *
 * Node previously emitted:
 *   tracked_artifacts: [{id, name, version}]      (key divergence: name vs path)
 *   sessions: [{agent_id}]                        (missing agent_name + states)
 *
 * These tests pin the corrected shape so any future regression on the
 * Node side breaks loudly (the agent-coherence-status CLI reads
 * `agent_name` and `states` directly — silent empty against the old
 * shape).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { createServer } from "../server.js";
import { ArtifactRegistry } from "../registry.js";
import { PolicyRef } from "../policy.js";
import { SessionRegistry } from "../sessions.js";

function makeOptions() {
  const tmp = mkdtempSync(join(tmpdir(), "ac03-test-"));
  const registry = new ArtifactRegistry(join(tmp, "state.db"));
  const policy = PolicyRef.load(tmp);
  const sessions = new SessionRegistry();
  const cleanup = (): void => {
    registry.close();
    try {
      rmSync(tmp, { recursive: true, force: true });
    } catch {
      // best-effort
    }
  };
  return {
    options: {
      secret: "test-secret-not-used-in-direct-handler-tests",
      startedAtMs: Date.now() - 100,
      version: "0.1.1-test",
      registry,
      policy,
      sessions,
    },
    cleanup,
    tmp,
  };
}

async function statusBody(server: ReturnType<typeof createServer>, secret: string): Promise<{
  status: number;
  body: Record<string, unknown>;
}> {
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error(`unexpected server address: ${String(address)}`);
  }
  const url = `http://127.0.0.1:${address.port}/status`;
  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${secret}`,
      Host: "127.0.0.1",
    },
  });
  const body = (await res.json()) as Record<string, unknown>;
  return { status: res.status, body };
}

test("AC-03: tracked_artifacts entries use 'path' (Python parity)", async () => {
  const { options, cleanup } = makeOptions();
  try {
    const sid = "11111111-2222-4111-8111-aaaaaaaaaaaa";
    const agentId = options.sessions.registerSession(sid);
    const artId = options.registry.resolveOrRegisterArtifact("plan.md", "abc");
    options.registry.grantShared(artId, agentId, 0);

    const server = createServer(options);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    try {
      const { status, body } = await statusBody(server, options.secret);
      assert.equal(status, 200);
      const arts = body.tracked_artifacts as ReadonlyArray<Record<string, unknown>>;
      assert.ok(Array.isArray(arts) && arts.length >= 1);
      assert.equal(typeof arts[0]!.path, "string", "tracked_artifacts entries must carry 'path'");
      assert.equal(arts[0]!.path, "plan.md");
      assert.equal(typeof arts[0]!.version, "number");
      assert.equal(typeof arts[0]!.id, "string");
      assert.equal(
        (arts[0] as Record<string, unknown>).name,
        undefined,
        "tracked_artifacts entries must NOT carry deprecated 'name' key",
      );
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  } finally {
    cleanup();
  }
});

test("AC-03: sessions entries carry agent_name + states map (Python parity)", async () => {
  const { options, cleanup } = makeOptions();
  try {
    const sid = "22222222-3333-4222-8222-bbbbbbbbbbbb";
    const agentId = options.sessions.registerSession(sid);
    const artId = options.registry.resolveOrRegisterArtifact("plan.md", "abc");
    options.registry.acquireExclusive(artId, agentId, 0);

    const server = createServer(options);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    try {
      const { status, body } = await statusBody(server, options.secret);
      assert.equal(status, 200);
      const sessions = body.sessions as ReadonlyArray<Record<string, unknown>>;
      assert.ok(Array.isArray(sessions) && sessions.length === 1);
      const s = sessions[0]!;
      assert.equal(s.agent_id, agentId);
      assert.equal(typeof s.agent_name, "string", "sessions entries must carry agent_name");
      assert.match(
        s.agent_name as string,
        /^claude-session-/,
        "agent_name must be the human-readable claude-session-<id> form",
      );
      const states = s.states as Record<string, string>;
      assert.deepEqual(states, { "plan.md": "EXCLUSIVE" });
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  } finally {
    cleanup();
  }
});

test("AC-03: INVALID states excluded from per-agent states map (Python parity)", async () => {
  const { options, cleanup } = makeOptions();
  try {
    const sid = "33333333-4444-4333-8333-cccccccccccc";
    const agentId = options.sessions.registerSession(sid);
    const artId = options.registry.resolveOrRegisterArtifact("plan.md", "abc");
    // Acquire then invalidate so the agent appears in the active set
    // with an INVALID state rather than no row at all.
    options.registry.acquireExclusive(artId, agentId, 0);
    options.registry.invalidate(artId, agentId, 1);

    const server = createServer(options);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    try {
      const { body } = await statusBody(server, options.secret);
      const sessions = body.sessions as ReadonlyArray<Record<string, unknown>>;
      // listActiveAgents may or may not include this agent depending on
      // whether INVALID-only counts as "active". Either way: if the agent
      // appears, its states map must be empty (no INVALID entries).
      for (const s of sessions) {
        if (s.agent_id === agentId) {
          assert.deepEqual(
            s.states,
            {},
            "INVALID state must not appear in sessions[].states",
          );
        }
      }
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  } finally {
    cleanup();
  }
});
