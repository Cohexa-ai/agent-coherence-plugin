/**
 * MESI stable-state enum and transition validation.
 *
 * Mirrors Python `src/ccs/core/states.py` MESIState. v0.1.1 implements the
 * MESI SUBSET per KTD-10: stable states only (M / E / S / I). The transient
 * states Python uses to model in-flight grants (ISG / IED / EIA / SIA / MWB
 * / MSA) are NOT modeled in the Node coordinator — all state transitions
 * happen atomically inside BEGIN IMMEDIATE transactions, so the in-flight
 * window is collapsed to zero from the protocol's perspective.
 *
 * This is the "MESI subset the plugin actually touches" the plan KTD-10
 * locked. Drift from Python on the transient-state surface is acceptable
 * and expected; KTD-B parity contract enforces wire-equality on stable
 * states only (M/E/S/I string values).
 */

export const MESIState = {
  MODIFIED: "MODIFIED",
  EXCLUSIVE: "EXCLUSIVE",
  SHARED: "SHARED",
  INVALID: "INVALID",
} as const;

export type MESIState = (typeof MESIState)[keyof typeof MESIState];

/** Stable-state transitions allowed by the MESI subset. Mirrors Python VALID_TRANSITIONS. */
const VALID_TRANSITIONS: ReadonlySet<string> = new Set([
  `${MESIState.INVALID}→${MESIState.SHARED}`,
  `${MESIState.INVALID}→${MESIState.EXCLUSIVE}`,
  `${MESIState.SHARED}→${MESIState.INVALID}`,
  `${MESIState.SHARED}→${MESIState.EXCLUSIVE}`,
  `${MESIState.EXCLUSIVE}→${MESIState.SHARED}`,
  `${MESIState.EXCLUSIVE}→${MESIState.MODIFIED}`,
  `${MESIState.EXCLUSIVE}→${MESIState.INVALID}`,
  `${MESIState.MODIFIED}→${MESIState.INVALID}`,
  `${MESIState.MODIFIED}→${MESIState.SHARED}`,
]);

export function isValidTransition(current: MESIState, next: MESIState): boolean {
  return VALID_TRANSITIONS.has(`${current}→${next}`);
}

/** States that count as "writer" for single-writer invariant. */
export const M_OR_E_STATES: ReadonlySet<MESIState> = new Set([
  MESIState.MODIFIED,
  MESIState.EXCLUSIVE,
]);

export function isWriter(state: MESIState): boolean {
  return M_OR_E_STATES.has(state);
}
