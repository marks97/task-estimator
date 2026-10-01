# The measurement layer: phases, thresholds, calibration

How a task's elapsed time is decomposed, which constants cut it, and how personal
history is turned into a forecast. Constants below are measured, not chosen by taste —
where a choice was arbitrary, that is stated so it can be published rather than hidden.

## 1. Phase taxonomy (P0–P7)

Every task's wall-clock is partitioned into exactly these, with no unlabelled residue.

| | Phase | Boundary |
|---|---|---|
| **P0** | **Framing** | First human prompt → first *mutating* tool call. Reads/searches are still framing. |
| **P1** | **Agent execution** | Sub-spans: **orient** (search/read) / **edit** (write/patch) / **verify** (test/build/run). Track the three separately; their ratio is the best cheap regime signal. |
| **P2** | **Awaiting approval** | `tool_use` → `tool_result` gap **>60s with no assistant tokens in between**. **THE hidden phase**: **52% of long intra-task gaps, median 32 min.** Invisible unless explicitly carved out, and it is the largest single recoverable loss. |
| **P3** | **Human turnaround** | `end_turn` → next human prompt. The human is the server, the agent is the queue. |
| **P4** | **Iteration** | First done-claim → last change. Classify each subsequent turn as **approval / correction / new-scope**; only correction is rework, new-scope must be re-billed as a new item. |
| **P5** | **Blocked** | **Enumerated causes only, never a residual bucket** (waiting on access, on a deploy, on another person, on an external API). A residual "blocked" absorbs measurement error and destroys the model. Gaps **>2h are abandonment and are excluded from cycle time entirely.** |
| **P6** | **Handoff** | Last change → `pr-link` / PR creation. |
| **P7** | **PR tail** | Classic PR metrics, **LinearB definitions verbatim** (pickup time, review time, merge time) so numbers stay comparable with published industry baselines. Do not invent local variants. |

## 2. Thresholds (and their provenance)

| Constant | Value | Why |
|---|---|---|
| Agent-gap credit cap | **120s** | p99 of genuinely agent-internal gaps is **53s**; 120s is ~2× that, so anything longer is a human, not the model thinking. |
| Session wall | **15 min** | WakaTime lineage — the long-standing heartbeat/idle convention for editor activity. |
| Human-turnaround cap | **30 min** | Captures **83%** of human gaps; beyond it the gap is a context switch, not a turnaround. |
| Task / abandonment boundary | **2h** | Sensitivity analysis is **flattest in the 1–5h band** (so the choice is robust there), and it matches the `git-hours` convention. |
| Ambiguous gap | **split at midpoint** | ActivityWatch flood-fill convention: an unattributable gap is halved between the phases on either side rather than assigned to a favourite. |
| Commit-only fallback | **120 min** | Used only when no transcript exists. **Calibrate per-repo** to the p75–p85 of same-author inter-commit gaps; 120 is the cold default, not a law. |

## 3. Key measured facts (651-session corpus, 2026)

- **Human-gap distribution is unimodal — there is NO natural threshold.** No valley
  exists to cut at. Every gap threshold is therefore a *decision*: **publish the choice
  and its sensitivity**, never present it as discovered.
- **Per-round agent work is stable: ~9s per step, p50 ≈ 2 min per turn.** The agent side
  barely varies.
- **All the variance lives in the round count.**
  - human rounds → duration: **r = 0.82**
  - turn-1 duration → total duration: **r ≈ 0.0**
  - **A LONG first turn predicts FEWER rounds** (front-loaded framing pays for itself).
    Do not treat a slow start as a bad sign.
- **LOC is the weakest predictor (r = 0.53).** Assistant steps are the strongest
  (**r = 0.86**). Estimate steps/rounds, then convert — do not estimate lines.
- **Lognormal does not fit**: it lands at **×0.72 of the true median** and **×1.72 at
  p95**. Use **raw empirical quantiles** instead — leave-one-out coverage came in at
  **49.9 / 79.8 / 89.9** against nominal 50 / 80 / 90, i.e. essentially exact.
- **Only 35% of tasks land within 2× of the median.** Point estimates are indefensible
  at this dispersion; the interval *is* the answer.
- **Flow efficiency: 8.5% at turn level, 35% at task level.** Both are true. **Always
  quote which boundary** — the same work looks 4× more efficient depending on the frame,
  and an unqualified figure is a rhetorical device, not a measurement.

## 4. Transcript gold (highest-fidelity signals)

