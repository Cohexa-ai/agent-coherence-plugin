#!/usr/bin/env node
// Copyright (c) 2026 Arbiter contributors.
// The Coherence Protocol for AI Agents

/**
 * Release-readiness preflight for agent-coherence-plugin.
 *
 * Node port of `tools/check_release_readiness.py` in the sibling Python repo
 * (`agent-coherence`). Run before any `v*` tag push to confirm the GitHub
 * side is configured for fail-closed publishing.
 *
 * Three checks (each shells out to `gh api`):
 *
 *   1. main branch protection is configured. 404 → fail (run setup commands
 *      in docs/RELEASE.md §1). 403 → warn (CI token lacks admin scope).
 *
 *   2. dev branch exists with protection. Distinguishes "branch missing on
 *      origin" from "branch exists but unprotected"; both fail with distinct
 *      remediation messages. 403 → warn.
 *
 *   3. A tag-protection ruleset targeting `refs/tags/v*` is active. Walks
 *      the rulesets list, fetches the full body of each tag-targeting
 *      active ruleset, and verifies `conditions.ref_name.include` covers
 *      `refs/tags/v*`. 403 → warn.
 *
 * Exit code: 0 if all pass or only warnings; 1 if any fail.
 *
 * Invoked manually before tag push (`node tools/check_release_readiness.js`)
 * and from the `preflight` job in `.github/workflows/release.yml`.
 *
 * No package.json script alias is added by this file — invoke directly.
 */

import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const FALLBACK_SLUG = 'Cohexa-ai/agent-coherence-plugin';
const TAG_PATTERN = 'v*';
const EXPECTED_TAG_REF = `refs/tags/${TAG_PATTERN}`;

// -----------------------------------------------------------------------------
// Repo slug resolution
// -----------------------------------------------------------------------------

/**
 * Parse `owner/repo` from a GitHub URL of any common form
 * (https, ssh, with-or-without .git suffix). Returns null on no match.
 */
function parseRepoSlug(url) {
  if (typeof url !== 'string' || url.length === 0) return null;
  // Strip leading "git+" if present (npm convention).
  const cleaned = url.replace(/^git\+/, '');
  // Match the trailing "owner/repo" segment, with optional .git.
  const match = cleaned.match(/[/:]([\w.-]+)\/([\w.-]+?)(?:\.git)?$/);
  if (!match) return null;
  return `${match[1]}/${match[2]}`;
}

function resolveRepoSlug() {
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    const pkgPath = resolve(here, '..', 'package.json');
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
    const url = pkg?.repository?.url;
    const slug = parseRepoSlug(url);
    if (slug) return slug;
    console.warn(
      `warning: could not parse repo slug from package.json repository.url ` +
      `(${url ?? 'missing'}); falling back to ${FALLBACK_SLUG}`
    );
  } catch (err) {
    console.warn(
      `warning: could not read package.json (${err.message}); ` +
      `falling back to ${FALLBACK_SLUG}`
    );
  }
  return FALLBACK_SLUG;
}

// -----------------------------------------------------------------------------
// gh api wrapper
// -----------------------------------------------------------------------------

/**
 * Run `gh api <path>` and return { ok, status, stdout, stderr }.
 *
 *   ok=true  → exit 0, stdout is body.
 *   ok=false → status is one of 'http_404', 'http_403', 'gh_missing', 'other'.
 */
