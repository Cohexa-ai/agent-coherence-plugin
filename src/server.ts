/**
 * HTTP server for the Node coordinator.
 *
 * Wires auth middleware (Bearer + Host allowlist) per KTD-A.5 + KTD-12, and
 * dispatches to per-route handlers. v0.1.1 Unit 1 lands /health only;
 * subsequent commits / units add /status (three-tier per KTD-K),
 * /hooks/pre-read, /hooks/pre-edit, /hooks/post-edit, /hooks/session-stop,
 * /policy/track, /policy/untrack.
 *
 * Conventions (matching Python coordinator's coordinator_server.py per KTD-B.3):
 * - Error envelope: `{"error": "<lowercase phrase>"}` — single key, no trailing punctuation
 * - HTTP status mapping: bad Host → 403; missing Bearer → 401; oversized body → 413;
 *   coordinator mid-shutdown → 503; unknown route → 404; unhandled → 500
 *   with `{"error": "internal: <ErrorName>"}` (class name leaks deliberately)
 * - Field naming: snake_case for all coordinator-owned JSON keys; camelCase
 *   ONLY at the Claude Code hookSpecificOutput boundary (none of those yet
 *   in this commit)
 * - R21: MAX_REQUEST_BODY_BYTES = 64 KiB; reject Content-Length above with 413
 *   before reading the body
 */
import { createServer as createHttpServer, type IncomingMessage, type ServerResponse, type Server } from "node:http";
import { verifyBearer, verifyHost } from "./auth.js";

/** R21: per KTD-B.2 security-parity corpus + v0.1.1 plan KTD-K. */
export const MAX_REQUEST_BODY_BYTES = 64 * 1024;

/** Bind address: locked invariant per Open Questions; no user-configurable override. */
export const BIND_HOST = "127.0.0.1";

export interface ServerOptions {
  /** Bearer secret returned by ensureSecret(); used for verifyBearer auth. */
  secret: string;
  /** Coordinator-process startup timestamp (epoch ms); surfaces in /health. */
  startedAtMs: number;
  /** Coordinator-process semver; surfaces in /health for version-skew diagnostics. */
  version: string;
}

interface ErrorEnvelope {
  error: string;
}

function writeJson(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(body));
}

function writeError(res: ServerResponse, status: number, message: string): void {
  const envelope: ErrorEnvelope = { error: message };
  writeJson(res, status, envelope);
}

/**
 * Auth middleware: rejects on bad Host (403), missing/invalid Bearer (401),
 * or oversized Content-Length (413). Returns true if the request passed all
 * gates and should proceed to the route handler.
 */
function checkAuth(req: IncomingMessage, res: ServerResponse, secret: string): boolean {
  if (!verifyHost(req)) {
    writeError(res, 403, "host header not allowlisted");
    return false;
  }
  if (!verifyBearer(req, secret)) {
    writeError(res, 401, "missing or invalid bearer token");
    return false;
  }
  const lenHeader = req.headers["content-length"];
  if (typeof lenHeader === "string") {
    const len = Number.parseInt(lenHeader, 10);
    if (Number.isNaN(len) || len < 0) {
      writeError(res, 400, "invalid content-length header");
      return false;
    }
    if (len > MAX_REQUEST_BODY_BYTES) {
      writeError(res, 413, "request body too large");
      return false;
    }
  }
  return true;
}

interface HealthBody {
  status: "ok";
  version: string;
  backend: "node";
  uptime_seconds: number;
}

function handleHealth(req: IncomingMessage, res: ServerResponse, options: ServerOptions): void {
  if (req.method !== "GET") {
    writeError(res, 404, "not found");
    return;
  }
  const body: HealthBody = {
    status: "ok",
    version: options.version,
    backend: "node",
    uptime_seconds: Math.floor((Date.now() - options.startedAtMs) / 1000),
  };
  writeJson(res, 200, body);
}

export function createServer(options: ServerOptions): Server {
  const server = createHttpServer((req, res) => {
    try {
      if (!checkAuth(req, res, options.secret)) {
        return;
      }
      // Route dispatch. v0.1.1 Unit 1 lands /health only; /status + hook
      // endpoints land in subsequent commits.
      if (req.url === "/health") {
        handleHealth(req, res, options);
        return;
      }
      writeError(res, 404, "not found");
    } catch (err) {
      const name = err instanceof Error ? err.constructor.name : "Unknown";
      writeError(res, 500, `internal: ${name}`);
    }
  });
  return server;
}
