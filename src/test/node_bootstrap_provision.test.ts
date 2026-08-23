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

// The exact crash a Node-major change produces once node_modules holds a
// binary built for the previous ABI — the failure this file's ABI-stamp
// tests exist to make self-healing.
const ABI_CRASH_COORDINATOR_TS =
  "throw new Error(\"The module '/x/better_sqlite3.node' was compiled against a " +
  'different Node.js version using NODE_MODULE_VERSION 131. This version of Node.js ' +
  'requires NODE_MODULE_VERSION 137.");\n';

/** The ABI the running node binds native addons to — what the stamp records. */
const RUNNING_ABI = process.versions.modules;
const ABI_STAMP = '.node-abi';

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
      // Same package.json, same ABI, entry already built → no install, no
      // rebuild. The ABI key must not turn every session into a reinstall.
      assert.doesNotMatch(second.stderr, /installing Node deps/);
      assert.doesNotMatch(second.stderr, /building src\//);
      assert.doesNotMatch(second.stderr, /Node ABI changed/);
      assert.match(second.stderr, /spawned Node coordinator/);
      assert.equal(readFileSync(join(data, ABI_STAMP), 'utf8').trim(), RUNNING_ABI);
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
    // ...but a crash with no NODE_MODULE_VERSION in it is NOT an ABI problem,
    // so the ABI stamp must survive. Invalidating it on any crash would turn
    // an ordinary coordinator bug into a full npm reinstall every session.
    assert.equal(readFileSync(join(data, ABI_STAMP), 'utf8').trim(), RUNNING_ABI);
    assert.doesNotMatch(r.stderr, /next session reprovisions/);
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

test('ABI STAMP: a successful provision records the running Node ABI', () => {
  const root = makeStubRoot({ srcCoordinatorTs: HEALTHY_COORDINATOR_TS, withTsc: true });
  const { data, ws, cleanup } = makeDirs();
  try {
    const r = runBootstrap(root, data, ws);
    try {
      assert.equal(r.status, 0, `bootstrap failed:\n${r.stdout}\n${r.stderr}`);
      // process.versions.modules — NOT the Node version. A binary is bound to
      // the ABI, and two Node majors can share one (as 24 and 25 nearly did).
      assert.equal(readFileSync(join(data, ABI_STAMP), 'utf8').trim(), RUNNING_ABI);
    } finally {
      killSpawned(r.stderr ?? '');
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
    cleanup();
  }
});

test('REGRESSION: a Node-major change (stale ABI stamp) forces a CLEAN reinstall', () => {
  const root = makeStubRoot({ srcCoordinatorTs: HEALTHY_COORDINATOR_TS, withTsc: true });
  const { data, ws, cleanup } = makeDirs();
  try {
    const first = runBootstrap(root, data, ws);
    killSpawned(first.stderr ?? '');
    assert.equal(first.status, 0, `first bootstrap failed:\n${first.stdout}\n${first.stderr}`);

    // Stand in for the tree a previous Node major left behind: node_modules
    // present, holding a binary compiled for ABI 131 (Node 23). The sentinel
    // is the load-bearing part — a plain `npm install` over this tree leaves
    // it untouched, because npm sees a satisfying version already installed,
    // which is exactly how the 0.3.1 -> 0.4.0 bump shipped a stale binary to
    // a Node 24 user. Only a teardown removes it.
    const sentinel = join(data, 'node_modules', 'STALE-ABI-131-ARTIFACT');
    mkdirSync(join(data, 'node_modules'), { recursive: true });
    writeFileSync(sentinel, 'compiled for NODE_MODULE_VERSION 131\n');
    writeFileSync(join(data, ABI_STAMP), '131\n');

    const second = runBootstrap(root, data, ws);
    try {
      assert.equal(
        second.status,
        0,
        `second bootstrap failed:\n${second.stdout}\n${second.stderr}`
      );
      assert.match(second.stderr, new RegExp(`Node ABI changed \\(131 -> ${RUNNING_ABI}\\)`));
      assert.match(second.stderr, /installing Node deps/);
      assert.equal(
        existsSync(sentinel),
        false,
        'stale node_modules must be torn down, not installed over'
      );
      assert.equal(readFileSync(join(data, ABI_STAMP), 'utf8').trim(), RUNNING_ABI);
      assert.match(second.stderr, /spawned Node coordinator/);
    } finally {
      killSpawned(second.stderr ?? '');
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
    cleanup();
  }
});

test('a stamp left behind by a hand-deleted node_modules does not vouch for the missing tree', () => {
  const root = makeStubRoot({ srcCoordinatorTs: HEALTHY_COORDINATOR_TS, withTsc: true });
  const { data, ws, cleanup } = makeDirs();
  try {
    const first = runBootstrap(root, data, ws);
    killSpawned(first.stderr ?? '');
    assert.equal(first.status, 0, `first bootstrap failed:\n${first.stdout}\n${first.stderr}`);

    // A CURRENT-ABI stamp over a tree that isn't there. Reading the stamp
    // without checking the tree would take the fast path and spawn straight
    // into a MODULE_NOT_FOUND crash loop.
    rmSync(join(data, 'node_modules'), { recursive: true, force: true });
    writeFileSync(join(data, ABI_STAMP), `${RUNNING_ABI}\n`);

    const second = runBootstrap(root, data, ws);
    try {
      assert.equal(
        second.status,
        0,
        `second bootstrap failed:\n${second.stdout}\n${second.stderr}`
      );
      assert.match(second.stderr, /spawned Node coordinator/);
      assert.equal(readFileSync(join(data, ABI_STAMP), 'utf8').trim(), RUNNING_ABI);
    } finally {
      killSpawned(second.stderr ?? '');
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
    cleanup();
  }
});

test('SELF-HEAL: a NODE_MODULE_VERSION crash invalidates the stamp so the next session reprovisions', () => {
  const root = makeStubRoot({ srcCoordinatorTs: ABI_CRASH_COORDINATOR_TS, withTsc: true });
  const { data, ws, cleanup } = makeDirs();
  try {
    const r = runBootstrap(root, data, ws);
    assert.equal(r.status, 1, `expected loud failure:\n${r.stdout}\n${r.stderr}`);
    assert.match(r.stderr, /exited immediately after spawn/);
    assert.doesNotMatch(r.stderr, /spawned Node coordinator/);
    // The stamp vouched for a tree that cannot load. Dropping it is what
    // turns "dead until the user figures it out" into one bad session: the
    // next run finds no stamp, probes, and reinstalls.
    assert.match(r.stderr, /next session reprovisions/);
    assert.equal(existsSync(join(data, ABI_STAMP)), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
    cleanup();
  }
});

test('STAGE 2: a src/ change with no package.json change still rebuilds dist/', () => {
  const root = makeStubRoot({ srcCoordinatorTs: HEALTHY_COORDINATOR_TS, withTsc: true });
  const { data, ws, cleanup } = makeDirs();
  try {
    const first = runBootstrap(root, data, ws);
    killSpawned(first.stderr ?? '');
    assert.equal(first.status, 0, `first bootstrap failed:\n${first.stdout}\n${first.stderr}`);
    assert.match(first.stderr, /building src\//);

    // A plugin update that touches src/ without bumping the version — the
    // same shape as the ABI bug: package.json is a proxy, and keying only on
    // it serves the OLD dist/ forever.
    writeFileSync(
      join(root, 'src', 'coordinator.ts'),
      `${HEALTHY_COORDINATOR_TS}const marker = "SECOND-REVISION";\nvoid marker;\n`
    );

    const second = runBootstrap(root, data, ws);
    try {
      assert.equal(
        second.status,
        0,
        `second bootstrap failed:\n${second.stdout}\n${second.stderr}`
      );
      assert.match(second.stderr, /building src\//);
      assert.doesNotMatch(second.stderr, /installing Node deps/);
      assert.match(readFileSync(join(data, 'dist', 'coordinator.js'), 'utf8'), /SECOND-REVISION/);
    } finally {
      killSpawned(second.stderr ?? '');
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
