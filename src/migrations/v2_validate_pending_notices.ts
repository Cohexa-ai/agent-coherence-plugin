/**
 * Migration v2: validate `pending_notices` shape and formalize the version
 * boundary per KTD-D.
 *
 * Background (per KTD-D + Python sqlite_registry.py lines 319-333): the v0.1
 * Python coordinator's `pending_notices` table was added as a forward-compat
 * `CREATE TABLE IF NOT EXISTS` shim that did NOT bump PRAGMA user_version
 * ("additive change that doesn't warrant a migration"). KTD-D's argument was
 * that pattern hides future column-adds — they silently won't apply on
 * existing databases because PRAGMA user_version is 1 in both cases.
 *
 * Migration v2's purpose: validate that `pending_notices` exists with the
 * canonical shape, then bump user_version to 2. This formalizes the version
 * boundary that "pending_notices is required" rather than "implicitly
 * forward-compat."
 *
 * Behavior per KTD-D conditional logic:
 * - Table exists with right shape (canonical Node/Python install path):
 *   no-op + bump user_version
 * - Table exists with wrong shape: hard-fail with actionable error pointing
 *   to the bug
 * - Table missing: should not happen if migration v1 ran (v1 creates the
 *   table). Defensive CREATE TABLE in this case + bump, with a warning.
 */
import type { Database } from "better-sqlite3";
import type { Migration } from "../migrations.js";

interface ColumnInfo {
  cid: number;
  name: string;
  type: string;
  notnull: number;
  dflt_value: unknown;
  pk: number;
}

/** Canonical shape v1 created. Validated by migration v2; never changed thereafter. */
const EXPECTED_COLUMNS: ReadonlyArray<{
  name: string;
  type: string;
  notnull: 0 | 1;
  pk: 0 | 1 | 2;
}> = [
  { name: "agent_id", type: "TEXT", notnull: 1, pk: 1 },
  { name: "artifact_id", type: "TEXT", notnull: 1, pk: 2 },
  { name: "preempter_agent_id", type: "TEXT", notnull: 1, pk: 0 },
  { name: "preempted_at_unix_ts", type: "REAL", notnull: 1, pk: 0 },
];

function shapeMismatchError(reason: string): Error {
  return new Error(
    `Migration v2 (validate pending_notices): SHAPE MISMATCH — ${reason}. ` +
      `This is a bug; the canonical shape is documented in migration v1 and Python's ` +
      `sqlite_registry.py _apply_v1_schema. Do NOT 'fix' state.db by hand. Recovery: ` +
      `stop all coordinator processes, back up state.db, remove it, restart (loses ` +
      `cache; no source-of-record data lost per v0.1 plan KTD-13).`,
  );
}

function validatePendingNoticesShape(db: Database): void {
  const cols = db.prepare(`PRAGMA table_info(pending_notices)`).all() as ColumnInfo[];

  if (cols.length !== EXPECTED_COLUMNS.length) {
    throw shapeMismatchError(
      `column count ${cols.length} != expected ${EXPECTED_COLUMNS.length}`,
    );
  }

  for (const expected of EXPECTED_COLUMNS) {
    const actual = cols.find((c) => c.name === expected.name);
    if (actual === undefined) {
      throw shapeMismatchError(`missing column '${expected.name}'`);
    }
    // Normalize types (SQLite accepts loose type names; canonical form is
    // uppercase per CREATE TABLE in v1).
    if (actual.type.toUpperCase() !== expected.type) {
      throw shapeMismatchError(
        `column '${expected.name}' type='${actual.type}' != expected '${expected.type}'`,
      );
    }
    if (actual.notnull !== expected.notnull) {
      throw shapeMismatchError(
        `column '${expected.name}' notnull=${actual.notnull} != expected ${expected.notnull}`,
      );
    }
    if (actual.pk !== expected.pk) {
      throw shapeMismatchError(
        `column '${expected.name}' pk=${actual.pk} != expected ${expected.pk}`,
      );
    }
  }
}

function tableExists(db: Database, name: string): boolean {
  const row = db
    .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name = ?`)
    .get(name);
  return row !== undefined;
}

export const V2_VALIDATE_PENDING_NOTICES: Migration = {
  version: 2,
  description: "validate pending_notices shape; formalize v1→v2 version boundary",
  apply: (db) => {
    db.exec("BEGIN IMMEDIATE");
    try {
      if (!tableExists(db, "pending_notices")) {
        // Should not happen — migration v1 always creates pending_notices.
        // Defensive recovery: CREATE the canonical shape so the downstream
        // shape validation passes. This preserves the parity-with-Python
        // contract even for state.db files in an unexpected state.
        db.exec(`
          CREATE TABLE pending_notices (
            agent_id              TEXT NOT NULL,
            artifact_id           TEXT NOT NULL,
            preempter_agent_id    TEXT NOT NULL,
            preempted_at_unix_ts  REAL NOT NULL,
            PRIMARY KEY (agent_id, artifact_id),
            FOREIGN KEY (artifact_id) REFERENCES artifacts(id) ON DELETE CASCADE
          )
        `);
      }

      validatePendingNoticesShape(db);

      db.exec(`PRAGMA user_version = 2`);
      db.exec("COMMIT");
    } catch (err) {
      try {
        db.exec("ROLLBACK");
      } catch {
        // Rollback failure is non-recoverable; surface original error.
      }
      throw err;
    }
  },
};
