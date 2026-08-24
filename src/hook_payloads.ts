/**
 * Hook response builders — Node port of Python `hook_payloads.py`.
 *
 * Produces the exact `hookSpecificOutput` shapes Claude Code injects into
 * the agent's context: stale-read warnings, edit-collision warnings,
 * preemption-notice prose. Per-invocation variation in the text is
 * structural defense for v0.2 strict mode (the §13.5 retry-loop hazard the
 * Phase 0 falsifiability experiment investigated — see
 * docs/probes/2026-05-19-ktd-e-falsifiability/REPORT.md).
 *
 * Per KTD-B.3 C3: the OUTER response keys are snake_case (we own them).
 * Per the same: `hookSpecificOutput` and all keys inside it are camelCase
 * (Claude Code owns the hook-output schema — this is the documented
 * boundary).
 *
 * Per KTD-13: NEVER include content bytes, content hashes, or diff text
 * in the response surface. Stale-read summary is structural metadata only.
 */
import { SWEEP_RECLAMATION_PREEMPTER_ID } from "./agent_id.js";

export interface StaleSummary {
  path: string;
  current_version: number;
  prior_version_seen_by_session: number | null;
  last_writer_session_id: string;
  last_writer_at_unix_ts: number;
  warning_generated_at_unix_ts: number;
  hash_differs: boolean;
}

export interface HookSpecificOutput {
  hookEventName: "PreToolUse";
  permissionDecision: "allow" | "deny" | "ask";
  /**
   * OPTIONAL (Unit 6 review correction): Python's `emit_strict_deny` returns
   * NO `additionalContext` key at all, and `emit_allow` includes it only
   * when non-None. Byte-parity requires OMITTING the key, not sending "".
   */
  additionalContext?: string;
  permissionDecisionReason?: string;
}

// ----------------------------------------------------------------------
// v0.2 strict-mode emitters — Node port of Python hook_payloads.py
// (KTD-P static deny text · KTD-U terminal denial) — zero-Python Unit 6
// ----------------------------------------------------------------------

/**
 * KTD-U security invariant: denial classes that must NEVER be converted to
 * `permissionDecision: "allow"`. `emitAllow` throws on membership.
 */
export const TERMINAL_DENIAL_CLASSES: ReadonlySet<string> = new Set([
  "permissions_deny_strict_mode",
]);

/**
 * KTD-P static deny text — BYTE-IDENTICAL to the Python
 * `STRICT_MODE_DENY_REASON_TEMPLATE`. Phase 0 H1 proved varied deny text
 * WORSENS opus retry behavior (5 retries vs 2); every substitution is
 * deterministic per-artifact / per-preempter / per-commit-tick. Do not
 * reword, respace, or add fields.
 */
export const STRICT_MODE_DENY_REASON_TEMPLATE =
  "Stale read denied: {path} was updated by session {last_writer_short} " +
  "at {last_writer_ts_iso}. Re-read {path} via the Read tool before " +
  "proceeding. This denial is structural (v0.2 strict mode); retrying " +
  "the same operation will produce the same denial.";

/**
 * Python `datetime.fromtimestamp(ts, tz=utc).isoformat()` semantics —
 * NOT `Date.toISOString()` (which emits `Z` + fixed 3-digit ms and would
 * byte-diverge on every fractional timestamp; plan review finding):
 * - offset rendered as `+00:00`
 * - microsecond precision, 6 digits zero-padded, OMITTED entirely when the
 *   fractional part rounds to 0.
 */
export function pythonIsoUtc(unixSeconds: number): string {
  const totalMicros = Math.round(unixSeconds * 1e6);
  const micros = ((totalMicros % 1_000_000) + 1_000_000) % 1_000_000;
  const seconds = (totalMicros - micros) / 1_000_000;
  const d = new Date(seconds * 1000);
  const pad = (n: number, w: number) => String(n).padStart(w, "0");
  const base =
    `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1, 2)}-${pad(d.getUTCDate(), 2)}` +
    `T${pad(d.getUTCHours(), 2)}:${pad(d.getUTCMinutes(), 2)}:${pad(d.getUTCSeconds(), 2)}`;
  return micros === 0 ? `${base}+00:00` : `${base}.${pad(micros, 6)}+00:00`;
}

/**
 * Build the allow envelope. ALL allow emissions route through here so the
 * KTD-U invariant is structurally enforced: converting a terminal-class
 * denial back to allow throws (mirrors Python's AssertionError).
 */
