/**
 * Marketplace provisioning regression — a plugin package WITHOUT dist/ (the
 * shape every marketplace install receives: git clone + gitignored dist/)
 * must still yield a LIVE Node coordinator, and provisioning failures must
 * be loud — exit 1 with no "spawned" line — never the pre-fix behavior of
 * spawning a nonexistent entry point and reporting success while the
 * coordinator crash-looped MODULE_NOT_FOUND into coordinator.log.
 *
 * Subprocess style per dispatch_unit5.test.ts. The stub package has zero
 * dependencies so Stage 1's `npm install` is fast and offline; tsc is
 * provided by symlinking the repo's own node_modules as the stub package's
 * (standing in for the marketplace installer's npm install in the plugin
 * cache — no network in tests).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  mkdirSync,
  cpSync,
  chmodSync,
  symlinkSync,
  existsSync,
  readFileSync,
} from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const PLUGIN_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

const STUB_PACKAGE_JSON = JSON.stringify({
  name: 'provision-stub',
  version: '0.0.1',
  private: true,
  type: 'module',
});

// Minimal project shape mirroring the real tsconfig's src → dist layout.
const STUB_TSCONFIG = JSON.stringify({
  compilerOptions: {
    target: 'ES2022',
    module: 'NodeNext',
    moduleResolution: 'NodeNext',
    outDir: 'dist',
    rootDir: 'src',
  },
  include: ['src/**/*'],
});

// The inline `declare` keeps the stub compilable with no @types/node in the
// stub's (empty) node_modules; the runtime global exists in Node regardless.
const HEALTHY_COORDINATOR_TS =
  'declare function setInterval(cb: () => void, ms: number): unknown;\nsetInterval(() => {}, 60_000);\n';
const CRASHING_COORDINATOR_TS = 'throw new Error("stub coordinator crash on boot");\n';
const HEALTHY_PREBUILT_JS = 'setInterval(() => {}, 60_000);\n';

interface StubRootOpts {
  /** When set, the package ships src/coordinator.ts + tsconfig.json (marketplace shape). */
  srcCoordinatorTs?: string;
  /** Symlink the repo's node_modules into the package (provides .bin/tsc). */
  withTsc?: boolean;
  /** When set, the package ships a prebuilt dist/coordinator.js (dev-checkout shape). */
  prebuiltDistJs?: string;
}

function makeStubRoot(opts: StubRootOpts): string {
  const root = mkdtempSync(join(tmpdir(), 'provision-root-'));
  mkdirSync(join(root, 'bin'), { recursive: true });
  cpSync(
    join(PLUGIN_ROOT, 'bin', 'ensure-coordinator-node'),
    join(root, 'bin', 'ensure-coordinator-node')
  );
  chmodSync(join(root, 'bin', 'ensure-coordinator-node'), 0o755);
  writeFileSync(join(root, 'package.json'), STUB_PACKAGE_JSON);
  if (opts.srcCoordinatorTs !== undefined) {
    writeFileSync(join(root, 'tsconfig.json'), STUB_TSCONFIG);
    mkdirSync(join(root, 'src'), { recursive: true });
    writeFileSync(join(root, 'src', 'coordinator.ts'), opts.srcCoordinatorTs);
  }
  if (opts.withTsc) {
    symlinkSync(join(PLUGIN_ROOT, 'node_modules'), join(root, 'node_modules'), 'dir');
  }
  if (opts.prebuiltDistJs !== undefined) {
    mkdirSync(join(root, 'dist'), { recursive: true });
    writeFileSync(join(root, 'dist', 'coordinator.js'), opts.prebuiltDistJs);
  }
  return root;
}

function runBootstrap(root: string, data: string, ws: string) {
  return spawnSync('bash', [join(root, 'bin', 'ensure-coordinator-node')], {
    cwd: ws,
    encoding: 'utf8',
    timeout: 120000,
    env: {
      ...process.env,
      CLAUDE_PLUGIN_ROOT: root,
      CLAUDE_PLUGIN_DATA: data,
    } as NodeJS.ProcessEnv,
  });
}

