/**
 * End-to-end tests for `tools/check_lockfile_drift.js`.
 *
 * The verdict function is covered exhaustively in lockfile_drift.test.ts. What
 * those tests cannot reach is everything between the CLI entry point and that
 * function: the `contents?ref=` URL for each branch, the base64/JSON decode,
 * the per-ref status branching, and the exit code. Without the cases below the
 * whole check could be deleted — or wired to read one ref twice — with the
 * suite still green, which is the same silent-control failure the check itself
 * exists to catch on the Dependabot side.
 *
 * Each case spawns the real CLI against a fake `gh` on PATH.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// __dirname at runtime is dist/test/; plugin root is two levels up.
const __filename = fileURLToPath(import.meta.url);
const PLUGIN_ROOT = resolve(dirname(__filename), '..', '..');
const TOOL = join(PLUGIN_ROOT, 'tools', 'check_lockfile_drift.js');

/** How the fake `gh` answers the two `contents` reads. */
type LockBehavior =
  | { kind: 'perRef'; main: Record<string, string>; dev: Record<string, string> }
  | { kind: 'http'; code: 403 | 404 };

/** A `contents` API envelope wrapping a minimal lockfile of name -> version. */
function envelope(versions: Record<string, string>): string {
  const packages: Record<string, unknown> = { '': { name: 'p', version: '0.5.0' } };
  for (const [name, version] of Object.entries(versions)) {
    packages[`node_modules/${name}`] = { version };
  }
  const body = JSON.stringify({ lockfileVersion: 3, packages });
  return JSON.stringify({ encoding: 'base64', content: Buffer.from(body).toString('base64') });
}

function writeFakeGh(dir: string, lock: LockBehavior): string {
  const binDir = join(dir, 'bin');
  mkdirSync(binDir, { recursive: true });
  let cases: string[];
  if (lock.kind === 'http') {
    const label = lock.code === 404 ? 'Not Found' : 'Forbidden';
    cases = [
      `  repos/*/contents/package-lock.json*) echo "gh: ${label} (HTTP ${lock.code})" >&2; exit 1 ;;`,
    ];
  } else {
    const mainLock = join(dir, 'lock_main.json');
    const devLock = join(dir, 'lock_dev.json');
    writeFileSync(mainLock, envelope(lock.main));
    writeFileSync(devLock, envelope(lock.dev));
    // Keyed on `?ref=`: serving one shared body for every ref cannot tell the
    // check running from the check never running, which is the whole point.
    cases = [
      `  repos/*/contents/package-lock.json*ref=main) cat "${mainLock}" ;;`,
      `  repos/*/contents/package-lock.json*ref=dev) cat "${devLock}" ;;`,
    ];
  }
  const script = [
    '#!/usr/bin/env bash',
    '# Fake gh for lockfile-drift CLI tests: supports `gh api <path>`.',
    'path="$2"',
    'case "$path" in',
    ...cases,
    '  *) echo "gh: Not Found (HTTP 404)" >&2; exit 1 ;;',
    'esac',
  ].join('\n');
  const ghPath = join(binDir, 'gh');
  writeFileSync(ghPath, `${script}\n`);
  chmodSync(ghPath, 0o755);
  return binDir;
}

function withFakeGh(
  lock: LockBehavior,
  run: (res: { status: number; stdout: string; stderr: string }) => void
): void {
  const dir = mkdtempSync(join(tmpdir(), 'lockfile-drift-'));
  try {
    const res = spawnSync(process.execPath, [TOOL], {
      encoding: 'utf-8',
      env: { ...process.env, PATH: `${writeFakeGh(dir, lock)}:${process.env['PATH'] ?? ''}` },
      timeout: 30000,
    });
    run({ status: res.status ?? -1, stdout: res.stdout ?? '', stderr: res.stderr ?? '' });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('cli: dev behind main on a package → exit 1 naming it', () => {
  withFakeGh({ kind: 'perRef', main: { 'js-yaml': '4.3.2' }, dev: { 'js-yaml': '4.3.1' } }, (res) => {
    assert.equal(res.status, 1, `drift must exit non-zero:\n${res.stdout}\n${res.stderr}`);
    assert.match(res.stdout, /js-yaml \(dev 4\.3\.1 < main 4\.3\.2\)/);
    assert.match(res.stdout, /forward-merge main into dev/);
  });
});

test('cli: the two refs are read distinctly and in the right order', () => {
  // dev AHEAD of main must exit 0. This separates a CLI that reads two distinct
  // refs from one that reads `main` twice (which would also pass here, but
  // fails the drift case above), and from one that swapped the comparison
  // arguments (which would report drift here).
  withFakeGh({ kind: 'perRef', main: { 'js-yaml': '4.3.1' }, dev: { 'js-yaml': '4.3.2' } }, (res) => {
    assert.equal(res.status, 0, `dev ahead is normal, not drift:\n${res.stdout}`);
    assert.match(res.stdout, /no package in dev's lockfile is older than main's/);
  });
});

test('cli: a 403 warns and exits 0 — it is not evidence about the lockfiles', () => {
  // 403 means the token cannot read contents at all. Every other read failure
  // fails closed; this one must not, or a low-scope token turns a green run
  // into a permanent red check that says nothing.
  withFakeGh({ kind: 'http', code: 403 }, (res) => {
    assert.equal(res.status, 0, `403 must warn, not fail:\n${res.stdout}`);
    assert.match(res.stdout, /check skipped \(HTTP 403/);
  });
});

test('cli: an unreadable lockfile exits 1 rather than certifying', () => {
  // Lost evidence is not proof of health. The check must not exit 0 having
  // compared nothing.
  withFakeGh({ kind: 'http', code: 404 }, (res) => {
    assert.equal(res.status, 1, `lost evidence must fail closed:\n${res.stdout}`);
    assert.match(res.stdout, /cannot prove dev is patched/);
  });
});
