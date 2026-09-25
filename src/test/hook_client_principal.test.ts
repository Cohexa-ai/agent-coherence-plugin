/**
 * Caller principal through the REAL hook client binary (library
 * caller-principal plan, U5). The Python coordinator mints a principal per session and
 * requires it on its require-class routes; this Node coordinator issues none
 * (404 on the claim) and ignores the header (plan KTD12).
 *
 * What the principal buys on the hook surface is convention-enforcement and a
 * detectable unbound caller: the client stores it under `.coherence/`, so any
 * process that can read that directory can present it for any session. None
 * of these tests claim caller separation between processes of one OS user.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { spawn } from 'node:child_process';
import { createServer as createHttpServer, type IncomingMessage, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AddressInfo } from 'node:net';
import { ArtifactRegistry } from '../registry.js';
import { PolicyRef } from '../policy.js';
import { SessionRegistry } from '../sessions.js';
import { createServer } from '../server.js';
import { sessionToAgentId } from '../agent_id.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const HOOK_CLIENT_JS = join(HERE, '..', 'hook_client.js');
/** FROZEN duplicate of the wire name — never imported from the code under test. */
const HEADER = 'coherence-caller-principal'; // node lowercases incoming header names
const SID = '66666666-6666-4666-8666-666666666666';
const SECRET = 's'.repeat(32);
const MINTED = 'P'.repeat(43); // a principal-shaped value a fake coordinator hands out

interface Recorded {
  url: string;
  principal: string | undefined;
  body: Record<string, unknown>;
}

function makeWorkspace(): string {
  const root = mkdtempSync(join(tmpdir(), 'principal-test-'));
  mkdirSync(join(root, '.coherence'), { recursive: true, mode: 0o700 });
  writeFileSync(join(root, '.coherence', 'hook.secret'), `${SECRET}\n`);
  return root;
}

function filesFor(root: string, sessionId: string): { nonce: string; principal: string } {
  const key = sessionToAgentId(sessionId);
  return {
    nonce: join(root, '.coherence', `caller-principal-${key}.nonce`),
    principal: join(root, '.coherence', `caller-principal-${key}.principal`),
  };
}

async function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const text = Buffer.concat(chunks).toString('utf8');
  return text === '' ? {} : (JSON.parse(text) as Record<string, unknown>);
}