export function emitAllow(args: {
  source: string;
  additionalContext?: string | null;
  denialClass?: string | null;
}): HookSpecificOutput {
  if (args.denialClass != null && TERMINAL_DENIAL_CLASSES.has(args.denialClass)) {
    throw new Error(
      `emitAllow(source=${args.source}, denialClass=${args.denialClass}): ` +
        `refused to convert TERMINAL_DENIAL_CLASSES member to allow. ` +
        `This is the KTD-U security invariant — strict-mode denials are structurally terminal.`,
    );
  }
  const out: HookSpecificOutput = {
    hookEventName: "PreToolUse",
    permissionDecision: "allow",
  };
  if (args.additionalContext != null) out.additionalContext = args.additionalContext;
  return out;
}

/**
 * Build the strict-mode deny envelope — byte-parity with Python
 * `emit_strict_deny`:
 * - null/absent last_writer → the literal `<unknown>`;
 * - a `<…>` sentinel is preserved VERBATIM (a naive [:8] slice would emit
 *   `<unknown` — the plan-review finding);
 * - otherwise the 8-char short form;
 * - timestamp via `pythonIsoUtc` (never toISOString);
 * - NO additionalContext key.
 * The `source` arg is kept for call-site telemetry parity with Python.
 */
export function emitStrictDeny(args: { source: string; summary: StaleSummary }): HookSpecificOutput {
  const lastWriterFull = args.summary.last_writer_session_id || "<unknown>";
  const lastWriterShort =
    lastWriterFull.startsWith("<") && lastWriterFull.endsWith(">")
      ? lastWriterFull
      : lastWriterFull.slice(0, 8);
  const lastWriterTsIso = pythonIsoUtc(args.summary.last_writer_at_unix_ts);
  const reason = STRICT_MODE_DENY_REASON_TEMPLATE.replaceAll("{path}", args.summary.path)
    .replace("{last_writer_short}", lastWriterShort)
    .replace("{last_writer_ts_iso}", lastWriterTsIso);
  return {
    hookEventName: "PreToolUse",
    permissionDecision: "deny",
    permissionDecisionReason: reason,
  };
}

export interface StaleResponse {
  hookSpecificOutput: HookSpecificOutput;
  status: "stale";
  summary: StaleSummary;
}

export interface CollisionResponse {
  hookSpecificOutput: HookSpecificOutput;
  ok: true;
  collision: true;
}

export interface FreshResponse {
  status: "fresh";
}

export interface FreshWithNoticeResponse {
  status: "fresh";
  hookSpecificOutput: HookSpecificOutput;
}

/** Single source of truth for "now" in unix-seconds; tests can mock later. */
export function nowUnix(): number {
  return Date.now() / 1000;
}

function isoUtc(unixSeconds: number): string {
  return new Date(unixSeconds * 1000).toISOString();
}

/**
 * Build the stale-read additionalContext text. Per-invocation variation
 * via `warning_generated_at_unix_ts` (handler-time now()) guarantees
 * byte-different text across retries — structural defense for any future
 * strict-mode flip. Matches Python `stale_read_warning` prose pattern.
 */
export function staleReadWarning(summary: StaleSummary): string {
  const lastWriterShort = summary.last_writer_session_id.slice(0, 8);
  const lastWriterTs = isoUtc(summary.last_writer_at_unix_ts);
  const generatedTs = isoUtc(summary.warning_generated_at_unix_ts);

  const priorClause =
    summary.prior_version_seen_by_session !== null
      ? `you previously saw v${summary.prior_version_seen_by_session}`
      : "this is the first time your session has observed this artifact " +
        "(another session in this workspace registered it before you)";

  const divergence = summary.hash_differs
    ? "Your worktree's current content also differs from the coordinator's " +
      "last-recorded hash, which suggests in-flight local edits or a " +
      "different branch checkout."
    : "Your worktree's content matches the last-recorded hash; the divergence " +
      "is purely about version-tracking metadata.";

  return (
    `⚠ Stale read [warning emitted ${generatedTs}]: ${summary.path} was ` +
    `updated by session ${lastWriterShort} at ${lastWriterTs}. ` +
    `Current version is v${summary.current_version}; ${priorClause}. ` +
    `${divergence} ` +
    `Consider re-reading ${summary.path} before acting on stale assumptions.`
  );
}

/**
 * Build the edit-collision additionalContext text. Per-invocation variation
 * via `detected_ts = now()` matches Python's structural defense.
 */
