/**
 * Lockfile-drift validation tests — the dev-behind-main guard in
 * tools/check_release_readiness.js.
 *
 * Origin: Dependabot builds its dependency graph from the DEFAULT branch
 * only. `.github/dependabot.yml` says so in its own comment, and the repo is
 * configured with default_branch=main. So a security advisory produces
 * exactly one alert and one PR, both scoped to main, and `dev` is never
 * examined — even though every feature branch is cut from dev.
 *
 * That makes the main→dev forward-merge half of the remediation rather than
 * release hygiene, and it is the half that gets skipped. The record:
 *
 *   - Alert #5 (js-yaml, 2026-08-23) has fixed_at FOUR SECONDS after PR #102
 *     merged to main, and FORTY-ONE MINUTES before PR #109 carried the same
 *     bump to dev. The alert reported green while dev was still vulnerable.
 *   - By 2026-09-16, twelve main-only commits had accumulated since that last
 *     forward-merge, every one authored by dependabot[bot], while alert #6
 *     (js-yaml again, GHSA-2883-xcg3-v3hh) sat open.
 *
 * Nothing in preflight looked at this, because every other check inspects
 * branch protection or workflow shape — none compares the two branches'
 * resolved dependency versions. A green alert is not evidence dev is patched.
 *
 * These tests pin the guard on evaluateLockfileDrift(), the pure verdict
 * function, so the rule logic runs with no network round-trip:
 *   1. The exact alert-#6 shape fails and names js-yaml with both versions.
 *   2. Parity passes.
 *   3. dev AHEAD of main passes — dev leading is the normal state, not drift.
 *   4. A package on main but absent from dev is not this failure mode.
 *   5. Every drifted package is named, not just the first.
 *   6. Versions that are not plainly comparable are skipped, never guessed.
 *   7. Malformed bodies degrade to a verdict rather than throwing.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
// @ts-expect-error — plain JS tool, no type declarations by design.
import { evaluateLockfileDrift } from '../../tools/check_release_readiness.js';

type Verdict = { ok: boolean; detail: string };

/** Minimal package-lock.json shape: only `packages{}` matters to the guard. */
function lock(pkgs: Record<string, string>): Record<string, unknown> {
  const packages: Record<string, unknown> = {
    // The root entry carries the project's OWN version and no dependency
    // meaning. Comparing it would flag every release where main is tagged
    // ahead of dev, which is the normal state, so it must be ignored.
    '': { name: 'agent-coherence-plugin-coordinator', version: '0.5.0' },
  };
  for (const [name, version] of Object.entries(pkgs)) {
    packages[`node_modules/${name}`] = { version };
  }
  return { lockfileVersion: 3, packages };
}

test('lockfile drift: dev behind main on js-yaml fails and names both versions', () => {
  // The literal alert-#6 state: PR #128 lands 4.3.2 on main, dev keeps 4.3.1.
  const v: Verdict = evaluateLockfileDrift(
    lock({ 'js-yaml': '4.3.2', uuid: '14.0.2' }),
    lock({ 'js-yaml': '4.3.1', uuid: '14.0.2' })
  );
  assert.equal(v.ok, false);
  assert.match(v.detail, /js-yaml/);
  // Both versions must appear, or the reader cannot tell which way it drifted
  // or how far behind dev is.
  assert.match(v.detail, /4\.3\.1/);
  assert.match(v.detail, /4\.3\.2/);
  // The remedy has to be in the message: this fires in CI, where the reader
  // has no context for why a lockfile comparison is a security finding.
  assert.match(v.detail, /forward-merge/i);
});

test('lockfile drift: identical lockfiles pass', () => {
  const same = { 'js-yaml': '4.3.2', uuid: '14.0.2', 'better-sqlite3': '12.10.0' };
  const v: Verdict = evaluateLockfileDrift(lock(same), lock(same));
  assert.equal(v.ok, true);
});

test('lockfile drift: dev AHEAD of main passes — dev leading is the normal state', () => {
  // dev is the integration branch and routinely carries newer deps than the
  // released line. Flagging this would make the check fire constantly and
  // train everyone to ignore it.
  const v: Verdict = evaluateLockfileDrift(
    lock({ 'js-yaml': '4.3.1' }),
    lock({ 'js-yaml': '4.3.2' })
  );
  assert.equal(v.ok, true);
});

test('lockfile drift: a package on main but absent from dev is not flagged', () => {
  // Absence is a different question (dev dropped a dep, or the trees diverged
  // structurally). This guard answers exactly one: is dev running something
  // OLDER than main? Conflating the two produces noise on every refactor.
  const v: Verdict = evaluateLockfileDrift(
    lock({ 'js-yaml': '4.3.2', 'only-on-main': '1.0.0' }),
    lock({ 'js-yaml': '4.3.2' })
  );
  assert.equal(v.ok, true);
});

test('lockfile drift: every drifted package is named, not just the first', () => {
  const v: Verdict = evaluateLockfileDrift(
    lock({ 'js-yaml': '4.3.2', uuid: '14.0.2', 'brace-expansion': '5.0.9' }),
    lock({ 'js-yaml': '4.3.1', uuid: '14.0.1', 'brace-expansion': '5.0.8' })
  );
  assert.equal(v.ok, false);
  for (const pkg of ['js-yaml', 'uuid', 'brace-expansion']) {
    assert.match(v.detail, new RegExp(pkg));
  }
});

