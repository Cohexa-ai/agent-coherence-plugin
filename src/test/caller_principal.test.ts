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
      assert.doesNotMatch(
        run.error!.message,
        /remove .* by hand/,
        'a write that may still be in progress is never named for removal'
      );
      assert.equal(statSync(nonce).size, 0, 'left exactly as it was');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
}

// ------------------------- the grace window, pinned on both sides of its edge

/**
 * FROZEN duplicates of the Python rule (auth.TORN_FILE_GRACE_SEC = 2.0 and
 * `age > TORN_FILE_GRACE_SEC`) — never imported from the code under test. An
 * existing nonce file that holds no complete nonce is PAST the grace only when
 * its age is strictly greater than 2000 ms; at exactly 2000 ms it is still
 * young and is waited on.
 */
const GRACE_MS = 2000;
/** The operator's step, which only an abandoned (old) file may name. */
const REMOVAL_STEP = /remove .* by hand/;

/** The young path's report, byte for byte (parity with the Python client's young-path message). */
function youngMessage(path: string): string {
  return (
    `${path} exists but its write was still in progress across 5 attempts; not overwriting it. ` +
    'This invocation proceeds without a principal; a later one adopts the nonce if that write ' +
    `lands, or reports ${path} as an interrupted write once it has stayed incomplete for 2 s.`
  );
}

/** The old path's report, byte for byte (unchanged, parity with the Python client). */
function abandonedMessage(path: string): string {
  return (
    `${path} exists but holds no complete nonce (an interrupted write); not overwriting it. ` +
    `The session runs without a principal until it is fixed: remove ${path} by hand if no ` +
    'hook of this session is running.'
  );
}

/**
 * An empty nonce file whose mtime is a whole second, and a clock pinned at
 * `ageMs` after it — so the age the client computes is exactly `ageMs`, to the
 * millisecond. `tick` advances the pinned clock (a wait that took time).
 */
function withPinnedAge<T>(
  ageMs: number,
  body: (nonce: string, tick: (ms: number) => void) => T
): T {
  const root = makeWorkspace();
  const original = Date.now;
  try {
    const { nonce } = filesFor(root, SID);
    writeFileSync(nonce, '', { mode: 0o600 });
    const wholeSecond = Math.floor(original() / 1000) - 60;
    utimesSync(nonce, wholeSecond, wholeSecond);
    assert.equal(
      statSync(nonce).mtimeMs,
      wholeSecond * 1000,
      'precondition: the mtime is exactly the whole second set, so the pinned age is exact'
    );
    let now = wholeSecond * 1000 + ageMs;
    Date.now = () => now;
    return body(nonce, (ms) => {
      now += ms;
    });
  } finally {
    Date.now = original;
    rmSync(root, { recursive: true, force: true });
  }
}

for (const ageMs of [GRACE_MS - 1, GRACE_MS]) {
  test(`grace edge: a torn nonce file aged exactly ${ageMs} ms is still YOUNG — the whole bounded wait, then the young report with no removal step`, () => {
    withPinnedAge(ageMs, (nonce) => {
      const run = countingWaits(() =>
        ensureMintNonce(dirname(dirname(nonce)), callerPrincipalKey(SID))
      );
      assert.equal(run.waits, BOUNDED_WAITS, `aged ${ageMs} ms: not past the grace, so waited on`);
      assert.equal(run.error?.message, youngMessage(nonce), `aged ${ageMs} ms: the young report`);
      assert.doesNotMatch(
        run.error!.message,
        REMOVAL_STEP,
        'a young file is never named for removal'
      );
      assert.equal(statSync(nonce).size, 0, 'left exactly as it was');
    });
  });
}

for (const ageMs of [GRACE_MS + 1, GRACE_MS + 100]) {
  test(`grace edge: a torn nonce file aged ${ageMs} ms is PAST the grace — reported at once with the removal step, no wait`, () => {
    withPinnedAge(ageMs, (nonce) => {
      const run = countingWaits(() =>
        ensureMintNonce(dirname(dirname(nonce)), callerPrincipalKey(SID))
      );
      assert.equal(run.waits, 0, `aged ${ageMs} ms: past the grace, so not waited on`);
      assert.equal(
        run.error?.message,
        abandonedMessage(nonce),
        `aged ${ageMs} ms: the abandoned report`
      );
      assert.equal(statSync(nonce).size, 0, 'left exactly as it was');
    });
  });
}

test('grace edge: the age is re-read at every attempt — a young file that crosses the edge DURING the wait is reported as abandoned at that attempt', () => {
  // 1990 ms at the first attempt; each wait advances the pinned clock 20 ms, so
  // the second attempt sees 2010 ms (past the edge) and stops waiting.
  withPinnedAge(GRACE_MS - 10, (nonce, tick) => {
    const run = countingWaits(
      () => ensureMintNonce(dirname(dirname(nonce)), callerPrincipalKey(SID)),
      () => tick(20)
    );
    assert.equal(run.waits, 1, 'one wait, then the file is past the grace');
    assert.equal(run.error?.message, abandonedMessage(nonce));
  });
});

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
