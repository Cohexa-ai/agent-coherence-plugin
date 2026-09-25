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
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { sessionToAgentId } from '../agent_id.js';
import {
  callerPrincipalKey,
  ensureMintNonce,
  loadCallerPrincipal,
  storeCallerPrincipal,
} from '../caller_principal.js';

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

// ------------------------------------------ a file a crashed writer left torn

const VALUE_SHAPE = /^[A-Za-z0-9_-]{43}$/;
/** FROZEN duplicate of the bounded wait: 5 attempts, so 4 waits — never imported from the code under test. */
const BOUNDED_WAITS = 4;

function ageBy(path: string, seconds: number): void {
  const then = Date.now() / 1000 - seconds;
  utimesSync(path, then, then);
}

function listCoherence(root: string): string[] {
  return readdirSync(join(root, '.coherence')).sort();
}

/**
 * Run `body`, counting every bounded wait it makes instead of sleeping (the
 * Python test counts `time.sleep` the same way). `onWait` runs at each wait —
 * the moment a racer's write could land.
 */
function countingWaits(
  body: () => string,
  onWait?: (n: number) => void
): { value?: string; error?: Error; waits: number } {
  const original = Atomics.wait;
  let waits = 0;
  Atomics.wait = (() => {
    waits += 1;
    onWait?.(waits);
    return 'timed-out';
  }) as typeof Atomics.wait;
  try {
    const value = body();
    return { value, waits };
  } catch (error) {
    return { error: error as Error, waits };
  } finally {
    Atomics.wait = original;
  }
}

// The grace is 2 s (twin of Python auth.TORN_FILE_GRACE_SEC); an age on each
// side of it pins that the age is USED, not only read.
for (const [label, content] of [
  ['empty', ''],
  ['malformed', 'not-a-nonce\n'],
] as const) {
  for (const ageSeconds of [3, 3600]) {
    test(`mint nonce: an OLD (${ageSeconds} s) ${label} file is reported at once, without the bounded wait, and never overwritten; the error names the file and the step`, () => {
      const root = makeWorkspace();
      try {
        const { nonce } = filesFor(root, SID);
        writeFileSync(nonce, content, { mode: 0o600 });
        ageBy(nonce, ageSeconds);
        const before = listCoherence(root);
        const run = countingWaits(() => ensureMintNonce(root, callerPrincipalKey(SID)));
        assert.equal(run.value, undefined, 'no nonce is invented over an existing file');
        assert.equal(run.waits, 0, 'an abandoned write is not waited on');
        assert.ok(run.error?.message.includes(nonce), 'the error names the file in full');
        assert.match(run.error!.message, /not overwriting it/);
        assert.match(run.error!.message, /remove .* by hand/);
        assert.equal(readFileSync(nonce, 'utf8'), content, 'left exactly as it was');
        assert.deepEqual(listCoherence(root), before, 'nothing created beside it');
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });
  }
}

for (const ageSeconds of [0, 1]) {
  test(`mint nonce: a YOUNG (${ageSeconds} s) empty file (a writer still between create and write) is waited on — the whole bounded wait — and never overwritten`, () => {
    const root = makeWorkspace();
    try {
      const { nonce } = filesFor(root, SID);
      writeFileSync(nonce, '', { mode: 0o600 });
      ageBy(nonce, ageSeconds);
      const run = countingWaits(() => ensureMintNonce(root, callerPrincipalKey(SID)));
      assert.equal(run.waits, BOUNDED_WAITS, 'a write in progress is waited on');
      assert.ok(run.error?.message.includes(nonce), 'the error names the file in full');
      assert.match(run.error!.message, /not overwriting it/);
      assert.equal(statSync(nonce).size, 0, 'left exactly as it was');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
}

test("mint nonce: a YOUNG empty file whose writer lands during the wait is adopted — the loser presents the winner's nonce", () => {
  const root = makeWorkspace();
  try {
    const { nonce } = filesFor(root, SID);
    writeFileSync(nonce, '', { mode: 0o600 });
    const winner = 'W'.repeat(43);
    const run = countingWaits(
      () => ensureMintNonce(root, callerPrincipalKey(SID)),
      (n) => {
        if (n === 2) writeFileSync(nonce, `${winner}\n`);
      }
    );
    assert.equal(run.error, undefined);
    assert.equal(run.value, winner);
    assert.equal(run.waits, 2);
    assert.match(run.value!, VALUE_SHAPE);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// -------------------------------------------------------- the stored principal

test('stored principal: written whole by write-then-rename at 0600 in .coherence/, replacing a torn file or a value the coordinator no longer binds', () => {
  const root = makeWorkspace();
  try {
    const key = callerPrincipalKey(SID);
    const { principal } = filesFor(root, SID);
    writeFileSync(principal, '', { mode: 0o644 });
    storeCallerPrincipal(root, key, 'A'.repeat(43));
    assert.equal(loadCallerPrincipal(root, key), 'A'.repeat(43));
    assert.equal(statSync(principal).mode & 0o777, 0o600);
    storeCallerPrincipal(root, key, 'B'.repeat(43));
    assert.equal(readFileSync(principal, 'utf8'), `${'B'.repeat(43)}\n`);
    assert.equal(statSync(principal).mode & 0o777, 0o600);
    assert.deepEqual(listCoherence(root), [`caller-principal-${key}.principal`, 'hook.secret']);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
