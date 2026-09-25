/**
 * Caller principal — the Node hook client's stored mint nonce (library
 * caller-principal plan, U5 / KTD11). The nonce is persisted BEFORE a claim is
 * sent, so a retry after a lost response presents the same nonce; hook
 * processes racing on a new session must all end up presenting ONE nonce.
 *
 * What the principal buys on the hook surface is convention-enforcement and a
 * detectable unbound caller: these values live under `.coherence/`, readable
 * by any process that can read that directory. Nothing here claims caller
 * separation between processes of one OS user.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { sessionToAgentId } from '../agent_id.js';
import { callerPrincipalKey, ensureMintNonce } from '../caller_principal.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const CALLER_PRINCIPAL_JS = join(HERE, '..', 'caller_principal.js');
const SID = '66666666-6666-4666-8666-666666666666';
const SECRET = 's'.repeat(32);

function makeWorkspace(): string {
  const root = mkdtempSync(join(tmpdir(), 'principal-test-'));
  mkdirSync(join(root, '.coherence'), { recursive: true, mode: 0o700 });
  writeFileSync(join(root, '.coherence', 'hook.secret'), `${SECRET}\n`);
  return root;
}

function filesFor(root: string, sessionId: string): { nonce: string; principal: string } {
  const key = sessionToAgentId(sessionId);
  return {
    nonce: join(root, '.coherence', `caller-principal-${key}.nonce`),
    principal: join(root, '.coherence', `caller-principal-${key}.principal`),
  };
}

// ---------------------------------------------------------------- the nonce

test('mint nonce: created exclusively at 0600 before any claim; a second caller adopts it; never overwritten', () => {
  const root = makeWorkspace();
  try {
    const key = callerPrincipalKey(SID);
    const first = ensureMintNonce(root, key);
    const { nonce } = filesFor(root, SID);
    assert.match(first, /^[A-Za-z0-9_-]{43}$/);
    assert.equal(statSync(nonce).mode & 0o777, 0o600);
    assert.equal(ensureMintNonce(root, key), first, 'a second caller adopts the stored nonce');
    assert.equal(readFileSync(nonce, 'utf8').trim(), first);
    // Keyed by the PARENT session's derived id, not the raw session id.
    assert.equal(key, sessionToAgentId(SID));
    assert.ok(!existsSync(join(root, '.coherence', `caller-principal-${SID}.nonce`)));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('mint nonce: hook processes racing on a new session all adopt ONE nonce', async () => {
  const root = makeWorkspace();
  try {
    const key = callerPrincipalKey(SID);
    const startAt = Date.now() + 400; // every child spins to the same instant, then races
    const script =
      `import { ensureMintNonce } from ${JSON.stringify(pathToFileURL(CALLER_PRINCIPAL_JS).href)};` +
      `while (Date.now() < ${startAt}) {}` +
      `process.stdout.write(ensureMintNonce(${JSON.stringify(root)}, ${JSON.stringify(key)}));`;
    const racers = await Promise.all(
      Array.from(
        { length: 6 },
        () =>
          new Promise<string>((resolveRun) => {
            const child = spawn(process.execPath, ['--input-type=module', '-e', script], {
              stdio: ['ignore', 'pipe', 'pipe'],
            });
            let out = '';
            child.stdout.on('data', (c: Buffer) => (out += c.toString('utf8')));
            child.on('close', () => resolveRun(out));
          })
      )
    );
    assert.equal(new Set(racers).size, 1, `racers disagreed: ${JSON.stringify(racers)}`);
    assert.match(racers[0]!, /^[A-Za-z0-9_-]{43}$/);
    assert.equal(readFileSync(filesFor(root, SID).nonce, 'utf8').trim(), racers[0]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
