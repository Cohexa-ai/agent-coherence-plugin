/**
 * Migration v3: add `deadline_tick` column to `agent_states` per KTD-F.
 *
 * KTD-F (Watchdog A6 fix — deadline column with transactional abort): every
 * mutation transaction stamps an `issued_at_tick` deadline; subsequent
 * mutations on the same row check `now_tick <= issued_at_tick +
 * HANDLER_DEADLINE_SEC` inside the BEGIN IMMEDIATE block and abort the
 * transaction if violated. Eliminates the late-arriving-watchdog race
 * documented in plugin docs/known-issues/2026-05-17-watchdog-races.md.
 *
 * `deadline_tick` is nullable: existing rows from v2 databases have NULL
 * (matches "no active deadline"); new acquires set it. Unit 4 wires the
 * deadline-stamping logic onto the MESI write/commit path.
 *
 * ALTER TABLE ADD COLUMN is atomic in SQLite (single statement). The
 * BEGIN IMMEDIATE wrapper is for the PRAGMA bump pairing, not the ALTER.
 */
import type { Migration } from "../migrations.js";

export const V3_WATCHDOG_DEADLINE: Migration = {
  version: 3,
  description: "add agent_states.deadline_tick for KTD-F watchdog A6 fix",
  apply: (db) => {
    db.exec("BEGIN IMMEDIATE");
    try {
      db.exec(`ALTER TABLE agent_states ADD COLUMN deadline_tick INTEGER`);
      db.exec(`PRAGMA user_version = 3`);
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
