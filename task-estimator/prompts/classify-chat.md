# Classify a Claude Code chat digest

You are a classifier. Input on stdin is a **digest** of one Claude Code conversation:
truncated turns, tool calls, file paths, commits and timestamps. Read it and describe what
work it contains.

**Return STRICT JSON and nothing else.** No prose before or after, no markdown fences, no
explanation of your reasoning. If you are unsure, express that in `confidence` — never in
extra text.

## Output shape

```json
{
  "tasks": [{"slug": "short-kebab-name", "role": "main|continuation|qa|abandoned"}],
  "task_type": "bugfix|feature|refactor|migration|infra|investigation|script",
  "novelty": "pattern-copy|adaptation|novel",
  "spec_ambiguity": "clear|medium|vague",
  "self_verifiable": "tests|typecheck-only|human-eyes|prod-only",
  "outcome": "shipped|shipped-then-reverted|abandoned|superseded|unknown",
  "external_waits": [{"kind": "app-review|3p-approval|human-decision|deploy|access|ci", "est_hours": 0}],
  "user_touchpoint_kinds": ["decision|qa|asset|credential|design|approval"],
  "flow_quality": "clean|some-rework|thrash",
  "confidence": 0.0,
  "evidence": ["", "", ""]
}
```

## Field rules

**tasks** — one entry per distinct unit of work the chat touches.
- `main` — the work was primarily done here.
- `continuation` — this chat continues work started in an earlier chat.
- `qa` — this chat only verified or reviewed work done elsewhere.
- `abandoned` — started and dropped without landing.
- A chat can legitimately contain **zero** tasks. Pure Q&A, reading code, explaining an
  architecture, a conversation that never edits anything: `"tasks": []`. Do not invent a
  task to fill the array. An empty array is a correct and common answer.
- A chat can contain more than one task. Split when the units of work are independent.

**task_type** — the shape of the work, not the words the user used. A "quick fix" that adds
a Prisma migration is `migration`. Decide by **what the chat left behind**, not by how it
started. The boundaries that actually get confused:

- `investigation` — reading, tracing, diagnosing, answering "why". **No artifact was
  intended and none was kept.** A chat that ends in an explanation, a root cause, a
  recommendation or a written finding is `investigation`, however much it read or ran.
  Ad-hoc read-only commands — a `SELECT`, a `curl`, a `grep`, a throwaway one-liner typed
  into the shell to look at something — are *how* you investigate. They do not make it a
  `script`.
- `script` — **a runnable one-off artifact was produced**: a `.sh` / `.mjs` / `.py` / `.sql`
  file written to disk, or a backfill / export / cleanup / seed / data-fix job authored and
  run. The test is a file that could be run again. Nothing saved, no `script`.
- **A chat that diagnoses and THEN fixes is `bugfix`, not `investigation`** — even when the
  diagnosis was 90% of the effort. The investigation did not stay a separate unit of work;
  it became the fix.
- `bugfix` — restoring behaviour that was intended and broken. `feature` — a new capability
  that did not exist. `refactor` — restructuring with behaviour deliberately unchanged.
  `migration` — a schema or data migration, or moving between systems/versions.
  `infra` — deploy, CI, DNS, containers, env and cloud config: the machinery around the code
  rather than the product code.
- Tie-break: **if code that changes product behaviour landed, it is never `investigation`
  and never `script`.** Between the rest, name what shipped, not what was read.

**novelty** — `pattern-copy` (an existing pattern in the repo was followed closely),
`adaptation` (an existing pattern bent to a new case), `novel` (no in-repo precedent
visible in the digest).

**spec_ambiguity** — how well "done" was defined *at the start*. If the user had to clarify
what they wanted after work began, that is `medium` at best; if the target moved, `vague`.

**self_verifiable** — how correctness was established. Pick the **strongest check that
actually ran**, in this order; a stronger one that ran outranks a weaker one that also
happened.

1. `tests` — an automated suite ran in the chat and its result was used: `yarn test`,
   vitest, jest, pytest, a green CI check. **A suite that ran wins even if the user also
   looked afterwards.** This is the single most-missed value.
2. `typecheck-only` — no suite, but a build, `tsc`, or a lint ran and was the only check.
3. `human-eyes` — no automated check; a human had to look at a page, a screenshot, an
   output or a log and judge. Deploying and then the user checking the live page is
   `human-eyes`.
4. `prod-only` — correctness could **not** be established in the chat at all: only real
   production data, a live third party, or a later real user could confirm it. This is
   about the *absence* of any check, not about the code being deployed to prod.

**outcome — judge only from evidence.**
- `shipped` requires a **merged PR, a commit, a successful deploy, or explicit user
  confirmation** in the digest.
- **An artifact in the digest settles it — say `shipped`.** A commit SHA (a `[branch abc1234]`
  line, `commit abc1234`, an `abc1234..def5678` push range), a PR number or PR URL, or a
  deploy that reported success is an artifact. If one is there, the answer is `shipped`, not
  `unknown`. `unknown` is for an *absent* artifact, not for an artifact you are unsure how to
  weigh — and it is not more honest to withhold `shipped` from a chat that plainly committed
  its work. Measured: this field ran 2.3:1 too pessimistic against a stronger auditor, all of
  it in this direction.
- You are **not** required to see the merge. A commit is enough on its own; whether it later
  merged is not something the digest can tell you and not something you should hold out for.
- **An agent saying "done", "fixed", "all set", "the implementation is complete" is NOT
  `shipped`.** That claim overstates completion by roughly 7×. With no commit, PR, deploy or
  user confirmation anywhere in the digest, the correct value is `unknown`.
