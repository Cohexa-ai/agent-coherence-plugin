/**
 * Migration v4: add `last_observed_version` column to `agent_states` per SB-10.
 *
 * SB-10 (compaction re-emission, R6/R7/R9): the durable per-(agent, artifact)
 * record of the artifact version whose BYTES that agent last observed. The
 * registry writes it atomically with every non-INVALID state upsert and
 * advances the committer's value on the commit paths; it is the comparand the
 * post-compaction stale flag is computed from. Mirrors the Python
 * coordinator's v5→v6 step (agent-coherence commit 8d5dcfe) for wire parity.
 *
 * `last_observed_version` is nullable ON PURPOSE: existing rows from v3
 * databases (and never-observed pairs) stay NULL — "never observed a version
 * under the new comparand" — and the accessor surfaces that as null, never a
 * 0-sentinel. Column-only and additive per KTD3: on `agent_states` (NOT a new
 * table), no index, and deliberately not joined to any GC/retention seam.
 *
 * Cross-runtime note (KTD9): Python v6 carries the SAME column name on
 * agent_states, so `last_observed_version` is NOT a lineage marker in either
 * direction. The disjoint fingerprints remain `deadline_tick` (Node-only) vs
 * the `artifact_versions` table / `artifacts.owner_generation` (Python-only);
 * `rejectForeignLedgerDb` needs no new probe for this column.
 *
 * ALTER TABLE ADD COLUMN is atomic in SQLite (single statement). The
 * BEGIN IMMEDIATE wrapper is for the PRAGMA bump pairing, not the ALTER.
 */
import type { Migration } from "../migrations.js";

export const V4_LAST_OBSERVED: Migration = {
  version: 4,
  description: "add agent_states.last_observed_version for SB-10 compaction re-emission",
  apply: (db) => {
    db.exec("BEGIN IMMEDIATE");
    try {
      db.exec(`ALTER TABLE agent_states ADD COLUMN last_observed_version INTEGER`);
      db.exec(`PRAGMA user_version = 4`);
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