export function editCollisionWarning(
  holderSessionId: string,
  holderAcquiredAtUnixTs: number,
  path: string,
): string {
  const holderShort = holderSessionId.slice(0, 8);
  const holderTs = isoUtc(holderAcquiredAtUnixTs);
  const detectedTs = isoUtc(nowUnix());
  return (
    `⚠ Concurrent edit detected at ${detectedTs} (UTC): another session ` +
    `(${holderShort}) has been editing ${path} since ${holderTs}. ` +
    `Your edit will land in your own worktree, but only one session's ` +
    `commit will be accepted by the coordinator. Consider waiting for the ` +
    `other session to finish or coordinating which one should proceed.`
  );
}

/**
 * F3 hardening (Python `_PREEMPTION_PROSE_VERBATIM_CAP`): render at most this
 * many notices verbatim and coalesce the rest into one overflow line, so the
 * block stays a constant size regardless of N and leaves room under Claude
 * Code's 10KB additionalContext cap for a prepended stale-read warning.
 */
const PREEMPTION_PROSE_VERBATIM_CAP = 3;

/** One pending notice, resolved to the fields the prose renders. */
export interface RenderableNotice {
  artifactPath: string;
  /** Raw preempter agent id — compared against the ADV-004 sweep sentinel. */
  preempterAgentId: string;
  preempterSessionShort: string;
  preemptedAtUnixTs: number;
}

/**
 * Build the preemption-notice additionalContext text for a session whose M/E
 * grant was silently revoked. Byte-identical to Python `_build_preemption_text`
 * (coordinator_server.py), which is the reference implementation: this prose is
 * the whole signal telling a model its edit was stranded, so the two backends
 * must not word it differently. Newest first; sweep reclamation named as such
 * rather than as a peer session.
 */
export function preemptionNoticeText(notices: ReadonlyArray<RenderableNotice>): string {
  if (notices.length === 0) return "";
  // Stable sort (ES2019+) newest-first, matching Python's stable `sorted(...,
  // reverse=True)` — equal timestamps keep the order the registry returned.
  const sorted = [...notices].sort((a, b) => b.preemptedAtUnixTs - a.preemptedAtUnixTs);
  const verbatim = sorted.slice(0, PREEMPTION_PROSE_VERBATIM_CAP);
  const overflow = sorted.slice(PREEMPTION_PROSE_VERBATIM_CAP);

  const lines: string[] = ["⚠ Coordinator notice: your EXCLUSIVE grant was preempted:"];
  for (const n of verbatim) {
    if (n.preempterAgentId === SWEEP_RECLAMATION_PREEMPTER_ID) {
      lines.push(
        `  • ${n.artifactPath} — reclaimed by the coordinator sweep ` +
          `(heartbeat timeout or max-hold ceiling) at ${isoUtc(n.preemptedAtUnixTs)}. ` +
          `Any local edit you made to this file will land in your ` +
          `worktree but is NOT reflected in the coordinator's version. ` +
          `Re-fetch via pre-read and retry.`,
      );
      continue;
    }
    lines.push(
      `  • ${n.artifactPath} — preempted/revoked by session ${n.preempterSessionShort} ` +
        `at ${isoUtc(n.preemptedAtUnixTs)}. Any local edit you made to this file will land ` +
        `in your worktree but is NOT reflected in the coordinator's version.`,
    );
  }
  if (overflow.length > 0) {
    lines.push(
      `  • Plus ${overflow.length} more preemptions since your last activity; ` +
        `run \`/agent-coherence status\` (or query GET /status on the coordinator) ` +
        `for the full list.`,
    );
  }
  lines.push(
    "Re-read affected files before continuing if you need the latest " +
      "coordinator-tracked version, or proceed knowing your edits remain " +
      "local-only until you re-acquire and commit.",
  );
  return lines.join("\n");
}

export function buildStaleResponse(summary: StaleSummary): StaleResponse {
  return {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "allow", // v0.1.1 warn-only; v0.2 may flip per KTD-E
      additionalContext: staleReadWarning(summary),
    },
    status: "stale",
    summary,
  };
}

export function buildCollisionResponse(
  holderSessionId: string,
  holderAcquiredAtUnixTs: number,
  path: string,
): CollisionResponse {
  return {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "allow",
      additionalContext: editCollisionWarning(holderSessionId, holderAcquiredAtUnixTs, path),
    },
    ok: true,
    collision: true,
  };
}

export function buildFreshWithNotice(notice: string): FreshWithNoticeResponse {
  return {
    status: "fresh",
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "allow",
      additionalContext: notice,
    },
  };
}
