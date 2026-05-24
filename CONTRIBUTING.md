# Contributing

Thanks for considering a contribution. This plugin is a single-maintainer project; the contribution posture is **maintainer-curated**, not auto-merge. PRs are welcome but reviewed individually with explicit acceptance criteria.

## Quick orientation

| Surface | Where it lives | When to use |
|---|---|---|
| Bug reports | [Issues](https://github.com/hipvlady/agent-coherence-plugin/issues/new?template=bug_report.md) | The plugin did something wrong. 72h triage SLA. |
| Install issues | [Issues — install template](https://github.com/hipvlady/agent-coherence-plugin/issues/new?template=install_troubleshooting.md) | The install isn't working. 72h triage SLA. |
| Feature requests | [Issues — feature template](https://github.com/hipvlady/agent-coherence-plugin/issues/new?template=feature_request.md) | A new feature you'd like. No SLA. |
| Q&A / design discussion | [Discussions — Q&A](https://github.com/hipvlady/agent-coherence-plugin/discussions/categories/q-a) | A question without a clear "the plugin did X" answer. Lower-friction than an Issue. |
| Sharing your setup | [Discussions — Show & Tell](https://github.com/hipvlady/agent-coherence-plugin/discussions/categories/show-and-tell) | Your `tracked.yaml` / `strict_mode.yaml` config, workflow tweaks. |
| Strict-mode feedback | [Discussions — Strict Mode](https://github.com/hipvlady/agent-coherence-plugin/discussions/categories/strict-mode) | First-impressions, design questions, unexpected denies (not bugs). |
| v0.2 upgrade reports | [Discussions — v0.2 Upgrade Reports](https://github.com/hipvlady/agent-coherence-plugin/discussions/categories/v02-upgrade-reports) | Post-upgrade signal during the 14-day broad-beta monitoring window. |
| Security issues | [security@agent-coherence.dev](mailto:security@agent-coherence.dev) or [GitHub security tab](https://github.com/hipvlady/agent-coherence-plugin/security) | Anything that could compromise auth, secrets, or file content. **Do not open a public Issue.** 72h response SLA. |
| Code contributions | Pull Requests | Patches that fix a bug, add a feature, improve docs. See "PR posture" below. |

## Triage SLA

| Class | Target |
|---|---|
| Security-class report | First response within 72h; patch target depends on severity (P0 in 7 days). |
| Bug report (non-security) | Triage within 72h. Acknowledgement + label. Repro + patch happen async. |
| Install issue | Triage within 72h. Most resolve on the first reply via the diagnostic asks in the template. |
| Feature request | No SLA. Reviewed at irregular intervals. |
| Discussion | No SLA. The maintainer participates when they have time. |

## PR posture

PRs are welcome. The maintainer-curated posture means:

- **Reviewed via `gh pr view` + Claude-assisted review** (the same workflow this repo uses on its own internal changes). Expect 1-3 review cycles before merge.
- **Never auto-merged.** Even small docs PRs land manually after the maintainer has read the diff.
- **Tests are not optional** for behavioral changes. New behavior gets new tests; changed behavior gets updated tests; deleted behavior gets removed tests. Pure docs / config changes are an explicit exception.
- **One PR = one concern.** Mixing a bug fix with a refactor in the same PR makes both harder to review. Split them.

If a PR ends up in the "needs significant rework" bucket, the maintainer will say so explicitly + suggest scope. The maintainer reserves the right to close PRs whose scope can't be agreed on, with an explanation.

## Branching convention

| Branch | Role |
|---|---|
| `main` | Release target. Tagged for `v*` releases. Protected. |
| `dev` | Integration branch for in-flight features. Protected (status checks only, no review required). |
| `feat/*` | New features. Target `dev`. |
| `fix/*` | Bug fixes. Target `dev` (or `main` for hot-fixes per [docs/RELEASE.md section 3](docs/RELEASE.md)). |
| `docs/*` | Documentation-only changes. Target `dev`. |
| `refactor/*` | Internal restructure without behavioral change. Target `dev`. |

`gh pr create` defaults to `--base dev`. The only PR that should target `main` is the release `dev → main` merge per [docs/RELEASE.md](docs/RELEASE.md) section 2.

## Pre-PR checklist

Before opening a PR, verify:

- [ ] Tests pass locally: `npm run test:src`
- [ ] Typecheck clean: `npx tsc --noEmit`
- [ ] Build clean: `npm run build`
- [ ] If the PR adds a new behavior on the Python coordinator side, the [library repo](https://github.com/hipvlady/agent-coherence)'s `tests/protocol_corpus/` covers it (or a follow-up PR will). Cross-impl wire-shape drift is a P0 regression class.
- [ ] If the PR touches `package.json`, `.claude-plugin/plugin.json`, or `.claude-plugin/marketplace.json` version fields, all three stay in sync (the pre-commit hook will reject mismatches).
- [ ] [CHANGELOG.md](CHANGELOG.md) `[Unreleased]` section has an entry (Added / Changed / Fixed / Security / Internal — pick the right subheading).
- [ ] PR title follows conventional commits (`feat:` / `fix:` / `docs:` / `refactor:` / `chore:`).

## Code style

- TypeScript strict mode; no `any` without an inline rationale comment.
- Match the surrounding file's voice: workmanlike, specific, evidence-grounded. No marketing fluff.
- Comments explain WHY, not WHAT. The "what" should be readable from the code itself.

## Architecture references

- The canonical design lives in the [library repo](https://github.com/hipvlady/agent-coherence)'s `docs/plans/` directory. Read the most recent v0.X plan before proposing architectural changes.
- The plugin's hook surface is documented in [hooks/hooks.json](hooks/hooks.json) with inline comments explaining the KTD-N H4 mitigation, the command-type-vs-HTTP-type rationale (Phase E.0 probe 2A), and the SessionStart hook contract.
- Wire-shape parity between Python and Node coordinators is enforced by the library's `tests/protocol_corpus/` suite — any plugin-side change that affects the wire shape needs a matching fixture there.

## Code of Conduct

[CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md) — adopts Contributor Covenant 2.1. Applies to all participants in Issues, Discussions, and PRs.

## License

By contributing, you agree that your contributions will be licensed under the [Apache 2.0 License](LICENSE) that covers the rest of the project.
