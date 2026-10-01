<!-- task-estimator:start -->
## Record finished tasks (task-estimator)

After completing a substantive task — a commit, a merged PR, or the user saying it is done
— record it into the estimation ledger:

```bash
node .claude/skills/task-estimator/scripts/record.mjs --latest --project "$(pwd)"
```

(If you know the session id, prefer `--session <id>`. Add `--outcome shipped` when a
commit/PR exists; use `--in-progress` for work that continues.)

Skip it for trivial Q&A, one-line lookups, and anything that edited nothing.

Every recorded task sharpens the next estimate — and if a quote was logged for this task,
recording it scores the estimate. The ledger is the only reason estimates here beat guessing.
<!-- task-estimator:end -->
