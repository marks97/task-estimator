# task-estimator

A Claude Code skill that answers "how long will this take?" from **your own measured
history** instead of the model's intuition.

The motivating result: in METR's 2025 study, experienced developers working on their own
repositories were **19% slower** with AI assistance while believing they were **20%
faster**. Any estimate produced by introspection inherits that gap. This skill replaces
introspection with a ledger.

## What it does

- **Mines your Claude Code transcripts** into a ledger of tasks with real durations, real
  human round counts, and real outcomes.
- **Quotes new tasks against the empirical distribution** of similar past tasks — a
  probabilistic service-level expectation ("85% of your similar tasks finished in ≤ …"),
  never a single number.
- **Scores its own quotes.** Every estimate is logged; when the task lands, the actual is
  compared against it, so over- and under-estimation are visible instead of remembered.

## How it works

Four modes, described in full in `SKILL.md`:

| Mode | What happens |
|---|---|
| `estimate` | Strip anchors → readiness gate → extract features → retrieve reference class → empirical quantiles → bounded inside-view shift → SLE output → log the quote |
| `setup` | Create the ledger, ask consent, backfill from transcripts, classify, audit the classifier, calibrate |
| `record` | Mine the just-finished session into the ledger, charging rework to the original task |
| `recalibrate` | Re-derive calibration and report interval coverage and bias |

Three properties do most of the work:

1. **Anchor-blind.** The class quantile is computed before any deadline, story point or
   "should be quick" is taken into account. Anchors move estimates 4–5× and survive being
   told to ignore them.
2. **Rounds, not minutes.** Human round count correlates with total duration at r ≈ 0.83;
   first-turn duration correlates at r ≈ 0.0. The pipeline estimates interactions and lets
   the clock follow.
3. **Refuses unready work.** No testable acceptance criteria or no converged strategy means
   no estimate — a timeboxed spike instead. That is the population that overruns by >180%.

## Layout

```
SKILL.md                          the operating manual — read this first
README.md                         you are here
references/estimation-science.md  classical results: EBS, reference classes, anchoring
references/ai-era-evidence.md     what changed once an agent was in the loop
references/measurement-model.md   phase taxonomy, measured constants, calibration math
prompts/estimate-features.md      feature extraction checklist (with the searches to run)
prompts/classify-chat.md          haiku classifier for a chat digest (strict JSON)
prompts/audit-task.md             sonnet re-judge of a classified task
templates/claude-md-snippet.md    the CLAUDE.md block that triggers record mode
scripts/extract.mjs               transcript JSONL -> raw events
scripts/stitch.mjs                events -> chats + tasks
scripts/digest.mjs                one chat -> compact text for the LLM pass
scripts/slice.mjs                 epics -> labelled sub-deliverables (task.sub_tasks)
scripts/calibrate.mjs             ledger -> calibration.json
```

Data lives outside the skill, in `~/.claude/estimation/` — deliberately outside the skill
directory so it survives reinstalls, and under `~/.claude/` so it is one history for the
machine. Override the location with `$CLAUDE_ESTIMATION_DIR`.

## If you cloned this

Run the skill and say "set up estimation". It will create the ledger, **ask before reading
any transcript**, and tell you the token cost of the backfill before spending it.

Everything stays on your machine except the classification calls, which go to the Anthropic
API through `claude -p` — the same place your normal sessions already go. Classification
runs with `--tools "" --safe-mode --no-session-persistence`: no tools, no project
instructions, and no new transcript files (without that last flag the backfill would mine
its own classification sessions on the next run).

To remove it entirely: `rm -rf ~/.claude/estimation` and delete the
`<!-- task-estimator -->` block from your global `CLAUDE.md`.

Until the ledger holds ~10 tasks in a class, estimates for that class are prior-based and
say so. It is worth the first backfill.
