/**
 * SQLite artifact registry — Node port of the Python coordinator's
 * SqliteArtifactRegistry (src/ccs/coordinator/sqlite_registry.py).
 *
 * v0.1.1 Unit 1 (this commit) lands ONLY the constructor + close():
 * - Open Database at <workspace>/.coherence/state.db
 * - Set PRAGMA journal_mode = WAL (concurrent reader safety)
 * - Set PRAGMA busy_timeout = 1500ms per KTD-K REVISED ordering rule
 *   (busy_timeout is per-lock-acquisition, NOT per-transaction; multi-statement
 *   transactions accumulate budget; 2× lock-acquisitions × 1500ms = 3s ceiling
 *   stays under the 4s handler watchdog with 1s safety margin)
 * - Run pending migrations (empty list in Unit 1; Unit 2 fills)
 * - Provide close() for graceful shutdown
 *
 * NOT in this commit (Unit 2 lands):
 * - register_artifact / fetch / write / commit / invalidate methods
 * - pending_notices table operations
 * - state_log callback wiring
 * - mutation-then-log invariant enforcement (per KTD-A.5 + sqlite_registry.py
 *   "mutation-then-log" docstring)
 *
 * Per KTD-C: state.db lives in the workspace (not ${CLAUDE_PLUGIN_DATA}) because
 * it's per-workspace shared state across coordinator backends, not per-plugin
 * cache. Same path as Python coordinator — KTD-A.5 point 1 mutex + KTD-D
 * forward-compatible schema enable backend coexistence.
 */
import BetterSqlite3, { type Database } from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { runPendingMigrations, SCHEMA_USER_VERSION } from "./migrations.js";
import { MESIState, isValidTransition, isWriter } from "./states.js";
import { checkSingleWriter, checkMonotonicVersion } from "./invariants.js";

/** Per KTD-K REVISED: per-lock-acquisition retry budget, NOT per-transaction. */
export const BUSY_TIMEOUT_MS = 1500;

export interface RegistryStats {
  readonly schemaVersion: number;
  readonly migrationsApplied: number;
}

/**
 * Artifact record returned by registry queries. Mirrors Python core/types.py
 * Artifact dataclass for KTD-B wire-equality contract. `id` is UUID hex
 * (no hyphens, lowercase); `name` is parent-repo-relative path.
 */
export interface Artifact {
  /** UUID hex without hyphens — matches Python `Artifact.id.hex`. */
  readonly id: string;
  /** Parent-repo-relative path. UNIQUE in the artifacts table. */
  readonly name: string;
  /** Monotonic version. Bumps on commit (Unit 2 commit 3). */
  readonly version: number;
  /** SHA-256 hex of content at this version. */
  readonly content_hash: string;
  /** Optional token count for diagnostics; null if unknown. */
  readonly size_tokens: number | null;
  /** UUID hex of last agent to commit; null if never written. */
  readonly last_writer_id: string | null;
  /** Coordinator epoch seconds (Date.now() / 1000) of last write. */
  readonly updated_at: number;
}

/**
 * Typed CAS result — Node mirror of Python's `ConflictDetail` / `CasCorruption`
 * / WIN-tuple discrimination (core/types.py). Returned (never thrown) so the
 * route layer maps each outcome to its exact Python wire body:
 * - win        → `{ok: true, version}`
 * - conflict   → `{ok: false, reason, current_version}` (reason matched
 *                EXACTLY by consumers — typed-signal discipline, never substring)
 * - corruption → the service-level `commit_cas_corruption …` error body
 *                (`expected_version > current`; no current_version on the wire)
 */
export type CasOutcome =
  | { kind: "win"; artifact: Artifact; invalidatedPeers: string[] }
  | {
      kind: "conflict";
      reason: "version_mismatch" | "other_holder";
      currentVersion: number;
    }
  | { kind: "corruption"; currentVersion: number };

// ArtifactRow / rowToArtifact removed (ce-review maintainability finding):
// the SQLite row shape and the Artifact interface were byte-identical;
// the mapper was an identity function. We cast directly to `Artifact` at
// the `.get()`/`.all()` call sites — the `readonly` modifiers on Artifact
// are a TypeScript compile-time constraint that the cast satisfies.

/**
 * Narrow a raw SQLite `state` string to `MESIState`. Throws on unknown values
 * (e.g., a Python transient state string like "ISG" surfacing through a
 * shared state.db). ce-review kieran-typescript finding: replaces the bare
 * `as MESIState` cast with an explicit guard.
 */
