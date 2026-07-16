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
  return typeof raw === "string" && raw !== "";
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
