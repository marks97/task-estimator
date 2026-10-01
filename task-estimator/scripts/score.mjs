#!/usr/bin/env node
/**
 * score.mjs — calibration OF THE ESTIMATOR, not of the tasks.
 *
 * calibrate.mjs answers "how long do tasks like this take?" from tasks.ndjson.
 * This answers the other question: "were the quotes any good?" — it joins
 * estimates.ndjson to tasks.ndjson and reports ratio, interval coverage,
 * signed bias in log space, and a WIS-lite decomposition.
 *
 * Usage:
 *   node score.mjs                          # $LEDGER/ledger
 *   node score.mjs --ledger <dir>           # <dir>/estimates.ndjson + tasks.ndjson
 *   node score.mjs --estimates a.ndjson --tasks b.ndjson
 *   node score.mjs --json                   # machine-readable, no prose
 *
 * Two rules this file exists to enforce:
 *
 *   1. NOTHING IS AVERAGED IN LINEAR SPACE. A ratio of 4x and a ratio of 0.25x
 *      are the same size error in opposite directions; their arithmetic mean is
 *      2.1x ("systematically over-running"), their geometric mean is 1.0
 *      ("unbiased, wildly dispersed"). Only the second is true. Bias is the
 *      MEDIAN of log(actual/quoted), dispersion is reported separately.
 *   2. SMALL n IS SAID OUT LOUD, WITH ITS BAND. Coverage is printed against the
 *      binomial acceptance band at the current n (measurement-model.md 5:
 *      "coverage bands are displayable from task one"). At n=1 that band is
 *      0..1 — which is the honest message, and it stops a first miss from being
 *      read as a broken estimator. WIS is withheld entirely below n=5.
 */
import fs from 'node:fs';
import path from 'node:path';
import { readJsonl, round2, parseArgs, resolveLedger, expandHome } from './lib.mjs';

/** Central interval the quotes are scored at (SKILL.md quotes a P50 + a band). */
export const ALPHA = 0.2;
export const NOMINAL_COVERAGE = 1 - ALPHA;
export const AXES = ['agent_hours', 'human_rounds', 'calendar_days'];
/** WIS is withheld below this; matches the n>=5 median gate in calibrate.mjs. */
export const WIS_MIN_N = 5;

const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : null);
const geoMid = (lo, hi) => (lo != null && hi != null && lo > 0 && hi > 0 ? Math.sqrt(lo * hi) : null);

/**
 * One axis of a quote, from whichever shape the row was written in.
 *
 * `p50` may be absent — some rows quote a rounds BAND and no centre.
 * Rather than drop the axis, the centre falls back to the band's geometric
 * midpoint (log-space midpoint, since the ladder is logarithmic) and says so in
 * `p50_source`, so a ratio computed against it is never mistaken for a ratio
 * against something the estimator actually said.
 */
function axis(p50, band, scale = 1) {
  const lo = Array.isArray(band) ? num(band[0]) : null;
  const hi = Array.isArray(band) ? num(band[1]) : null;
  const centre = num(p50);
  const s = (x) => (x == null ? null : round2(x * scale));
  return {
    p50: s(centre) ?? s(geoMid(lo, hi)),
    p50_source: centre != null ? 'quoted' : (geoMid(lo, hi) != null ? 'band-log-midpoint' : 'none'),
    lo: s(lo),
    hi: s(hi),
  };
}

/**
 * estimates.ndjson row -> estimate.v1, accepting both the canonical shape and
 * the two legacy ones (a hand-written band-only row, and the `quoted_quantiles`
 * shape SKILL.md used to document). Normalising on read instead of demanding a
 * migration means a quote logged by hand mid-conversation still scores.
 */
