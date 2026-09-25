/**
 * Caller principal — the hook client's half (library caller-principal plan, U5).
 *
 * The bearer in `.coherence/hook.secret` authenticates the WORKSPACE. A caller
 * principal is a value a coordinator mints and binds to ONE acting identity on
 * that identity's first claim (`POST /principal/claim`, Python coordinator
 * only); a request naming the identity presents it in the
 * `Coherence-Caller-Principal` header. The Python coordinator refuses a
 * request without it on the routes where an absent principal admits harm
 * (session-stop, post-edit, post-edit-cas, ...). This Node coordinator issues
 * none: it answers 404 on the claim and ignores the header. Its pid file says
 * `backend=node`, so against it the client does not claim at all — one request
 * per hook, exactly as before, instead of a 404 round trip on every event. A
 * pid file without that line (the Python coordinator's format) is claimed
 * against, and a 404 there (an older Python coordinator) still means "send no
 * header".
 *
 * Parity with the Python client (`ccs/cli/_coherence_client.py`
 * `obtain_stored_principal` + `ccs/adapters/claude_code/auth.py`):
 * - One process per hook event, so the values live on disk in the existing
 *   0700 `.coherence/`, created with O_CREAT|O_EXCL at 0600 — the hook.secret
 *   discipline — and NEVER overwritten.
 * - Keyed by the PARENT session's derived agent id (32 hex), never the raw
 *   session id: `caller-principal-<key>.nonce` / `.principal`. The file names
 *   and formats are identical across the two clients, so they share one
 *   binding per session.
 * - The mint nonce is persisted BEFORE the claim is sent (so a retry after a
 *   lost response presents the same nonce and receives the same principal); a
 *   concurrent loser of the exclusive create adopts the winner's nonce.
 * - A refused claim (`caller_principal_claimed`) is reported and the client
 *   proceeds without a principal. It never deletes a stored value and claims
 *   again: that would reopen the gate first-claim-wins closes.
 *
 * What this buys on the hook surface is convention-enforcement and a
 * detectable unbound caller: any process that can read `.coherence/` can read
 * these files for any session, so it is not separation between callers of the
 * same OS user.
 */
