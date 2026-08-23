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
 * Six checks (1–3 and 5–6 shell out to `gh api`; 4 is filesystem-only):
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
 *   4. package.json, .claude-plugin/plugin.json, and
 *      .claude-plugin/marketplace.json declare one identical version, and —
 *      when RELEASE_TAG is set (release.yml preflight exports
 *      `github.ref_name`) — the tag equals `v<version>`. Local pre-tag runs
 *      skip only the tag comparison. Added after v0.3.1 shipped with
 *      marketplace.json still at 0.3.0.
 *
 *   5./6. Required status checks on main and dev name only contexts that
 *      `.github/workflows/ci.yml` actually produces. Job display names are
 *      derived statically — matrix `name:` templates are expanded over
 *      their axis values, e.g. "Tests (Node ${{ matrix.node-version }})" ×
 *      ["20", "22"] — and compared against
 *      GET /branches/{branch}/protection/required_status_checks.
 *      A required context no job produces → fail: that is the drift that
 *      kept protection requiring the removed "Tests (Node 18)" leg after
 *      the matrix moved to 20/22, blocking every PR merge behind an admin
 *      override while this tool still reported 0 failures (fixed by hand
 *      2026-08-23 via the gh api PUT commands in docs/RELEASE.md §1).
 *      A ci.yml job absent from the required set → warn. 404 (no required
 *      checks at all) → fail; 403 → warn.
 *
 * Exit code: 0 if all pass or only warnings; 1 if any fail.
 *
 * Invoked manually before tag push (`node tools/check_release_readiness.js`)
 * and from the `preflight` job in `.github/workflows/release.yml`. That
 * preflight runs on a bare checkout (no `npm ci`), so this file must not
 * import anything beyond node builtins — ci.yml is read with the scoped
 * workflow parser below, not a YAML library.
 *
 * No package.json script alias is added by this file — invoke directly.
 * Also importable — collectWorkflowContexts / compareContextsToJobs feed the
 * compiled test suite (dist/test/release_readiness_contexts.test.js);
 * importing never runs the CLI entry point.
 */

import { execSync } from 'node:child_process';
import { readFileSync, realpathSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, resolve } from 'node:path';
import { evaluateVersionSync } from './check_versions_synced.js';

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
// Check 4: manifest version sync (package.json / plugin.json / marketplace.json / tag)
// -----------------------------------------------------------------------------

function checkVersionSync() {
  const name = 'manifest version sync';
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const verdict = evaluateVersionSync(repoRoot, process.env.RELEASE_TAG);
  return result(name, verdict.ok ? PASS : FAIL, verdict.detail);
}

// -----------------------------------------------------------------------------
// ci.yml job-name extraction (dependency-free YAML subset)
// -----------------------------------------------------------------------------
//
// The release preflight invokes this tool on a bare checkout (no `npm ci`),
// so a YAML library cannot be imported here. Instead of a general parser,
// this reads the narrow, conventionally 2-space-indented shape GitHub
// workflow files use for job naming:
//
//   jobs:
//     <job-id>:
//       name: <scalar, may embed ${{ matrix.<axis> }}>
//       strategy:
//         matrix:
//           <axis>: [v1, v2]        # flow list
//           <axis>:                 # or block list of scalars
//             - v1
//
// Display-name rules mirror GitHub's: an explicit `name:` is the display
// name (matrix expressions expanded over the axis values); a matrix job
// without `name:` renders per leg as "<job-id> (<v1>, <v2>, ...)"; a plain
// job without `name:` renders as the job id.
//
// A job whose display name cannot be statically expanded (expressions other
// than `matrix.<axis>`, matrix include/exclude, non-list axis values)
// degrades to a loose wildcard match plus a warning — visible imprecision,
// never a silent verdict.

function indentOf(line) {
  return line.match(/^ */)[0].length;
}

function isContentLine(line) {
  const trimmed = line.trim();
  return trimmed.length > 0 && !trimmed.startsWith('#');
}

/**
 * Parse a YAML scalar as workflow files use them: optional single/double
 * quoting, trailing comment on unquoted values. Always returns a string.
 */
