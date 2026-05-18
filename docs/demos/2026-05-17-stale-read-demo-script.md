# Stale-read demo screencast script

**Goal**: 60-second visual proof that the plugin catches the stale-spec
collision phpmac's #59309 describes — without manual intervention. The
recording targets the Unit 10 marketplace listing + the marketing
`/code` page.

**Verified-on**: claude v2.1.131, agent-coherence-plugin commit
`aed5390+`, library `feat/claude-code-plugin-v0.1` branch.

**Install time measured 2026-05-17**: 27s end-to-end (R1 <30s PASS).
Breakdown: pip (19s) + marketplace add (6s) + plugin install (2s).
With v0.8.0a1 on PyPI: estimated 10-13s.

---

## Recording setup (5 min prep, NOT recorded)

```bash
# 1. Fresh disposable workspace
SMOKE=$(mktemp -d)
cd "$SMOKE"
git init -q
mkdir -p docs/plans

# 2. Seed a plan.md the demo will reference
cat > docs/plans/feature-x.md <<'EOF'
# Feature X plan (v4 — UPDATED 2026-05)
Steps:
  1. Add database migration
  2. Add API endpoint
  3. Add tests
  4. Wire feature flag
  5. Ship behind flag (rollout cohort: 10% → 100% over 1 week)
EOF

# 3. Install the plugin (already done, just confirm)
agent-coherence-coordinator --quiet
agent-coherence-track docs/plans/feature-x.md

# 4. Pre-seed coordinator state so the demo agent sees a stale-read
#    warning on its first Read (simulates "another session updated this")
python3 -c "
import sqlite3, uuid, time
db = '$SMOKE/.coherence/state.db'
c = sqlite3.connect(db, isolation_level=None)
c.execute('INSERT OR REPLACE INTO artifacts (id,name,version,content_hash,size_tokens,last_writer_id,updated_at) VALUES (?,?,?,?,NULL,?,?)',
  (uuid.uuid4().hex, 'docs/plans/feature-x.md', 3, 'f'*64, uuid.uuid4().hex, time.time()))
"
```

## Recording (60s — START RECORDING HERE)

**Scene 1 (0-10s)**: Two-pane terminal (e.g., tmux). Left pane shows
the file content (`cat docs/plans/feature-x.md`); right pane is empty
ready for claude.

**Voice-over / caption**: *"Two Claude sessions working in parallel on
the same plan.md. Session A read it 30 minutes ago. Session B just
updated it. What does session A's NEXT read see?"*

**Scene 2 (10-30s)**: Type in the right pane:

```bash
claude --include-hook-events --output-format stream-json --print --verbose \
       --model haiku \
       "Read docs/plans/feature-x.md and summarize the deployment plan."
```

Let it run. The stream-json output is the visual richness; focus on
the `additionalContext` payload from our PreToolUse:Read hook.

**Scene 3 (30-45s)**: Pause the scroll on the line containing our
warning. Highlight (or zoom into) the key text:

> ⚠ Stale read [warning emitted ...]: docs/plans/feature-x.md was
> updated by session ... at .... Current version is v3; this is the
> first time your session has observed this artifact (another session
> in this workspace registered it before you). ... Consider re-reading
> docs/plans/feature-x.md before acting on stale assumptions.

**Voice-over / caption**: *"The plugin injected this warning into the
agent's context. The agent sees it BEFORE acting — no platform fix
needed, no model retraining."*

**Scene 4 (45-60s)**: Show the model's response — Claude acknowledges
the warning and either re-reads or surfaces it to the user (depending
on the seed). End on `agent-coherence-status` showing the artifact
state.

**Voice-over / caption**: *"Install via `pip install agent-coherence`
+ `claude plugin marketplace add hipvlady/agent-coherence-plugin`. 27
seconds end-to-end. Private alpha for ~10 hand-picked installers; book
a discovery call at agent-coherence.dev/code."*

---

## Post-recording

- Crop tightly on the warning text — it's the visual proof
- Add a 3-second freeze frame on the warning so screen-readers / fast
  scrubbers can absorb it
- Export at 1080p ≤ 5MB for the marketplace listing thumbnail
- Upload to `docs/demos/agent-coherence-stale-read.gif` (or `.webm`)

## What NOT to record

- The pre-seeding python script (it's a demo aid, not a feature — a
  real second session would write to the file and the post-edit hook
  would bump the version naturally)
- Any pop-ups, browser tabs, secrets/tokens visible in the terminal
- The `agent-coherence-coordinator` cold-spawn output (it's noisy and
  not part of the value pitch — pre-warm before recording)

## Alternative if recording video tooling is unavailable

Take the 4 scenes as still screenshots and string them as a 4-panel
PNG montage. The warning text in scene 3 is the load-bearing visual;
everything else is context. A montage is acceptable for v0.1 alpha if
recorded video lags marketplace submission for v0.1.1.

