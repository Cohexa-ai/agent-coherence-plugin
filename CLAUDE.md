# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
# Install dependencies (use the lock file)
npm ci

# Type-check (no emit)
npx tsc --noEmit

# Build (tsc → dist/)
npm run build

# Test (Node native test runner against dist/test/)
npm run test:src

# Lint (after Unit 8 lands)
npm run lint

# Format check (after Unit 8 lands)
npm run format:check

# Release readiness preflight (after Unit 9 lands)
node tools/check_release_readiness.js
```

## Branching strategy

| Branch | Role |
|---|---|
| `main` | GitHub default branch and release target. Tagged for `v*` releases via the CI workflow. Treat as protected — only fully verified work lands here. |
| `dev` | Integration branch for in-flight features. CI runs on both `push` and `pull_request` for `[main, dev]`. Feature branches MUST target `dev`, not `main`, when the change is not yet production-ready (e.g., behind a feature flag, missing adapter wiring, or part of a multi-step rollout). |
| `feat/*`, `fix/*`, `refactor/*`, `docs/*` | Topic branches. Branch from `dev` (or `main` if it is current with `dev`) and open the PR against `dev` by default. |

When opening a PR with `gh pr create`, pass `--base dev` unless the change is the actual `dev → main` release merge.

When `gh pr edit` is needed to retarget a PR (e.g., after discovering the change isn't fully prod-ready), use `gh pr edit <number> --base dev`.

The GitHub default branch is `main` per the repo configuration; do not change that. The default branch is what GitHub shows when someone clones the repo and the target of `git push origin HEAD` without an explicit upstream — that's the right default for general traffic. The integration target for *in-flight* feature work is `dev`.

## Architecture

The plugin coordinator is a TypeScript HTTP server that implements the MESI-subset wire contract shared with the library's Python coordinator. Entry points:

- `src/coordinator.ts` — process entry, HTTP server bootstrap
- `src/server.ts` — HTTP server + auth + routing
- `src/registry.ts` — SQLite registry with MESI write-path
- `src/hooks/` — handler implementations matching the library's wire contract
- `src/auth.ts` — Bearer + Host-header check (R12 disclosure threshold)

The canonical design lives at `/Users/vladparakhin/projects/agent-coherence/docs/plans/2026-05-18-001-feat-claude-code-coherence-plugin-v0.1.1-plan.md` (read-only; this path is gitignored locally but contains the full plan).

## Release

Release procedure is documented in [docs/RELEASE.md](docs/RELEASE.md) (added in Unit 6). The short version: PR `dev → main`, verify CI green, merge, bump version in `package.json` + `.claude-plugin/{plugin,marketplace}.json`, tag `v{version}` on `main`, push tag — `release.yml` runs preflight + build + GitHub release with SBOM.

## Plugin coexistence

The plugin coordinator and the library's Python coordinator share the HTTP wire contract — both implement the same MESI subset. The operator chooses between them via `coherence.coordinator_backend` in plugin settings. Cross-backend switching uses `agent-coherence-coordinator --prepare-for-migration` (library CLI).