test('lockfile drift: versions that are not plainly comparable are skipped, not guessed', () => {
  // A prerelease or git-ref version has no total order this guard can assert
  // without a real semver implementation, and a wrong FAIL here would block a
  // release on a false positive. Skipping is the safe direction: the guard
  // exists to catch a missed forward-merge of a plain version bump.
  const v: Verdict = evaluateLockfileDrift(
    lock({ pkg: '1.0.0-rc.2', other: 'github:owner/repo#abc123' }),
    lock({ pkg: '1.0.0-rc.1', other: 'github:owner/repo#def456' })
  );
  assert.equal(v.ok, true);
});

test('lockfile drift: malformed bodies produce a verdict, never a throw', () => {
  for (const [a, b] of [
    [null, null],
    [{}, {}],
    [lock({ x: '1.0.0' }), {}],
    [{ packages: 'not-an-object' }, lock({ x: '1.0.0' })],
    [undefined, lock({ x: '1.0.0' })],
  ]) {
    const v: Verdict = evaluateLockfileDrift(a, b);
    // Fail CLOSED, and assert the direction rather than merely the type. An
    // earlier version of this test asserted `typeof v.ok === 'boolean'`, which
    // a mutant flipping the guard to `ok: true` passed — the malformed-input
    // path silently certifying dev as patched is precisely the failure this
    // case exists to prevent.
    assert.equal(v.ok, false);
    assert.equal(typeof v.detail, 'string');
    assert.ok(v.detail.length > 0);
  }
});

test('lockfile drift: the root "" entry is ignored, so a tagged main never trips it', () => {
  // main sits at the released version and dev at the in-flight one, so the
  // root entry is legitimately "behind" on main-vs-dev comparisons in both
  // directions. It is project metadata, not a dependency.
  const mainLock = lock({ 'js-yaml': '4.3.2' }) as { packages: Record<string, unknown> };
  const devLock = lock({ 'js-yaml': '4.3.2' }) as { packages: Record<string, unknown> };
  mainLock.packages[''] = { name: 'p', version: '0.6.0' };
  devLock.packages[''] = { name: 'p', version: '0.5.0' };
  const v: Verdict = evaluateLockfileDrift(mainLock, devLock);
  assert.equal(v.ok, true);
});

/** Lockfile with arbitrary `packages{}` paths — for nesting and alias shapes. */
function rawLock(entries: Record<string, Record<string, unknown>>): Record<string, unknown> {
  return {
    lockfileVersion: 3,
    packages: { '': { name: 'p', version: '0.5.0' }, ...entries },
  };
}

test('lockfile drift: a nested older copy on dev is caught, not hidden by the path mismatch', () => {
  // npm hoists freely, so one package lives at different lockfile paths on
  // different branches — this repo's real lockfile already carries four such
  // nested duplicates. Keying the comparison on the path reports this clean,
  // which is the exact blind spot a security guard cannot afford.
  const v: Verdict = evaluateLockfileDrift(
    rawLock({ 'node_modules/js-yaml': { version: '4.3.2' } }),
    rawLock({ 'node_modules/eslint/node_modules/js-yaml': { version: '4.3.1' } })
  );
  assert.equal(v.ok, false);
  assert.match(v.detail, /js-yaml/);
  // The operator cannot act on this without knowing where the old copy lives.
  assert.match(v.detail, /node_modules\/eslint\/node_modules\/js-yaml/);
});

test('lockfile drift: dev holding BOTH the patched and a nested vulnerable copy fails', () => {
  // The worst case: dev's top-level entry matches main exactly while it still
  // installs the vulnerable copy underneath a dependency. Collapsing each name
  // to its HIGHEST version would certify this clean; the collapse takes the
  // lowest precisely so this fails.
  const v: Verdict = evaluateLockfileDrift(
    rawLock({ 'node_modules/js-yaml': { version: '4.3.2' } }),
    rawLock({
      'node_modules/js-yaml': { version: '4.3.2' },
      'node_modules/some-dep/node_modules/js-yaml': { version: '4.3.1' },
    })
  );
  assert.equal(v.ok, false);
  assert.match(v.detail, /js-yaml/);
  assert.match(v.detail, /4\.3\.1/);
});

test('lockfile drift: versions of differing arity compare by segment, not by length', () => {
  // The accepted-version pattern admits `\d+(?:\.\d+)*`, so a two-segment
  // version can reach the comparator. Without zero-padding the shorter side,
  // '1.2' vs '1.2.3' inverts and the drift is reported backwards.
  const behind: Verdict = evaluateLockfileDrift(
    rawLock({ 'node_modules/p': { version: '1.2.3' } }),
    rawLock({ 'node_modules/p': { version: '1.2' } })
  );
  assert.equal(behind.ok, false);
  const ahead: Verdict = evaluateLockfileDrift(
    rawLock({ 'node_modules/p': { version: '1.2' } }),
    rawLock({ 'node_modules/p': { version: '1.2.3' } })
  );
  assert.equal(ahead.ok, true);
});

test('lockfile drift: an npm alias resolves by its real package name, never by its specifier', () => {
  // v3 writes an alias as `"node_modules/lru": { name: "lru-cache", ... }`.
  // Keying on the specifier would compare lru-cache against quick-lru and
  // report a version move on a package that does not exist.
  const v: Verdict = evaluateLockfileDrift(
    rawLock({ 'node_modules/lru': { name: 'lru-cache', version: '11.0.0' } }),
    rawLock({ 'node_modules/lru': { name: 'quick-lru', version: '7.0.1' } })
  );
  assert.equal(v.ok, true);
});
