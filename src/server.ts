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
import type { ArtifactRegistry } from "./registry.js";
import type { PolicyRef, PolicySummary } from "./policy.js";
import type { SessionRegistry } from "./sessions.js";
import { writeJson, writeError } from "./hooks/_common.js";
import { preReadRoute } from "./hooks/pre_read.js";
import { preEditRoute } from "./hooks/pre_edit.js";
import { postEditRoute } from "./hooks/post_edit.js";
import { sessionStopRoute } from "./hooks/session_stop.js";
import { preBashRoute } from "./hooks/pre_bash.js";
import { preGrepRoute } from "./hooks/pre_grep.js";
import { postEditCasRoute } from "./hooks/post_edit_cas.js";
import { policyTrackRoute, policyUntrackRoute } from "./hooks/policy_routes.js";

/** R21: per KTD-B.2 security-parity corpus + v0.1.1 plan KTD-K. */
export const MAX_REQUEST_BODY_BYTES = 64 * 1024;

/** Bind address: locked invariant per Open Questions; no user-configurable override. */
export const BIND_HOST = "127.0.0.1";

export interface ServerOptions {
  /** Bearer secret returned by ensureSecret(); used for verifyBearer auth. */
  secret: string;
  /** Coordinator-process startup timestamp (epoch ms); surfaces in /health + /status. */
  startedAtMs: number;
  /** Coordinator-process semver; surfaces in /health + /status for version-skew diagnostics. */
  version: string;
  /** SQLite registry handle; surfaces stats in /status default tier. */
  registry: ArtifactRegistry;
  /** Mutable tracked-artifact policy holder; handlers read through it (Unit 2). */
  policy: PolicyRef;
  /** In-memory session_id ↔ agent_id map for hook handlers. */
  sessions: SessionRegistry;
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

/**
 * /status three-tier disclosure model per KTD-K.
 *
 * - **Default (minimal)**: Bearer-auth only. UUID5 agent_id ONLY (strip
 *   `claude-session-` prefix so operators can't accidentally cross-reference
 *   CC transcript history); repo-relative paths; counts and aggregates.
 *   Lower-leakage tier for default operator queries.
 * - **`?detail=metrics`**: Bearer-auth only. KTD-J counters only; NO paths,
 *   NO session identifiers. Safe-to-share tier for GitHub bug reports.
 *   README routes users here for issue templates.
 * - **`?detail=full`**: Bearer + `Coherence-Local-Operator: true` header
 *   (misuse boundary — same-secret holder CAN set it trivially; the header
 *   prevents accidental paste-into-issue leakage, not malicious disclosure).
 *   Unmasks raw session_id (full agent_name), absolute paths, coordinator_pid.
 *   DEFERRED TO UNIT 8 — Unit 1 returns 501 Not Implemented for this tier.
 *
 * v0.1.1 Unit 1 ships default + metrics tiers with placeholder bodies
 * (empty arrays + zero counters). Unit 2 fills tracked_artifacts + sessions
 * with real registry data. Unit 8 lands ?detail=full + KTD-J counter values.
 */

type StatusDetail = "default" | "metrics" | "full";

interface StatusDefaultBody {
  status: "ok";
  backend: "node";
  version: string;
  coordinator_uptime_seconds: number;
  schema_version: number;
  // AC-03 (cross-backend parity): tracked_artifacts entries use `path`,
  // sessions entries carry `agent_name` + `states` (per-artifact MESI
  // map). Mirrors Python's `_handle_status` shape so dashboards and
  // CLIs work identically across backends.
  tracked_artifacts: ReadonlyArray<{ id: string; path: string; version: number }>;
  sessions: ReadonlyArray<{
    agent_id: string;
    agent_name: string;
    states: Record<string, string>;
  }>;
  counts: {
    tracked_artifacts: number;
    sessions: number;
  };
  policy_summary: PolicySummary;
}

interface StatusMetricsBody {
  backend: "node";
  version: string;
  counters: Record<string, number>;
}

function parseDetailParam(rawUrl: string): StatusDetail {
  // Use a fixed base because IncomingMessage.url is a path+query, not an absolute URL.
  const url = new URL(rawUrl, "http://localhost");
  const detail = url.searchParams.get("detail");
  if (detail === "metrics") return "metrics";
  if (detail === "full") return "full";
  return "default";
}

function handleStatus(req: IncomingMessage, res: ServerResponse, options: ServerOptions): void {
  if (req.method !== "GET") {
    writeError(res, 404, "not found");
    return;
  }
  const detail = parseDetailParam(req.url ?? "/status");

  if (detail === "full") {
    // Unit 8 lands the operator opt-in header check + unmasked body.
    writeError(res, 501, "detail=full not implemented in v0.1.1 unit 1");
    return;
  }

  const uptimeSeconds = Math.floor((Date.now() - options.startedAtMs) / 1000);
  const schemaVersion = options.registry.getStats().schemaVersion;

  if (detail === "metrics") {
    const body: StatusMetricsBody = {
      backend: "node",
      version: options.version,
      // KTD-J counters land in Unit 8. Empty placeholder keeps the shape stable
      // so consumers can parse the body even before counters are wired.
      counters: {},
    };
    writeJson(res, 200, body);
    return;
  }

  // Default tier. Both tracked_artifacts and sessions wired from the registry's
  // domain methods. agent_id is the UUID5 of the session_id, with no
  // `claude-session-` prefix (the prefix only appears in the hook layer's
  // agent_name field; the stored agent_id is already a bare UUID5 per KTD-K).
  //
  // AC-03 (cross-backend parity): tracked_artifacts uses `path` (not
  // `name`) to match Python's wire shape. Sessions include agent_name +
  // per-artifact MESI states so agent-coherence-status renders the same
  // table against either backend.
  const artifactList = options.registry.listArtifacts();
  const artifacts = artifactList.map((a) => ({
    id: a.id,
    path: a.name, // Already repo-relative per the resolveOrRegister contract
    version: a.version,
  }));
  const activeAgents = options.registry.listActiveAgents();
  const sessions = activeAgents.map((agentId) => {
    const states: Record<string, string> = {};
    for (const art of artifactList) {
      const state = options.registry.getAgentState(art.id, agentId);
      // Only non-INVALID states appear in the per-agent map (Python parity).
      if (state !== null && state !== "INVALID") {
        states[art.name] = state;
      }
    }
    // agent_name falls back to "<unknown>" if the SessionRegistry has not
    // seen this agent_id (e.g., the agent surfaced via a peer
    // invalidation but never called register_session itself yet).
    const agentName = options.sessions.agentIdToName(agentId) ?? "<unknown>";
    return {
      agent_id: agentId,
      agent_name: agentName,
      states,
    };
  });

  const body: StatusDefaultBody = {
    status: "ok",
    backend: "node",
    version: options.version,
    coordinator_uptime_seconds: uptimeSeconds,
    schema_version: schemaVersion,
    tracked_artifacts: artifacts,
    sessions,
    counts: {
      tracked_artifacts: artifacts.length,
      sessions: sessions.length,
    },
    policy_summary: options.policy.summary(),
  };
  writeJson(res, 200, body);
}

export function createServer(options: ServerOptions): Server {
  const server = createHttpServer((req, res) => {
    // Top-level wrapper handles sync exceptions; async route handlers chain
    // their own catch and forward to the same 500 envelope.
    const handle500 = (err: unknown): void => {
      const name = err instanceof Error ? err.constructor.name : "Unknown";
      try {
        writeError(res, 500, `internal: ${name}`);
      } catch {
        // Response already started; nothing left to do.
      }
    };

    try {
      if (!checkAuth(req, res, options.secret)) {
        return;
      }
      // Route dispatch on path only (query string handled per-route).
      const path = (req.url ?? "/").split("?")[0];
      if (path === "/health") {
        handleHealth(req, res, options);
        return;
      }
      if (path === "/status") {
        handleStatus(req, res, options);
        return;
      }
      const hookDeps = {
        registry: options.registry,
        policy: options.policy,
        sessions: options.sessions,
      };
      if (path === "/hooks/pre-read") {
        preReadRoute(req, res, hookDeps, MAX_REQUEST_BODY_BYTES).catch(handle500);
        return;
      }
      if (path === "/hooks/pre-edit") {
        preEditRoute(req, res, hookDeps, MAX_REQUEST_BODY_BYTES).catch(handle500);
        return;
      }
      if (path === "/hooks/post-edit") {
        postEditRoute(req, res, hookDeps, MAX_REQUEST_BODY_BYTES).catch(handle500);
        return;
      }
      if (path === "/hooks/session-stop") {
        sessionStopRoute(req, res, hookDeps, MAX_REQUEST_BODY_BYTES).catch(handle500);
        return;
      }
      // Zero-Python Unit 2 routes (Python coordinator parity).
      if (path === "/hooks/pre-bash") {
        preBashRoute(req, res, hookDeps, MAX_REQUEST_BODY_BYTES).catch(handle500);
        return;
      }
      if (path === "/hooks/pre-grep") {
        preGrepRoute(req, res, hookDeps, MAX_REQUEST_BODY_BYTES).catch(handle500);
        return;
      }
      if (path === "/hooks/post-edit-cas") {
        postEditCasRoute(req, res, hookDeps, MAX_REQUEST_BODY_BYTES).catch(handle500);
        return;
      }
      if (path === "/policy/track") {
        policyTrackRoute(req, res, hookDeps, MAX_REQUEST_BODY_BYTES).catch(handle500);
        return;
      }
      if (path === "/policy/untrack") {
        policyUntrackRoute(req, res, hookDeps, MAX_REQUEST_BODY_BYTES).catch(handle500);
        return;
      }
      writeError(res, 404, "not found");
    } catch (err) {
      handle500(err);
    }
  });
  return server;
}