function parseScalar(raw) {
  const s = raw.trim();
  if (s.length === 0) return '';
  const quote = s[0];
  if (quote === '"' || quote === "'") {
    let out = '';
    for (let i = 1; i < s.length; i += 1) {
      const ch = s[i];
      if (quote === '"' && ch === '\\' && i + 1 < s.length) {
        out += s[i + 1];
        i += 1;
      } else if (ch === quote) {
        if (quote === "'" && s[i + 1] === "'") {
          out += "'"; // YAML doubles single quotes to escape them
          i += 1;
        } else {
          return out;
        }
      } else {
        out += ch;
      }
    }
    return out; // unterminated quote — best effort
  }
  const comment = s.match(/\s#/);
  return (comment ? s.slice(0, comment.index) : s).trim();
}

/** Split flow-list innards on top-level commas, respecting quotes. */
function splitFlowItems(inner) {
  const parts = [];
  let buf = '';
  let quote = null;
  for (const ch of inner) {
    if (quote) {
      buf += ch;
      if (ch === quote) quote = null;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      buf += ch;
    } else if (ch === ',') {
      parts.push(buf);
      buf = '';
    } else {
      buf += ch;
    }
  }
  parts.push(buf);
  return parts;
}

/**
 * Parse `[a, "b", 20]` into ['a', 'b', '20']. Returns null when the value
 * is not a flow list of plain scalars (nested lists/maps bail out).
 */
function parseFlowList(raw) {
  const s = raw.trim();
  if (!s.startsWith('[')) return null;
  let quote = null;
  for (let i = 1; i < s.length; i += 1) {
    const ch = s[i];
    if (quote) {
      if (ch === quote) quote = null;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (ch === ']') {
      const items = splitFlowItems(s.slice(1, i)).map(parseScalar);
      if (items.some((v) => /[[\]{}]/.test(v))) return null;
      return items.filter((v) => v.length > 0);
    }
  }
  return null; // unterminated list
}

/**
 * [start, end) of the block nested under the key line at `keyIdx`: every
 * following line more indented than `keyIndent`, up to `endLimit`.
 */
function blockUnder(lines, keyIdx, keyIndent, endLimit) {
  let end = keyIdx + 1;
  while (end < endLimit) {
    const line = lines[end];
    if (isContentLine(line) && indentOf(line) <= keyIndent) break;
    end += 1;
  }
  return [keyIdx + 1, end];
}

/** Indent of the first content line within [start, end), or null when empty. */
function firstIndent(lines, start, end) {
  for (let i = start; i < end; i += 1) {
    if (isContentLine(lines[i])) return indentOf(lines[i]);
  }
  return null;
}

/**
 * Find `key:` at exactly `indent` within [start, end). Returns
 * { idx, rest } (rest = text after the colon) or null.
 */
function findKey(lines, start, end, indent, key) {
  const re = new RegExp(`^ {${indent}}${key}:(.*)$`);
  for (let i = start; i < end; i += 1) {
    if (!isContentLine(lines[i])) continue;
    const m = lines[i].match(re);
    if (m) return { idx: i, rest: m[1] };
  }
  return null;
}

/** Reject value lists that still contain unexpanded expressions/containers. */
function guardStaticValues(values) {
  return values.some((v) => /[{[]/.test(v)) ? null : values;
}

/** Axis values: flow list, block list of scalars, or single scalar. */
function parseAxisValues(lines, entryIdx, entryIndent, endLimit, rest) {
  if (rest.trim().length > 0) {
    const flow = parseFlowList(rest);
    if (flow) return guardStaticValues(flow);
    const scalar = parseScalar(rest);
    return scalar.length > 0 ? guardStaticValues([scalar]) : null;
  }
  const [bStart, bEnd] = blockUnder(lines, entryIdx, entryIndent, endLimit);
  const values = [];
  for (let i = bStart; i < bEnd; i += 1) {
    const line = lines[i];
    if (!isContentLine(line)) continue;
    const item = line.trim();
    // `- key: value` items are mappings, not scalars — bail out. So do
    // continuation lines of a mapping item (no leading dash).
    if (!item.startsWith('- ') || /^[A-Za-z0-9_.-]+:\s/.test(item.slice(2))) {
      return null;
    }
    const value = parseScalar(item.slice(2));
    if (value.length === 0) return null;
    values.push(value);
  }
  return values.length > 0 ? guardStaticValues(values) : null;
}

/**
 * Parse `strategy.matrix` inside a job body. Returns
 * { axes: [{ key, values }], expandable } or null when the job has no
 * matrix. `expandable` is false when include/exclude are present (they
 * rewrite legs in ways this subset does not model) or when any axis value
 * cannot be resolved to a static scalar list.
 */
function parseMatrix(lines, bodyStart, bodyEnd, bodyIndent) {
  const strategy = findKey(lines, bodyStart, bodyEnd, bodyIndent, 'strategy');
  if (!strategy) return null;
  const [sStart, sEnd] = blockUnder(lines, strategy.idx, bodyIndent, bodyEnd);
  const sIndent = firstIndent(lines, sStart, sEnd);
  if (sIndent === null) return null;
  const matrix = findKey(lines, sStart, sEnd, sIndent, 'matrix');
  if (!matrix) return null;
  const [mStart, mEnd] = blockUnder(lines, matrix.idx, sIndent, sEnd);
  const mIndent = firstIndent(lines, mStart, mEnd);
  if (mIndent === null) return { axes: [], expandable: false };

  const axes = [];
  let expandable = true;
  const entryRe = new RegExp(`^ {${mIndent}}([A-Za-z0-9_.-]+):(.*)$`);
  for (let i = mStart; i < mEnd; i += 1) {
    const line = lines[i];
    if (!isContentLine(line) || indentOf(line) !== mIndent) continue;
    const m = line.match(entryRe);
    if (!m) {
      expandable = false;
      continue;
    }
    const [, key, rest] = m;
    if (key === 'include' || key === 'exclude') {
      expandable = false;
      continue;
    }
    const values = parseAxisValues(lines, i, mIndent, mEnd, rest);
    if (values === null) expandable = false;
    axes.push({ key, values });
  }
  return { axes, expandable };
}

const MATRIX_EXPR_RE = /\$\{\{\s*([^}]*?)\s*\}\}/g;
const AXIS_REF_RE = /^matrix\.([A-Za-z0-9_.-]+)$/;

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Regex matching a display-name template with every expression wildcarded. */
function looseNameRegex(template) {
  const parts = template.split(/\$\{\{[^}]*\}\}/).map(escapeRegExp);
  return new RegExp(`^${parts.join('.*')}$`);
}

function cartesian(lists) {
  return lists.reduce(
    (combos, list) => combos.flatMap((combo) => list.map((v) => [...combo, v])),
    [[]]
  );
}

function loose(jobId, regex, why) {
  return {
    loose: { jobId, regex },
    warning: `job '${jobId}': ${why} — matching its required contexts loosely`,
  };
}

/**
 * Expand one job into the display names GitHub reports as status-check
 * contexts: { names } on success, { loose, warning } when the name cannot
 * be derived statically.
 */
function expandJobDisplayNames(jobId, rawName, matrix) {
  const template = rawName ?? jobId;
  const exprs = [...template.matchAll(MATRIX_EXPR_RE)];

  if (exprs.length === 0) {
    if (rawName === null && matrix !== null) {
      // GitHub renders name-less matrix legs as "<job-id> (v1, v2, ...)".
      if (matrix.expandable && matrix.axes.length > 0) {
        const combos = cartesian(matrix.axes.map((a) => a.values));
        return { names: combos.map((c) => `${jobId} (${c.join(', ')})`) };
      }
      return loose(
        jobId,
        new RegExp(`^${escapeRegExp(jobId)} \\(.*\\)$`),
        'matrix cannot be statically expanded'
      );
    }
    return { names: [template] };
  }

  const axisByKey = new Map((matrix?.axes ?? []).map((a) => [a.key, a.values]));
  const referenced = [];
  for (const m of exprs) {
    const axis = m[1].match(AXIS_REF_RE);
    const values = axis ? axisByKey.get(axis[1]) : undefined;
    if (!axis || !values || !matrix.expandable) {
      return loose(
        jobId,
        looseNameRegex(template),
        `display name '${template}' cannot be statically expanded`
      );
    }
    if (!referenced.some((r) => r.key === axis[1])) {
      referenced.push({ key: axis[1], values });
    }
  }
  const byKey = new Map();
  const names = new Set();
  for (const combo of cartesian(referenced.map((r) => r.values))) {
    referenced.forEach((r, i) => byKey.set(r.key, combo[i]));
    names.add(
      template.replace(MATRIX_EXPR_RE, (_, expr) => byKey.get(expr.match(AXIS_REF_RE)[1]))
    );
  }
  return { names: [...names] };
}

/**
 * Extract the status-check context names a workflow file produces.
 *
 * Returns { names, loose, warnings }: `names` are exact display names;
 * `loose` carries per-job wildcard matchers for jobs that could not be
 * expanded, each surfaced in `warnings`. A file without a top-level
 * `jobs:` mapping returns an `error` field instead.
 *
 * Exported for dist/test/ unit tests.
 */
export function collectWorkflowContexts(text) {
  const lines = text.split(/\r?\n/);
  let jobsIdx = -1;
  for (let i = 0; i < lines.length; i += 1) {
    if (/^jobs:\s*(#.*)?$/.test(lines[i])) {
      jobsIdx = i;
      break;
    }
  }
  if (jobsIdx === -1) {
    return { names: [], loose: [], warnings: [], error: "no top-level 'jobs:' mapping found" };
  }
  const [jStart, jEnd] = blockUnder(lines, jobsIdx, 0, lines.length);
  const jobIndent = firstIndent(lines, jStart, jEnd);
  if (jobIndent === null) {
    return { names: [], loose: [], warnings: [], error: "'jobs:' mapping is empty" };
  }

  const names = [];
  const looseJobs = [];
  const warnings = [];
  const jobRe = new RegExp(`^ {${jobIndent}}([A-Za-z_][A-Za-z0-9_-]*):\\s*(?:#.*)?$`);
  for (let i = jStart; i < jEnd; i += 1) {
    const m = lines[i].match(jobRe);
    if (!m) continue;
    const jobId = m[1];
    const [bStart, bEnd] = blockUnder(lines, i, jobIndent, jEnd);
    const bodyIndent = firstIndent(lines, bStart, bEnd);
    const nameKey = bodyIndent === null ? null : findKey(lines, bStart, bEnd, bodyIndent, 'name');
    const rawName = nameKey === null ? null : parseScalar(nameKey.rest);
    if (nameKey !== null && rawName === '') {
      // `name: >-` block scalars etc. — the display name is unknowable here.
      const opaque = loose(jobId, /^.*$/, 'display name is not an inline scalar');
      looseJobs.push(opaque.loose);
      warnings.push(opaque.warning);
      continue;
    }
    const matrix = bodyIndent === null ? null : parseMatrix(lines, bStart, bEnd, bodyIndent);
    const expanded = expandJobDisplayNames(jobId, rawName, matrix);
    if (expanded.names) {
      names.push(...expanded.names);
    } else {
      looseJobs.push(expanded.loose);
      warnings.push(expanded.warning);
    }
  }
  return { names, loose: looseJobs, warnings };
}

// -----------------------------------------------------------------------------
// Checks 5+6: required status contexts on main/dev name real ci.yml jobs
// -----------------------------------------------------------------------------
//
// Scope: only .github/workflows/ci.yml is parsed — it is the sole workflow
// that runs on main/dev pushes and PRs today (release.yml is tag-triggered
// and never produces branch contexts). If another PR-triggered workflow
// starts producing required contexts, teach loadWorkflowContexts() about it;
// until then an unknown required context fails loudly rather than passing
// silently.

function loadWorkflowContexts() {
  const here = dirname(fileURLToPath(import.meta.url));
  const ciPath = resolve(here, '..', '.github', 'workflows', 'ci.yml');
  let text;
  try {
    text = readFileSync(ciPath, 'utf8');
  } catch (err) {
    return {
      names: [],
      loose: [],
      warnings: [],
      error: `could not read .github/workflows/ci.yml (${err.message})`,
    };
  }
  return collectWorkflowContexts(text);
}

/** Required contexts from a required_status_checks body; null on bad shape. */
function extractRequiredContexts(body) {
  if (Array.isArray(body?.contexts)) {
    return body.contexts.filter((c) => typeof c === 'string');
  }
  if (Array.isArray(body?.checks)) {
    return body.checks.map((c) => c?.context).filter((c) => typeof c === 'string');
  }
  return null;
}

/**
 * Diff required contexts against the workflow's produced names:
 * { stale, unrequired }. `stale` = required contexts no job produces
 * (exact names first, then each loose matcher); `unrequired` = exact job
 * names absent from the required set (loose jobs are skipped — their names
 * are unknowable). Exported for dist/test/ unit tests.
 */
export function compareContextsToJobs(contexts, workflow) {
  const exact = new Set(workflow.names);
  const required = new Set(contexts);
  const stale = contexts.filter(
    (c) => !exact.has(c) && !workflow.loose.some((l) => l.regex.test(c))
  );
  const unrequired = workflow.names.filter((n) => !required.has(n));
  return { stale, unrequired };
}

function checkRequiredContexts(slug, branch, workflow) {
  const name = `${branch} required status contexts`;
  const res = ghApi(`repos/${slug}/branches/${branch}/protection/required_status_checks`);
  if (!res.ok) {
    if (res.status === 'http_403') {
      return result(
        name,
        WARN,
        'check skipped (HTTP 403 — token lacks admin scope). Verify locally.'
      );
    }
    if (res.status === 'http_404') {
      return result(
        name,
        FAIL,
        `No required status checks are configured on \`${branch}\` ` +
        '(or its branch protection is missing entirely). ' +
        'Run the gh api PUT command in docs/RELEASE.md §1.'
      );
    }
    if (res.status === 'gh_missing') {
      return result(name, FAIL, 'gh CLI not found on PATH');
    }
    return result(name, FAIL, oneLine(res.stderr) || 'gh api failed');
  }

  let body;
  try {
    body = JSON.parse(res.stdout);
  } catch {
    return result(name, FAIL, 'required_status_checks endpoint returned non-JSON');
  }
  const contexts = extractRequiredContexts(body);
  if (contexts === null) {
    return result(name, FAIL, 'required_status_checks endpoint returned unexpected shape');
  }
  if (contexts.length === 0) {
    return result(
      name,
      FAIL,
      `Required status checks on \`${branch}\` list no contexts, so merges are ` +
      'not gated on CI. Run the gh api PUT command in docs/RELEASE.md §1.'
    );
  }

  const { stale, unrequired } = compareContextsToJobs(contexts, workflow);
  if (stale.length > 0) {
    const list = stale.map((c) => `'${c}'`).join(', ');
    return result(
      name,
      FAIL,
      `required context(s) ${list} are not produced by any ci.yml job — ` +
      `PRs into \`${branch}\` can only merge via admin override. Update the ` +
      'required contexts to the ci.yml job names via the gh api PUT command ' +
      'in docs/RELEASE.md §1.'
    );
  }
  if (unrequired.length > 0) {
    const list = unrequired.map((c) => `'${c}'`).join(', ');
    return result(
      name,
      WARN,
      `all ${contexts.length} required context(s) map to ci.yml jobs, ` +
      `but ci.yml job(s) ${list} are not required on \`${branch}\``
    );
  }
  return result(name, PASS, `${contexts.length} required context(s), all produced by ci.yml jobs`);
}

/** Checks 5+6 plus any parser warnings, as a flat result list. */
function requiredContextsChecks(slug) {
  const workflow = loadWorkflowContexts();
  if (workflow.error) {
    return [
      result(
        'ci.yml job names',
        FAIL,
        `${workflow.error} — cannot validate required status contexts. ` +
        'If CI moved, update loadWorkflowContexts() in this tool.'
      ),
    ];
  }
  return [
    ...workflow.warnings.map((w) => result('ci.yml job names', WARN, w)),
    checkRequiredContexts(slug, 'main', workflow),
    checkRequiredContexts(slug, 'dev', workflow),
  ];
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
    checkVersionSync(),
    ...requiredContextsChecks(slug),
  ];
  printReport(slug, results);
  const failed = results.some((r) => r.level === FAIL);
  process.exit(failed ? 1 : 0);
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
