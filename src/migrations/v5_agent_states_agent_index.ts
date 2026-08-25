/**
 * Migration v5: index `agent_states(agent_id)` — SB-10 perf follow-up.
 *
 * The post-compaction session-start builder reads agent_states scoped by
 * `WHERE agent_id IN (...)` (allStateMaps), but the table is keyed
 * `(artifact_id, agent_id)` and nothing indexed `agent_id` alone, so that
 * predicate still walked every page of a table nothing garbage-collects —
 * on a hook path, twice per compaction, synchronously. Measured on a
 * 500k-row ledger (200 artifacts x 2500 agents, four-agent session): the
 * scoped read drops 61ms -> 1.5ms with the index (SCAN -> SEARCH); the gain
 * grows with accumulated agents, which is the dimension that grows forever.
 * Cost side, same table: single-row grant upsert p50 24us -> 40us and ~26%
 * more disk — microseconds spread across writes with milliseconds of
 * headroom, against a 60ms synchronous stall on a watchdog-guarded path.
 *
 * Mirrors the Python coordinator's v6->v7 step: BOTH ledgers gain the SAME
 * index name in the SAME change, because the cross-runtime schema guard
 * treats a one-sided user_version bump as a foreign ledger. An index is
 * structural but carries no lineage signal — `rejectForeignLedgerDb` probes
 * columns, tables, and the schema_runtime stamp, never index names — so no
 * new probe is needed in either direction (same KTD9 reasoning as v4).
 *
 * CREATE INDEX IF NOT EXISTS is itself the half-migrated-db guard: a crash
 * after the CREATE but before the PRAGMA stamp leaves a v4-stamped db whose
 * re-migrate re-runs this step and no-ops the CREATE.
 */
import type { Migration } from "../migrations.js";

export const V5_AGENT_STATES_AGENT_INDEX: Migration = {
  version: 5,
  description: "index agent_states(agent_id) for the scoped session-start read (SB-10 perf)",
  apply: (db) => {
    db.exec("BEGIN IMMEDIATE");
    try {
      db.exec(`CREATE INDEX IF NOT EXISTS idx_agent_states_agent ON agent_states(agent_id)`);
      db.exec(`PRAGMA user_version = 5`);
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
