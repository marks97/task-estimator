# Estimation science: what survived the evidence

Classical results the estimate mode leans on. Everything here predates agents but
constrains how any estimate is produced, adjusted, and expressed.

## 1. Evidence-Based Scheduling (Spolsky)

- **Velocity is per-estimator, not per-team.** velocity = estimate / actual for one
  completed item. A person who consistently says 2h and takes 6h has velocity 0.33 and
  that is *usable signal*, not a defect to coach away.
- **Resample, never average.** Draw whole historical velocity ratios with replacement
  (Monte Carlo, 100+ runs) and divide each new estimate by a drawn ratio. Averaging
  velocity destroys the disaster tail — the 0.1 days that produce the overruns are
  exactly the draws that must stay reachable. The shape of the ratio distribution *is*
  the forecast.
- **Interruptions are absorbed into actuals, never modeled.** Do not build a
  "meetings/context-switch" multiplier. Elapsed actuals already contain it; adding a
  factor double-counts and inflates the mean while flattening the tail.
- **Rework is charged back to the original item.** A bug found in review reopens the
  item's clock. Filing follow-up work as a fresh item is the single most common way a
  history silently reports itself as accurate.
- **Cold start: <6 completed items → synthetic wide prior.** Do not resample from 3
  points. Use a deliberately wide population prior and say so.
- Estimates must be **decomposed to ≤ ~1 day units** before resampling; an unbroken
  multi-day item has no comparable history.

## 2. Reference-class forecasting (Kahneman, Lovallo, Flyvbjerg)

- **Outside view first, always.** Identify the class ("brownfield API change with
  external provider"), pull that class's empirical distribution, quote it, *then*
  consider the specifics. Inside-view-first estimation is planning-fallacy generation.
- **Bounded inside-view adjustment.** A shift of at most **one bucket** off the class
  quantile, and only with **named evidence** ("identical migration done twice this
  month, both ≤2h"). Unnamed intuition buys zero adjustment.
- **UK Green Book, inverted.** Optimism-bias uplifts are mandatory-by-default and
  reduced only against explicit mitigation. Applied here: **default to the class P85.
  Dropping to P50 requires naming the mitigation** that removes the tail (spec frozen,
  test harness exists, no external dependency).
- **IT/software class base rates:** mean cost overrun ≈ **73%**; **18% of projects sit
  in a tail averaging +447%**. The distribution is fat-tailed, not normal — the mean is
  not the typical case and the typical case is not the risk.
- Consequence: **quote P95 explicitly** for anything with an external dependency. A
  point estimate on a fat-tailed class is a category error.

## 3. Anchoring (Løhre & Jørgensen)

- An irrelevant number in the prompt shifts estimates by a factor of **4–5×**.
- The effect **survives explicit instructions to disregard it**, and survives the
  anchor coming from an **obviously non-credible source** ("a customer with no
  technical background guessed 2 hours").
- Therefore the pipeline must be **anchor-blind**: compute the class/history estimate
  *before* reading any stated deadline, ticket point value, or "should be quick". If an
  anchor has already been seen, state that it was seen and that the number is
  history-derived, not adjusted toward it.
- **Same-person re-estimate of an identical task deviates by 71%.** Human estimate
  consistency is too poor to be an input. **Calibrate from actuals only** — never from
  a remembered or restated estimate.

## 4. Flow metrics and Service Level Expectations (Vacanti)

- **Output form is a probabilistic SLE, not a duration:**
  *"85% of items like this finish in ≤ X."* Never "this will take X".
- **Right-sizing beats estimating.** If a candidate exceeds the class P85, the correct
  response is **split**, not a bigger number.
- **Sample-size gates** (state which gate you are at):
  - **5 items** → median usable, nothing more.
  - **11 items** → the observed range contains the next value ~90% of the time.
  - **10–20** → floor for publishing an upper limit.
  - **15 fresh points beat 150 stale ones.** Recency dominates volume.
- **Recency window ≈ 6 months.** Older data is a different system (different tooling,
  different codebase maturity) and biases toward the past regime.

## 5. Analogy-based estimation (Shepperd & Schofield)

- **k = 1–3 nearest neighbours** on task features. Larger k regresses to the mean and
  loses the discriminating power that made analogy work.
- **Accuracy stabilizes at ~10 analogues** in the case base — beyond that, feature
  quality matters more than count.
- **Feature selection beats equal weighting.** A few relevant features (same subsystem,
  same provider, same change type) outperform many equally-weighted ones.
- **Report the variance across the neighbours, not just the centre.** Three analogues at
  1h/1h/9h is a fundamentally different answer from 3h/3h/4h even though both centre
  near 3h.

## 6. Intervals: elicitation, representation, scoring

- **Stated 90% intervals empirically contain 60–70% of outcomes.** Human interval width
  is not calibrated to the stated confidence.
- Asking for **98% vs 80%** confidence changes interval width by only **0.44 vs 0.40
  (p = .4)** — i.e. the requested confidence level barely moves the answer.
- Consequence: **never elicit a confidence level. Impose the interval from history.**
  The quantile comes from the data; the human supplies features, not widths.
- **Work in log space.** Durations are multiplicative and right-skewed; use geometric
  means and log-space quantiles, then exponentiate. Arithmetic means on durations are
  dominated by the tail.
- **Scoring:** at small n, count **interval coverage** (did the outcome land inside the
  80% band?) and compare against binomial bands. As n grows, move to **WIS / CRPS** for
  a proper score that rewards sharpness *and* calibration.

## 7. COCOMO: what to salvage

The parametric model is dead — its coefficients were fit to a vanished waterfall
regime, and effort-multiplier calibration does not transfer. **The driver taxonomy
survives as a feature vocabulary** for the analogy/class lookup:

| Driver | Modern reading |
|---|---|
| Precedentedness | Have we done this exact shape before, in this repo? |
| Complexity | Blast radius: files, modules, call sites touched |
| Platform volatility | External API churn (third-party provider drift) |
| Context freshness | Is the relevant code already in context / recently touched? |
| Tooling | Test harness, repro path, deploy script exist? |
| External human dependency | Waiting on review, access, a decision, another team |
| Spec quality | Are acceptance criteria stated and testable? |

Use these as the feature set for nearest-neighbour matching and as the checklist that
justifies a one-bucket inside-view shift. Do not multiply coefficients.

## Rules the skill enforces from this

1. Resample whole historical ratios via Monte Carlo; never average velocity, never fit a curve over the tail.
2. Outside view first: name the reference class, quote its P85 by default, and drop to P50 only against a named mitigation.
3. Run anchor-blind — compute from history before reading any deadline, point value or "should be quick", and never treat a stated estimate as data.
4. Emit an SLE ("85% finish in ≤ X"), impose the interval from history rather than eliciting confidence, and recommend splitting anything above class P85.
5. Declare the sample gate (<6 → wide prior, 5 → median only, 11 → range, 10–20 → limits) and prefer 15 fresh points over 150 stale ones.