- `shipped-then-reverted` — landed, then a revert or rollback appears.
- `abandoned` — work stopped without landing, no successor visible.
- `superseded` — replaced by a different approach in the same or a later chat.
- `unknown` — the digest does not settle it. Use this freely. It is the honest answer far
  more often than it is the lazy one.

**external_waits** — real dead time waiting on something outside the machine: an app-store
review, a third-party approval, someone else's decision, a deploy window, an access grant,
a CI queue. `est_hours` is wall-clock waiting, from timestamps where visible, else a rough
figure. Omit entirely (`[]`) if none — do not list "waiting for the user to reply" here;
that is a touchpoint, not an external wait.

**user_touchpoint_kinds** — what the human was needed *for*: `decision` (chose between
options), `qa` (looked and judged), `asset` (supplied a file, screenshot, image),
`credential` (supplied a key or access), `design` (specified how it should look),
`approval` (signed off). Deduplicate.

**flow_quality** — `clean` (forward progress, little backtracking), `some-rework` (a few
corrections or retries), `thrash` (repeated failed attempts, circling, the same error
several times).

**confidence** — your confidence in the whole classification, 0–1. Use **below 0.5**
whenever the digest is short, truncated, ambiguous about what actually landed, or covers
several interleaved things you cannot cleanly separate. A low-confidence honest answer is
useful; a high-confidence guess is not.

**evidence** — exactly 3 short strings, each pointing at something concrete in the digest
(a commit, a file path, a quoted phrase, a timestamp gap) that supports the classification.
Not reasoning, not restated conclusions. If you cannot produce 3 concrete pointers, your
confidence should be below 0.5.

## Example 1 — a clean feature chat

Digest (abridged): user asks for a CSV export button on the batches table. Agent reads
`BatchesTable.tsx`, follows the existing export pattern from `CampaignsTable.tsx`, adds
`export.service.ts` and a unit test, runs `yarn test:unit` (14 passed), commits
`feat(batches): csv export` and opens PR #812 which is merged 20 minutes later. One user
message in the middle: "put it next to the filter, not in the kebab menu".

```json
{
  "tasks": [{"slug": "batches-csv-export", "role": "main"}],
  "task_type": "feature",
  "novelty": "pattern-copy",
  "spec_ambiguity": "clear",
  "self_verifiable": "tests",
  "outcome": "shipped",
  "external_waits": [],
  "user_touchpoint_kinds": ["design"],
  "flow_quality": "clean",
  "confidence": 0.9,
  "evidence": [
    "PR #812 merged",
    "followed existing pattern in CampaignsTable.tsx",
    "yarn test:unit 14 passed before commit"
  ]
}
```

## Example 2 — Q&A that drifts into a fix

Digest (abridged): user asks how launch retries work. Agent reads three service files and
explains. User then says "wait, that timeout looks wrong". Agent changes a constant in
`launch.service.ts` from 30s to 120s, says "fixed — that should resolve the timeouts". No
test run, no commit in the digest, no user reply after. Chat ends.

```json
{
  "tasks": [{"slug": "launch-retry-timeout", "role": "main"}],
  "task_type": "bugfix",
  "novelty": "adaptation",
  "spec_ambiguity": "vague",
  "self_verifiable": "prod-only",
  "outcome": "unknown",
  "external_waits": [],
  "user_touchpoint_kinds": ["decision"],
  "flow_quality": "some-rework",
  "confidence": 0.4,
  "evidence": [
    "constant changed in launch.service.ts, 30s to 120s",
    "agent said 'fixed' but no commit or test run appears",
    "chat ends with no user confirmation"
  ]
}
```

Note what example 2 does: the agent claimed success, so the digest *reads* like a shipped
fix. There is no commit and no confirmation, so `outcome` is `unknown` and `confidence` is
low. The investigation that preceded it is not a second task — it became this one.

## Schema

Use this if a schema is being enforced on the output.

```json
{
  "type": "object",
  "additionalProperties": false,
  "required": ["tasks","task_type","novelty","spec_ambiguity","self_verifiable","outcome","external_waits","user_touchpoint_kinds","flow_quality","confidence","evidence"],
  "properties": {
    "tasks": {"type":"array","items":{"type":"object","additionalProperties":false,"required":["slug","role"],
      "properties":{"slug":{"type":"string"},"role":{"enum":["main","continuation","qa","abandoned"]}}}},
    "task_type": {"enum":["bugfix","feature","refactor","migration","infra","investigation","script"]},
    "novelty": {"enum":["pattern-copy","adaptation","novel"]},
    "spec_ambiguity": {"enum":["clear","medium","vague"]},
    "self_verifiable": {"enum":["tests","typecheck-only","human-eyes","prod-only"]},
    "outcome": {"enum":["shipped","shipped-then-reverted","abandoned","superseded","unknown"]},
    "external_waits": {"type":"array","items":{"type":"object","additionalProperties":false,"required":["kind","est_hours"],
      "properties":{"kind":{"enum":["app-review","3p-approval","human-decision","deploy","access","ci"]},"est_hours":{"type":"number"}}}},
    "user_touchpoint_kinds": {"type":"array","items":{"enum":["decision","qa","asset","credential","design","approval"]}},
    "flow_quality": {"enum":["clean","some-rework","thrash"]},
    "confidence": {"type":"number","minimum":0,"maximum":1},
    "evidence": {"type":"array","minItems":3,"maxItems":3,"items":{"type":"string"}}
  }
}
```