- **`system/turn_duration`** — harness ground truth for turn timing. Validated against
  independent measurement at a **ratio of 1.00**. Prefer it over any wall-clock
  arithmetic on message timestamps.
- **Resume chains are exact.** When the **first `sessionId` inside a file ≠ the
  filename**, that is a **parent edge**: the session was resumed from another. Rebuild
  the full chain before computing any task duration, or long tasks are silently
  truncated at each resume.
- **`pr-link` records** — authoritative P6→P7 boundary and the join key to the PR tail.
- **Subagent work lives in the SIDECAR TRANSCRIPT, not in the parent's tool_result.**
  `<chat_id>/subagents/agent-*.jsonl` (+ `.meta.json` naming the agent type) is the
  primary record: the subagent's own full transcript, measurable with exactly the same
  extractor as any chat. Mine it, and subagent time is fully attributable; never estimate it.

  A `Task`/`Agent` `toolUseResult` *may* also carry a `toolStats` summary (duration,
  tokens, lines added/removed), and where it does it agrees. **It is usually absent**:
  across the measured corpus, 121 chats spawned subagents and only **6** carried any
  `toolStats` LOC, while **81** sidecar transcripts existed. Treating that summary as the
  source of truth scores a 104-spawn sprint at zero LOC. Where both exist, the sidecar
  measurement REPLACES the summary for that `toolUseId` — never adds to it.

  The parent also does not persist every spawn (one 104-spawn sprint kept two), and
  **depth-2 agents** — spawned by another subagent — have no `tool_use` block in the
  parent at all; they appear only as sidecars, flat in the same directory with a
  `parentAgentId`.

  Subagent minutes run **inside** the parent's wall clock, so they are reported beside the
  parent's own metrics and never added to them.
- **`userModified`** — a human overrode the agent's edit. Direct, unambiguous
  human-override signal; strong feature for the correction-vs-approval classifier.
- **Stitch on structure, never on time.** Meyer et al.: purely temporal session
  stitching tops out at **50–73% accuracy**. Use session IDs, parent edges, file
  identity and PR links; use timestamps only to order, never to group.

## 5. Calibration math

- **Shrinkage to the population prior:** `w = n / (n + κ)` on the personal estimate,
  applied whenever **n < ~20** tasks in the class. Justification: bootstrap shows a
  **personal p85 at n = 11 spans 0.31–2.26× the truth** — an 11-sample personal quantile
  is nearly worthless alone but useful as a shrunk adjustment.
- **Recency:** exponential decay, **half-life ≈ 90 days**. Matches the ~6-month flow
  window without a hard cutoff.
- **RFC 6298 asymmetric update** (TCP RTO, borrowed wholesale):
  - track mean and dispersion separately;
  - **dispersion adapts ~2× faster than the mean**;
  - **commit = estimate + 4 × dispersion**;
  - **widen immediately on a blowout**, decay back slowly. Fast up, slow down.
- **Glicko-style staleness:** uncertainty **grows with inactivity**. A class untouched
  for months reverts toward the population prior, **capped at stranger-level** — you can
  never be more uncertain about your own history than about a stranger's.
- **Scoring:** headline **WIS at the 80% interval**, plus a **PIT histogram once n ≥ 20**
  to expose systematic bias (U-shape = too narrow, hump = too wide).
- **Coverage bands are displayable from task one:** plot the binomial acceptance band
  `binom.ppf(0.05, n, p)/n` … `binom.ppf(0.95, n, p)/n` around nominal `p`. At small n
  the band is enormous — which is the honest message, and it prevents over-reacting to
  the first two misses.

## Rules the skill enforces from this

1. Partition every task into P0–P7 with no residual; carve out awaiting-approval explicitly (52% of long gaps, median 32 min) and enumerate blocked causes rather than inferring them.
2. Apply the measured constants — 120s agent-gap cap, 15 min session wall, 30 min turnaround cap, 2h task/abandonment boundary, midpoint split for ambiguous gaps — and publish the threshold choice, since the gap distribution is unimodal and offers no natural cut.
3. Predict from assistant steps and human round count (r = 0.86 / 0.82), never from LOC (r = 0.53) or first-turn duration (r ≈ 0.0).
4. Emit raw empirical quantiles, never a fitted lognormal (×0.72 median, ×1.72 p95), and always state the flow-efficiency boundary (8.5% turn / 35% task).
5. Shrink to the population prior below ~20 tasks with w = n/(n+κ), decay history at a 90-day half-life, widen on blowouts via the RFC 6298 asymmetric rule, and report coverage against binomial bands from the first task.
