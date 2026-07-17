/**
 * SB-25 Unit 1 — composite subagent identity, cross-language byte parity.
 *
 * The expected hexes are Python-authority vectors, computed with:
 *   uuid5(NAMESPACE_URL, "ccs-agent:claude-session-<sid>[:subagent-<aid>]").hex
 * A one-char fold-string divergence between backends would silently fork
 * the shared agent_states rows — these vectors are the guard.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { sessionToAgentId } from "../agent_id.js";

const SID = "deadbeef";
const SUB_A = "a0826622451ec196f";
const SUB_B = "b1937733562fd2a7e";

test("parent derivation unchanged (byte-identical to pre-SB-25)", () => {
  assert.equal(sessionToAgentId(SID), "c72c9b5c603054adbc7fa70a4887d327");
  // Absent, null, and empty subagent ids are all the parent path.
  assert.equal(sessionToAgentId(SID, null), sessionToAgentId(SID));
  assert.equal(sessionToAgentId(SID, ""), sessionToAgentId(SID));
});

test("subagent derivation: distinct, stable, Python-byte-identical", () => {
  assert.equal(sessionToAgentId(SID, SUB_A), "00bc1e3b20975c899de6d7b138acc202");
  assert.equal(sessionToAgentId(SID, SUB_B), "be73a85d9be95187a61e421795012f85");
  // Stability + distinctness.
  assert.equal(sessionToAgentId(SID, SUB_A), sessionToAgentId(SID, SUB_A));
  assert.notEqual(sessionToAgentId(SID, SUB_A), sessionToAgentId(SID, SUB_B));
  assert.notEqual(sessionToAgentId(SID, SUB_A), sessionToAgentId(SID));
});
