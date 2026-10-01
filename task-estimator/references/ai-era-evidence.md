# AI-era evidence: what changed when the agent showed up

Empirical facts about human+agent development, 2025–2026. These override intuition and
override anything the developer (or the agent) reports about its own speed.

## 1. METR RCT 2025 — the perception gap (arXiv 2507.09089)

- 16 expert OSS developers, **246 real tasks** in repos they maintain, randomized
  AI-allowed vs AI-disallowed.
- Measured result: **+19% SLOWER with AI.**
- The same developers **believed they had been 20% faster** *after* doing the work.
  Beforehand they predicted **−38%**. Economics/ML experts predicted similar.
- **Perception gap ≈ 39 percentage points, and it does not self-correct with
  experience on the task.** People cannot feel their own slowdown.
- **Therefore: self-reported speedups are banned as calibration inputs.** "That took me
  10 minutes with Claude" is not data. Only timestamps and merge events are data.
- Slowdown was **largest where the developer was most familiar** with a **large, mature,
  high-standards repo** — precisely the conditions of most real work here.
- **<44% of generations were accepted.** Time spent reviewing and discarding output is
  the mechanism, not a mystery.

## 2. The speedup quadrant (Stanford, ~100k developers)

Speedup is not a scalar. It is a function of (greenfield vs brownfield) × (simple vs
complex):

| | Simple | Complex |
|---|---|---|
| **Greenfield** | **+30–40%** | **+10–15%** |
| **Brownfield** | **+15–20%** | **0–10%, sometimes negative** |

- Net-of-rework aggregate across all work: **+15–20%**, far below the ~2× folklore.
- **Speedup and variance move together.** The quadrants with the biggest gains also have
  the widest spread — a bigger expected discount always comes with a wider interval,
  never a tighter one. Never narrow a band because "the agent will handle it".
- Classify every task into a quadrant before applying any discount.

## 3. Bimodality (Frontiers 2026, LLM-aware effort estimation)

- **78% of high-complexity tasks completed at <25% of expected effort.**
- **22% of low-complexity tasks blew past 180% of expected effort**, driven by
  validation and integration overhead, not by the coding.
- The joint distribution is **bimodal, not shifted-unimodal**. A single central estimate
  sits in the trough between the two modes and describes almost nothing.
- Required response:
  1. **Regime classifier** — decide up front whether the task is "agent nails it" or
     "agent thrashes on integration".
  2. **Mixture output** — report both modes with weights, not one blended number.
  3. **Readiness gate on acceptance criteria** — the low-complexity blowups correlate
     with unstated/untestable acceptance criteria. If criteria are absent, the task is
     in the slow mode regardless of apparent size.

## 4. METR time horizons — how long an agent runs unattended

- **T80 ≈ T50 / 3.** At an 80% success bar the horizon is roughly **30 minutes of
  human-equivalent work**, and T80 stayed **flat for a year while T50 grew** — capability
  gains showed up at the coin-flip reliability bar, not the dependable one.
- **Constant-hazard model:** failure probability per unit of work is roughly constant,
  so expected human touchpoints ≈ `ceil(human_equivalent_minutes / T80)`.
  A 2-hour-equivalent task implies ~4 touchpoints, and touchpoints are the unit that
  actually consumes calendar time.
- **Failed trajectories run 18–82% LONGER than successful ones.** Failure is not cheap
  and early; it is expensive and late. Budget the failure branch at *more* than the
  success branch, never less.

## 5. The review shift (Faros AI, 22k developers; DORA 2025)

Throughput moved upstream; the constraint moved downstream.

- Task throughput **+33.7%** — and simultaneously:
  - median **review time +441%**
  - **pickup time +156%**
  - **code churn +861%**
  - **incidents per PR +242%**
- **Agentic PRs wait 5.3× longer for pickup** than human-authored ones.
- **38% of agentic PR failures are "never reviewed"** — a queueing failure, not a
  capability failure. The bottleneck is human attention, not model quality.
- **Merge priors by PR type** (use as the prior on whether the tail ever closes):
  docs **84%** > CI **79%** > build **74%** > bugfix **64%** > perf **55%**.
- Consequence: any estimate that stops at "code written" is measuring the part that got
  faster and ignoring the part that got 5× slower.

## 6. Anthropic telemetry — the shape of a session

- **Median turn ≈ 45s.** Agent-internal work is fast and remarkably stable.
- **Interventions per session: 3.3–5.4.** This is the real cost driver.
- The agent **asks for clarification 2×+ more often on complex tasks** — touchpoint
  count is a **property of the task**, agent-initiated, and therefore predictable from
  task features rather than from operator discipline.
- **Coding is only ~30–40% of a developer's calendar time.** Even a hypothetical 100%
  coding speedup caps end-to-end improvement near 30–40% (Amdahl). Any claimed
  end-to-end gain above that is a measurement error.

## 7. "Done" inflation

- **Agent-declared completion overstates real completion by ~7×** on a maintainer-review
  basis. A "pass" routinely hides **~26 minutes of remediation** before the change is
  actually acceptable.
- Therefore **done = merged / accepted by a human. Nothing else counts.** Not "tests
  pass", not "task complete", not a green CI run, not the agent's own summary.
- The remediation tail is the single largest source of underestimation in agent-era
  histories, because it is invisible in the transcript that declared success.

## Cross-cutting consequences

- Estimate **touchpoints and review latency first**, coding time second. Coding time is
  the part that both compressed and stopped being the constraint.
- Apply the quadrant discount, then **widen** the interval — never narrow it.
- Treat every "that was fast" as unmeasured. The 39pp perception gap makes felt speed
  anti-correlated with truth in exactly the brownfield-expert case that dominates here.

## Rules the skill enforces from this

1. Never accept self-reported speedup as calibration data — measured timestamps and merge events only (METR: felt −20%, real +19%).
2. Classify the task into the greenfield/brownfield × simple/complex quadrant, apply that quadrant's discount, and widen the interval alongside it.
3. Emit a bimodal/mixture estimate with a regime call, and gate on acceptance criteria — absent criteria force the slow mode.
4. Size the human touchpoints as ceil(human-equivalent minutes / 30 min T80), budget the failure branch longer than the success branch, and price review pickup and remediation into the tail.
5. Score "done" as merged/accepted only; discount any agent-declared completion by the ~7× inflation factor.