/** A stand-in for a principal-issuing (Python) coordinator: scripted claim and hook answers, every request recorded. */
async function fakeCoordinator(
  root: string,
  answer: (url: string, body: Record<string, unknown>) => { status: number; body: unknown }
): Promise<{ server: Server; seen: Recorded[] }> {
  const seen: Recorded[] = [];
  const server = createHttpServer((req, res) => {
    void readBody(req).then((body) => {
      const principal = req.headers[HEADER];
      seen.push({
        url: req.url ?? '',
        principal: typeof principal === 'string' ? principal : undefined,
        body,
      });
      const out = answer(req.url ?? '', body);
      const payload = JSON.stringify(out.body);
      res.writeHead(out.status, {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
      });
      res.end(payload);
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const port = (server.address() as AddressInfo).port;
  writeFileSync(join(root, '.coherence', 'server.pid'), `${process.pid}\n${port}\n`);
  return { server, seen };
}

function runClient(
  args: string[],
  stdin: string,
  cwd: string
): Promise<{ stdout: string; stderr: string; status: number | null }> {
  return new Promise((resolveRun) => {
    const child = spawn(process.execPath, [HOOK_CLIENT_JS, ...args], {
      cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c: Buffer) => (stdout += c.toString('utf8')));
    child.stderr.on('data', (c: Buffer) => (stderr += c.toString('utf8')));
    child.on('close', (status) => resolveRun({ stdout, stderr, status }));
    child.stdin.write(stdin);
    child.stdin.end();
  });
}

function postEditPayload(root: string, sessionId: string = SID): string {
  writeFileSync(join(root, 'plan.md'), 'plan v2');
  return JSON.stringify({
    session_id: sessionId,
    tool_input: { file_path: join(root, 'plan.md') },
  });
}

const close = (server: Server): Promise<void> => new Promise((r) => server.close(() => r()));

// ------------------------------------------- against a principal-issuing coordinator

test('claim once, then present: the principal is persisted and every later hook sends it without claiming again', async () => {
  const root = makeWorkspace();
  const { server, seen } = await fakeCoordinator(root, (url) =>
    url === '/principal/claim'
      ? { status: 200, body: { ok: true, principal: MINTED } }
      : { status: 200, body: { ok: true } }
  );
  try {
    const first = await runClient(['post-edit', '--root', root], postEditPayload(root), root);
    const second = await runClient(
      ['session-stop', '--root', root],
      JSON.stringify({ session_id: SID }),
      root
    );
    assert.equal(first.status, 0);
    assert.equal(second.status, 0);
    assert.deepEqual(
      seen.map((r) => [r.url, r.principal]),
      [
        ['/principal/claim', undefined],
        ['/hooks/post-edit', MINTED],
        ['/hooks/session-stop', MINTED],
      ]
    );
    const { nonce, principal } = filesFor(root, SID);
    // The nonce on the wire is the one persisted BEFORE the claim was sent.
    assert.equal(seen[0]!.body.mint_nonce, readFileSync(nonce, 'utf8').trim());
    assert.equal(seen[0]!.body.session_id, SID);
    assert.equal(readFileSync(principal, 'utf8').trim(), MINTED);
    assert.equal(statSync(principal).mode & 0o777, 0o600);
  } finally {
    await close(server);
    rmSync(root, { recursive: true, force: true });
  }
});

test('a refused claim is reported and NOT re-minted: nothing stored, the nonce left in place, no header sent', async () => {
  const root = makeWorkspace();
  const { server, seen } = await fakeCoordinator(root, (url) =>
    url === '/principal/claim'
      ? { status: 200, body: { ok: false, reason: 'caller_principal_claimed', detail: 'bound' } }
      : { status: 200, body: { ok: true } }
  );
  try {
    const run = await runClient(['pre-edit', '--root', root], postEditPayload(root), root);
    const { nonce, principal } = filesFor(root, SID);
    const nonceBefore = readFileSync(nonce, 'utf8');
    const again = await runClient(['pre-edit', '--root', root], postEditPayload(root), root);
    assert.equal(run.status, 0);
    assert.match(run.stderr, /caller principal refused: .*NOT re-minting/);
    assert.equal(again.status, 0);
    assert.ok(!existsSync(principal), 'a refused claim stores nothing');
    assert.equal(readFileSync(nonce, 'utf8'), nonceBefore, 'the nonce is never replaced');
    const claims = seen.filter((r) => r.url === '/principal/claim');
    assert.equal(
      new Set(claims.map((r) => r.body.mint_nonce)).size,
      1,
      'every retry presents the SAME nonce'
    );
    assert.ok(
      seen.filter((r) => r.url === '/hooks/pre-edit').every((r) => r.principal === undefined)
    );
  } finally {
    await close(server);
    rmSync(root, { recursive: true, force: true });
  }
});

test('a foreign-principal refusal is reported; the stored principal stays and nothing is re-claimed; stdout is {}', async () => {
  const root = makeWorkspace();
  const refusal =
    'the Coherence-Caller-Principal header is not the caller principal bound to the session_id this request names (caller_principal_foreign)';
  const { server, seen } = await fakeCoordinator(root, (url) =>
    url === '/hooks/post-edit'
      ? { status: 400, body: { error: refusal } }
      : { status: 200, body: { ok: true } }
  );
  try {
    const { principal } = filesFor(root, SID);
    const stale = 'Q'.repeat(43);
    writeFileSync(principal, `${stale}\n`, { mode: 0o600 });
    const run = await runClient(['post-edit', '--root', root], postEditPayload(root), root);
    assert.equal(run.status, 0);
    assert.equal(run.stdout.trim(), '{}');
    assert.ok(run.stderr.includes(refusal), run.stderr);
    assert.equal(
      readFileSync(principal, 'utf8').trim(),
      stale,
      'the stored principal is left in place'
    );
    assert.deepEqual(
      seen.map((r) => [r.url, r.principal]),
      [['/hooks/post-edit', stale]],
      'no claim, no retry'
    );
  } finally {
    await close(server);
    rmSync(root, { recursive: true, force: true });
  }
});

// ------------------------------------------------ against THIS (Node) coordinator

async function nodeCoordinator(
  root: string
): Promise<{ server: Server; registry: ArtifactRegistry; seen: Recorded[] }> {
  const registry = new ArtifactRegistry(join(root, '.coherence', 'state.db'));
  const server = createServer({
    secret: SECRET,
    startedAtMs: Date.now(),
    version: 'test',
    registry,
    policy: PolicyRef.load(root),
    sessions: new SessionRegistry(),
  });
  const seen: Recorded[] = [];
  server.on('request', (req: IncomingMessage) => {
    const principal = req.headers[HEADER];
    seen.push({
      url: req.url ?? '',
      principal: typeof principal === 'string' ? principal : undefined,
      body: {},
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const port = (server.address() as AddressInfo).port;
  writeFileSync(join(root, '.coherence', 'server.pid'), `${process.pid}\n${port}\nbackend=node\n`);
  return { server, registry, seen };
}

test('against the Node coordinator (backend=node pid file) the hook sends NO claim and NO header, as before', async () => {
  const root = makeWorkspace();
  const { server, registry, seen } = await nodeCoordinator(root);
  try {
    const cc = JSON.stringify({ session_id: SID });
    const run = await runClient(['session-stop', '--root', root], cc, root);
    assert.equal(run.status, 0);
    assert.deepEqual(JSON.parse(run.stdout), { ok: true, released_artifacts: [] });
    assert.equal(run.stderr, '', 'a coordinator that issues no principals is not an error');
    assert.deepEqual(
      seen.map((r) => [r.url, r.principal]),
      [['/hooks/session-stop', undefined]],
      'one request per hook: no 404 round trip on every event'
    );
    const { nonce, principal } = filesFor(root, SID);
    assert.ok(!existsSync(nonce) && !existsSync(principal), 'nothing is created or stored');
  } finally {
    await close(server);
    registry.close();
    rmSync(root, { recursive: true, force: true });
  }
});

for (const [label, backendLine, claims] of [
  ['the Python coordinator format (no backend line)', '', true],
  ['backend=python', 'backend=python\n', true],
  ['backend=node', 'backend=node\n', false],
] as const) {
  test(`pid file with ${label}: ${claims ? 'claims, and a 404 still means no header' : 'no claim at all'}`, async () => {
    const root = makeWorkspace();
    const { server, seen } = await fakeCoordinator(root, (url) =>
      url === '/principal/claim'
        ? { status: 404, body: { error: 'not found' } }
        : { status: 200, body: { ok: true } }
    );
    try {
      const pidFile = join(root, '.coherence', 'server.pid');
      writeFileSync(pidFile, readFileSync(pidFile, 'utf8') + backendLine);
      const run = await runClient(['post-edit', '--root', root], postEditPayload(root), root);
      assert.equal(run.status, 0);
      assert.deepEqual(JSON.parse(run.stdout), { ok: true });
      const expected: Array<[string, string | undefined]> = claims
        ? [
            ['/principal/claim', undefined],
            ['/hooks/post-edit', undefined],
          ]
        : [['/hooks/post-edit', undefined]];
      assert.deepEqual(
        seen.map((r) => [r.url, r.principal]),
        expected
      );
      assert.equal(existsSync(filesFor(root, SID).nonce), claims, 'nonce file');
    } finally {
      await close(server);
      rmSync(root, { recursive: true, force: true });
    }
  });
}

test('the Node coordinator does not refuse on a principal (KTD12): an unknown one is ignored, the answer unchanged', async () => {
  const root = makeWorkspace();
  const { server, registry } = await nodeCoordinator(root);
  try {
    const port = (server.address() as AddressInfo).port;
    const post = async (headers: Record<string, string>): Promise<[number, unknown]> => {
      const r = await fetch(`http://127.0.0.1:${port}/hooks/session-stop`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${SECRET}`,
          Host: '127.0.0.1',
          'Content-Type': 'application/json',
          ...headers,
        },
        body: JSON.stringify({ session_id: SID }),
      });
      return [r.status, await r.json()];
    };
    const without = await post({});
    const withForeign = await post({ 'Coherence-Caller-Principal': 'R'.repeat(43) });
    assert.deepEqual(withForeign, without);
    assert.equal(without[0], 200);
  } finally {
    await close(server);
    registry.close();
    rmSync(root, { recursive: true, force: true });
  }
});