export function normalizeEstimate(row) {
  const q = row.quoted || {};
  const qq = row.quoted_quantiles || {};
  const ax = (name, legacyP50, legacyBand, scale = 1) => {
    const canonical = q[name];
    if (canonical && typeof canonical === 'object' && !Array.isArray(canonical)) {
      return axis(canonical.p50, [canonical.lo, canonical.hi]);
    }
    if (qq[name] && typeof qq[name] === 'object') {
      return axis(qq[name].p50, [qq[name].p50 ?? qq[name].p85, qq[name].p85]);
    }
    return axis(q[legacyP50], q[legacyBand], scale);
  };
  const cal = q.calendar_days || qq.calendar_days || q.calendar_days_band
    ? ax('calendar_days', 'calendar_days_p50', 'calendar_days_band')
    : axis(q.calendar_weeks_p50, q.calendar_weeks_band, 7);
  const date = typeof row.date === 'string' ? row.date : null;
  const task = row.task ?? row.task_slug ?? null;
  return {
    schema: 'estimate.v1',
    estimate_id: row.estimate_id ?? (date && task ? `${date}-${task}` : (date ?? task ?? 'unnamed')),
    date,
    task,
    ticket: row.ticket ?? null,
    task_desc_hash: row.task_desc_hash ?? null,
    features: row.features ?? null,
    class: row.class ?? (row.class_n != null ? { n: row.class_n, neighbors: row.neighbors ?? [] } : null),
    quoted: {
      agent_hours: ax('agent_hours', 'agent_h_p50', 'agent_h_band'),
      human_rounds: ax('human_rounds', 'rounds_p50', 'rounds_band'),
      calendar_days: cal,
    },
    source: row.source ?? null,
    outcome_note: row.outcome_note ?? null,
    _raw: row,
  };
}

