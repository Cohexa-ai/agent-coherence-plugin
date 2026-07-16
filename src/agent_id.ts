/**
 * Deterministic agent identity derivation.
 *
 * Mirrors Python `src/ccs/adapters/claude_code/coordinator_server.py:96-105`:
 *   agent_id = uuid5(NAMESPACE_URL, f"ccs-agent:claude-session-{session_id}")
 *
 * Per KTD-A.5 point 3 + KTD-B parity contract, the derivation MUST be
 * byte-identical with Python so the agent_states + heartbeats rows
 * written by either backend reference the same agent identity. The UUID5
 * algorithm is RFC 4122 v5 (SHA-1 of namespace + name; version 5 bits set)
 * — deterministic across implementations. Verified empirically against
 * Python: ccs-agent:claude-session-deadbeef → c72c9b5c603054adbc7fa70a4887d327
 * (both implementations).
 */
import { v5 as uuidv5 } from "uuid";

/** RFC 4122 §4.3 URL namespace UUID, matches Python `uuid.NAMESPACE_URL`. */
const NAMESPACE_URL = "6ba7b811-9dad-11d1-80b4-00c04fd430c8";

/**
 * Single source of truth for the subagent-id charset/length rule (SB-25).
 * Shared by the server-side reader (`readSubagentId`) AND the client-side
 * subagent-stop guard (`buildSubagentStop`) so the "must never release the
 * parent" invariant is enforced at BOTH layers, not just server-side.
 *
 * The Python mirror (`_SUBAGENT_ID_RE`) uses `\A…\Z` — NOT `$` — so a
 * trailing newline is rejected identically on both backends (JS `$` without
 * the `m` flag already anchors end-of-string only, so this literal `$` is
 * already newline-strict; kept explicit for parity with Python's `\Z`).
 */
export const SUBAGENT_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

/** True iff `value` is a well-formed subagent id (charset + length). */
export function isValidSubagentId(value: unknown): value is string {
  return typeof value === "string" && SUBAGENT_ID_RE.test(value);
}

/**
 * Convert a Claude Code session_id to the deterministic agent_id (UUID hex,
 * 32 chars, no hyphens, lowercase) used for `agent_states.agent_id` rows.
 */
export function sessionToAgentId(sessionId: string, subagentId?: string | null): string {
  // SB-25 composite identity: fold string mirrored byte-for-byte with
  // Python session_to_agent_id — absent/empty subagentId ⇒ the original
  // derivation, byte-identical (main-thread behavior unchanged).
  const name =
    subagentId != null && subagentId !== ""
      ? `ccs-agent:claude-session-${sessionId}:subagent-${subagentId}`
      : `ccs-agent:claude-session-${sessionId}`;
  // uuid v5 returns "xxxxxxxx-xxxx-..." (hyphenated). Strip + lowercase
  // to match Python's UUID.hex output exactly.
  return uuidv5(name, NAMESPACE_URL).replace(/-/g, "").toLowerCase();
}

/** Human-readable agent name for status / debug surfaces; matches Python `session_to_agent_name`. */
export function sessionToAgentName(sessionId: string): string {
  return `claude-session-${sessionId}`;
}