function toMESIState(s: string): MESIState {
  switch (s) {
    case MESIState.MODIFIED:
    case MESIState.EXCLUSIVE:
    case MESIState.SHARED:
    case MESIState.INVALID:
      return s;
    default:
      throw new Error(`registry: unknown MESI state from DB: ${s}`);
  }
}

/**
 * UUID hex format used in `artifacts.id`: 32 hex chars, no hyphens, lowercase.
 * Matches Python's `UUID.hex` representation. randomUUID() returns the
 * hyphenated form; we strip + lowercase for storage consistency.
 */
function newArtifactId(): string {
  return randomUUID().replace(/-/g, "").toLowerCase();
}

export class ArtifactRegistry {
  private readonly db: Database;
  private readonly stats: RegistryStats;
  private closed = false;

  constructor(databasePath: string) {
    mkdirSync(dirname(databasePath), { recursive: true, mode: 0o700 });

    this.db = new BetterSqlite3(databasePath, { fileMustExist: false });
    this.db.pragma("journal_mode = WAL");
    this.db.pragma(`busy_timeout = ${BUSY_TIMEOUT_MS}`);
    // foreign_keys = ON matches Python coordinator's _apply_v1_schema setup.
    this.db.pragma("foreign_keys = ON");
    // synchronous = NORMAL matches Python coordinator's sqlite_registry.py:181 —
    // WAL default is NORMAL but Python sets it explicitly; mirror for parity.
    // ce-review safe_auto fix per data-migrations finding 4.
    this.db.pragma("synchronous = NORMAL");

    const result = runPendingMigrations(this.db);
    this.stats = {
      schemaVersion: result.current,
      migrationsApplied: result.applied.length,
    };
  }

  /** Stats from constructor migration run; surfaces in /status diagnostics. */
  getStats(): RegistryStats {
    return this.stats;
  }

  // ------------------------------------------------------------------
  // Artifact registration + lookup (Unit 2 commit 2)
  // ------------------------------------------------------------------

  /**
   * KTD-9 first-observation seeding. Mirrors Python `resolve_or_register`
   * (sqlite_registry.py:818).
   *
   * Atomically: SELECT artifact by name → if found, return its id; otherwise
   * INSERT new artifact at version=1 with the given content_hash. Concurrent
   * first-Reads from two sessions on the same fresh path converge to ONE row:
   * BEGIN IMMEDIATE + UNIQUE constraint on `artifacts.name` absorbs the race;
   * the loser's INSERT raises SqliteError code SQLITE_CONSTRAINT_UNIQUE, which
   * we catch + re-fetch.
   *
   * Returns the artifact's UUID hex id (32 chars, no hyphens, lowercase).
   */
  resolveOrRegisterArtifact(name: string, contentHash: string): string {
    const select = this.db.prepare(`SELECT id FROM artifacts WHERE name = ?`);
    const insert = this.db.prepare(`
      INSERT INTO artifacts (id, name, version, content_hash, size_tokens, last_writer_id, updated_at)
      VALUES (?, ?, 1, ?, NULL, NULL, ?)
    `);

    this.db.exec("BEGIN IMMEDIATE");
    try {
      const existing = select.get(name) as { id: string } | undefined;
      if (existing !== undefined) {
        this.db.exec("COMMIT");
        return existing.id;
      }
      const newId = newArtifactId();
      insert.run(newId, name, contentHash, Date.now() / 1000);
      this.db.exec("COMMIT");
      return newId;
    } catch (err) {
      try {
        this.db.exec("ROLLBACK");
      } catch {
        // Rollback failure non-recoverable; surface original error.
      }
      // UNIQUE-on-name race: another caller inserted between our SELECT and
      // INSERT. Re-fetch the winning row. better-sqlite3 surfaces the
      // constraint violation as SqliteError with `code === "SQLITE_CONSTRAINT_UNIQUE"`.
      if (
        err !== null &&
        typeof err === "object" &&
        "code" in err &&
        err.code === "SQLITE_CONSTRAINT_UNIQUE"
      ) {
        const existing = select.get(name) as { id: string } | undefined;
        if (existing !== undefined) {
          return existing.id;
        }
        // Genuine UNIQUE violation that's NOT our name race; re-throw.
      }
      throw err;
    }
  }

  /** Return artifact metadata by id, or null if unknown. */
  getArtifactById(id: string): Artifact | null {
    const row = this.db
      .prepare(`SELECT id, name, version, content_hash, size_tokens, last_writer_id, updated_at FROM artifacts WHERE id = ?`)
      .get(id) as Artifact | undefined;
    return row ?? null;
  }

  /** Return artifact metadata by name (parent-repo-relative path), or null. */
  getArtifactByName(name: string): Artifact | null {
    const row = this.db
      .prepare(`SELECT id, name, version, content_hash, size_tokens, last_writer_id, updated_at FROM artifacts WHERE name = ?`)
      .get(name) as Artifact | undefined;
    return row ?? null;
  }