/** Kill the detached coordinator a successful bootstrap left running. */
function killSpawned(stderr: string): void {
  const m = /spawned Node coordinator \(pid=(\d+)/.exec(stderr);
  if (m) {
    try {
      process.kill(Number(m[1]), 'SIGKILL');
    } catch {
      // already exited
    }
  }
}

function makeDirs(): { data: string; ws: string; cleanup: () => void } {
  const data = mkdtempSync(join(tmpdir(), 'provision-data-'));
  const ws = mkdtempSync(join(tmpdir(), 'provision-ws-'));
  return {
    data,
    ws,
    cleanup: () => {
      // maxRetries absorbs the window between SIGKILL and the OS releasing
      // the daemon's open log handle (same pattern as zero_python_smoke).
      rmSync(data, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
      rmSync(ws, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    },
  };
}

test('REGRESSION: dist-less package (marketplace clone) self-builds src/ and spawns a LIVE coordinator', () => {
  const root = makeStubRoot({ srcCoordinatorTs: HEALTHY_COORDINATOR_TS, withTsc: true });
  const { data, ws, cleanup } = makeDirs();
  try {
    const r = runBootstrap(root, data, ws);
    try {
      assert.equal(r.status, 0, `bootstrap failed:\n${r.stdout}\n${r.stderr}`);
      assert.match(r.stderr, /building src\//);
      assert.ok(
        existsSync(join(data, 'dist', 'coordinator.js')),
        'built entry must exist in PLUGIN_DATA'
      );
      const m = /spawned Node coordinator \(pid=(\d+)/.exec(r.stderr);
      assert.ok(m, `no spawn line in stderr:\n${r.stderr}`);
      // The bootstrap's own liveness gate passed; the pid must still be up.
      assert.doesNotThrow(() => process.kill(Number(m[1]), 0));
      // First successful provision of a VIRGIN workspace stamps the backend,
      // so the dispatcher's state.db guard can't reroute session 2 to python.
      assert.equal(
        readFileSync(join(ws, '.coherence', 'coordinator_backend'), 'utf8').trim(),
        'node'
      );
    } finally {
      killSpawned(r.stderr ?? '');
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
    cleanup();
  }
});

test('provisioning is keyed: an unchanged package skips the rebuild and just spawns', () => {
  const root = makeStubRoot({ srcCoordinatorTs: HEALTHY_COORDINATOR_TS, withTsc: true });
  const { data, ws, cleanup } = makeDirs();
  try {
    const first = runBootstrap(root, data, ws);
    killSpawned(first.stderr ?? '');
    assert.equal(first.status, 0, `first bootstrap failed:\n${first.stdout}\n${first.stderr}`);
    assert.match(first.stderr, /building src\//);

    const second = runBootstrap(root, data, ws);
    try {
      assert.equal(
        second.status,
        0,
        `second bootstrap failed:\n${second.stdout}\n${second.stderr}`
      );
      // Same package.json + entry already built → no install, no rebuild.
      assert.doesNotMatch(second.stderr, /installing Node deps/);
      assert.doesNotMatch(second.stderr, /building src\//);
      assert.match(second.stderr, /spawned Node coordinator/);
    } finally {
      killSpawned(second.stderr ?? '');
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
    cleanup();
  }
});

test("LOUD FAIL: dist-less package with no tsc anywhere → exit 1, actionable stderr, NO false 'spawned'", () => {
  const root = makeStubRoot({ srcCoordinatorTs: HEALTHY_COORDINATOR_TS, withTsc: false });
  const { data, ws, cleanup } = makeDirs();
  try {
    const r = runBootstrap(root, data, ws);
    assert.equal(r.status, 1, `expected loud failure:\n${r.stdout}\n${r.stderr}`);
    assert.match(r.stderr, /no dist\/ and no tsc/);
    assert.match(r.stderr, /coordinator will not start this session/);
    assert.doesNotMatch(r.stderr, /spawned Node coordinator/);
  } finally {
    rmSync(root, { recursive: true, force: true });
    cleanup();
  }
});

test("LIVENESS GATE: a coordinator that dies on boot → exit 1 with a log excerpt, NO false 'spawned'", () => {
  const root = makeStubRoot({ srcCoordinatorTs: CRASHING_COORDINATOR_TS, withTsc: true });
  const { data, ws, cleanup } = makeDirs();
  try {
    const r = runBootstrap(root, data, ws);
    assert.equal(r.status, 1, `expected loud failure:\n${r.stdout}\n${r.stderr}`);
    assert.match(r.stderr, /exited immediately after spawn/);
    // The crash log tail is surfaced so the failure is diagnosable from the
    // hook output alone.
    assert.match(r.stderr, /stub coordinator crash on boot/);
    assert.doesNotMatch(r.stderr, /spawned Node coordinator/);
    // A FAILED boot must not stamp the workspace as node-backed.
    assert.equal(existsSync(join(ws, '.coherence', 'coordinator_backend')), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
    cleanup();
  }
});

test('dev-checkout shape: a package WITH dist/ is mirrored (no build) and spawns', () => {
  const root = makeStubRoot({ prebuiltDistJs: HEALTHY_PREBUILT_JS });
  const { data, ws, cleanup } = makeDirs();
  try {
    // An ESTABLISHED store (state.db predates this boot) must not be claimed
    // for node — it may be Python-owned; the default-flip guard decides.
    mkdirSync(join(ws, '.coherence'), { recursive: true });
    writeFileSync(join(ws, '.coherence', 'state.db'), '');
    const r = runBootstrap(root, data, ws);
    try {
      assert.equal(r.status, 0, `bootstrap failed:\n${r.stdout}\n${r.stderr}`);
      assert.ok(
        existsSync(join(data, 'dist', 'coordinator.js')),
        'mirrored entry must exist in PLUGIN_DATA'
      );
      assert.doesNotMatch(r.stderr, /building src\//);
      assert.match(r.stderr, /spawned Node coordinator/);
      assert.equal(existsSync(join(ws, '.coherence', 'coordinator_backend')), false);
    } finally {
      killSpawned(r.stderr ?? '');
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
    cleanup();
  }
});

test("an operator's existing coordinator_backend file is never overwritten by the stamp", () => {
  const root = makeStubRoot({ prebuiltDistJs: HEALTHY_PREBUILT_JS });
  const { data, ws, cleanup } = makeDirs();
  try {
    // Virgin store, but the operator already selected python (this bootstrap
    // still runs when e.g. COHERENCE_COORDINATOR_BACKEND=node overrides it).
    mkdirSync(join(ws, '.coherence'), { recursive: true });
    writeFileSync(join(ws, '.coherence', 'coordinator_backend'), 'python\n');
    const r = runBootstrap(root, data, ws);
    try {
      assert.equal(r.status, 0, `bootstrap failed:\n${r.stdout}\n${r.stderr}`);
      assert.match(r.stderr, /spawned Node coordinator/);
      assert.equal(readFileSync(join(ws, '.coherence', 'coordinator_backend'), 'utf8'), 'python\n');
    } finally {
      killSpawned(r.stderr ?? '');
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
    cleanup();
  }
});

test('hook-client resolves the PLUGIN_DATA-provisioned Node client on a dist-less package', () => {
  const root = mkdtempSync(join(tmpdir(), 'provision-root-'));
  const { data, ws, cleanup } = makeDirs();
  try {
    mkdirSync(join(root, 'bin'), { recursive: true });
    cpSync(join(PLUGIN_ROOT, 'bin', 'hook-client'), join(root, 'bin', 'hook-client'));
    chmodSync(join(root, 'bin', 'hook-client'), 0o755);
    // What ensure-coordinator-node's provision leaves behind.
    mkdirSync(join(data, 'dist'), { recursive: true });
    writeFileSync(
      join(data, 'dist', 'hook_client.js'),
      'process.stdout.write(JSON.stringify({ marker: "data-client" }));\n'
    );

    const run = () =>
      spawnSync('bash', [join(root, 'bin', 'hook-client'), 'pre-read'], {
        cwd: ws,
        encoding: 'utf8',
        input: '{}',
        timeout: 30000,
        env: {
          ...process.env,
          CLAUDE_PLUGIN_ROOT: root,
          CLAUDE_PLUGIN_DATA: data,
        } as NodeJS.ProcessEnv,
      });

    // Marketplace shape: no ROOT dist → the DATA client is the only one.
    const viaData = run();
    assert.equal(viaData.status, 0);
    assert.match(viaData.stdout, /"marker":"data-client"/);

    // Dev-checkout shape: the package's own dist/ wins over the DATA copy.
    mkdirSync(join(root, 'dist'), { recursive: true });
    writeFileSync(
      join(root, 'dist', 'hook_client.js'),
      'process.stdout.write(JSON.stringify({ marker: "root-client" }));\n'
    );
    const viaRoot = run();
    assert.equal(viaRoot.status, 0);
    assert.match(viaRoot.stdout, /"marker":"root-client"/);
  } finally {
    rmSync(root, { recursive: true, force: true });
    cleanup();
  }
});

test('CLI shim resolves the PLUGIN_DATA-provisioned Node CLI on a dist-less package', () => {
  const root = mkdtempSync(join(tmpdir(), 'provision-root-'));
  const { data, ws, cleanup } = makeDirs();
  try {
    mkdirSync(join(root, 'bin'), { recursive: true });
    cpSync(
      join(PLUGIN_ROOT, 'bin', 'agent-coherence-status'),
      join(root, 'bin', 'agent-coherence-status')
    );
    chmodSync(join(root, 'bin', 'agent-coherence-status'), 0o755);
    mkdirSync(join(data, 'dist'), { recursive: true });
    writeFileSync(
      join(data, 'dist', 'cli_status.js'),
      'process.stdout.write("data-cli-status");\n'
    );

    const r = spawnSync('bash', [join(root, 'bin', 'agent-coherence-status')], {
      cwd: ws,
      encoding: 'utf8',
      timeout: 30000,
      env: {
        ...process.env,
        CLAUDE_PLUGIN_ROOT: root,
        CLAUDE_PLUGIN_DATA: data,
      } as NodeJS.ProcessEnv,
    });
    assert.equal(r.status, 0, `shim failed:\n${r.stdout}\n${r.stderr}`);
    assert.match(r.stdout, /data-cli-status/);
  } finally {
    rmSync(root, { recursive: true, force: true });
    cleanup();
  }
});
