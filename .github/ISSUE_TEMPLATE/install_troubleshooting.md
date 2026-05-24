---
name: Install troubleshooting
about: The plugin doesn't seem to be working — help diagnosing the install
title: '[install] '
labels: 'install'
assignees: ''
---

**What's not working**

Pick the row that matches and fill in the diagnostic ask:

- [ ] `claude plugin install` succeeded, but I see no behavior change (warnings don't fire on stale reads)
- [ ] `claude plugin marketplace add` failed
- [ ] `pip install agent-coherence` failed
- [ ] `agent-coherence-status` is "command not found"
- [ ] `agent-coherence-status --self-test` exits non-zero
- [ ] Other (describe below)

**Self-test output**

Please paste the output of:

```bash
agent-coherence-status --self-test
```

If the command isn't found, that's your answer for "where is it." Move to the next section.

**PATH check**

```bash
which agent-coherence-coordinator
which agent-coherence-hook-client
which agent-coherence-status
```

If any of those return "not found", check that the directory `pip install` wrote them to is on your `$PATH`. Common locations:

- `~/.local/bin` (user install)
- `/usr/local/bin` (system install)
- Your virtualenv's `bin/` (venv install)

`pip show -f agent-coherence | grep 'agent-coherence-'` will show the absolute paths the install wrote.

**Plugin load**

```bash
claude --include-hook-events --output-format stream-json "echo test"
```

Look for `plugin_errors` in the first init event. If `hook-load-failed` appears, the plugin's `hooks.json` is referencing commands not on PATH — usually means `agent-coherence-hook-client` isn't resolvable.

**Environment**

- `claude` CLI version (`claude --version`):
- Python version (`python --version` or `python3 --version`):
- How you installed `agent-coherence` (system pip / `pip install --user` / venv / Conda / pipx):
- Coordinator backend (`coherence.coordinator_backend`; default is `python`):
- OS (macOS / Linux distro + version / WSL2):
- Shell (bash / zsh / fish):

**What you've tried**

Steps you've already run. Saves the maintainer from suggesting things you've already done.

**Triage SLA**

Install-troubleshooting issues are triaged within 72h. Many are quick — the diagnostic sections above usually surface the cause without needing back-and-forth. If your issue is install-related but security-sensitive (e.g., `hook.secret` leaked, `pip` installed an unexpected dependency), please report via the [security tab](https://github.com/hipvlady/agent-coherence-plugin/security) instead.
