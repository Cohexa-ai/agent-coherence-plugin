/**
 * Node coordinator entry point.
 *
 * Wires ensureSecret + HTTP server. Listens on an ephemeral port on
 * 127.0.0.1; writes <pid>\n<port>\nbackend=node\n to
 * <workspace>/.coherence/server.pid for hook clients to discover.
 *
 * v0.1.1 Unit 1 (this commit) lands the minimal startup path:
 *   - resolve workspace root (env var, fallback to CWD)
 *   - ensure .coherence/ dir + hook.secret
 *   - start HTTP server on ephemeral port (R21 body cap + auth wired)
 *   - write server.pid with 3-line format (KTD-A.5 point 1 backend field)
 *   - graceful shutdown on SIGINT/SIGTERM (removes server.pid; closes server)
 *
 * NOT in this commit (deferred to subsequent Unit 1 commits / Unit 2):
 *   - fcntl flock on server.pid (KTD-A.5 mutex enforcement)
 *   - lifecycle: idle-shutdown, race-safe spawn-or-join
 *   - SQLite registry + migration runner (Unit 2)
 *   - /status three-tier (KTD-K)
 *   - hook handler routes (Unit 3)
 */
import { mkdirSync, writeFileSync, unlinkSync } from "node:fs";
import { join, resolve } from "node:path";
import { hostname } from "node:os";
import { ensureSecret } from "./auth.js";
import { createServer, BIND_HOST } from "./server.js";

const VERSION = "0.1.1-alpha.1";

interface Workspace {
  root: string;
  coherenceDir: string;
  pidFile: string;
  portFile: string;
}

function resolveWorkspace(): Workspace {
  const root = resolve(process.env["AGENT_COHERENCE_WORKSPACE"] ?? process.cwd());
  const coherenceDir = join(root, ".coherence");
  return {
    root,
    coherenceDir,
    pidFile: join(coherenceDir, "server.pid"),
    portFile: join(coherenceDir, "server.port"),
  };
}

function writePidFile(pidFile: string, pid: number, port: number, backend: "node"): void {
  // 3-line format: extends v0.1's <pid>\n<port>\n with a backend= field per
  // KTD-A.5 point 1. Python's read_port_from_file picks line 2 as port and
  // ignores subsequent lines for backwards compatibility; v0.1.1 Python
  // coordinator (Unit 6) gains backend-discrimination via the third line.
  const payload = `${pid}\n${port}\nbackend=${backend}\n`;
  writeFileSync(pidFile, payload, { mode: 0o600 });
}

function writePortFile(portFile: string, port: number): void {
  // Mirror Python coordinator's <workspace>/.coherence/server.port (single-line port).
  writeFileSync(portFile, `${port}\n`, { mode: 0o600 });
}

function logInfo(message: string): void {
  // Stderr-only logging per Claude Code hook conventions; stdout is reserved
  // for hook response JSON (when invoked as a hook command). The coordinator
  // process itself is long-running, so stdout/stderr both go to the operator's
  // log surface — but stderr is the conventional channel.
  process.stderr.write(`agent-coherence-coordinator: ${message}\n`);
}

async function main(): Promise<void> {
  const startedAtMs = Date.now();
  const workspace = resolveWorkspace();

  mkdirSync(workspace.coherenceDir, { recursive: true, mode: 0o700 });
  const secret = ensureSecret(workspace.coherenceDir);

  const server = createServer({
    secret,
    startedAtMs,
    version: VERSION,
  });

  // Bind to ephemeral port on loopback. Per KTD-A.5 + Open Questions:
  // BIND_HOST = "127.0.0.1" is a code-level invariant; no operator override.
  server.listen(0, BIND_HOST, () => {
    const address = server.address();
    if (address === null || typeof address === "string") {
      throw new Error(`unexpected server address shape: ${String(address)}`);
    }
    const port = address.port;

    writePidFile(workspace.pidFile, process.pid, port, "node");
    writePortFile(workspace.portFile, port);

    logInfo(`spawned at ${BIND_HOST}:${port} (pid=${process.pid}, host=${hostname()})`);
    logInfo(`workspace=${workspace.root}; pid_file=${workspace.pidFile}`);
  });

  // Graceful shutdown. Removes pid+port files so peer hook clients see no
  // stale references; closes the HTTP server (in-flight requests get drained
  // by Node's default close-on-idle behavior — Unit 5 lands the explicit
  // in-flight semaphore drain per KTD-I).
  const shutdown = (signal: NodeJS.Signals): void => {
    logInfo(`shutting down on ${signal}`);
    try {
      unlinkSync(workspace.pidFile);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
        logInfo(`unlink pidFile failed: ${String(err)}`);
      }
    }
    try {
      unlinkSync(workspace.portFile);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
        logInfo(`unlink portFile failed: ${String(err)}`);
      }
    }
    server.close((closeErr) => {
      if (closeErr !== undefined) {
        logInfo(`server.close error: ${String(closeErr)}`);
        process.exit(1);
      }
      process.exit(0);
    });
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err: unknown) => {
  process.stderr.write(`agent-coherence-coordinator: fatal: ${String(err)}\n`);
  process.exit(1);
});
