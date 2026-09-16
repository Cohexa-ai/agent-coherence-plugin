#!/usr/bin/env node
// Copyright (c) 2026 Arbiter contributors.
// The Coherence Protocol for AI Agents

/**
 * Report whether `dev`'s package-lock.json carries a package older than
 * `main`'s, and exit non-zero when it does.
 *
 * WHY THIS EXISTS. Dependabot builds its dependency graph from the DEFAULT
 * branch only — `.github/dependabot.yml` says so in its own comment — so a
 * security advisory raises exactly one alert and one PR, both scoped to
 * `main`, and `dev` is never examined even though every feature branch is cut
 * from it. That makes the `main` -> `dev` forward-merge half of the
 * remediation, and it is the half with no alert behind it. The record:
 *
 *   - Alert #5 (js-yaml, 2026-08-23) recorded `fixed_at` FOUR SECONDS after
 *     PR #102 merged to `main` and FORTY-ONE MINUTES before PR #109 carried
 *     the same bump to `dev`. The alert was green while `dev` was vulnerable.
 *   - Alert #6, the same package again, closed FIVE SECONDS after PR #128
 *     merged while `dev` still sat on 4.3.1 (fixed by PR #141).
 *
 * Between those, twelve main-only commits accumulated with no forward-merge,
 * every one authored by dependabot[bot].
 *
 * WHY NOT IN THE RELEASE PREFLIGHT. `tools/check_release_readiness.js` gates
 * tag pushes, and a tag points at `main`. `dev`'s state says nothing about
 * whether the artifact being released is correct, so gating the tag on it
 * would block a good release for an unrelated condition at the one moment it
 * cannot be retried — the `refs/tags/v*` ruleset forbids deletion and
 * non-fast-forward, so a failure there spends the version number. It would
 * also enforce a step `docs/RELEASE.md` §2 does not contain and §3 sequences
 * after the tag push. The comparison itself lives in `tools/lockfile_drift.js`
 * and imports nothing; `check_release_readiness.js` contributes only the
 * gh-fetching wrapper, because that is where `ghApi` lives.
 *
 * WHEN THIS RUNS. `.github/workflows/lockfile-drift.yml` invokes it on every
 * push to `main` or `dev` — the moment the drift is created, from either side —
 * and on demand via workflow_dispatch. A red check is visible and blocks
 * nothing.
 *
 * EXIT CODE: 0 only on a proven-clean comparison. Every other outcome exits 1,
 * including the HTTP 403 that stays WARN in the level. The level and the exit
 * code answer different questions: the level says how bad it is, the exit code
 * says whether this run produced the assurance the check exists to produce. A
 * 403 produced none, and exiting 0 on it would paint a green check on a run
 * that never compared anything — the exact silent pass this guard is meant to
 * make impossible. The distinction is not lost: it survives in the level mark
 * and in the discriminated closing line below.
 */

import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { checkLockfileDrift, resolveRepoSlug } from './check_release_readiness.js';

const MARK = { pass: '✓', fail: '✗', warn: '⚠' };

/**
 * The closing line, keyed on WHY this run is not a pass.
 *
 * Only `drift` may assert that dev is missing an update — that claim rests on
 * having read both lockfiles and compared them. Printing it after a failed
 * fetch would send an operator to forward-merge a branch the check never looked
 * at, and they would find nothing to merge.
 */
const CLOSING_LINE = {
  drift: 'dev is missing dependency updates that landed on main.',
  unreadable:
    'This is NOT a statement about dev — the check could not read its evidence. ' +
    'Compare the two lockfiles by hand before trusting either branch.',
  skipped:
    'This is NOT a statement about dev — the check was not permitted to read its evidence. ' +
    'Compare the two lockfiles by hand before trusting either branch.',
};

function main() {
  const slug = resolveRepoSlug();
  const result = checkLockfileDrift(slug);
  console.log(`Lockfile drift check for ${slug}`);
  console.log(`${MARK[result.level] ?? '?'} ${result.name}: ${result.detail}`);
  if (result.level === 'pass') process.exit(0);
  console.log('');
  console.log(CLOSING_LINE[result.reason] ?? CLOSING_LINE.unreadable);
  process.exit(1);
}

function isDirectRun() {
  if (!process.argv[1]) return false;
  try {
    // realpath both sides: node resolves the main module through symlinks.
    return import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;
  } catch {
    return false;
  }
}

if (isDirectRun()) main();