function ghApi(path) {
  try {
    const stdout = execSync(`gh api ${path}`, {
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return { ok: true, stdout, stderr: '' };
  } catch (err) {
    const stderr = (err.stderr ?? '').toString();
    const stdout = (err.stdout ?? '').toString();
    // ENOENT → gh CLI not on PATH.
    if (err.code === 'ENOENT') {
      return { ok: false, status: 'gh_missing', stdout, stderr };
    }
    if (/HTTP 404/i.test(stderr)) {
      return { ok: false, status: 'http_404', stdout, stderr };
    }
    if (/HTTP 403/i.test(stderr)) {
      return { ok: false, status: 'http_403', stdout, stderr };
    }
    return { ok: false, status: 'other', stdout, stderr };
  }
}

// -----------------------------------------------------------------------------
// Check primitives
// -----------------------------------------------------------------------------

const PASS = 'pass';
const FAIL = 'fail';
const WARN = 'warn';

function result(name, level, detail) {
  return { name, level, detail };
}

// -----------------------------------------------------------------------------
// Check 1: main branch protection
// -----------------------------------------------------------------------------

function checkMainBranchProtection(slug) {
  const name = 'main branch protection';
  const res = ghApi(`repos/${slug}/branches/main/protection`);
  if (res.ok) {
    try {
      JSON.parse(res.stdout);
      return result(name, PASS, 'configured');
    } catch {
      return result(name, FAIL, 'gh api returned non-JSON response');
    }
  }
  if (res.status === 'http_404') {
    return result(
      name,
      FAIL,
      'Branch protection on `main` is not configured. ' +
      'Run the gh api PUT command in docs/RELEASE.md §1.'
    );
  }
  if (res.status === 'http_403') {
    return result(
      name,
      WARN,
      'check skipped (HTTP 403 — token lacks admin scope). Verify locally.'
    );
  }
  if (res.status === 'gh_missing') {
    return result(name, FAIL, 'gh CLI not found on PATH');
  }
  return result(name, FAIL, oneLine(res.stderr) || 'gh api failed');
}

// -----------------------------------------------------------------------------
// Check 2: dev branch exists with protection
// -----------------------------------------------------------------------------

/**
 * Distinguishes "dev branch does not exist on origin" from
 * "dev exists but is unprotected" by probing /branches/dev first when the
 * /protection call returns 404.
 */
function checkDevBranchProtection(slug) {
  const name = 'dev branch';
  const res = ghApi(`repos/${slug}/branches/dev/protection`);
  if (res.ok) {
    return result(name, PASS, 'configured with protection');
  }
  if (res.status === 'http_403') {
    return result(
      name,
      WARN,
      'check skipped (HTTP 403 — token lacks admin scope). Verify locally.'
    );
  }
  if (res.status === 'http_404') {
    // Disambiguate: does the branch itself exist?
    const branchRes = ghApi(`repos/${slug}/branches/dev`);
    if (!branchRes.ok && branchRes.status === 'http_404') {
      return result(
        name,
        FAIL,
        'Dev branch does not exist on origin. ' +
        'Run the gh commands in docs/RELEASE.md §1.'
      );
    }
    // Branch exists (or its existence couldn't be ruled out as 404) →
    // the original 404 was on /protection, meaning unprotected.
    return result(
      name,
      FAIL,
      'Branch protection on `dev` is not configured.'
    );
  }
  if (res.status === 'gh_missing') {
    return result(name, FAIL, 'gh CLI not found on PATH');
  }
  return result(name, FAIL, oneLine(res.stderr) || 'gh api failed');
}

// -----------------------------------------------------------------------------
// Check 3: tag ruleset for refs/tags/v*
// -----------------------------------------------------------------------------

function checkTagRuleset(slug) {
  const name = 'tag ruleset';
  const listRes = ghApi(`repos/${slug}/rulesets`);
  if (!listRes.ok) {
    if (listRes.status === 'http_403') {
      return result(
        name,
        WARN,
        'check skipped (HTTP 403 — token lacks admin scope). Verify locally.'
      );
    }
    if (listRes.status === 'http_404') {
      return result(
        name,
        FAIL,
        'No active tag protection ruleset matches refs/tags/v*. ' +
        'Run the gh api POST command in docs/RELEASE.md §1.'
      );
    }
    if (listRes.status === 'gh_missing') {
      return result(name, FAIL, 'gh CLI not found on PATH');
    }
    return result(name, FAIL, oneLine(listRes.stderr) || 'gh api failed');
  }

  let rulesets;
  try {
    rulesets = JSON.parse(listRes.stdout);
  } catch {
    return result(name, FAIL, 'rulesets endpoint returned non-JSON');
  }
  if (!Array.isArray(rulesets)) {
    return result(name, FAIL, 'rulesets endpoint returned unexpected shape');
  }

  const candidates = rulesets.filter(
    (rs) =>
      rs && typeof rs === 'object' &&
      rs.target === 'tag' &&
      rs.enforcement === 'active' &&
      rs.id != null
  );
  if (candidates.length === 0) {
    return result(
      name,
      FAIL,
      'No active tag protection ruleset matches refs/tags/v*. ' +
      'Run the gh api POST command in docs/RELEASE.md §1.'
    );
  }

  for (const rs of candidates) {
    const detailRes = ghApi(`repos/${slug}/rulesets/${rs.id}`);
    if (!detailRes.ok) continue;
    let body;
    try {
      body = JSON.parse(detailRes.stdout);
    } catch {
      continue;
    }
    const includes = body?.conditions?.ref_name?.include;
    if (Array.isArray(includes) && includes.includes(EXPECTED_TAG_REF)) {
      const label = body.name ?? `id=${rs.id}`;
      return result(name, PASS, `active ruleset '${label}' covers ${EXPECTED_TAG_REF}`);
    }
  }

  return result(
    name,
    FAIL,
    'No active tag protection ruleset matches refs/tags/v*. ' +
    'Run the gh api POST command in docs/RELEASE.md §1.'
  );
}

// -----------------------------------------------------------------------------
// Reporting
// -----------------------------------------------------------------------------

function oneLine(s) {
  return (s ?? '').toString().trim().replace(/\s+/g, ' ');
}

function statusGlyph(level) {
  if (level === PASS) return '✓';
  if (level === WARN) return '⚠';
  return '✗';
}

function printReport(slug, results) {
  console.log(`Release readiness preflight for ${slug}`);
  for (const r of results) {
    console.log(`${statusGlyph(r.level)} ${r.name}: ${r.detail}`);
  }
  const failures = results.filter((r) => r.level === FAIL).length;
  const warnings = results.filter((r) => r.level === WARN).length;
  console.log('');
  console.log(
    `Result: ${failures} failure(s), ${warnings} warning(s). ` +
    `See docs/RELEASE.md §1.`
  );
}

// -----------------------------------------------------------------------------
// Entry
// -----------------------------------------------------------------------------

function main() {
  const slug = resolveRepoSlug();
  const results = [
    checkMainBranchProtection(slug),
    checkDevBranchProtection(slug),
    checkTagRuleset(slug),
  ];
  printReport(slug, results);
  const failed = results.some((r) => r.level === FAIL);
  process.exit(failed ? 1 : 0);
}

main();
