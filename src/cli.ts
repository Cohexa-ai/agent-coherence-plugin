/**
 * Node CLI surface backing the slash commands (zero-Python Unit 4 / G3):
 * track / untrack / status. Ports the Python console scripts
 * (`ccs/cli/coherence_track.py`, `coherence_untrack.py`, `coherence_status.py`).
 *
 * Exit codes (Python parity): 0 success · 1 not-in-git / nothing valid to
 * send · 2 coordinator unavailable or HTTP error. Unlike the hook-client
 * (fail-open, always 0), the CLIs are operator-facing and DO signal failure.
 *
 * Path normalization ($ARGUMENTS-verbatim learning, 2026-05-26): operators
 * paste absolute paths from their shell/IDE; absolute-inside-root is
 * auto-stripped to workspace-relative, absolute-outside-root is rejected —
 * absolute paths must NEVER leak into tracked.yaml / ignored.yaml.
 */
import { isAbsolute, relative, resolve, sep } from "node:path";
import {
  CoordinatorUnavailable,
  findCoordinatorRoot,
  requestJson,
  resolveEndpoint,
} from "./hook_client_transport.js";

function err(line: string): void {
  process.stderr.write(line + "\n");
}
function out(line: string): void {
  process.stdout.write(line + "\n");
}

/** Pure-string relative-path rules (mirror of Python validate_relative_path). */
function validateRelativePath(p: string): string | null {
  if (p === "") return "empty";
  if (p.startsWith("/")) return "absolute path";
  if (p.replace(/\\/g, "/").split("/").includes("..")) return "contains '..'";
  return null;
}

/**
 * Normalize a CLI path argument to workspace-relative form (mirror of Python
 * `normalize_workspace_path`). Returns [normalized, null] or [original, reason].
 */
export function normalizeWorkspacePath(p: string, root: string): [string, string | null] {
  if (p === "") return [p, "empty"];
  if (isAbsolute(p)) {
    const rel = relative(resolve(root), resolve(p));
    if (rel === "" || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
      return [p, "path outside workspace root"];
    }
    const reason = validateRelativePath(rel);
    return reason === null ? [rel, null] : [p, reason];
  }
  const reason = validateRelativePath(p);
  return reason === null ? [p, null] : [p, reason];
}

function parseArgs(argv: string[]): { paths: string[]; root: string | null } {
  const rootIdx = argv.indexOf("--root");
  const root = rootIdx !== -1 ? (argv[rootIdx + 1] ?? null) : null;
  const paths = argv.filter((a, i) => !a.startsWith("--") && (rootIdx === -1 || i !== rootIdx + 1));
  return { paths, root };
}

async function runPolicyMutation(
  prog: "agent-coherence-track" | "agent-coherence-untrack",
  endpointPath: "/policy/track" | "/policy/untrack",
  resultKey: "added" | "removed",
  verb: "tracked" | "untracked",
  argv: string[],
): Promise<number> {
  const { paths, root: rootArg } = parseArgs(argv);
  const root = rootArg ?? findCoordinatorRoot();
  if (root === null) {
    err(`${prog}: not in a git repository`);
    return 1;
  }

  const invalid: Array<[string, string]> = [];
  const valid: string[] = [];
  for (const p of paths) {
    const [normalized, reason] = normalizeWorkspacePath(p, root);
    if (reason !== null) invalid.push([p, reason]);
    else valid.push(normalized);
  }
  if (valid.length === 0) {
    for (const [p, reason] of invalid) err(`${prog}: rejected '${p}': ${reason}`);
    return 1;
  }

  let payload: Record<string, unknown> | null;
  try {
    const endpoint = resolveEndpoint(resolve(root));
    payload = await requestJson(endpoint, "POST", endpointPath, { paths: valid });
  } catch (exc) {
    if (exc instanceof CoordinatorUnavailable) {
      err(`${prog}: ${exc.message}`);
      return 2;
    }
    err(`${prog}: ${(exc as Error).message}`);
    return 2;
  }
  if (payload === null) {
    err(`${prog}: coordinator rejected the request`);
    return 2;
  }

  const applied = Array.isArray(payload[resultKey]) ? (payload[resultKey] as string[]) : [];
  const rejected = Array.isArray(payload.rejected)
    ? (payload.rejected as Array<Record<string, unknown>>)
    : [];
  for (const p of applied) out(`${prog}: ${verb} ${p}`);
  for (const entry of rejected) {
    err(`${prog}: rejected ${String(entry.path ?? "")}: ${String(entry.reason ?? "")}`);
  }
  for (const [p, reason] of invalid) err(`${prog}: rejected '${p}': ${reason}`);
  return 0;
}

export function runTrack(argv: string[]): Promise<number> {
  return runPolicyMutation("agent-coherence-track", "/policy/track", "added", "tracked", argv);
}

export function runUntrack(argv: string[]): Promise<number> {
  return runPolicyMutation("agent-coherence-untrack", "/policy/untrack", "removed", "untracked", argv);
}

export async function runStatus(argv: string[]): Promise<number> {
  const { root: rootArg } = parseArgs(argv);
  const root = rootArg ?? findCoordinatorRoot();
  if (root === null) {
    err("agent-coherence-status: not in a git repository");
    return 1;
  }
  let payload: Record<string, unknown> | null;
  try {
    const endpoint = resolveEndpoint(resolve(root));
    payload = await requestJson(endpoint, "GET", "/status");
  } catch (exc) {
    err(`agent-coherence-status: ${(exc as Error).message}`);
    return 2;
  }
  if (payload === null) {
    err("agent-coherence-status: coordinator rejected the request");
    return 2;
  }
  out(JSON.stringify(payload, null, 2));
  return 0;
}
