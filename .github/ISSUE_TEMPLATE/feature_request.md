---
name: Feature request
about: Suggest a new feature or enhancement
title: '[feat] '
labels: 'enhancement'
assignees: ''
---

**Use case**

What you're trying to do, and why the current behavior makes that hard. Be specific — "I want to coordinate across machines" is less useful than "I want session A on workstation X and session B on workstation Y to see each other's writes to `plan.md`."

**Proposed solution**

What you'd like to happen, in 1-2 sentences. Pseudo-code, schema sketches, or UX flows are welcome but not required.

**Alternatives considered**

Other ways you've thought about solving the same problem. Helps the maintainer understand the design space — including approaches that DON'T require a plugin change (e.g., a workflow tweak, a `tracked.yaml` glob).

**Scope estimate**

If you have a sense, indicate how big you think this is:

- [ ] Small (config option, doc clarification, new error message)
- [ ] Medium (new flag, new endpoint, new yaml schema field)
- [ ] Large (new architectural surface — e.g., new backend, new coordination model)
- [ ] Don't know

**Triage**

Feature requests have no SLA. The maintainer reviews them at irregular intervals; large ones may end up in [GitHub Discussions](https://github.com/Cohexa-ai/agent-coherence-plugin/discussions) for collaborative scoping before becoming a tracked issue. If you'd like to talk through a feature before formalizing it, opening a Discussion is the lower-friction path.

For multi-target install paths (Cursor, Codex, Copilot, etc.), see the v0.3 multi-target plan reference in the [README](../../README.md#install) — that work is tracked separately.