const slugOf = (taskId) => String(taskId ?? '').split('/').slice(1).join('/').replace(/#\d+$/, '');
const norm = (s) => String(s ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

/**
 * Does this task row answer this estimate? Strongest evidence first.
 * `estimate_id` on the task row is written by record.mjs at link time, so a
 * link a human confirmed once is never re-guessed afterwards.
 */
export function matchEstimate(est, task) {
  if (!est || !task) return null;
  if (task.estimate_id && task.estimate_id === est.estimate_id) return 'estimate_id';
  if (est.ticket && norm(slugOf(task.task_id)) === norm(est.ticket)) return 'ticket';
  if (est.task_desc_hash && task.task_desc_hash === est.task_desc_hash) return 'task_desc_hash';
  if (est.task) {
    const t = norm(est.task);
    if (!t) return null;
    if (norm(slugOf(task.task_id)) === t) return 'slug';
    if (task.summary && norm(task.summary) === t) return 'summary';
    // a slice of an epic: `sub_tasks` is the MEASURED grouping (slice.mjs), so it
    // outranks `sub_deliverables`, which is the raw per-chat classifier label
    if (Array.isArray(task.sub_tasks) && task.sub_tasks.some((s) => norm(s.slug) === t)) {
      return 'sub_task';
    }
    if (Array.isArray(task.sub_deliverables) && task.sub_deliverables.some((s) => norm(s.slug) === t)) {
      return 'sub_deliverable';
    }
  }
  return null;
}

/**
 * The row a quote is actually scored against. For every match but `sub_task`
 * that is the task itself; for a slice it is the SLICE, because scoring "the
 * webhook part" against the epic's 76 hours would report a 60x miss on a quote
 * that was never about the epic. `rounds` is the slice's name for
 * `human_rounds`.
 */
export function actualsFor(est, task, how) {
  if (how !== 'sub_task') return task;
  const t = norm(est.task);
  const s = (task.sub_tasks || []).find((x) => norm(x.slug) === t);
  if (!s) return task;
  return {
    ...task,
    agent_hours: s.agent_hours,
    human_rounds: s.rounds,
    calendar_days: s.calendar_days,
    sub_task_slug: s.slug,
  };
}

export function findTaskFor(est, tasks) {
  const order = ['estimate_id', 'ticket', 'task_desc_hash', 'slug', 'summary', 'sub_task', 'sub_deliverable'];
  let best = null;
  for (const t of tasks) {
    const how = matchEstimate(est, t);
    if (!how) continue;
    if (!best || order.indexOf(how) < order.indexOf(best.how)) best = { task: t, how };
  }
  return best;
}

/** actual/quoted per axis, plus whether the actual landed inside the band. */
export function scoreOne(est, task, how = null) {
  const src = actualsFor(est, task, how);
  const axes = {};
  for (const a of AXES) {
    const q = est.quoted[a] || {};
    const actual = num(src[a]);
    const ratio = q.p50 != null && q.p50 > 0 && actual != null ? actual / q.p50 : null;
    const inside = q.lo != null && q.hi != null && actual != null ? actual >= q.lo && actual <= q.hi : null;
    axes[a] = {
      quoted_p50: q.p50 == null ? null : round2(q.p50),
      quoted_p50_source: q.p50_source,
      band: q.lo == null || q.hi == null ? null : [round2(q.lo), round2(q.hi)],
      actual,
      ratio: ratio == null ? null : round2(ratio),
      log_ratio: ratio != null && ratio > 0 ? round2(Math.log(ratio)) : null,
      inside,
      verdict: inside == null ? 'unscorable'
        : inside ? 'inside band'
          : actual > q.hi ? `over by ${round2(actual / q.hi)}x the upper bound`
            : `under by ${round2(q.lo / actual || 0)}x the lower bound`,
    };
  }
  return {
    estimate_id: est.estimate_id,
    task_id: task.task_id,
    matched_by: how,
    // when a quote was about one slice of an epic, say which — the task_id alone
    // would read as a quote against the whole epic
    sub_task: src.sub_task_slug ?? null,
    scored_at: new Date().toISOString(),
    outcome: task.outcome ?? null,
    axes,
    axes_inside: AXES.filter((a) => axes[a].inside === true).length,
    axes_scorable: AXES.filter((a) => axes[a].inside != null).length,
  };
}

// ---- aggregate statistics --------------------------------------------------

/** exp(mean(ln r)). The only defensible average of a ratio. */
export function geoMeanRatio(ratios) {
  const rs = ratios.filter((r) => Number.isFinite(r) && r > 0);
  if (!rs.length) return null;
  return Math.exp(rs.reduce((s, r) => s + Math.log(r), 0) / rs.length);
}

export function medianLogRatio(ratios) {
  const ls = ratios.filter((r) => Number.isFinite(r) && r > 0).map(Math.log).sort((a, b) => a - b);
  if (!ls.length) return null;
  const m = Math.floor(ls.length / 2);
  return ls.length % 2 ? ls[m] : (ls[m - 1] + ls[m]) / 2;
}

function binomCdf(k, n, p) {
  let cum = 0;
  let term = (1 - p) ** n;
  for (let i = 0; i <= k; i++) {
    if (i > 0) term *= ((n - i + 1) / i) * (p / (1 - p));
    cum += term;
  }
  return Math.min(1, cum);
}

const binomPpf = (q, n, p) => {
  for (let k = 0; k <= n; k++) if (binomCdf(k, n, p) >= q - 1e-12) return k;
  return n;
};

/**
 * Binomial acceptance band for an observed coverage rate: the range of k/n a
 * correctly calibrated estimator produces 90% of the time. At n=1 it is [0,1] —
 * i.e. one miss proves nothing, which is exactly what needs saying at n=1.
 */
export function coverageBand(n, p = NOMINAL_COVERAGE, level = 0.9) {
  if (!n) return null;
  const tail = (1 - level) / 2;
  return [binomPpf(tail, n, p) / n, binomPpf(1 - tail, n, p) / n];
}

/**
 * WIS-lite: the weighted interval score at the single central (1-ALPHA)
 * interval, decomposed into the three things it is a sum of.
 *
 *   IS = (u - l) + (2/a)(l - y)1{y<l} + (2/a)(y - u)1{y>u}
 *        \_______/   \______________/   \______________/
 *        sharpness    overprediction     underprediction
 *
 * Each term is divided by the quoted centre before averaging, so a 3-hour task
 * and a 150-hour task contribute comparably. The shares are what to read: a
 * score dominated by sharpness means the bands are too wide, one dominated by
 * underprediction means the quotes are too low.
 */
export function wisLite(pairs, alpha = ALPHA) {
  const rows = [];
  for (const { l, u, y, c } of pairs) {
    if (![l, u, y, c].every((v) => Number.isFinite(v)) || c <= 0) continue;
    const sharp = (u - l) / c;
    const over = ((2 / alpha) * Math.max(0, l - y)) / c;
    const under = ((2 / alpha) * Math.max(0, y - u)) / c;
    rows.push({ sharp, over, under, total: sharp + over + under });
  }
  if (rows.length < WIS_MIN_N) return { n: rows.length, withheld: true, min_n: WIS_MIN_N };
  const mean = (f) => rows.reduce((s, r) => s + f(r), 0) / rows.length;
  const wis = mean((r) => r.total);
  return {
    n: rows.length,
    withheld: false,
    wis_normalized: round2(wis),
    sharpness: round2(mean((r) => r.sharp)),
    overprediction: round2(mean((r) => r.over)),
    underprediction: round2(mean((r) => r.under)),
    shares: wis > 0 ? {
      sharpness: round2(mean((r) => r.sharp) / wis),
      overprediction: round2(mean((r) => r.over) / wis),
      underprediction: round2(mean((r) => r.under) / wis),
    } : null,
  };
}

export function scoreLedger(estimateRows, taskRows) {
  const estimates = estimateRows.map(normalizeEstimate);
  const tasks = taskRows.filter((t) => t && (t.schema === 'task.v1' || t.task_id));
  const scored = [];
  const pending = [];
  for (const est of estimates) {
    const hit = findTaskFor(est, tasks);
    if (hit) scored.push({ est, ...scoreOne(est, hit.task, hit.how) });
    else pending.push(est);
  }

  const per_axis = {};
  for (const a of AXES) {
    const rows = scored.map((s) => s.axes[a]);
    const ratios = rows.map((r) => r.ratio).filter((r) => Number.isFinite(r) && r > 0);
    const insides = rows.map((r) => r.inside).filter((v) => typeof v === 'boolean');
    const covered = insides.filter(Boolean).length;
    const gm = geoMeanRatio(ratios);
    const mlr = medianLogRatio(ratios);
    per_axis[a] = {
      n_scored: ratios.length,
      geometric_mean_ratio: gm == null ? null : round2(gm),
      median_log_ratio: mlr == null ? null : round2(mlr),
      bias: mlr == null ? 'no data'
        : Math.abs(mlr) < 0.05 ? 'unbiased so far'
          : mlr > 0 ? `under-quoting by ~${round2(Math.exp(mlr))}x (actuals run long)`
            : `over-quoting by ~${round2(1 / Math.exp(mlr))}x (actuals come in short)`,
      coverage: insides.length ? { k: covered, n: insides.length, rate: round2(covered / insides.length) } : null,
      coverage_band_90pct: coverageBand(insides.length),
      wis_lite: wisLite(rows.map((r) => ({
        l: r.band?.[0], u: r.band?.[1], y: r.actual, c: r.quoted_p50,
      }))),
    };
  }

  return {
    schema: 'estimator-score.v1',
    generated_at: new Date().toISOString(),
    nominal_coverage: NOMINAL_COVERAGE,
    n_estimates: estimates.length,
    n_scored: scored.length,
    n_awaiting_actuals: pending.length,
    gate: scored.length < WIS_MIN_N ? 'too-early' : 'scorable',
    per_estimate: scored.map((s) => ({
      estimate_id: s.estimate_id,
      task_id: s.task_id,
      matched_by: s.matched_by,
      outcome: s.outcome,
      axes: s.axes,
    })),
    awaiting_actuals: pending.map((e) => ({
      estimate_id: e.estimate_id, date: e.date, task: e.task, class_n: e.class?.n ?? null,
    })),
    per_axis,
  };
}

// ---- rendering -------------------------------------------------------------

const fmt = (v) => (v == null ? '—' : typeof v === 'number' ? String(round2(v)) : String(v));

export function render(rep) {
  const L = [];
  L.push(`ESTIMATOR CALIBRATION — ${rep.n_scored} of ${rep.n_estimates} quote(s) have actuals`);
  L.push('='.repeat(72));

  if (rep.n_estimates === 0) {
    L.push('No quotes logged yet. estimate mode appends one per quote (SKILL.md, estimate step 8);');
    L.push('until it has, there is nothing to score and calibration is prior-only by definition.');
    return L.join('\n');
  }

  if (rep.per_estimate.length) {
    L.push('', 'Per-estimate ratios (actual / quoted centre):');
    for (const e of rep.per_estimate) {
      L.push(`  ${e.estimate_id}  ->  ${e.task_id}   [matched by ${e.matched_by}; outcome ${fmt(e.outcome)}]`);
      for (const a of AXES) {
        const x = e.axes[a];
        const band = x.band ? `[${fmt(x.band[0])}, ${fmt(x.band[1])}]` : '—';
        const centre = `${fmt(x.quoted_p50)}${x.quoted_p50_source === 'band-log-midpoint' ? '*' : ''}`;
        L.push(`      ${a.padEnd(14)} quoted ${centre.padStart(8)} band ${band.padEnd(18)}`
          + ` actual ${fmt(x.actual).padStart(8)}  ratio ${fmt(x.ratio).padStart(6)}x  ${x.verdict}`);
      }
    }
    if (rep.per_estimate.some((e) => AXES.some((a) => e.axes[a].quoted_p50_source === 'band-log-midpoint'))) {
      L.push('  * centre not quoted on that axis; the band\'s log midpoint stands in, so the ratio is');
      L.push('    against a derived centre, not against something the estimator actually said.');
    }
  }

  if (rep.awaiting_actuals.length) {
    L.push('', 'Awaiting actuals (quoted, not yet recorded):');
    for (const e of rep.awaiting_actuals) {
      L.push(`  ${e.estimate_id}  (${fmt(e.date)}, class n=${fmt(e.class_n)}) — run record.mjs when it lands`);
    }
  }

  L.push('', `Per axis (nominal interval coverage ${Math.round(rep.nominal_coverage * 100)}%):`);
  for (const a of AXES) {
    const p = rep.per_axis[a];
    const cov = p.coverage ? `${p.coverage.k}/${p.coverage.n} = ${Math.round(p.coverage.rate * 100)}%` : '—';
    const band = p.coverage_band_90pct
      ? `${Math.round(p.coverage_band_90pct[0] * 100)}–${Math.round(p.coverage_band_90pct[1] * 100)}%`
      : '—';
    L.push(`  ${a}`);
    L.push(`      n=${p.n_scored}  geometric mean ratio ${fmt(p.geometric_mean_ratio)}x  (${p.bias})`);
    L.push(`      coverage ${cov}   binomial acceptance band at this n: ${band}`);
    if (p.wis_lite.withheld) {
      L.push(`      WIS-lite: withheld (n=${p.wis_lite.n}, needs ${p.wis_lite.min_n})`);
    } else {
      const w = p.wis_lite;
      L.push(`      WIS-lite ${w.wis_normalized} = sharpness ${w.sharpness} + over ${w.overprediction} + under ${w.underprediction}`
        + (w.shares ? `  (shares ${Math.round(w.shares.sharpness * 100)}/${Math.round(w.shares.overprediction * 100)}/${Math.round(w.shares.underprediction * 100)}%)` : ''));
    }
  }

  if (rep.gate === 'too-early') {
    L.push('', 'TOO EARLY TO CALL — READ THIS BEFORE READING ANY NUMBER ABOVE'.padEnd(0));
    L.push('-'.repeat(72));
    L.push(`${rep.n_scored} scored quote(s) is below the n=${WIS_MIN_N} gate. What that means concretely:`);
    L.push('  · Coverage is uninformative. The 90% binomial acceptance band above spans nearly');
    L.push('    the whole 0–100% range at this n, so neither a hit nor a miss is evidence.');
    L.push('  · The geometric mean ratio is a single observation wearing a statistic\'s hat.');
    L.push('    Report it as "the one quote we have came in Nx", never as a bias correction.');
    L.push('  · WIS is withheld deliberately, not missing.');
    L.push('  · Do NOT feed these numbers back into an estimate as an EBS ratio distribution.');
    L.push(`    EBS resampling needs a population of ratios; it has ${rep.n_scored}.`);
    L.push(`  Next: ${WIS_MIN_N - rep.n_scored} more recorded quote/actual pair(s) turn this on.`);
  }
  return L.join('\n');
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const ledgerDir = args.ledger
    ? expandHome(String(args.ledger))
    : path.join(resolveLedger(), 'ledger');
  const estFile = expandHome(String(args.estimates ?? path.join(ledgerDir, 'estimates.ndjson')));
  const tasksFile = expandHome(String(args.tasks ?? path.join(ledgerDir, 'tasks.ndjson')));
  for (const f of [estFile, tasksFile]) {
    if (!fs.existsSync(f)) {
      process.stderr.write(`score: missing ${f} — run setup/backfill first\n`);
      process.exit(2);
    }
  }
  const rep = scoreLedger(readJsonl(estFile).records, readJsonl(tasksFile).records);
  process.stdout.write(args.json ? `${JSON.stringify(rep, null, 2)}\n` : `${render(rep)}\n`);
}

if (import.meta.url === `file://${process.argv[1]}`) main();
