/**
 * Shared HTTP body-drain + JSON-parse helper for hook endpoints.
 *
 * Per R21 + KTD-B.3 C1: body cap enforced at server.ts via Content-Length
 * pre-check; this helper enforces a second-pass cap on actually-received
 * bytes (defense-in-depth for the header-lies-about-length case).
 *
 * Error envelope: `{error: "<lowercase phrase>"}` per KTD-B.3 C1.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import type { ArtifactRegistry } from "../registry.js";
import type { PolicyRef } from "../policy.js";
import type { SessionRegistry } from "../sessions.js";
import { isValidSubagentId } from "../agent_id.js";
import {
  preemptionNoticeText,
  shortSessionId,
  PREEMPTION_NOTICE_OVERFLOW_LINE_TEMPLATE,
} from "../hook_payloads.js";

export interface HookDeps {
  registry: ArtifactRegistry;
  /**
   * Mutable policy holder (zero-Python Unit 1/2): handlers must read the
   * policy THROUGH this ref (`deps.policy.isTracked(...)`) so a
   * /policy/track|untrack reload is visible without a restart.
   */
  policy: PolicyRef;
  sessions: SessionRegistry;
}

export function writeJson(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(body));
}

export function writeError(res: ServerResponse, status: number, message: string): void {
  writeJson(res, status, { error: message });
}

/**
 * Coordinator-side tick (epoch seconds). Centralized for parity with Python
 * coordinator's `time.time()` / 1.0s tick semantics, and so hook handlers
 * stop repeating `Math.floor(Date.now() / 1000)` inline.
 *
 * ce-review maintainability fix: was inlined at 4 hook call sites.
 */
export function nowTick(): number {
  return Math.floor(Date.now() / 1000);
}

/**
 * Per KTD-K + ce-review reliability finding (readJsonBody had no read timeout).
 * Set to the watchdog handler deadline minus headroom so a stalled body read
 * unblocks before the outer watchdog fires.
 */
export const BODY_READ_TIMEOUT_MS = 2000;

/**
 * Drain request body up to `maxBytes`, parse as JSON object. Writes 400
 * error envelope and returns null on parse failure or oversize. Caller
 * should return immediately if null is returned.
 *
 * Enforces BODY_READ_TIMEOUT_MS so a stalled client (TCP open, no body) does
 * not hold a handler slot indefinitely. Per ce-review reliability finding —
 * pairs with the future A7 handler semaphore in Unit 4.
 */
export async function readJsonBody(
  req: IncomingMessage,
  res: ServerResponse,
  maxBytes: number,
): Promise<Record<string, unknown> | null> {
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    await new Promise<void>((resolve, reject) => {
      req.setTimeout(BODY_READ_TIMEOUT_MS, () => {
        req.destroy(new Error("body read timeout"));
      });
      req.on("data", (chunk: Buffer) => {
        total += chunk.length;
        if (total > maxBytes) {
          reject(new Error("body too large"));
          req.destroy();
          return;
        }
        chunks.push(chunk);
      });
      req.on("end", () => resolve());
      req.on("error", (err) => reject(err));
    });
  } catch (err) {
    const message = (err as Error).message;
    if (message === "body too large") {
      writeError(res, 413, "request body too large");
    } else if (message === "body read timeout") {
      writeError(res, 408, "request body read timeout");
    } else {
      writeError(res, 400, "could not read request body");
    }
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    writeError(res, 400, "invalid json");
    return null;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    writeError(res, 400, "body must be a JSON object");
    return null;
  }
  return parsed as Record<string, unknown>;
}

// ----------------------------------------------------------------------
// Input validators — shared across hook handlers
// ----------------------------------------------------------------------

const SESSION_ID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
const CONTENT_HASH_RE = /^[0-9a-fA-F]{64}$/;

/** Raw subagent-id value from the body, snake_case preferred (SB-25). */
function rawSubagentIdValue(body: Record<string, unknown>): unknown {
  return body.agent_id !== undefined ? body.agent_id : body.agentId;
}

/**
 * SB-25: optional subagent identity from the hook request body. Accepts the
 * documented snake_case `agent_id` with a defensive camelCase `agentId`
 * fallback (wire casing pinned by the R6 live capture). Additive +
 * backward-compatible: absent/invalid resolves to null (the parent
 * identity), never a 400. Mirrors Python `read_subagent_id`.
 */
