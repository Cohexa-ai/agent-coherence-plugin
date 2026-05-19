/**
 * Migration v1: initial schema.
 *
 * Mirrors the Python coordinator's `_apply_v1_schema`
 * (src/ccs/coordinator/sqlite_registry.py lines 197-300) byte-for-byte to
 * preserve the KTD-B parity contract: a state.db written by the Python
 * coordinator at user_version=1 MUST be opened by the Node coordinator
 * without re-running migration 1 (because PRAGMA user_version is already 1),
 * and vice versa.
 *
 * Atomicity contract per KTD-D + Python's _apply_v1_schema docstring:
 * all DDL + seed INSERT + PRAGMA user_version bump live inside ONE
 * BEGIN IMMEDIATE / COMMIT transaction. SIGKILL between BEGIN and COMMIT
 * rolls back the entire migration; SIGKILL after COMMIT leaves user_version
 * at 1 with all tables present (the success state). NEVER a partial state.
 *
 * Schema shape:
 * - `artifacts`: per-artifact metadata (id, name, version, content_hash,
 *   size_tokens, last_writer_id, updated_at) + UNIQUE(name) for lookup
 * - `agent_states`: per-(artifact, agent) MESI state + transient state +
 *   reclaim diagnostics, FK to artifacts(id) ON DELETE CASCADE
 * - `heartbeats`: per-agent liveness tick (KTD-2 crash-recovery surface)
 * - `registry_meta`: KV store, seeded with `instance_id` (UUID) and
 *   `sequence_number` (= "0")
 * - `pending_notices`: A1 preemption notices (KTD-D / Python line 274+)
 *   queued for the victim agent's next pre-read/pre-edit hook
 */
import type { Migration } from "../migrations.js";
import { randomUUID } from "node:crypto";

export const V1_INITIAL: Migration = {
  version: 1,
  description: "initial schema (artifacts, agent_states, heartbeats, registry_meta, pending_notices)",
  apply: (db) => {
    const instanceId = randomUUID();

    // One BEGIN IMMEDIATE wraps DDL + meta seed + PRAGMA user_version bump.
    // Per KTD-D + Python _apply_v1_schema: SIGKILL atomicity guarantee.
    db.exec("BEGIN IMMEDIATE");
    try {
      db.exec(`
        CREATE TABLE artifacts (
          id              TEXT PRIMARY KEY,
          name            TEXT NOT NULL UNIQUE,
          version         INTEGER NOT NULL,
          content_hash    TEXT NOT NULL,
          size_tokens     INTEGER,
          last_writer_id  TEXT,
          updated_at      REAL NOT NULL
        )
      `);

      db.exec(`CREATE INDEX idx_artifacts_name ON artifacts(name)`);

      db.exec(`
        CREATE TABLE agent_states (
          artifact_id          TEXT NOT NULL,
          agent_id             TEXT NOT NULL,
          state                TEXT NOT NULL,
          transient_state      TEXT,
          transient_tick       INTEGER,
          granted_at_tick      INTEGER,
          last_reclaim_trigger TEXT,
          last_reclaim_tick    INTEGER,
          PRIMARY KEY (artifact_id, agent_id),
          FOREIGN KEY (artifact_id) REFERENCES artifacts(id) ON DELETE CASCADE
        )
      `);

      db.exec(`
        CREATE TABLE heartbeats (
          agent_id   TEXT PRIMARY KEY,
          last_tick  INTEGER NOT NULL
        )
      `);

      db.exec(`
        CREATE TABLE registry_meta (
          key   TEXT PRIMARY KEY,
          value TEXT
        )
      `);

      // A1: preemption notices. Mirrors Python `_apply_v1_schema` line 274+.
      // PRIMARY KEY (agent_id, artifact_id) means a second preemption on the
      // same (victim, artifact) UPSERTs — latest preempter wins.
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

      db.prepare(
        `INSERT INTO registry_meta (key, value) VALUES (?, ?), (?, ?)`,
      ).run("instance_id", instanceId, "sequence_number", "0");

      // PRAGMA inside BEGIN IMMEDIATE is transactional per SQLite docs.
      // Cannot use parameter bindings; integer literal interpolation is safe.
      db.exec(`PRAGMA user_version = 1`);

      db.exec("COMMIT");
    } catch (err) {
      try {
        db.exec("ROLLBACK");
      } catch {
        // Rollback failure is non-recoverable; surface the original error.
      }
      throw err;
    }
  },
};
