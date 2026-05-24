# v0.2.0 broad-beta launch announcement

**Single source of truth** for the v0.2.0 broad-beta launch communication. Operator copies sections verbatim into:

1. The GitHub Release body for `v0.2.0` (the curated callout block alongside the auto-generated release notes)
2. The `agent-coherence.dev/plugin/` landing-page hero + mechanism section
3. Any operator-driven social posts (LinkedIn / X / community Discords)

Maintaining one source prevents cross-surface drift. Per `docs/BROAD_BETA.md` BB8, the landing page must reflect this within 1h of tag push.

---

## Headline (≤ 80 chars)

> agent-coherence v0.2 — strict mode, open broad beta on the Claude Code marketplace.

## Sub-headline (≤ 160 chars)

> Per-artifact opt-in `permissionDecision: "deny"` on stale reads across 5 hooked tool surfaces. Multi-model validated on haiku, sonnet, opus.

---

## Release body — top section (≤ 500 words)

**What v0.2 ships**

Per-artifact strict-mode opt-in via `.coherence/strict_mode.yaml`. Tracked artifacts opted into strict mode receive `permissionDecision: "deny"` on stale-read attempts across all 5 hooked tool surfaces — Read, Edit, Write, Bash, Grep. Operators who want hard guardrails on specific artifacts (typically: long-running CI workflows, multi-developer specs, security-sensitive runbooks) now have them; warn-mode behavior is preserved byte-identical for every artifact not explicitly opted in.

The 5-handler surface closes the Phase 0 H4 routing-around-Read finding: when a Read deny fires, the model retries 2-5 times and then routes around via `bash cat <file>`. Without Bash + Grep hook coverage, that bypass is silent. The plugin now covers the full surface.

**Why the deny text is byte-stable across retries**

Phase 0 falsifiability experiment (2026-05-19) inverted the original hypothesis. Varied deny prose was supposed to bound model retries; it actually WORSENS opus (5 retries vs 2 with static text, because opus reads varied text as prompt-injection patterns and retries to disambiguate). v0.2 deny reasons are static and byte-identical across retries per KTD-P. The model exits the retry loop on its own.

**Security invariant: `TERMINAL_DENIAL_CLASSES`**

Every code path that emits `permissionDecision: "allow"` routes through a single `emit_allow()` helper that refuses to convert strict-mode denials. An AST-based meta-test grep-counts allow-emission call sites and forces a parameter-list extension on every new path. A future contributor cannot silently weaken the strict-mode boundary.

**`agent-coherence-migrate-deny` — security-hardened helper**

Stricter sibling to v0.1.1's `agent-coherence-migrate-rules`. STDOUT-only (never writes settings.json), symlink-contained (canonical-path containment check refuses CLAUDE.md / AGENTS.md whose realpath escapes the workspace root), never invokes an LLM, under-emit bias (only canonical phrasings trigger). For security-sensitive workspaces that need the migration translation surface without the auto-apply risk.

**Telemetry + denial-only audit log**

Three new counters in `/status?detail=metrics`: `strict_mode_denials_total`, `strict_mode_routed_around_via_bash_total` (Phase 0 H4 routing-pattern detector with 30s window), `audit_log_mode_drift_total`. Minimal denial-only JSONL at `.coherence/audit.log` (mode 0o600, no command bodies, no user content, no schema_version). Full callback surface deferred to v0.2.x.

**Cross-implementation protocol corpus**

`tests/protocol_corpus/` in the library repo — 12 warn-mode + 8 strict-mode fixtures, parametrized over (fixture × backend). Catches Python ↔ Node coordinator wire-shape drift before it ships. Strict mode is Python-coordinator-only in v0.2; v0.3 brings it to Node via the multi-target converter plan.

**Install**

```bash
pip install "agent-coherence>=0.9.0"   # strict-mode wire shape requires 0.9.0+
claude plugin marketplace add hipvlady/agent-coherence-plugin
claude plugin install agent-coherence@agent-coherence
```

Canonical install drops the version pin per the broad-beta canonicalization — the marketplace add resolves to the latest published tag. For operators who need version pinning (CI / reproducibility), `@v0.2.0` is supported.

**Upgrading from v0.1.x — MANDATORY `hook.secret` rotation**

v0.1.1 secrets were generated under the warn-only threat model and are insufficient to bridge v0.2's strict-mode hard guardrails. Procedure in [docs/RELEASE.md section 4](RELEASE.md): stop running `claude` sessions → `rm <repo>/.coherence/hook.secret` → restart any `claude` session, which lazy-spawns the coordinator and generates a fresh 32-byte secret. Documented as a load-bearing step, not advisory.

---

## Landing-page hero block

```html
<header>
  <h1>agent-coherence v0.2 — strict mode, open broad beta</h1>
  <p>Per-artifact opt-in <code>permissionDecision: "deny"</code> on stale reads across 5 hooked tool surfaces. Static deny text byte-stable across retries (Phase 0 H1 falsified). Multi-model validated on haiku, sonnet, opus. <a href="https://github.com/hipvlady/agent-coherence-plugin/releases/tag/v0.2.0">Release notes →</a></p>
  <pre><code>claude plugin marketplace add hipvlady/agent-coherence-plugin
claude plugin install agent-coherence@agent-coherence</code></pre>
  <p class="meta">Broad-beta open YYYY-MM-DD · macOS / Linux / WSL2 · Apache-2.0</p>
</header>
```