import { closeSync, constants as fsConstants, openSync, readFileSync, writeSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { sessionToAgentId } from './agent_id.js';
import {
  type CoordinatorEndpoint,
  readBackendFromPidFile,
  requestJsonStatus,
} from './hook_client_transport.js';

export const CALLER_PRINCIPAL_HEADER = 'Coherence-Caller-Principal';
export const PRINCIPAL_CLAIM_ROUTE = '/principal/claim';
export const CALLER_PRINCIPAL_FILE_PREFIX = 'caller-principal-';
/** The Python coordinator's typed refusal for a second claimant. */
export const CALLER_PRINCIPAL_CLAIMED_REASON = 'caller_principal_claimed';
/** The pid-file backend that issues no principals (this package's own coordinator). */
export const NODE_BACKEND = 'node';

/** base64url of 32 random bytes — the shape of a nonce this client makes and a principal the coordinator mints. */
const VALUE_RE = /^[A-Za-z0-9_-]{43}$/;
const KEY_RE = /^[0-9a-f]{32}$/;
/** Mirrors the coordinators' session_id shape check (a claim for anything else answers 400). */
const SESSION_ID_RE =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
/** Twin of auth.ts RECOVERY_MAX_ATTEMPTS / Python ENSURE_SECRET_MAX_RETRIES. */
const NONCE_MAX_ATTEMPTS = 5;

export type PrincipalClaimOutcome = 'bound' | 'unsupported' | 'refused' | 'unconfirmed';

export interface PrincipalClaim {
  outcome: PrincipalClaimOutcome;
  principal: string | null;
  /** Diagnostic prose; never carries the principal or the nonce. */
  detail: string;
}

function principalFile(root: string, key: string, suffix: '.nonce' | '.principal'): string {
  if (!KEY_RE.test(key))
    throw new Error('caller principal key must be 32 lowercase hex characters');
  return join(root, '.coherence', `${CALLER_PRINCIPAL_FILE_PREFIX}${key}${suffix}`);
}

/** The stored value, or null when absent or not (yet) well-formed — a file a racer created but has not finished writing. */
function readValue(path: string): string | null {
  let text: string;
  try {
    text = readFileSync(path, 'utf8').trim();
  } catch {
    return null;
  }
  return VALUE_RE.test(text) ? text : null;
}

/** O_CREAT|O_EXCL at 0600; false when the file already existed (never truncated or rewritten). */
function createExclusive(path: string, value: string): boolean {
  let fd: number;
  try {
    fd = openSync(path, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL, 0o600);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') return false;
    throw err;
  }
  try {
    writeSync(fd, `${value}\n`);
  } finally {
    closeSync(fd);
  }
  return true;
}

/** The file key for a session: its PARENT session's derived agent id (a subagent shares it). */
export function callerPrincipalKey(sessionId: string): string {
  return sessionToAgentId(sessionId);
}

/**
 * The mint nonce for `key`, generating and persisting it first if no process
 * has. Throws if `.coherence/` is missing (a hook client never creates it) or
 * if an existing file stays unreadable across the bounded wait.
 */
export function ensureMintNonce(root: string, key: string): string {
  const path = principalFile(root, key, '.nonce');
  for (let attempt = 1; attempt <= NONCE_MAX_ATTEMPTS; attempt++) {
    const existing = readValue(path);
    if (existing !== null) return existing;
    const candidate = randomBytes(32).toString('base64url');
    if (createExclusive(path, candidate)) return candidate;
    if (attempt < NONCE_MAX_ATTEMPTS)
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
  }
  throw new Error(`${path} exists but stayed unreadable; not overwriting it`);
}

export function loadCallerPrincipal(root: string, key: string): string | null {
  return readValue(principalFile(root, key, '.principal'));
}

/** Persist exclusively; an existing stored principal is never replaced. */
export function storeCallerPrincipal(root: string, key: string, principal: string): void {
  createExclusive(principalFile(root, key, '.principal'), principal);
}

/** One `POST /principal/claim`. Transport failures come back as `unconfirmed`. */
export async function claimCallerPrincipal(
  endpoint: CoordinatorEndpoint,
  sessionId: string,
  mintNonce: string
): Promise<PrincipalClaim> {
  let answer: { status: number; body: Record<string, unknown> | null };
  try {
    answer = await requestJsonStatus(endpoint, 'POST', PRINCIPAL_CLAIM_ROUTE, {
      session_id: sessionId,
      mint_nonce: mintNonce,
    });
  } catch (err) {
    return {
      outcome: 'unconfirmed',
      principal: null,
      detail: `claim failed: ${(err as Error).message}`,
    };
  }
  if (answer.status === 404) {
    return {
      outcome: 'unsupported',
      principal: null,
      detail: 'the coordinator issues no caller principals',
    };
  }
  const body = answer.body;
  const principal = body?.principal;
  if (
    answer.status === 200 &&
    body?.ok === true &&
    typeof principal === 'string' &&
    principal !== ''
  ) {
    return { outcome: 'bound', principal, detail: '' };
  }
  if (body?.reason === CALLER_PRINCIPAL_CLAIMED_REASON) {
    return { outcome: 'refused', principal: null, detail: CALLER_PRINCIPAL_CLAIMED_REASON };
  }
  return {
    outcome: 'unconfirmed',
    principal: null,
    detail: `claim not confirmed (HTTP ${answer.status}, reason=${JSON.stringify(body?.reason ?? null)})`,
  };
}

/**
 * The principal to present for `sessionId`: stored → else nonce, claim, store.
 * `null` means send no header: the coordinator issues none (404), the claim is
 * unconfirmed (a later invocation retries with the same nonce), or it was
 * refused (reported; nothing deleted, nothing re-minted). Against a
 * `backend=node` pid file nothing is claimed, read or created.
 */
export async function obtainStoredPrincipal(
  endpoint: CoordinatorEndpoint,
  root: string,
  sessionId: string,
  report: (message: string) => void
): Promise<string | null> {
  if (!SESSION_ID_RE.test(sessionId)) return null;
  if (readBackendFromPidFile(join(root, '.coherence', 'server.pid')) === NODE_BACKEND) return null;
  const key = callerPrincipalKey(sessionId);
  const stored = loadCallerPrincipal(root, key);
  if (stored !== null) return stored;
  let nonce: string;
  try {
    nonce = ensureMintNonce(root, key);
  } catch (err) {
    report(
      `caller principal unavailable: could not persist a mint nonce (${(err as Error).message})`
    );
    return null;
  }
  const claim = await claimCallerPrincipal(endpoint, sessionId, nonce);
  if (claim.outcome === 'bound' && claim.principal !== null) {
    try {
      storeCallerPrincipal(root, key, claim.principal);
    } catch (err) {
      report(`caller principal not stored (${(err as Error).message}); it will be re-obtained`);
    }
    return claim.principal;
  }
  if (claim.outcome === 'refused') {
    report(
      'caller principal refused: this session is already bound under a different mint nonce; ' +
        'proceeding without a principal and NOT re-minting (routes that require one will refuse this session)'
    );
  }
  return null;
}

/** The extra header presenting `principal`, or undefined for none. */
export function principalHeaders(principal: string | null): Record<string, string> | undefined {
  return principal === null ? undefined : { [CALLER_PRINCIPAL_HEADER]: principal };
}
