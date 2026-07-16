/**
 * POST /hooks/pre-grep — KTD-N H4 mitigation, Grep variant (zero-Python Unit 2).
 *
 * Node port of Python `_handle_pre_grep` (coordinator_server.py:2424).
 * Enumerates registry-known artifacts under `search_root` and surfaces
 * stale-read warnings. Unlike pre-bash there is NO first-observation
 * seeding (unknown artifacts are skipped) and the re-grant trigger is
 * "post_stale_grep". Warn-parity in Unit 2; strict lands in Unit 6.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { MESIState } from "../states.js";
import { emitStrictDeny, nowUnix, type StaleSummary } from "../hook_payloads.js";
import { drainNoticeText } from "./pre_bash.js";
import {
  type HookDeps,
  writeJson,
  writeError,
  readJsonBody,
  isValidSessionId,
  isValidPath,
  nowTick as nowTickFn,
  readSubagentId,
} from "./_common.js";

interface PreGrepBody {
  session_id?: unknown;
  search_root?: unknown;
}

export async function handlePreGrep(
  body: PreGrepBody,
  res: ServerResponse,
  deps: HookDeps,
): Promise<void> {
  if (!isValidSessionId(body.session_id)) {
    writeError(res, 400, "missing session_id");
    return;
  }
  const searchRoot = body.search_root ?? "";
  if (typeof searchRoot !== "string") {
    writeError(res, 400, "missing or empty path");
    return;
  }
  // "" = workspace root; a non-empty root must be a safe relative path.
  if (searchRoot !== "" && !isValidPath(searchRoot)) {
    writeError(res, 400, "missing or empty path");
    return;
  }

  const trackedPaths = deps.registry.artifactNamesUnderPrefix(searchRoot);
  if (trackedPaths.length === 0) {
    writeJson(res, 200, { status: "fresh" });
    return;
  }

  const agentId = deps.sessions.registerSession(body.session_id, readSubagentId(body as Record<string, unknown>));
  const now = nowTickFn();

  const staleSummaries: Array<{ path: string; current_version: number }> = [];
  let strictStaleFirst: StaleSummary | null = null;
  for (const path of trackedPaths) {
    const existing = deps.registry.getArtifactByName(path);
    if (existing === null) continue; // no seeding on the grep path
    const agentState = deps.registry.getAgentState(existing.id, agentId);
    if (agentState !== null && agentState !== MESIState.INVALID) continue;
    staleSummaries.push({ path, current_version: existing.version });
    if (strictStaleFirst === null && deps.policy.isStrictMode(path)) {
      const lastWriterSession =
        existing.last_writer_id !== null
          ? deps.sessions.agentIdToSessionId(existing.last_writer_id)
          : null;
      strictStaleFirst = {
        path,
        current_version: existing.version,
        prior_version_seen_by_session:
          agentState === MESIState.INVALID ? existing.version - 1 : null,
        last_writer_session_id: lastWriterSession ?? "<unknown>",
        last_writer_at_unix_ts: existing.updated_at,
        warning_generated_at_unix_ts: nowUnix(),
        hash_differs: false,
      };
    }
    deps.registry.grantShared(existing.id, agentId, now, "post_stale_grep");
  }

  // v0.2 KTD-Q strict short-circuit — same shape as pre-bash (Unit 6).
  if (strictStaleFirst !== null) {
    writeJson(res, 200, {
      hookSpecificOutput: emitStrictDeny({
        source: "pre_grep_strict_deny",
        summary: strictStaleFirst,
      }),
      status: "stale",
      stale_paths: staleSummaries.map((s) => s.path),
    });
    return;
  }

  const noticeText = drainNoticeText(deps, agentId);

  if (staleSummaries.length === 0 && noticeText === null) {
    writeJson(res, 200, { status: "fresh" });
    return;
  }

  const parts: string[] = [];
  if (noticeText !== null) parts.push(noticeText);
  if (staleSummaries.length > 0) {
    const pathsStr = staleSummaries
      .map((s) => `${s.path} (current v${s.current_version})`)
      .join(", ");
    // Byte-parity with Python _handle_pre_grep's prose — do not reword.
    parts.push(
      `⚠ Grep search over tracked artifacts your session has ` +
        `not freshened since peer commits: ${pathsStr}. The ` +
        `results may reflect outdated content. Consider re-reading ` +
        `via Read before acting on Grep output.`,
    );
  }

  const resp: Record<string, unknown> = {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "allow",
      additionalContext: parts.join("\n\n"),
    },
  };
  if (staleSummaries.length > 0) {
    resp.status = "stale";
    resp.stale_paths = staleSummaries.map((s) => s.path);
  } else {
    resp.status = "fresh";
  }
  writeJson(res, 200, resp);
}

/** Parse + dispatch helper for use from server.ts. */
export async function preGrepRoute(
  req: IncomingMessage,
  res: ServerResponse,
  deps: HookDeps,
  maxBytes: number,
): Promise<void> {
  if (req.method !== "POST") {
    writeError(res, 404, "not found");
    return;
  }
  const body = await readJsonBody(req, res, maxBytes);
  if (body === null) return;
  await handlePreGrep(body as PreGrepBody, res, deps);
}
