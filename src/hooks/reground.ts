/**
 * SB-10 U8 — deferred re-grounding delivery at the admit seams.
 *
 * Node port of Python `_reground_qualifies` / `_claim_reground_context` /
 * `_attach_reground` / `_deliver_pending_reground` (agent-coherence a69a68d,
 * coordinator_server.py). The compact-pending flag armed by
 * /hooks/session-start is claimed — atomic test-and-clear — at the
 * allow-attach seam shared by the four admit surfaces (pre-read, pre-edit,
 * pre-bash, pre-grep), and the payload rides the PreToolUse allow envelope,
 * never the SessionStart wrapper.
 *
 * R2 at-most-once: the claim happens ONLY here, after every deny decision.
 * Node's single-threaded event loop already makes the Map-delete pop atomic,
 * but the claim-at-attach shape is kept so the contract survives any future
 * multi-writer transport. R8: allow envelopes only — a non-qualifying result
 * is returned as the SAME object (deny bodies stay byte-identical) and keeps
 * the flag pending; a request presenting an agent_id field (subagent
 * identity) neither consumes nor attaches. KTD2 rebuild-at-delivery: the
 * prose is rebuilt from registry truth via `buildSessionStartContext` at the
 * moment of attach — never a snapshot cached at compact time.
 */
import type { ServerResponse } from "node:http";
import { emitAllow, type HookSpecificOutput } from "../hook_payloads.js";
import { type HookDeps, hasSubagentIdField, writeJson } from "./_common.js";
import { buildSessionStartContext } from "./session_start.js";

/**
 * R8: does this admit response qualify to carry — and therefore consume —
 * the deferred re-grounding payload? The payload attaches ONLY to allow
 * envelopes. A response already carrying a `hookSpecificOutput` qualifies
 * iff its decision is "allow" — a strict-mode deny must stay byte-identical
 * (KTD-P) and must NOT consume: the flag survives for the next qualifying
 * admit. An envelope-less response qualifies iff it is an admit body —
 * `{ok: true}` (pre-edit) or `{status: "fresh"}` (pre-read / pre-bash /
 * pre-grep). A service-refusal body (`{ok: false, ...}`) is neither a deny
 * envelope nor an admit: no attach, no consume.
 */
function regroundQualifies(result: Record<string, unknown>): boolean {
  const hso = result.hookSpecificOutput as HookSpecificOutput | undefined;
  if (hso !== undefined) {
    return hso.permissionDecision === "allow";
  }
  return result.ok === true || result.status === "fresh";
}

/**
 * Atomically claim the session's pending re-grounding delivery and rebuild
 * its prose. Returns the payload text when THIS call wins the claim; null
 * when the request presents a subagent identity (R8: a parent request
 * carries NO agent_id field on the wire — a request presenting one must
 * neither consume nor attach), when no flag is pending, or when the rebuild
 * came back empty (state drained since the compact event — nothing left
 * worth re-grounding).
 *
 * Failure containment: re-grounding is advisory (KD3). A rebuild error
 * after a won claim must not turn an otherwise-successful admit into an
 * internal-error body, so the build is guarded and the delivery is
 * forfeited (R2 permits at-most-once → zero) rather than propagated.
 */
function claimRegroundContext(
  deps: HookDeps,
  sessionId: string,
  body: Record<string, unknown>,
): string | null {
  if (hasSubagentIdField(body)) return null;
  if (!deps.sessions.consumeCompactPending(sessionId)) return null;
  try {
    return buildSessionStartContext(deps, sessionId).text;
  } catch (err) {
    // Advisory delivery must never break the admit it rides.
    process.stderr.write(
      `agent-coherence: deferred re-grounding rebuild failed for session ${sessionId}; ` +
        `delivery forfeited: ${String(err)}\n`,
    );
    return null;
  }
}

/**
 * Merge the claimed re-grounding prose into a qualifying admit response.
 * An existing allow envelope keeps its text and gets the block appended
 * AFTER it (notices and stale warnings render first — KTD6 ordering); a
 * bare admit body is promoted to an allow envelope. The deferred path rides
 * the PreToolUse allow wrapper — never the SessionStart shape.
 */
function attachReground(result: Record<string, unknown>, text: string): Record<string, unknown> {
  const hso = result.hookSpecificOutput as HookSpecificOutput | undefined;
  if (hso === undefined) {
    return {
      ...result,
      hookSpecificOutput: emitAllow({
        source: "deferred_reground_attach",
        additionalContext: text,
      }),
    };
  }
  const existing = hso.additionalContext;
  const merged: HookSpecificOutput = {
    ...hso,
    additionalContext: existing === undefined ? text : existing + "\n\n" + text,
  };
  return { ...result, hookSpecificOutput: merged };
}

/**
 * KTD6: the allow-attach seam shared by the four admit surfaces. Runs AFTER
 * any deny decision: a non-qualifying result is returned untouched — the
 * SAME object, so deny bodies stay byte-identical — and only then does the
 * atomic pop race; exactly one concurrent qualifying admit attaches.
 */
export function deliverPendingReground(
  deps: HookDeps,
  sessionId: string,
  body: Record<string, unknown>,
  result: object,
): Record<string, unknown> {
  const admit = result as Record<string, unknown>;
  if (!regroundQualifies(admit)) return admit;
  const text = claimRegroundContext(deps, sessionId, body);
  if (text === null) return admit;
  return attachReground(admit, text);
}

/**
 * SB-10 U8 (KTD6): shared exit for the four hoisted fast paths (untracked /
 * zero-tracked admits). The advisory compact-pending peek — a process-local
 * lookup, never a registry touch — keeps no-flag traffic registry-free with
 * the exact pre-SB-10 response bytes; a pending flag routes through the
 * deferred re-ground attach, which claims it atomically at the allow seam.
 * Mirrors Python `_fast_path_json`.
 */
export function writeFastAdmit(
  res: ServerResponse,
  deps: HookDeps,
  sessionId: string,
  body: Record<string, unknown>,
  base: Record<string, unknown>,
): void {
  const result = deps.sessions.hasCompactPending(sessionId)
    ? deliverPendingReground(deps, sessionId, body, base)
    : base;
  writeJson(res, 200, result);
}
