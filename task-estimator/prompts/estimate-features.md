# Feature extraction (estimate mode, step 3)

You are turning a task description into a **feature vector** that can be matched against
`tasks.ndjson`. This is not a design review and not an estimate — do not think about
duration while doing this. Duration comes from the class, in step 5.

Run the searches. A guessed feature produces a wrong class, and a wrong class produces a
confidently wrong number. Two features carry most of the signal — **precedent in repo** and
**self-verifiability** — so if you spend effort anywhere, spend it there.

Emit exactly this JSON block, then continue with step 4.

```json
{
  "repos": ["example-api"],
  "task_type": "bugfix|feature|refactor|migration|infra|investigation|script",
  "ground": "greenfield|brownfield",
  "quadrant": "greenfield-simple|greenfield-complex|brownfield-simple|brownfield-complex",
  "precedent_in_repo": {"found": true, "ref": "<path/commit/PR that is the same shape>"},
  "self_verifiable": "tests|typecheck-only|human-eyes|prod-only",
  "blast_radius": {"files": 12, "how": "<the command you ran>"},
  "external_deps": [{"kind": "app-review|human-decision|deploy|3p-approval|access", "who": "..."}],
  "parallelizable": "single-file|multi-file|multi-repo",
  "spec": "clear|medium|vague",
  "strategy": "converged|forked"
}
```

## repos

Which repositories the change lands in. Multi-repo is a strong signal on its own: it
implies at least one coordination round and usually a deploy ordering constraint.

## task_type

One of `bugfix · feature · refactor · migration · infra · investigation · script`. Pick
the *work*, not the ticket label. "Bug" tickets that require a schema change are
`migration`. "Small feature" that is really a rename across 40 files is `refactor`.

## ground — greenfield vs brownfield

Brownfield = existing callers, existing data, existing behaviour someone depends on.
Greenfield = a new file/module nothing calls yet. Brownfield costs are dominated by what
you must not break, and that does not show up in the diff size.

## quadrant — greenfield/brownfield x simple/complex

Cross `ground` with complexity (does this need one coherent change, or several interacting
ones?). The agent discount differs per cell — greenfield-simple +30-40%, greenfield-complex
+10-15%, brownfield-simple +15-20%, brownfield-complex 0-10% and sometimes negative — and
**the cells with the bigger discount also have the wider spread**. Record the cell; step 6
applies the discount and widens the band accordingly.

## precedent_in_repo — search, do not assume

Have we shipped **this exact shape** in **this repo** before? Look for it:

```bash
git log --oneline -S'<distinctive symbol>' -- <likely dir> | head
git log --oneline --grep='<domain word>' | head -20
rg -l '<the pattern the new code would follow>' <repo>/src | head
```

Record the ref you found (`path`, commit SHA, or PR). If you cannot find one, set
`found: false` — "no precedent" is a legitimate and important feature value, and pretending
otherwise is the single easiest way to under-quote. A found precedent is also the strongest
evidence that can justify the one-bucket downward shift in step 6; nothing else qualifies
on its own.

## self_verifiable — how does the agent know it worked?

| Value | Meaning |
|---|---|
| `tests` | A test exists or can be written that fails before and passes after. Cheapest class. |
| `typecheck-only` | The compiler is the only oracle. Catches shape, not behaviour. |
| `human-eyes` | Someone must look at a UI, a chart, an email, a generated asset. Every verification costs a full human round. |
| `prod-only` | It cannot be proven anywhere but production — real ad spend, a live webhook, a real payment. |

Check for the harness before deciding: does a test file cover this module, is there a repro
script, is there a preview env?

```bash
rg --files -g '*<module>*.test.ts' | head
```

This feature is the main driver of **round count**, which is the main driver of duration.
`human-eyes` and `prod-only` both mean the loop cannot close without the user.

## blast_radius — count, do not eyeball

```bash
rg -l '<symbol|route|table|component>' <repo>/src | wc -l
git log --format= --name-only -20 -- <likely dir> | sort -u | wc -l
```

Record both the number and the command. A change touching 3 files and one touching 60 are
different classes even when the described behaviour is identical.

## external_deps — anything not under the keyboard

Third-party approvals (an app review, Stripe, an App Store), another human's decision or
review, an access grant or credential, a deploy that someone else runs, a CI queue that is
currently broken. List each with who it waits on.

These become **calendar days, not agent-hours**, and they are reported on their own line.
A task with two external approvals can be 90 minutes of work and three weeks of clock.

## parallelizable

`single-file` · `multi-file` · `multi-repo`. Work that fans out across independent files
compresses under agents; work that is a chain of dependent edits in one file does not.

## spec and strategy — feeds the readiness gate

`spec: vague` or `strategy: forked` means step 2 should already have refused to estimate.
If you filled these in as `vague`/`forked` and produced a number anyway, you skipped the
gate — go back.

## Then

Hand the block to step 4 and match it against `tasks.ndjson`. Report which features were
**searched** and which were **assumed** — an assumed feature is a caveat on the estimate,
and the user is entitled to see which ones they are.
