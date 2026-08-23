#!/usr/bin/env node
/**
 * Verify that the plugin version is identical across the three version-bearing files:
 *   - package.json                          .version
 *   - .claude-plugin/plugin.json            .version
 *   - .claude-plugin/marketplace.json       .plugins[0].version
 *
 * When RELEASE_TAG is set (exported by the release.yml preflight from
 * `github.ref_name`), additionally require the tag to equal `v<version>`.
 * Unset RELEASE_TAG skips only the tag comparison — local pre-tag runs and
 * the pre-commit hook still get the three-file check.
 *
 * Exits 0 silently on match; exits 1 with a clear diff on drift.
 *
 * Run via pre-commit hook, CI, or directly:
 *   node tools/check_versions_synced.js [rootDir]
 * `rootDir` defaults to the repo root and exists for the test suite.
 *
 * Also importable — `check_release_readiness.js` consumes `evaluateVersionSync`
 * as its manifest-version check; importing never runs the CLI entry point.
 */

import { readFileSync, realpathSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const sources = [
  {
    path: 'package.json',
    extract: (json) => json.version,
  },
  {
    path: '.claude-plugin/plugin.json',
    extract: (json) => json.version,
  },
  {
    path: '.claude-plugin/marketplace.json',
    extract: (json) => json.plugins?.[0]?.version,
  },
];

/** Read the three manifests under rootDir → [{ path, version }]. Throws on unreadable/invalid JSON. */
export function collectVersionReadings(rootDir) {
  return sources.map(({ path, extract }) => {
    const raw = readFileSync(resolve(rootDir, path), 'utf8');
    return { path, version: extract(JSON.parse(raw)) };
  });
}

/**
 * Single verdict over the three manifests, plus the tag when given.
 * Returns { ok: boolean, detail: string } — never throws, never exits.
 */
export function evaluateVersionSync(rootDir, tag) {
  let readings;
  try {
    readings = collectVersionReadings(rootDir);
  } catch (err) {
    return { ok: false, detail: `could not read manifests: ${err.message}` };
  }

  const missing = readings.filter((r) => !r.version);
  if (missing.length > 0) {
    const paths = missing.map((r) => r.path).join(', ');
    return { ok: false, detail: `missing version field in: ${paths}` };
  }

  const distinct = new Set(readings.map((r) => r.version));
  if (distinct.size > 1) {
    const listing = readings.map((r) => `${r.path}=${r.version}`).join(', ');
    return { ok: false, detail: `version drift: ${listing}` };
  }

  const version = readings[0].version;
  if (tag != null && tag !== '') {
    if (tag !== `v${version}`) {
      return {
        ok: false,
        detail: `tag ${tag} does not match manifest version ${version} (expected v${version})`,
      };
    }
    return { ok: true, detail: `all manifests at ${version}; tag ${tag} matches` };
  }
  return { ok: true, detail: `all manifests at ${version} (tag check skipped — RELEASE_TAG not set)` };
}

function main() {
  const rootDir = process.argv[2] ? resolve(process.argv[2]) : repoRoot;
  const verdict = evaluateVersionSync(rootDir, process.env.RELEASE_TAG);
  if (!verdict.ok) {
    console.error(`check_versions_synced: ${verdict.detail}`);
    process.exit(1);
  }
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
