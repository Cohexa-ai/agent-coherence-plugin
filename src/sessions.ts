/**
 * Session registry — in-memory mapping between Claude Code session_id strings
 * and the derived agent_id UUID hex used in agent_states / pending_notices.
 *
 * Per KTD-A.5 minor finding + Python pattern (`coordinator_server.py:282-289`
 * `register_session`): the agent_id is deterministic (UUID5 of the session_id,
 * see `agent_id.ts`), so this map could be reconstructed on the fly. But the
 * reverse direction (agent_id → session_id) is needed for stale-warning prose
 * — `last_writer_id` is stored as an agent_id; surfacing it as the short
 * 8-char session prefix requires the reverse lookup.
 *
 * In-memory, process-local. Coordinator restart clears the map; stale
 * warnings emitted before any session re-introduces itself show
 * `<unknown>` for the writer. Matches Python's `_agent_names` semantics.
 *
 * The `agent_names` field referenced in v0.1 plan's KTD-K residual-risk
 * "_agent_names mutation relies on CPython GIL" finding maps to THIS module;
 * since Node is single-threaded by design (no GIL concept; event loop
 * serializes JS access), the Python locking concern doesn't apply.
 */
import { sessionToAgentId, sessionToAgentName } from "./agent_id.js";

export class SessionRegistry {
  // Forward: agent_id → session_id. Used for last_writer_session_id lookup.
  // Forward: session_id → agent_id. Avoids re-running uuid5 on every hook.
  private readonly bySessionId = new Map<string, string>();
  // Reverse: agent_id → session_id. Used for last_writer_session_id lookup.
  private readonly byAgentId = new Map<string, string>();

  // agent_id → human-readable agent name (parent linkage stays visible on
  // /status for subagent identities). SB-25.
  private readonly nameByAgentId = new Map<string, string>();

  /**
   * Register a session by its Claude Code session_id, optionally scoped to a
   * subagent identity (SB-25 composite derivation — see agent_id.ts).
   * Returns the deterministic agent_id (UUID hex). Idempotent.
   *
   * R2 attribution: for a subagent identity the REVERSE lookup returns the
   * SUBAGENT id (not the parent session), so warn/deny prose `[:8]` names
   * the actual writer — mirrors Python `_agent_id_to_session`.
   */
  registerSession(sessionId: string, subagentId?: string | null): string {
    const cacheKey =
      subagentId != null && subagentId !== "" ? `${sessionId}:${subagentId}` : sessionId;
    const cached = this.bySessionId.get(cacheKey);
    if (cached !== undefined) return cached;
    const agentId = sessionToAgentId(sessionId, subagentId);
    this.bySessionId.set(cacheKey, agentId);
    this.byAgentId.set(
      agentId,
      subagentId != null && subagentId !== "" ? subagentId : sessionId,
    );
    this.nameByAgentId.set(
      agentId,
      subagentId != null && subagentId !== ""
        ? `${sessionToAgentName(sessionId)}:subagent-${subagentId}`
        : sessionToAgentName(sessionId),
    );
    return agentId;
  }

  /**
   * Reverse lookup: agent_id (UUID hex) → the ATTRIBUTION id — the
   * session_id for a parent, the subagent id for a subagent. Null if unknown.
   */
  agentIdToSessionId(agentId: string): string | null {
    return this.byAgentId.get(agentId) ?? null;
  }

  /** Human-readable agent name; mirrors Python `session_to_agent_name`. */
  agentIdToName(agentId: string): string | null {
    return this.nameByAgentId.get(agentId) ?? null;
  }

  /** All currently-known agent_ids. For /status diagnostics. */
  knownAgentIds(): string[] {
    return [...this.byAgentId.keys()];
  }
}
