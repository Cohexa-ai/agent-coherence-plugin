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
 * after the tag push. The comparison logic lives beside its siblings in that
 * file and is imported here; only the CLI entry point is separate.
 *
 * WHEN THIS RUNS. `.github/workflows/lockfile-drift.yml` invokes it on every
 * push to `main` — the moment the drift is created — and on demand via
 * workflow_dispatch. A red check on `main` is visible and blocks nothing.
 *
 * Exit code: 0 when `dev` is level or ahead, or when the check could not run
 * for a reason that is not evidence about the lockfiles (HTTP 403); 1 when
 * drift is proven or the evidence was lost.
 */

import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { checkLockfileDrift, resolveRepoSlug } from './check_release_readiness.js';

const MARK = { pass: '✓', fail: '✗', warn: '⚠' };

function main() {
  const slug = resolveRepoSlug();
  const result = checkLockfileDrift(slug);
  console.log(`Lockfile drift check for ${slug}`);
  console.log(`${MARK[result.level] ?? '?'} ${result.name}: ${result.detail}`);
  if (result.level === 'fail') {
    console.log('');
    console.log('dev is missing dependency updates that landed on main.');
    process.exit(1);
  }
  process.exit(0);
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