  /** Cheap existence check; cheaper than getArtifactById when only presence matters. */
  hasArtifact(id: string): boolean {
    const row = this.db.prepare(`SELECT 1 FROM artifacts WHERE id = ?`).get(id);
    return row !== undefined;
  }

  /** Return all known artifact ids (UUID hex). Order is unspecified. */
  listArtifactIds(): string[] {
    const rows = this.db.prepare(`SELECT id FROM artifacts`).all() as { id: string }[];
    return rows.map((r) => r.id);
  }

  /** Return all known artifacts. Order is unspecified. */
  listArtifacts(): Artifact[] {
    return this.db
      .prepare(`SELECT id, name, version, content_hash, size_tokens, last_writer_id, updated_at FROM artifacts`)
      .all() as Artifact[];
  }

  // ------------------------------------------------------------------
  // MESI write-path (Unit 2 commit 3)
  // ------------------------------------------------------------------

  /**
   * Return per-agent MESI state map for an artifact. Returns empty map if
   * no agent has ever touched it. Mirrors Python `get_state_map`.
   */
  getStateMap(artifactId: string): Map<string, MESIState> {
    const rows = this.db
      .prepare(`SELECT agent_id, state FROM agent_states WHERE artifact_id = ?`)
      .all(artifactId) as { agent_id: string; state: string }[];
    const map = new Map<string, MESIState>();
    for (const r of rows) {
      map.set(r.agent_id, toMESIState(r.state));
    }
    return map;
  }

  /** Return one agent's MESI state for an artifact, or null if no row exists. */
  getAgentState(artifactId: string, agentId: string): MESIState | null {
    const row = this.db
      .prepare(`SELECT state FROM agent_states WHERE artifact_id = ? AND agent_id = ?`)
      .get(artifactId, agentId) as { state: string } | undefined;
    return row === undefined ? null : toMESIState(row.state);
  }

  /**
   * Acquire EXCLUSIVE for `agentId` on `artifactId`, invalidating any peers
   * currently in M / E / S. Mirrors Python `CoordinatorService.write`
   * (service.py:164) collapsed into a single registry-level transaction
   * (per KTD-10 MESI subset: no transient states, no event bus).
   *
   * Side effects (all in one BEGIN IMMEDIATE):
   * - For each peer in {M, E, S}: UPSERT agent_states to INVALID; UPSERT a
   *   pending_notice with `agentId` as preempter and `nowUnixTs`.
   * - UPSERT agent_states[agentId] to EXCLUSIVE; stamp granted_at_tick.
   * - checkSingleWriter on the post-mutation state map → rollback if
   *   violated.
   *
   * Returns the list of peer agent_ids that were invalidated (empty if no
   * peers held the artifact). Caller uses this for `additionalContext`
   * warning emission downstream.
   */
  acquireExclusive(artifactId: string, agentId: string, nowTick: number): string[] {
    if (!this.hasArtifact(artifactId)) {
      throw new Error(`acquireExclusive: artifact ${artifactId} not registered`);
    }

    this.db.exec("BEGIN IMMEDIATE");
    try {
      const stateMap = this.getStateMap(artifactId);
      const invalidatedPeers: string[] = [];

      for (const [peerId, peerState] of stateMap) {
        if (peerId === agentId) continue;
        if (peerState === MESIState.INVALID) continue;
        if (!isValidTransition(peerState, MESIState.INVALID)) {
          throw new Error(
            `acquireExclusive: peer ${peerId} in ${peerState} cannot transition to INVALID`,
          );
        }
        this.setAgentStateInternal(artifactId, peerId, peerState, MESIState.INVALID, nowTick, "write");
        this.upsertPendingNotice(peerId, artifactId, agentId, nowTick);
        invalidatedPeers.push(peerId);
      }

      const priorAgentState = stateMap.get(agentId) ?? MESIState.INVALID;
      if (priorAgentState !== MESIState.EXCLUSIVE && priorAgentState !== MESIState.MODIFIED) {
        if (!isValidTransition(priorAgentState, MESIState.EXCLUSIVE)) {
          throw new Error(
            `acquireExclusive: ${agentId} transition ${priorAgentState}→EXCLUSIVE not allowed`,
          );
        }
        this.setAgentStateInternal(
          artifactId,
          agentId,
          priorAgentState,
          MESIState.EXCLUSIVE,
          nowTick,
          "write",
        );
      }

      // Verify single-writer in same txn so violation rolls back.
      const postMap = this.getStateMap(artifactId);
      checkSingleWriter(postMap);

      this.db.exec("COMMIT");
      return invalidatedPeers;
    } catch (err) {
      try {
        this.db.exec("ROLLBACK");
      } catch {
        // Rollback failure non-recoverable; surface original error.
      }
      throw err;
    }
  }

