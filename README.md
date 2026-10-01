# Task Estimator

> A [Claude Code](https://code.claude.com/docs/en/skills) skill.

Estimate how long a coding task will take, using the user's own measured history instead of intuition. Use this skill whenever someone asks for an estimate, an ETA, a timeline or a deadline for a feature, bug, refactor, migration, script or investigation — "how long will this take", "give me an estimate", "how many hours is this", "can this ship today", "is this a one-day job", "how many days for the whole epic", "what should I tell the client", "estimate this ticket", "size this" — and equally when the ask is skeptical ("is that realistic", "why did that take three days"). Also use it for the machinery behind the estimates — setting up or calibrating estimation, backfilling the task ledger from past Claude Code transcripts, recording a finished task's actuals ("record this task", "log this one", "add this to the ledger"), and re-running calibration or checking whether past estimates were any good. Trigger it even when the word "estimate" never appears — a question about how much work something is, or how long something took, is this skill.

## Install

Via [skills.sh](https://skills.sh):

```bash
npx skills add marks97/task-estimator
```

Or manually — copy the `task-estimator/` folder into your `.claude/skills/` directory.

## Usage

Once installed, Claude invokes this skill automatically when your request matches
what it does (see the triggers in [`task-estimator/SKILL.md`](task-estimator/SKILL.md)). You can
also ask for it by name.

## License

MIT © Marc Amoros

