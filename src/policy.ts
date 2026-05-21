/**
 * Tracked-artifact policy — Node port of Python adapters/claude_code/policy.py.
 *
 * Decides whether a parent-repo-relative path is coordinated. Loaded from
 * `<workspace>/.coherence/{tracked,ignored}.yaml` on coordinator startup;
 * the defaults below ship in code so a fresh workspace with no YAML files
 * still tracks the canonical coordination files.
 *
 * Per KTD-L: DECISIONS.md is included in the default tracked set as of
 * v0.1.1 (operator-rulings append-only ledger pattern surfaced by
 * kcarriedo in anthropics/claude-code#59309).
 *
 * KTD-A.5 point 4: YAML file locking interop with the Python coordinator
 * requires fd-level POSIX flock(2), NOT proper-lockfile's sidecar-lock
 * approach. v0.1.1 Unit 1 does not yet wire write-time locking (writes
 * happen via `/policy/track` + `/policy/untrack` endpoints landing in
 * Unit 3 / Unit 6); this module is read-only at the registry layer for now.
 *
 * Cross-language glob semantics: hand-rolled regex translation mirrors
 * Python's _glob_match exactly — `*` matches within a path segment,
 * `**` matches zero-or-more segments, `?` matches a single non-slash char.
 * fnmatch's fnmatchcase semantics; KTD-B.3 C5 prefix contract applies to
 * the parity scenarios that cover policy decisions.
 */
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { load as yamlLoad } from "js-yaml";

/**
 * Default tracked patterns (Unit 2 commit 4 + KTD-L).
 *
 * Cross-language safe — pattern set must not produce false positives on
 * Node, Rust, Django, or other-ecosystem path samples. Unit 8 lands the
 * 1000-path benchmark that locks the false-positive rate.
 */
export const DEFAULT_TRACKED_PATTERNS: ReadonlyArray<string> = [
  // Repo-root coordination files
  "CLAUDE.md",
  "AGENTS.md",
  // KTD-L: operator-rulings append-only ledger pattern (added 2026-05-18)
  "DECISIONS.md",
  // Spec/plan/brainstorm directories
  "docs/specs/**/*.md",
  "docs/plans/**/*.md",
  "docs/brainstorms/**/*.md",
  // Conventional coordination filenames at any depth
  "**/plan.md",
  "**/task.md",
  "**/spec.md",
];

export interface PolicySummary {
  coordinator_root: string;
  default_pattern_count: number;
  user_added_pattern_count: number;
  ignored_pattern_count: number;
  rejected_pattern_count: number;
}

export interface RejectedPattern {
  pattern: string;
  reason: string;
}

export class TrackedArtifactPolicy {
  readonly coordinatorRoot: string;
  readonly trackedPatterns: ReadonlyArray<string>;
  readonly ignoredPatterns: ReadonlyArray<string>;
  readonly userAddedPatterns: ReadonlyArray<string>;
  readonly rejectedPatterns: ReadonlyArray<RejectedPattern>;

  private constructor(args: {
    coordinatorRoot: string;
    trackedPatterns: ReadonlyArray<string>;
    ignoredPatterns: ReadonlyArray<string>;
    userAddedPatterns: ReadonlyArray<string>;
    rejectedPatterns: ReadonlyArray<RejectedPattern>;
  }) {
    this.coordinatorRoot = args.coordinatorRoot;
    this.trackedPatterns = args.trackedPatterns;
    this.ignoredPatterns = args.ignoredPatterns;
    this.userAddedPatterns = args.userAddedPatterns;
    this.rejectedPatterns = args.rejectedPatterns;
  }

  /** Load policy: defaults + .coherence/tracked.yaml opt-in + .coherence/ignored.yaml opt-out. */
  static load(coordinatorRoot: string): TrackedArtifactPolicy {
    const rejected: RejectedPattern[] = [];
    const added = loadYamlPatterns(join(coordinatorRoot, ".coherence", "tracked.yaml"), rejected);
    const ignored = loadYamlPatterns(join(coordinatorRoot, ".coherence", "ignored.yaml"), rejected);
    return new TrackedArtifactPolicy({
      coordinatorRoot,
      trackedPatterns: DEFAULT_TRACKED_PATTERNS,
      ignoredPatterns: ignored,
      userAddedPatterns: added,
      rejectedPatterns: rejected,
    });
  }

  /**
   * Return true if the given parent-repo-relative path is coordinated.
   * Algorithm: path is tracked if it matches any default OR user-added
   * pattern, AND does not match any ignored pattern. Ignore wins ties.
   */
  isTracked(parentRelativePath: string): boolean {
    const normalized = normalizeRelative(parentRelativePath);
    if (normalized === null) return false;

    const tracked =
      matchesAny(normalized, this.trackedPatterns) ||
      matchesAny(normalized, this.userAddedPatterns);
    if (!tracked) return false;
    if (matchesAny(normalized, this.ignoredPatterns)) return false;
    return true;
  }