  /**
   * Commit a new content_hash + bump version. Caller MUST hold EXCLUSIVE or
   * MODIFIED on the artifact (verified inside the BEGIN IMMEDIATE).
   *
   * Mirrors Python `CoordinatorService.commit` (service.py:216), collapsed
   * into one transaction per KTD-10.
   *
   * Side effects (all in one BEGIN IMMEDIATE):
   * - Verify agent_states[agentId] ∈ {EXCLUSIVE, MODIFIED}; raise otherwise
   * - Bump artifacts.version (monotonicity invariant check)
   * - Update artifacts.content_hash, last_writer_id, updated_at
   * - For each peer ≠ agentId in {S}: UPSERT agent_states to INVALID + pending_notice
   *   (any M/E peers would already be INVALID via acquireExclusive — they don't recur)
   * - UPSERT agent_states[agentId] to MODIFIED
   * - checkSingleWriter
   *
   * Returns the updated Artifact record.
   */
  commit(
    artifactId: string,
    agentId: string,
    newContentHash: string,
    nowTick: number,
    sizeTokens: number | null = null,
  ): { artifact: Artifact; invalidatedPeers: string[] } {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const artifactRow = this.db
        .prepare(
          `SELECT id, name, version, content_hash, size_tokens, last_writer_id, updated_at FROM artifacts WHERE id = ?`,
        )
        .get(artifactId) as Artifact | undefined;
      if (artifactRow === undefined) {
        throw new Error(`commit: artifact ${artifactId} not registered`);
      }

      const agentState = this.getAgentState(artifactId, agentId);
      if (agentState !== MESIState.EXCLUSIVE && agentState !== MESIState.MODIFIED) {
        throw new Error(
          `commit_not_allowed: agent=${agentId} artifact=${artifactId} state=${agentState ?? "INVALID"} ` +
            `(must be EXCLUSIVE or MODIFIED to commit)`,
        );
      }

      const nextVersion = artifactRow.version + 1;
      checkMonotonicVersion(artifactRow.version, nextVersion);

      const updatedAt = Date.now() / 1000;
      this.db
        .prepare(
          `UPDATE artifacts
             SET version = ?, content_hash = ?, size_tokens = COALESCE(?, size_tokens),
                 last_writer_id = ?, updated_at = ?
           WHERE id = ?`,
        )
        .run(nextVersion, newContentHash, sizeTokens, agentId, updatedAt, artifactId);

      // Invalidate any SHARED peers. M/E peers should already be INVALID per
      // single-writer + the acquireExclusive call that preceded this commit;
      // if any are still M/E that's a single-writer violation that the
      // post-commit checkSingleWriter will catch.
      const stateMap = this.getStateMap(artifactId);
      const invalidatedPeers: string[] = [];
      for (const [peerId, peerState] of stateMap) {
        if (peerId === agentId) continue;
        if (peerState === MESIState.INVALID) continue;
        if (!isValidTransition(peerState, MESIState.INVALID)) {
          throw new Error(
            `commit: peer ${peerId} in ${peerState} cannot transition to INVALID`,
          );
        }
        this.setAgentStateInternal(artifactId, peerId, peerState, MESIState.INVALID, nowTick, "commit");
        this.upsertPendingNotice(peerId, artifactId, agentId, nowTick);
        invalidatedPeers.push(peerId);
      }

      // Transition agent E → M (or M → M no-op).
      if (agentState === MESIState.EXCLUSIVE) {
        this.setAgentStateInternal(artifactId, agentId, agentState, MESIState.MODIFIED, nowTick, "commit");
      }
      // If already MODIFIED, no transition needed — caller is committing again on a held grant.

      // Single-writer invariant on post-state. Must hold post-mutation.
      const postMap = this.getStateMap(artifactId);
      checkSingleWriter(postMap);

      // Re-fetch the updated artifact row for the return value.
      const updatedRow = this.db
        .prepare(
          `SELECT id, name, version, content_hash, size_tokens, last_writer_id, updated_at FROM artifacts WHERE id = ?`,
        )
        .get(artifactId) as Artifact;

      this.db.exec("COMMIT");
      return { artifact: updatedRow, invalidatedPeers };
    } catch (err) {
      try {
        this.db.exec("ROLLBACK");
      } catch {
        // Rollback failure non-recoverable; surface original error.
      }
      throw err;
    }
  }

  /**
   * Optimistic-concurrency compare-and-swap commit. Node port of Python
   * `sqlite_registry.commit_cas` + the service-layer D4 preconditions
   * (`service._commit_cas_impl`), collapsed into one registry method per the
   * KTD-10 pattern (no separate service layer on Node).
   *
   * Discrimination order mirrors Python's wire outcome exactly:
   * 1. artifact missing → throw (route maps to an error body)
   * 2. caller in M/E → throw `commit_cas_not_allowed … occ_is_shared_or_invalid_only`
   *    (the D4 precondition: an acquired pessimistic writer must use commit()).
   *    SHARED **and INVALID** callers are admitted — same as Python.
   * 3. expected_version > current → `corruption` (no mutation) — the service
   *    wraps this as a verbose CoherenceError; the route mirrors that body.
   * 4. expected_version < current → `version_mismatch` (no mutation)
   * 5. version matches, another agent holds M/E → `other_holder` (no mutation)
   * 6. WIN: version+1, content_hash/last_writer_id/updated_at updated
   *    (size_tokens preserved on null), committer S/I → SHARED (an OCC writer
   *    never acquired a grant, so SHARED is the honest end-state and keeps a
   *    repeat commit_cas eligible), every non-INVALID peer → INVALID + a
   *    pending notice, single-writer re-checked.
   *
   * Parity notes (plan §Review corrections, decision A):
   * - `caller_in_transient_state` is STRUCTURALLY UNREACHABLE on Node: the
   *   MESI subset has no transient states (invalidation is instantaneous), so
   *   the mid-transient window the Python precondition guards cannot exist.
   * - `stale_read_generation` is STRUCTURALLY UNREACHABLE on Node: the Node
   *   schema has no read_generation/owner_generation columns — those are
   *   foreign-Python-ledger markers that the cross-runtime migration guard
   *   fails closed on (migrations.ts), so a fence claim can never be present
   *   in a Node-owned state.db.
   */
  commitCas(
    artifactId: string,
    agentId: string,
    expectedVersion: number,
    newContentHash: string,
    nowTick: number,
    sizeTokens: number | null = null,
  ): CasOutcome {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const artifactRow = this.db
        .prepare(`SELECT version FROM artifacts WHERE id = ?`)
        .get(artifactId) as { version: number } | undefined;
      if (artifactRow === undefined) {
        throw new Error(`commitCas: artifact ${artifactId} not registered`);
      }
      const current = artifactRow.version;

      // D4 precondition (Python service layer): an EXCLUSIVE/MODIFIED holder
      // is a pessimistic writer and must use commit(). Checked before the
      // version discrimination to match Python's wire outcome for an M/E
      // caller with a mismatched version.
      const callerState = this.getAgentState(artifactId, agentId);
      if (callerState === MESIState.EXCLUSIVE || callerState === MESIState.MODIFIED) {
        throw new Error(
          `commit_cas_not_allowed agent=${agentId} artifact=${artifactId} ` +
            `state=${callerState} reason=occ_is_shared_or_invalid_only ` +
            `(use commit() for an EXCLUSIVE/MODIFIED holder)`,
        );
      }

      if (expectedVersion > current) {
        this.db.exec("COMMIT");
        return { kind: "corruption", currentVersion: current };
      }
      if (expectedVersion < current) {
        this.db.exec("COMMIT");
        return { kind: "conflict", reason: "version_mismatch", currentVersion: current };
      }
      // Version matches. A *pessimistic* M/E peer blocks the OCC win.
      const otherHolder = this.db
        .prepare(
          `SELECT 1 FROM agent_states
           WHERE artifact_id = ? AND agent_id != ? AND state IN (?, ?)
           LIMIT 1`,
        )
        .get(artifactId, agentId, MESIState.MODIFIED, MESIState.EXCLUSIVE);
      if (otherHolder !== undefined) {
        this.db.exec("COMMIT");
        return { kind: "conflict", reason: "other_holder", currentVersion: current };
      }

      // ---- WIN: mutate atomically ----
      const nextVersion = current + 1;
      checkMonotonicVersion(current, nextVersion);
      this.db
        .prepare(
          `UPDATE artifacts
             SET version = ?, content_hash = ?, size_tokens = COALESCE(?, size_tokens),
                 last_writer_id = ?, updated_at = ?
           WHERE id = ?`,
        )
        .run(nextVersion, newContentHash, sizeTokens, agentId, Date.now() / 1000, artifactId);

      // Invalidate every non-INVALID peer (SHARED readers; M/E was excluded
      // above) + queue a preemption notice — same shape as commit().
      const stateMap = this.getStateMap(artifactId);
      const invalidatedPeers: string[] = [];
      for (const [peerId, peerState] of stateMap) {
        if (peerId === agentId) continue;
        if (peerState === MESIState.INVALID) continue;
        if (!isValidTransition(peerState, MESIState.INVALID)) {
          throw new Error(`commitCas: peer ${peerId} in ${peerState} cannot transition to INVALID`);
        }
        this.setAgentStateInternal(artifactId, peerId, peerState, MESIState.INVALID, nowTick, "commit_cas");
        this.upsertPendingNotice(peerId, artifactId, agentId, nowTick);
        invalidatedPeers.push(peerId);
      }

      // Committer ends SHARED (S no-op; I/absent → SHARED).
      const committerState = callerState ?? MESIState.INVALID;
      if (committerState !== MESIState.SHARED) {
        if (!isValidTransition(committerState, MESIState.SHARED)) {
          throw new Error(
            `commitCas: ${agentId} transition ${committerState}→SHARED not allowed`,
          );
        }
        this.setAgentStateInternal(artifactId, agentId, committerState, MESIState.SHARED, nowTick, "commit_cas");
      }

      const postMap = this.getStateMap(artifactId);
      checkSingleWriter(postMap);

      const updatedRow = this.db
        .prepare(
          `SELECT id, name, version, content_hash, size_tokens, last_writer_id, updated_at FROM artifacts WHERE id = ?`,
        )
        .get(artifactId) as Artifact;

      this.db.exec("COMMIT");
      return { kind: "win", artifact: updatedRow, invalidatedPeers };
    } catch (err) {
      try {
        this.db.exec("ROLLBACK");
      } catch {
        // Rollback failure non-recoverable; surface original error.
      }
      throw err;
    }
  }

  /**
   * Return the names of all registry-known artifacts whose name starts with
   * `prefix` (empty prefix = all). Used by /hooks/pre-grep to enumerate the
   * tracked artifacts under a search root. Mirrors Python
   * `sqlite_registry.artifact_names_under_prefix`.
   *
   * The LIKE pattern escapes `%`, `_`, and the escape char itself so a
   * literal prefix like `docs_v2/` cannot wildcard-match `docsXv2/`.
   */
  artifactNamesUnderPrefix(prefix: string): string[] {
    // Empty / "." / "./" ⇒ all artifacts (Grep over the workspace root).
    // Mirrors Python artifact_names_under_prefix. P1: the bare-LIKE version
    // both OVER-matched siblings ("docs/specs" catching "docs/specs-internal/")
    // and returned [] for a "." search_root — silently skipping the entire
    // pre-grep stale check for the very common workspace-root Grep.
    if (prefix === "" || prefix === "." || prefix === "./") {
      const all = this.db
        .prepare(`SELECT name FROM artifacts ORDER BY name`)
        .all() as { name: string }[];
      return all.map((r) => r.name);
    }
    // Strip trailing slash(es) then append exactly one, so the LIKE prefix
    // matches only true directory children — not sibling dirs sharing the
    // stem. UNION an exact-match so a search_root that IS a tracked file
    // still matches it.
    const stripped = prefix.replace(/\/+$/, "");
    const escaped = `${stripped}/`.replace(/([\\%_])/g, "\\$1");
    const rows = this.db
      .prepare(
        `SELECT name FROM artifacts WHERE name LIKE ? ESCAPE '\\'
         UNION SELECT name FROM artifacts WHERE name = ?
         ORDER BY name`,
      )
      .all(`${escaped}%`, stripped) as { name: string }[];
    return rows.map((r) => r.name);
  }

  /**
   * Transition an agent to SHARED on a tracked artifact. Used by pre-read
   * hooks (first-observation seeding + post-stale re-grant). Mirrors Python
   * `CoordinatorService` indirectly: Python flows through `set_agent_state`
   * with `MESIState.SHARED`; here we expose a thin wrapper for the hook
   * handler's clarity.
   *
   * Idempotent on already-SHARED state. Transitions from MODIFIED or
   * EXCLUSIVE to SHARED are valid per MESI semantics (writer downgrades
   * to reader). Throws on a non-valid transition.
   */
  grantShared(artifactId: string, agentId: string, nowTick: number, _trigger = "grant_shared"): void {
    if (!this.hasArtifact(artifactId)) {
      throw new Error(`grantShared: artifact ${artifactId} not registered`);
    }
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const priorState = this.getAgentState(artifactId, agentId) ?? MESIState.INVALID;
      if (priorState === MESIState.SHARED) {
        this.db.exec("COMMIT");
        return;
      }
      if (!isValidTransition(priorState, MESIState.SHARED)) {
        throw new Error(
          `grantShared: ${agentId} transition ${priorState}→SHARED not allowed`,
        );
      }
      this.setAgentStateInternal(artifactId, agentId, priorState, MESIState.SHARED, nowTick, _trigger);
      this.db.exec("COMMIT");
    } catch (err) {
      try {
        this.db.exec("ROLLBACK");
      } catch {
        // Rollback failure non-recoverable; surface original error.
      }
      throw err;
    }
  }

  /**
   * Return (agent_id, granted_at_tick) of the current exclusive holder for an
   * artifact, excluding `excludeAgentId`. Returns null if no M∪E holder. Used
   * by pre-edit collision detection.
   */
  exclusiveHolder(
    artifactId: string,
    excludeAgentId: string,
  ): { agentId: string; grantedAtTick: number | null } | null {
    const rows = this.db
      .prepare(
        `SELECT agent_id, granted_at_tick FROM agent_states
         WHERE artifact_id = ? AND state IN (?, ?) AND agent_id != ?`,
      )
      .all(artifactId, MESIState.MODIFIED, MESIState.EXCLUSIVE, excludeAgentId) as Array<{
      agent_id: string;
      granted_at_tick: number | null;
    }>;
    if (rows.length === 0) return null;
    // checkSingleWriter elsewhere keeps this to at most one row.
    const r = rows[0]!;
    return { agentId: r.agent_id, grantedAtTick: r.granted_at_tick };
  }

  /**
   * Release an agent's grant by transitioning to INVALID. Does NOT bump
   * artifact.version — this is for Stop-hook cleanup of uncommitted grants
   * per KTD-11. Mirrors Python `CoordinatorService.invalidate`.
   *
   * Safe to call on an agent that's already INVALID (no-op).
   */
  invalidate(artifactId: string, agentId: string, nowTick: number, trigger = "invalidate"): void {
    if (!this.hasArtifact(artifactId)) {
      return; // Delete-tombstone-style no-op for absent artifacts.
    }

    this.db.exec("BEGIN IMMEDIATE");
    try {
      const priorState = this.getAgentState(artifactId, agentId) ?? MESIState.INVALID;
      if (priorState === MESIState.INVALID) {
        this.db.exec("COMMIT");
        return;
      }
      if (!isValidTransition(priorState, MESIState.INVALID)) {
        throw new Error(
          `invalidate: ${agentId} transition ${priorState}→INVALID not allowed`,
        );
      }
      this.setAgentStateInternal(artifactId, agentId, priorState, MESIState.INVALID, nowTick, trigger);
      this.db.exec("COMMIT");
    } catch (err) {
      try {
        this.db.exec("ROLLBACK");
      } catch {
        // Rollback failure non-recoverable; surface original error.
      }
      throw err;
    }
  }

  // ------------------------------------------------------------------
  // Internal helpers (called within BEGIN IMMEDIATE from public methods)
  // ------------------------------------------------------------------

  /**
   * UPSERT agent_states with granted_at_tick + last_reclaim slot bookkeeping
   * mirroring Python `set_agent_state`. Caller MUST hold an open transaction.
   *
   * granted_at_tick semantics (per Python sqlite_registry.py:531-546):
   * - new ∈ M/E AND old ∉ M/E → stamp granted_at_tick = nowTick; clear last_reclaim slots
   * - new ∈ M/E AND old ∈ M/E → preserve granted_at_tick (continuous M∪E hold)
   * - old ∈ M/E AND new ∉ M/E → drop granted_at_tick (release)
   * - else → preserve
   */
  private setAgentStateInternal(
    artifactId: string,
    agentId: string,
    priorState: MESIState,
    newState: MESIState,
    nowTick: number,
    _trigger: string,
  ): void {
    const newInMe = isWriter(newState);
    const prevInMe = isWriter(priorState);

    // Look up prior granted_at_tick for the preserve case.
    const priorRow = this.db
      .prepare(`SELECT granted_at_tick FROM agent_states WHERE artifact_id = ? AND agent_id = ?`)
      .get(artifactId, agentId) as { granted_at_tick: number | null } | undefined;
    const priorGrantedAt = priorRow?.granted_at_tick ?? null;

    let grantedAtTick: number | null;
    let clearReclaim: boolean;
    if (newInMe && !prevInMe) {
      grantedAtTick = nowTick;
      clearReclaim = true;
    } else if (newInMe && prevInMe) {
      grantedAtTick = priorGrantedAt;
      clearReclaim = false;
    } else if (prevInMe) {
      grantedAtTick = null;
      clearReclaim = false;
    } else {
      grantedAtTick = priorGrantedAt;
      clearReclaim = false;
    }

    if (priorRow === undefined) {
      this.db
        .prepare(
          `INSERT INTO agent_states (artifact_id, agent_id, state, granted_at_tick,
                                     last_reclaim_trigger, last_reclaim_tick)
           VALUES (?, ?, ?, ?, NULL, NULL)`,
        )
        .run(artifactId, agentId, newState, grantedAtTick);
    } else if (clearReclaim) {
      this.db
        .prepare(
          `UPDATE agent_states
             SET state = ?, granted_at_tick = ?,
                 last_reclaim_trigger = NULL, last_reclaim_tick = NULL
           WHERE artifact_id = ? AND agent_id = ?`,
        )
        .run(newState, grantedAtTick, artifactId, agentId);
    } else {
      this.db
        .prepare(
          `UPDATE agent_states SET state = ?, granted_at_tick = ?
           WHERE artifact_id = ? AND agent_id = ?`,
        )
        .run(newState, grantedAtTick, artifactId, agentId);
    }
  }

  /**
   * UPSERT a preemption notice. PRIMARY KEY (agent_id, artifact_id) means a
   * second preemption on the same (victim, artifact) replaces the prior
   * notice — latest preempter wins (matches Python sqlite_registry.py:937
   * `INSERT … ON CONFLICT DO UPDATE WHERE excluded.preempted_at_unix_ts > …`).
   */
  private upsertPendingNotice(
    victimAgentId: string,
    artifactId: string,
    preempterAgentId: string,
    nowUnixTs: number,
  ): void {
    this.db
      .prepare(
        `INSERT INTO pending_notices (agent_id, artifact_id, preempter_agent_id, preempted_at_unix_ts)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(agent_id, artifact_id) DO UPDATE
           SET preempter_agent_id = excluded.preempter_agent_id,
               preempted_at_unix_ts = excluded.preempted_at_unix_ts
           WHERE excluded.preempted_at_unix_ts > pending_notices.preempted_at_unix_ts`,
      )
      .run(victimAgentId, artifactId, preempterAgentId, nowUnixTs);
  }

  /** Return + drain pending notices for one agent. Used by pre-read/pre-edit hooks. */
  popPendingNoticesForAgent(agentId: string): Array<{
    artifactId: string;
    preempterAgentId: string;
    preemptedAtUnixTs: number;
  }> {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const rows = this.db
        .prepare(
          `SELECT artifact_id, preempter_agent_id, preempted_at_unix_ts
             FROM pending_notices WHERE agent_id = ?`,
        )
        .all(agentId) as {
        artifact_id: string;
        preempter_agent_id: string;
        preempted_at_unix_ts: number;
      }[];
      if (rows.length === 0) {
        this.db.exec("COMMIT");
        return [];
      }
      this.db.prepare(`DELETE FROM pending_notices WHERE agent_id = ?`).run(agentId);
      this.db.exec("COMMIT");
      return rows.map((r) => ({
        artifactId: r.artifact_id,
        preempterAgentId: r.preempter_agent_id,
        preemptedAtUnixTs: r.preempted_at_unix_ts,
      }));
    } catch (err) {
      try {
        this.db.exec("ROLLBACK");
      } catch {
        // Rollback failure non-recoverable; surface original error.
      }
      throw err;
    }
  }

  /**
   * Return artifact_ids where the given agent currently holds one of the
   * listed MESI states. Used by /hooks/session-stop per KTD-11 to enumerate
   * uncommitted grants that need release. Mirrors Python
   * `sqlite_registry.artifacts_held_by_agent`.
   */
  artifactsHeldByAgent(agentId: string, states: ReadonlyArray<MESIState>): string[] {
    if (states.length === 0) return [];
    const placeholders = states.map(() => "?").join(",");
    const rows = this.db
      .prepare(
        `SELECT artifact_id FROM agent_states
         WHERE agent_id = ? AND state IN (${placeholders})`,
      )
      .all(agentId, ...states) as { artifact_id: string }[];
    return rows.map((r) => r.artifact_id);
  }

  /** Active sessions = agents with at least one non-INVALID grant. For /status default tier. */
  listActiveAgents(): string[] {
    const rows = this.db
      .prepare(
        `SELECT DISTINCT agent_id FROM agent_states WHERE state != ?`,
      )
      .all(MESIState.INVALID) as { agent_id: string }[];
    return rows.map((r) => r.agent_id);
  }

  isClosed(): boolean {
    return this.closed;
  }

  close(): void {
    if (this.closed) {
      return;
    }
    // Better-sqlite3 doesn't expose a checkpoint primitive directly; WAL
    // checkpoint happens automatically on close per the binding's docs.
    this.db.close();
    this.closed = true;
  }
}

export { SCHEMA_USER_VERSION };
