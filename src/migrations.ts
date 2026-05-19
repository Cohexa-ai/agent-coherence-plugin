/**
 * Schema migration ledger for the Node coordinator.
 *
 * Mirror of the Python coordinator's KTD-D revised pattern: schema lives as a
 * module-level array of {version, description, apply} tuples, each wrapped in
 * one atomic `BEGIN IMMEDIATE; …; PRAGMA user_version = N; COMMIT;`
 * transaction so partial-power-loss leaves the database at either the prior
 * version or the target — never mid-state.
 *
 * SCHEMA_USER_VERSION is derived from the list, NOT a hand-maintained constant.
 *
 * v0.1.1 Unit 1 (this commit) lands only the runner + empty array. Unit 2
 * appends migration 1 (initial schema mirroring _apply_v1_schema), migration 2
 * (formalize pending_notices), migration 3 (KTD-F watchdog deadline column).
 *
 * Per KTD-D revised: NEVER use multi-statement-without-batch-transaction.
 * Each apply() function MUST issue exactly one BEGIN IMMEDIATE that wraps all
 * DDL + PRAGMA user_version bump + COMMIT. This preserves the v0.1 SIGKILL
 * atomicity guarantee documented in Python's _apply_v1_schema docstring.
 */
import type { Database } from "better-sqlite3";
import { V1_INITIAL } from "./migrations/v1_initial.js";
import { V2_VALIDATE_PENDING_NOTICES } from "./migrations/v2_validate_pending_notices.js";
import { V3_WATCHDOG_DEADLINE } from "./migrations/v3_watchdog_deadline.js";

export interface Migration {
  /** Monotonically increasing positive integer. */
  version: number;
  /** Short human-readable label; surfaces in error messages on migration failure. */
  description: string;
  /**
   * Apply the migration. MUST wrap all DDL + `PRAGMA user_version = <version>`
   * in a single `BEGIN IMMEDIATE; … COMMIT;` transaction. The runner does NOT
   * wrap the call — it's the apply function's responsibility per the v0.1
   * pattern.
   */
  apply: (db: Database) => void;
}

/**
 * Ordered migration list. Each entry appends; never reorder, never delete.
 *
 * v0.1.1 Unit 2 (this commit):
 *  - v1: initial schema (artifacts, agent_states, heartbeats, registry_meta,
 *    pending_notices); mirrors Python `_apply_v1_schema` byte-for-byte for
 *    KTD-B parity
 *  - v2: validate pending_notices shape; formalize v1→v2 boundary per KTD-D
 *  - v3: add agent_states.deadline_tick column per KTD-F watchdog A6 fix
 *
 * Future migrations (v4+) append here; the version-derived SCHEMA_USER_VERSION
 * constant updates automatically.
 */
export const MIGRATIONS: ReadonlyArray<Migration> = [
  V1_INITIAL,
  V2_VALIDATE_PENDING_NOTICES,
  V3_WATCHDOG_DEADLINE,
];

/**
 * Target schema version = max version in the list, or 0 if list is empty.
 * Derived; do NOT hand-maintain a separate constant.
 */
export const SCHEMA_USER_VERSION: number =
  MIGRATIONS.length === 0 ? 0 : Math.max(...MIGRATIONS.map((m) => m.version));

/**
 * Apply all pending migrations from current `PRAGMA user_version` to
 * `SCHEMA_USER_VERSION`. Idempotent: re-running against an already-current
 * database is a no-op (no migrations to apply).
 *
 * Throws if a migration's apply() raises, OR if `PRAGMA user_version` after
 * apply does NOT match the migration's version (catches the foot-gun of an
 * apply() that forgets to bump PRAGMA user_version).
 */
export function runPendingMigrations(db: Database): { applied: ReadonlyArray<Migration>; current: number } {
  const currentRow = db.prepare("PRAGMA user_version").get() as { user_version: number } | undefined;
  const startVersion = currentRow?.user_version ?? 0;

  if (startVersion > SCHEMA_USER_VERSION) {
    throw new Error(
      `Schema mismatch: database is at user_version=${startVersion} but binary targets ${SCHEMA_USER_VERSION}. ` +
        `Either upgrade the binary or follow the downgrade escape hatch (KTD-D: rm <workspace>/.coherence/state.db).`,
    );
  }

  const pending = MIGRATIONS.filter((m) => m.version > startVersion);
  pending.sort((a, b) => a.version - b.version);

  for (const m of pending) {
    m.apply(db);
    const after = db.prepare("PRAGMA user_version").get() as { user_version: number };
    if (after.user_version !== m.version) {
      throw new Error(
        `Migration ${m.version} (${m.description}) ran but PRAGMA user_version is ${after.user_version}, ` +
          `not ${m.version}. The apply() function MUST set PRAGMA user_version inside its BEGIN IMMEDIATE block.`,
      );
    }
  }

  return { applied: pending, current: SCHEMA_USER_VERSION };
}