  summary(): PolicySummary {
    return {
      coordinator_root: this.coordinatorRoot,
      default_pattern_count: this.trackedPatterns.length,
      user_added_pattern_count: this.userAddedPatterns.length,
      ignored_pattern_count: this.ignoredPatterns.length,
      rejected_pattern_count: this.rejectedPatterns.length,
    };
  }
}

// ----------------------------------------------------------------------
// Internals
// ----------------------------------------------------------------------

/**
 * Normalize a relative path: strip leading `./`. Returns null if the path
 * is absolute, contains `..` components, or is empty after stripping.
 *
 * Note: uses literal `./` prefix strip (NOT trim of `./`) so dotfiles like
 * `.env` and `.gitignore` are unchanged. Mirrors Python's removeprefix fix
 * documented at policy.py:136-140.
 */
export function normalizeRelative(p: string): string | null {
  if (p === "") return null;
  if (p.startsWith("/")) return null;
  const cleaned = p.startsWith("./") ? p.slice(2) : p;
  if (cleaned === "") return null;
  const parts = cleaned.replace(/\\/g, "/").split("/");
  if (parts.includes("..")) return null;
  return cleaned;
}

function matchesAny(path: string, patterns: ReadonlyArray<string>): boolean {
  const posixPath = path.replace(/\\/g, "/");
  for (const pattern of patterns) {
    if (globMatch(posixPath, pattern)) return true;
  }
  return false;
}

/**
 * Posix-style glob matcher. Supports `**` (zero-or-more path segments),
 * `*` (zero-or-more chars within a segment, no `/`), `?` (one non-slash char).
 * Mirrors Python's _glob_match for KTD-B parity.
 */
// Per-process cache of compiled glob patterns. Hot path: every hook on
// every tracked-artifact lookup compiles `**` once per session otherwise.
// ce-review safe_auto fix: pure memoization, no semantic change.
const compiledGlobs: Map<string, RegExp> = new Map();

export function globMatch(path: string, pattern: string): boolean {
  let regex = compiledGlobs.get(pattern);
  if (regex === undefined) {
    regex = new RegExp("^" + patternToRegex(pattern) + "$");
    compiledGlobs.set(pattern, regex);
  }
  return regex.test(path);
}

function patternToRegex(pattern: string): string {
  const out: string[] = [];
  let i = 0;
  while (i < pattern.length) {
    const c = pattern[i];
    if (c === "*") {
      if (i + 1 < pattern.length && pattern[i + 1] === "*") {
        out.push(".*");
        i += 2;
        if (i < pattern.length && pattern[i] === "/") {
          i += 1;
        }
      } else {
        out.push("[^/]*");
        i += 1;
      }
    } else if (c === "?") {
      out.push("[^/]");
      i += 1;
    } else {
      // Escape regex metacharacters.
      out.push(c!.replace(/[.+^${}()|[\]\\]/g, "\\$&"));
      i += 1;
    }
  }
  return out.join("");
}

/**
 * Read a YAML file containing a list of pattern strings. Apply path-traversal
 * guard. Returns surviving patterns; mutates rejected with (pattern, reason)
 * for each rejection.
 *
 * Missing file → []. Malformed YAML → [] + logged WARNING. Non-list top-level → [].
 */
function loadYamlPatterns(yamlPath: string, rejected: RejectedPattern[]): string[] {
  let stat;
  try {
    stat = statSync(yamlPath);
  } catch {
    return [];
  }
  if (!stat.isFile()) return [];

  let raw: unknown;
  try {
    const text = readFileSync(yamlPath, "utf8");
    raw = yamlLoad(text);
  } catch (err) {
    process.stderr.write(
      `agent-coherence: WARNING — malformed YAML at ${yamlPath}; falling back to defaults: ${String(err)}\n`,
    );
    return [];
  }

  if (raw === null || raw === undefined) return [];
  if (!Array.isArray(raw)) {
    process.stderr.write(
      `agent-coherence: WARNING — ${yamlPath} top-level must be a list of patterns; got ${typeof raw}. Ignoring.\n`,
    );
    return [];
  }

  const surviving: string[] = [];
  for (const item of raw) {
    if (typeof item !== "string") {
      rejected.push({ pattern: String(item), reason: `non-string pattern (${typeof item})` });
      continue;
    }
    const reason = validatePattern(item);
    if (reason !== null) {
      rejected.push({ pattern: item, reason });
      continue;
    }
    surviving.push(item);
  }
  return surviving;
}

/** Path-traversal guard. Returns null if pattern is acceptable, else a short reason. */
function validatePattern(pattern: string): string | null {
  if (pattern === "") return "empty pattern";
  if (pattern.startsWith("/")) return "absolute path";
  const parts = pattern.replace(/\\/g, "/").split("/");
  if (parts.includes("..")) return "contains '..' (path traversal)";
  return null;
}