---

## Landing-page mechanism section (replaces existing §2)

> When a tracked artifact's version has changed since this session last observed it, the `PreToolUse` hook injects a single sentence into the agent's `additionalContext`: the path, the version this session last saw, the version the workspace coordinator currently holds, and who last wrote it. The model reads that sentence in line with the read it's about to perform.
>
> **v0.2 strict mode (operator opt-in per artifact)** — for tracked artifacts opted into `.coherence/strict_mode.yaml`, the same staleness detection returns `permissionDecision: "deny"` with a static reason text. The model receives the deny + the same reason byte-identical across retries. Per Phase 0, the model exits the retry loop after 2-5 attempts and routes to alternative behavior — the deny IS the signal. No agent escapes the boundary by spinning.
>
> Warn-mode (default for every artifact not in `strict_mode.yaml`) is preserved byte-identical from v0.1.1.

---

## Social-post variants

### LinkedIn (long form, ≤ 1200 chars)

> agent-coherence v0.2 is open broad beta on the Claude Code marketplace.
>
> The shape of the v0.2 ship: per-artifact opt-in `permissionDecision: "deny"` on stale reads. Tracked artifact, opted into strict mode, peer session committed v2 while your session was holding v1 → next Read attempt returns deny + a static reason. Model exits its bounded retry loop and surfaces the issue. Hard guardrail without breaking warn-mode behavior on the artifacts you DIDN'T opt in.
>
> Two findings the Phase 0 falsifiability experiment surfaced that shaped the design:
>
> 1) Varied deny text was supposed to bound model retries. It WORSENS opus — 5 retries vs 2 with static text, because opus reads varied prose as prompt-injection and retries to disambiguate. v0.2 deny reasons are static.
>
> 2) Single-tool deny is bypassable. Model retries Read 2-5 times, then routes to `bash cat <file>`. v0.2 ships hook coverage across Read / Edit / Write / Bash / Grep — 5 surfaces. Phase 0 confirmed this closes the H4 routing pattern.
>
> Plus: `TERMINAL_DENIAL_CLASSES` structural security invariant + AST-based meta-test that prevents future contributors from silently weakening the boundary. `agent-coherence-migrate-deny` — STDOUT-only, symlink-contained, never invokes an LLM.
>
> Install: `claude plugin marketplace add hipvlady/agent-coherence-plugin`
>
> Notes: github.com/hipvlady/agent-coherence-plugin/releases/tag/v0.2.0

### X / Mastodon (short, ≤ 280 chars)

> agent-coherence v0.2 — open broad beta on the Claude Code marketplace.
>
> Per-artifact opt-in `permissionDecision: "deny"` on stale reads. 5-surface hook coverage (Read/Edit/Write/Bash/Grep) closes the H4 routing pattern. Static deny text byte-stable across retries (Phase 0 H1 falsified).
>
> `claude plugin marketplace add hipvlady/agent-coherence-plugin`

---

## Notes on what to redact / adapt per surface

- **GitHub Release body**: keep everything. The auto-generated release notes (commit list) appears below the curated callout.
- **Landing-page**: replace `YYYY-MM-DD` with the actual tag-push date. Remove the markdown code-fence syntax around the HTML block; that's just for this file's readability.
- **Social posts**: pick ONE (LinkedIn OR X), don't cross-post identical text on both same-day — Algorithms penalize duplicate content.
- **Tag the release in the social post body** with `#claudecode` (X) or `Claude Code` mention (LinkedIn) so it surfaces in the platform's plugin/agent communities.

---

## Anti-overclaiming reminders

The v0.1.1 README + landing page set the tone — workmanlike, specific, evidence-grounded, no marketing fluff. Don't break that voice for the launch.

- DO say "broad beta" (factually accurate; this is the broad-beta cut per the v0.2 plan deepening).
- DON'T say "production-ready" or "GA" (the SemVer `0.x.y` line is explicitly pre-1.0 per `docs/BROAD_BETA.md` rationale).
- DO say "Phase 0 falsified the original hypothesis" + cite the specific finding (varied → 5 retries vs static → 2 on opus). The empirical specificity is the credibility differentiator.
- DON'T claim the plugin "blocks" the model from anything; the architecturally honest framing is "the model receives a deny and exits its retry loop" — both surface in the transcript.
- DO mention the multi-model validation (`{haiku, sonnet, opus}` × 2 consecutive). Most plugins ship without it.
- DON'T promise the multi-target install paths in v0.2 — Cursor / Codex / Copilot / etc. are explicitly v0.3.

## Rollback note for the announcement surface

If the launch triggers the rollback procedure in `docs/BROAD_BETA.md` section 4 within the 14-day window:

- Mark the GitHub Release as draft (already in the rollback runbook).
- Remove the social posts from public timelines if they're still recent enough that deletion is appropriate (judgement call — sometimes leaving them with a follow-up "v0.2.0 rolled back, see #ISSUE" reply is more honest than silent deletion).
- Update the landing-page hero with the rollback banner from BROAD_BETA section 4 step 5.

The single-source-of-truth nature of this file makes the rollback story coherent: future re-launch can git-revert this commit, edit the date + version to `v0.2.1`, and re-use the same surfaces.