export function readSubagentId(body: Record<string, unknown>): string | null {
  const raw = rawSubagentIdValue(body);
  return isValidSubagentId(raw) ? raw : null;
}

/**
 * True iff the body carries a NON-EMPTY subagent-id value, regardless of
 * whether it passes `isValidSubagentId`. Lets the destructive session-stop
 * path distinguish "no agent_id → legitimate parent stop" from "present but
 * malformed → refuse, never degrade to releasing the parent's grants" (the
 * P1 subagent-stop safety fix). Read paths don't need this — a malformed id
 * degrading to parent attribution there is benign.
 */
export function hasSubagentIdField(body: Record<string, unknown>): boolean {
  const raw = rawSubagentIdValue(body);
  // Any present, non-null, non-empty value of ANY type counts as "present" —
  // a present `agent_id: 42` must be REFUSED on session-stop, not treated as
  // absent and degraded to the parent identity. Parity with Python
  // has_subagent_id_field.
  return raw !== undefined && raw !== null && raw !== "";
}

export function isValidSessionId(s: unknown): s is string {
  return typeof s === "string" && SESSION_ID_RE.test(s);
}

export function isValidPath(p: unknown): p is string {
  return typeof p === "string" && p.length > 0 && !p.startsWith("/") && !p.split("/").includes("..");
}

export function isValidContentHashOrAbsent(h: unknown): h is string | undefined | null {
  if (h === undefined || h === null) return true;
  return typeof h === "string" && CONTENT_HASH_RE.test(h);
}

export function isValidContentHashRequired(h: unknown): h is string {
  return typeof h === "string" && CONTENT_HASH_RE.test(h);
}

/**
 * How many preemption notices one admit response renders verbatim before
 * coalescing the rest into a count. Mirrors Python's
 * `_PREEMPTION_PROSE_VERBATIM_CAP`, and deliberately the same value, so the
 * two backends coalesce at the same point.
 */
export const ADMIT_NOTICE_VERBATIM_CAP = 3;

/**
 * Drain this agent's pending preemption notices and render them for an admit
 * response — bounded, and the ONE place that bound exists.
 *
 * Previously each of pre_read, pre_edit and pre_bash/pre_grep popped and
 * rendered inline, each with its own copy of the same twelve lines. Three
 * copies of a cap is three chances for one to drift, and the whole failure
 * mode this bound exists to prevent is a response that renders more than it
 * promised or deletes more than it rendered.
 *
 * The bound is on the CONSUME, not on the render. `popPendingNoticesForAgent`
 * deletes only the slice named here and returns the whole queue, so:
 *
 *   - the intro reports the true pending total, not the bullet count;
 *   - the overflow line's count is arithmetic on data in hand;
 *   - and the rows not rendered are still in the table, which is what makes
 *     "still surface on your next tracked-file operation" a true sentence
 *     rather than the false one a render-only cap would print.
 */
export function drainNoticeText(deps: HookDeps, agentId: string): string | null {
  const all = deps.registry.popPendingNoticesForAgent(agentId, ADMIT_NOTICE_VERBATIM_CAP);
  if (all.length === 0) return null;
  // Same slice, same order, as the DELETE consumed — the list is newest-first
  // and neither side re-sorts it.
  const verbatim = all.slice(0, ADMIT_NOTICE_VERBATIM_CAP);
  const rendered = verbatim.map((n) => {
    const art = deps.registry.getArtifactById(n.artifactId);
    const preempterSession = deps.sessions.agentIdToSessionId(n.preempterAgentId) ?? "<unknown>";
    return {
      artifactPath: art?.name ?? "<unknown-artifact>",
      preempterSessionShort: shortSessionId(preempterSession),
      preemptedAtUnixTs: n.preemptedAtUnixTs,
    };
  });
  let text = preemptionNoticeText(rendered, all.length);
  const overflow = all.length - verbatim.length;
  if (overflow > 0) {
    text += "\n" + PREEMPTION_NOTICE_OVERFLOW_LINE_TEMPLATE.replace("{count}", String(overflow));
  }
  return text;
}
