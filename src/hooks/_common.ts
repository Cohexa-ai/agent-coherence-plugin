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
import type { TrackedArtifactPolicy } from "../policy.js";
import type { SessionRegistry } from "../sessions.js";

export interface HookDeps {
  registry: ArtifactRegistry;
  policy: TrackedArtifactPolicy;
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
