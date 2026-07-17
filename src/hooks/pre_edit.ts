/**
 * POST /hooks/pre-edit handler.
 *
 * Mirrors Python `_handle_pre_edit` at coordinator_server.py:531 — acquires
 * EXCLUSIVE per KTD-1 single-writer + KTD-9 collision surfacing.
 *
 * Wire shape per KTD-B / KTD-B.3 C3:
 * - Request: `{session_id, path}`
 * - Response: `{ok: true}` on clean acquire; `{ok: true, hookSpecificOutput: {...}}`
 *   with collision warning if another session held M/E; `{ok: false, reason}`
 *   on protocol error (single-writer violation propagated).
 *
 * Note on collision detection ordering: the Python handler peeks `exclusiveHolder`
 * BEFORE calling `write()` (which would invalidate the holder). We mirror this:
 * snapshot the holder identity first so the response can name them, THEN call
 * `acquireExclusive` which silently revokes their grant + writes a pending notice
 * the victim will see on their next hook.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { MESIState } from "../states.js";
import {
  buildCollisionResponse,
  emitStrictDeny,
  nowUnix,
  preemptionNoticeText,
  type StaleSummary,
} from "../hook_payloads.js";
import {
  type HookDeps,
  writeJson,
  writeError,
  readJsonBody,
  isValidSessionId,
  isValidPath,
  readSubagentId,
} from "./_common.js";

export type PreEditDeps = HookDeps;

interface PreEditBody {
  session_id?: unknown;
  path?: unknown;
}

export async function handlePreEdit(
  body: PreEditBody,
  res: ServerResponse,
  deps: PreEditDeps,
): Promise<void> {
  if (!isValidSessionId(body.session_id)) {
    writeError(res, 400, "missing session_id");
    return;
  }
  if (!isValidPath(body.path)) {
    writeError(res, 400, "missing or empty path");
    return;
  }
  const sessionId: string = body.session_id;
  const path: string = body.path;

  if (!deps.policy.isTracked(path)) {
    writeJson(res, 200, { ok: true });
    return;
  }

  const agentId = deps.sessions.registerSession(sessionId, readSubagentId(body as Record<string, unknown>));
  const nowTick = Math.floor(Date.now() / 1000);

  // Resolve-or-seed the artifact. Empty content_hash sentinel matches Python:
  // pre-edit doesn't get the post-write hash; post-edit supplies the real one.
  let artifactId: string;
  const existing = deps.registry.getArtifactByName(path);
  if (existing === null) {
    artifactId = deps.registry.resolveOrRegisterArtifact(path, "");
  } else {
    artifactId = existing.id;
  }

  // v0.2 KTD-Q strict-mode deny gate — Edit/Write surface (Unit 6, mirrors
  // Python pre-edit). INVALID-only: pre-edit carries no content_hash, so the
  // hash_differs disambiguation is unavailable; a first-time editor (state
  // None) falls through to the normal acquire flow. Fires only after this
  // session has been explicitly preempted.
  if (existing !== null && deps.policy.isStrictMode(path)) {
    const editorState = deps.registry.getAgentState(artifactId, agentId);
    if (existing.version > 0 && editorState === MESIState.INVALID) {
      const lastWriterSession =
        existing.last_writer_id !== null
          ? deps.sessions.agentIdToSessionId(existing.last_writer_id)
          : null;
      const summary: StaleSummary = {
        path,
        current_version: existing.version,
        prior_version_seen_by_session: existing.version - 1,
        last_writer_session_id: lastWriterSession ?? "<unknown>",
        last_writer_at_unix_ts: existing.updated_at,
        warning_generated_at_unix_ts: nowUnix(),
        hash_differs: false, // pre-edit doesn't carry content_hash
      };
      writeJson(res, 200, {
        ok: false,
        hookSpecificOutput: emitStrictDeny({ source: "pre_edit_strict_deny", summary }),
        status: "stale",
        summary,
      });
      return;
    }
  }

  // Collision detection: snapshot exclusive holder BEFORE acquireExclusive
  // (the acquire silently revokes their grant).
  const holder = deps.registry.exclusiveHolder(artifactId, agentId);
  const holderSessionId = holder !== null ? deps.sessions.agentIdToSessionId(holder.agentId) : null;
  const holderAcquiredAt = holder?.grantedAtTick ?? null;

  // Acquire EXCLUSIVE — invalidates any peers in M/E/S + writes pending
  // notices for those who held M/E (peers in S don't get a notice).
  try {
    deps.registry.acquireExclusive(artifactId, agentId, nowTick);
  } catch (err) {
    writeJson(res, 200, {
      ok: false,
      reason: (err as Error).message,
    });
    return;
  }

  // Pop any pending notices for THIS session — they accumulated from prior
  // preemptions before this pre-edit. Merge into the response.
  const popped = deps.registry.popPendingNoticesForAgent(agentId);
  const noticeText =
    popped.length === 0
      ? null
      : preemptionNoticeText(
          popped.map((n) => {
            const art = deps.registry.getArtifactById(n.artifactId);
            const preempterSession =
              deps.sessions.agentIdToSessionId(n.preempterAgentId) ?? "<unknown>";
            return {
              artifactPath: art?.name ?? "<unknown-artifact>",
              preempterSessionShort: preempterSession.slice(0, 8),
              preemptedAtUnixTs: n.preemptedAtUnixTs,
            };
          }),
        );

  // If we silently preempted someone in M/E, surface a collision warning.
  // Per Python convention: permissionDecision stays "allow" in v0.1.1 warn-only;
  // v0.2 may flip to "deny" per KTD-E (Phase 0 falsifiability gates the design).
  if (holder !== null) {
    const collisionResp = buildCollisionResponse(
      holderSessionId ?? "<unknown>",
      // granted_at_tick is seconds since some epoch; for the warning prose
      // use Unix-ts equivalent. Python uses the artifact's updated_at field
      // (RIGHTness: that's when the grant was stamped); we approximate via
      // holder.grantedAtTick which is monotonic seconds. For warn-only this
      // is acceptable; v0.2 may want stricter semantics.
      holderAcquiredAt ?? nowUnix(),
      path,
    );
    if (noticeText !== null) {
      collisionResp.hookSpecificOutput.additionalContext =
        noticeText + "\n\n" + collisionResp.hookSpecificOutput.additionalContext;
    }
    writeJson(res, 200, collisionResp);
    return;
  }

  // No collision, but the calling session may have had pending notices from
  // prior preemptions on OTHER artifacts. Surface them.
  if (noticeText !== null) {
    writeJson(res, 200, {
      ok: true,
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "allow",
        additionalContext: noticeText,
      },
    });
    return;
  }

  writeJson(res, 200, { ok: true });
}

export async function preEditRoute(
  req: IncomingMessage,
  res: ServerResponse,
  deps: PreEditDeps,
  maxBytes: number,
): Promise<void> {
  if (req.method !== "POST") {
    writeError(res, 404, "not found");
    return;
  }
  const body = await readJsonBody(req, res, maxBytes);
  if (body === null) return;
  await handlePreEdit(body as PreEditBody, res, deps);
}
