#!/usr/bin/env node
/**
 * Verify that the plugin version is identical across the three version-bearing files:
 *   - package.json                          .version
 *   - .claude-plugin/plugin.json            .version
 *   - .claude-plugin/marketplace.json       .plugins[0].version
 *
 * Exits 0 silently on match; exits 1 with a clear diff on drift.
 *
 * Run in CI (ci.yml `version-sync` job) or directly:  node tools/check_versions_synced.js
 */

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

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

const readings = sources.map(({ path, extract }) => {
  const raw = readFileSync(resolve(repoRoot, path), 'utf8');
  const parsed = JSON.parse(raw);
  return { path, version: extract(parsed) };
});

const missing = readings.filter((r) => !r.version);
if (missing.length > 0) {
  console.error('check_versions_synced: missing version field in:');
  missing.forEach((r) => console.error(`  - ${r.path}`));
  process.exit(1);
}

const versions = new Set(readings.map((r) => r.version));
if (versions.size > 1) {
  console.error('check_versions_synced: version drift detected');
  readings.forEach((r) => console.error(`  ${r.path}: ${r.version}`));
  console.error('All three files must declare the same version.');
  process.exit(1);
}
