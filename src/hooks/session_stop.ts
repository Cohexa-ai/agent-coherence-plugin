/**
 * POST /hooks/session-stop handler.
 *
 * Mirrors Python `_handle_session_stop` at coordinator_server.py:703. Per
 * KTD-11: when a Claude Code session reaches end-of-turn (Stop hook), release
 * any uncommitted EXCLUSIVE/MODIFIED grants the session still holds. Without
 * this, abandoned mid-edit grants would block peer sessions for the full
 * crash-recovery timeout window (default 120s).
 *
 * Wire shape per KTD-B / KTD-B.3 C3:
 * - Request: `{session_id}`
 * - Response: `{ok: true, released_artifacts: ["plan.md", ...]}` listing the
 *   repo-relative paths whose grants were released.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { MESIState } from "../states.js";
import {
  type HookDeps,
  writeJson,
  writeError,
  readJsonBody,
  isValidSessionId,
  readSubagentId,
} from "./_common.js";

export type SessionStopDeps = HookDeps;

interface SessionStopBody {
  session_id?: unknown;
}

export async function handleSessionStop(
  body: SessionStopBody,
  res: ServerResponse,
  deps: SessionStopDeps,
): Promise<void> {
  if (!isValidSessionId(body.session_id)) {
    writeError(res, 400, "missing session_id");
    return;
  }
  const sessionId: string = body.session_id;
  const agentId = deps.sessions.registerSession(sessionId, readSubagentId(body as Record<string, unknown>));
  const nowTick = Math.floor(Date.now() / 1000);

  // Per KTD-11: enumerate held M/E grants and release each. Released paths
  // surface in the response so /status logs / debugging can see what fired.
  const heldArtifactIds = deps.registry.artifactsHeldByAgent(agentId, [
    MESIState.MODIFIED,
    MESIState.EXCLUSIVE,
  ]);

  const releasedPaths: string[] = [];
  for (const artifactId of heldArtifactIds) {
    try {
      deps.registry.invalidate(artifactId, agentId, nowTick, "session_stop");
      const art = deps.registry.getArtifactById(artifactId);
      if (art !== null) releasedPaths.push(art.name);
    } catch (err) {
      // Failed-release on one artifact does NOT abort the loop — best-effort
      // release of remaining held grants matters more than reporting one
      // failure. Errors surface as warning in coordinator log; future v0.2
      // strict accounting can promote this to per-artifact failure reporting.
      process.stderr.write(
        `agent-coherence: session_stop invalidate failed for artifact=${artifactId}: ${String(err)}\n`,
      );
    }
  }

  writeJson(res, 200, { ok: true, released_artifacts: releasedPaths });
}

export async function sessionStopRoute(
  req: IncomingMessage,
  res: ServerResponse,
  deps: SessionStopDeps,
  maxBytes: number,
): Promise<void> {
  if (req.method !== "POST") {
    writeError(res, 404, "not found");
    return;
  }
  const body = await readJsonBody(req, res, maxBytes);
  if (body === null) return;
  await handleSessionStop(body as SessionStopBody, res, deps);
}
