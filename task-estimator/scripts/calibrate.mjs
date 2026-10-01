#!/usr/bin/env node
/**
 * calibrate.mjs — ledger -> calibration.json.
 *
 * Usage:
 *   node calibrate.mjs --tasks tasks.ndjson --out calibration.json
 *   node calibrate.mjs --ledger <ledgerDir> --out calibration.json   # reads <dir>/tasks.ndjson
 *   [--now <ISO>]   # pin the clock, for tests and reproducible runs
 *
 * Empirical quantiles only. No lognormal, no parametric fit of any kind: a
 * fitted lognormal lands at x0.72 of the true median and x1.72 at p95, while raw
 * empirical quantiles scored 49.9/79.8/89.9 against nominal 50/80/90.
 *
 * Recency: exponential decay, 90-day half-life (weight = 0.5^(age_days/90)),
 * applied as a weight inside the quantile, never as a cutoff.
 *
 * Rows the ledger holds but that are not a reference class for anything —
 * `noise` (permission probes, scratch-tree QA sessions) and `no_work: true`
 * (pure Q&A, nothing built) — are excluded from every quantile and counted in
 * `excluded`. They stay in tasks.ndjson; only the statistics ignore them.
 *
 * Sample gates are per group and are enforced by nulling out quantiles the group
 * has not earned:
 *   n < 5    prior-only   nothing quotable from the class
 *   5-9      p50-only     median only, no upper bound
 *   10-19    p85-ok       p50 + p80
 *   >= 20    p95-ok       p50 + p80 + p95
 */
import fs from 'node:fs';
import path from 'node:path';
import { readJsonl, round2, weightedQuantile, ts, parseArgs } from './lib.mjs';

const DAY = 86400000;
export const HALF_LIFE_DAYS = 90;
const METRICS = ['agent_hours', 'human_rounds', 'calendar_days'];

export function gateFor(n) {
  if (n < 5) return 'prior-only';
  if (n < 10) return 'p50-only';
  if (n < 20) return 'p85-ok';
  return 'p95-ok';
}
const ALLOWS = { 'prior-only': [], 'p50-only': ['p50'], 'p85-ok': ['p50', 'p80'], 'p95-ok': ['p50', 'p80', 'p95'] };

export function weightFor(task, nowMs) {
  const t = ts(task.ended_at) ?? ts(task.started_at) ?? ts(task.classified_at) ?? null;
  if (t === null) return 1; // undated rows are not penalised, only un-decayed
  const ageDays = Math.max(0, (nowMs - t) / DAY);
  return 0.5 ** (ageDays / HALF_LIFE_DAYS);
}

function summarize(rows, nowMs) {
  const n = rows.length;
  const gate = gateFor(n);
  const allowed = new Set(ALLOWS[gate]);
  const weighted_n = round2(rows.reduce((s, r) => s + weightFor(r, nowMs), 0));
  const out = { n, weighted_n, gate };
  for (const m of METRICS) {
    const pairs = rows
      .map((r) => ({ v: Number(r[m]), w: weightFor(r, nowMs) }))
      .filter((p) => Number.isFinite(p.v));
    const q = (p, key) => (allowed.has(key) && pairs.length ? round2(weightedQuantile(pairs, p)) : null);
    out[m] = { p50: q(0.5, 'p50'), p80: q(0.8, 'p80'), p95: q(0.95, 'p95') };
  }
  return out;
}

/** Classifier enums. A correction outside its field's list is the AUDITOR being
 *  out of spec, not the classifier being wrong, so it cannot count as a
 *  disagreement — it would report a prompt defect as a data defect. */
export const CLASSIFIER_ENUMS = {
  task_type: ['bugfix', 'feature', 'refactor', 'migration', 'infra', 'investigation', 'script'],
  novelty: ['pattern-copy', 'adaptation', 'novel'],
  spec_ambiguity: ['clear', 'medium', 'vague'],
  self_verifiable: ['tests', 'typecheck-only', 'human-eyes', 'prod-only'],
  outcome: ['shipped', 'shipped-then-reverted', 'abandoned', 'superseded', 'unknown'],
  flow_quality: ['clean', 'some-rework', 'thrash'],
};
const AUDIT_FIELDS = [...Object.keys(CLASSIFIER_ENUMS), 'external_waits', 'user_touchpoint_kinds'];
const RELIABLE_AT = 0.8;

/**
 * Per-field agreement from audit.ndjson.
 *
 * Reported on the STRIDE stratum, because that is the only unbiased sample: the
 * other strata are deliberately the hardest rows and their agreement is not a
 * population rate.
 *
 * Three kinds of correction are INADMISSIBLE and are discounted from the
 * adjusted rate, because each would report a defect somewhere else as a defect
 * in the classifier:
 *
 *   1. out of the field's own enum        — a different question answered
 *   2. `outcome -> unknown` against a commit/PR the ledger extracted from git
 *   3. a correction identical to the value already in the record — a `false`
 *      that contradicts itself, which prompts/audit-task.md forbids outright
 *
 * Separately, every field is ALSO reported on the rows the auditor called
 * well-stitched. That is not a discount and does not move `reliable`; it
 * localises the damage. Measured on this corpus: `task_type` agrees 0.52 on
 * stitch-`correct` rows and **0.00** on the 35% the auditor called
 * `over-merged` — which is not a coin flip, it is the signature of a question
 * with no answer. An over-merged row holds two or more units of work, so it has
 * no single true `task_type` and the auditor picks a different one every time.
 * The ledger's label is still wrong on those rows; the thing to fix is the
 * stitch, not the prompt.
 */
const hasArtifact = (t) => !!t && ((Number(t.commits) || 0) > 0 || (Array.isArray(t.prs) && t.prs.length > 0));

/**
 * A correction the auditor was not entitled to make.
 *
 * `outcome` is the one field where the ledger holds harder evidence than the
 * judge does. `commits` and `prs` are extracted from git and gh output over a
 * task's WHOLE transcript; the judge sees at most six chats, each truncated to
 * 7 KB, and is told to prefer `unknown` when the evidence does not settle it. So
 * "shipped -> unknown" on a row that records commits is the judge failing to see
 * evidence, not the ledger being wrong — measured here on the first clean audit:
 * 50 of 57 such corrections landed on rows with a commit, one of them on a row
 * with 61 of them.
 *
 * Discounted for the same reason an out-of-enum correction is: it would report a
 * prompt defect as a data defect. prompts/audit-task.md now states that these
 * fields are authoritative, so this counter should fall to ~0 on the next audit;
 * if it does not, the prompt is still wrong.
 */
function contradictsDeterministic(field, row, taskById) {
  if (field !== 'outcome') return false;
  return row.audit.corrections?.outcome === 'unknown' && hasArtifact(taskById.get(row.task_id));
}

/**
 * A `false` whose correction repeats the value already in the record. It asserts
 * a disagreement and then fails to name one, so there is nothing to score;
 * prompts/audit-task.md tells the judge to mark such a field `true` instead.
 */
function selfContradicting(field, row, taskById) {
  const c = row.audit.corrections?.[field];
  if (c == null) return false;
  const cur = taskById.get(row.task_id)?.[field];
  return cur != null && String(c) === String(cur);
}

const STITCH_OK = 'correct';

export function fieldReliability(audits, taskById = new Map()) {
  const ok = [...new Map(audits.filter((r) => r && r.ok && r.audit).map((r) => [r.task_id, r])).values()];
  const stride = ok.filter((r) => Array.isArray(r.strata) && r.strata.includes('stride'));
  const pop = stride.length >= 20 ? stride : ok;
  const verdicts = {};
  for (const r of pop) {
    const v = r.audit.stitch_verdict || 'unknown';
    verdicts[v] = (verdicts[v] || 0) + 1;
  }
  const out = {
    sample: stride.length >= 20 ? 'stride' : 'all',
    n: pop.length,
    audited_total: ok.length,
    // the auditor's own verdict on the ROW, reported beside the label rates
    // because it explains most of what is left of them
    stitch: {
      verdicts,
      over_merged_share: pop.length ? round2((verdicts['over-merged'] || 0) / pop.length) : null,
    },
    fields: {},
  };
  for (const f of AUDIT_FIELDS) {
    const seen = pop.filter((r) => typeof r.audit.agreements?.[f] === 'boolean');
    const dis = seen.filter((r) => r.audit.agreements[f] === false);
    const allowed = CLASSIFIER_ENUMS[f];
    const offSpec = allowed
      ? dis.filter((r) => { const c = r.audit.corrections?.[f]; return c != null && !allowed.includes(c); }).length
      : 0;
    const contradicts = dis.filter((r) => contradictsDeterministic(f, r, taskById)).length;
    const selfContra = dis.filter((r) => selfContradicting(f, r, taskById)).length;
    const rate = seen.length ? round2((seen.length - dis.length) / seen.length) : null;
    const discounted = offSpec + contradicts + selfContra;
    const scorable = dis.length - discounted;
    const adjusted = seen.length ? round2((seen.length - scorable) / seen.length) : null;
    // "unmeasured" is a claim about the PROMPT, so it needs more than one stray
    // correction to support it: the majority of the disagreements must be
    // inadmissible AND there must be at least two of them. One is an accident.
    const contaminated = dis.length ? (discounted >= 2 && discounted / dis.length >= 0.5) : false;

    // the same rate over the rows the auditor considered one unit of work
    const wellStitched = seen.filter((r) => r.audit.stitch_verdict === STITCH_OK);
    const wsRate = wellStitched.length
      ? round2(wellStitched.filter((r) => r.audit.agreements[f]).length / wellStitched.length)
      : null;

    out.fields[f] = {
      n: seen.length,
      agreement: rate,
      agreement_excluding_off_spec_corrections: adjusted,
      off_spec_corrections: offSpec,
      corrections_contradicting_deterministic_fields: contradicts,
      self_contradicting_corrections: selfContra,
      // diagnostic only — it never moves `reliable`, because the ledger really
      // does hold this label on the over-merged rows too
      n_well_stitched: wellStitched.length,
      agreement_on_well_stitched_rows: wsRate,
      reliable: contaminated ? null : adjusted != null && adjusted >= RELIABLE_AT,
      verdict: contaminated
        ? 'unmeasured — most of the auditor\'s corrections on this field were inadmissible '
          + '(outside its enum, contradicting a deterministically extracted field, or repeating '
          + 'the value already in the record); fix prompts/audit-task.md and re-audit before '
          + 'trusting either number'
        : adjusted == null ? 'no audit rows'
          : adjusted >= RELIABLE_AT ? 'reliable'
            : 'UNRELIABLE — below 0.8 agreement on admissible corrections; do not use in the '
              + 'feature vector without saying so'
              + (wsRate != null && wsRate >= RELIABLE_AT
                ? ` (it does clear the bar at ${wsRate} on the rows the auditor called well-stitched, `
                  + 'so the defect is the stitch, not the label)' : ''),
    };
  }
  return out;
}

/**
 * Rows that are in the ledger but must not shape a quantile.
 *
 *   `noise`         — permission probes and scratch-tree QA sessions. Real
 *                     transcripts, zero information about how long work takes.
 *   `no_work: true` — the classifier found no unit of work at all: pure Q&A,
 *                     a status check, a session that only read. These are the
 *                     single biggest distortion in this ledger — 127 of 426
 *                     rows — and they sit at the bottom of every class, so
 *                     leaving them in drags the median of "how long does a
 *                     bugfix take" toward "how long does answering a question
 *                     take". Reference-class forecasting needs the class to be
 *                     the same KIND of thing, not merely the same tag.
 *
 * Both stay in the ledger: they are evidence of how the days actually went, and
 * deleting them would quietly rewrite history. They are excluded here, and the
 * counts are reported so the exclusion is never invisible.
 */
export const isNoiseRow = (t) => typeof t.noise === 'string' && t.noise !== '';
export const isNoWorkRow = (t) => t.no_work === true;
export const isQuotable = (t) => !isNoiseRow(t) && !isNoWorkRow(t);

export function calibrate(tasks, nowMs, audits = null) {
  const all = tasks.filter((t) => t && (t.schema === 'task.v1' || t.task_id));
  const usable = all.filter(isQuotable);

  const noiseRows = all.filter(isNoiseRow);
  const byNoiseKind = {};
  for (const t of noiseRows) byNoiseKind[t.noise] = (byNoiseKind[t.noise] || 0) + 1;
  const excluded = {
    total: all.length - usable.length,
    noise: noiseRows.length,
    no_work: all.filter(isNoWorkRow).length,
    both: all.filter((t) => isNoiseRow(t) && isNoWorkRow(t)).length,
    by_noise_kind: Object.fromEntries(Object.keys(byNoiseKind).sort().map((k) => [k, byNoiseKind[k]])),
  };

  const byType = new Map();
  for (const t of usable) {
    const k = typeof t.task_type === 'string' && t.task_type ? t.task_type : null;
    if (!k) continue;
    if (!byType.has(k)) byType.set(k, []);
    byType.get(k).push(t);
  }
  const by_task_type = {};
  for (const k of [...byType.keys()].sort()) by_task_type[k] = summarize(byType.get(k), nowMs);

  // ---- the epic-slice reference class -------------------------------------
  // An epic is the unit of record and the wrong unit to quote: nobody is asked
  // "how long is a 76-hour integration", they are asked "how long is the webhook
  // part". `slice.mjs` cuts each epic into labelled sub-deliverables by PR, then
  // by label + time adjacency; every chat lands in exactly one slice, so the
  // slices sum back to their epic and nothing is counted twice. Those slices are
  // their own reference class — a class of "one deliverable inside a big piece of
  // work", which is a different animal from a standalone task of the same type
  // (it inherits the epic's context, its branch and its already-loaded code).
  // Kept OUTSIDE by_task_type on purpose: a slice is not a task row and must
  // never be mixed into the task quantiles.
  const sliceRows = [];
  const sliceEpics = new Set();
  let sliceNoWork = 0;
  for (const t of usable) {
    if (!Array.isArray(t.sub_tasks) || !t.sub_tasks.length) continue;
    sliceEpics.add(t.task_id);
    for (const s of t.sub_tasks) {
      if (s.no_work === true) { sliceNoWork++; continue; }
      sliceRows.push({
        epic_task_id: t.task_id,
        slug: s.slug,
        task_type: s.task_type ?? t.task_type ?? null,
        agent_hours: Number(s.agent_hours),
        human_rounds: Number(s.rounds),
        calendar_days: Number(s.calendar_days),
        started_at: s.started_at ?? t.started_at ?? null,
        ended_at: s.ended_at ?? t.ended_at ?? null,
      });
    }
  }
  const sliceByType = new Map();
  for (const s of sliceRows) {
    if (!s.task_type) continue;
    if (!sliceByType.has(s.task_type)) sliceByType.set(s.task_type, []);
    sliceByType.get(s.task_type).push(s);
  }
  const epicSliceByType = {};
  for (const k of [...sliceByType.keys()].sort()) epicSliceByType[k] = summarize(sliceByType.get(k), nowMs);
  const reference_classes = {
    'epic-slice': {
      ...summarize(sliceRows, nowMs),
      from_epics: sliceEpics.size,
      chats_per_epic_min: 6,
      excluded_no_work_slices: sliceNoWork,
      by_task_type: epicSliceByType,
    },
  };

  const perRound = usable.filter((t) => Number(t.human_rounds) > 0);
  const constPairs = (f) => perRound
    .map((t) => ({ v: f(t), w: weightFor(t, nowMs) }))
    .filter((p) => Number.isFinite(p.v));
  const agentPerRound = constPairs((t) => (Number(t.agent_hours) * 60) / Number(t.human_rounds));
  const waitPerRound = constPairs((t) => (Number(t.human_turnaround_hours) * 60) / Number(t.human_rounds));

  return {
    schema: 'calibration.v1',
    generated_at: new Date(nowMs).toISOString(),
    n_tasks: usable.length,
    n_tasks_in_ledger: all.length,
    excluded,
    half_life_days: HALF_LIFE_DAYS,
    metrics: METRICS,
    overall: summarize(usable, nowMs),
    by_task_type,
    reference_classes,
    per_round_constants: {
      n: perRound.length,
      agent_active_min_per_round_median: agentPerRound.length ? round2(weightedQuantile(agentPerRound, 0.5)) : null,
      human_turnaround_min_per_round_median: waitPerRound.length ? round2(weightedQuantile(waitPerRound, 0.5)) : null,
    },
    field_reliability: audits && audits.length
      // over ALL rows: an audited task that was excluded from the quantiles is
      // still a judgement of the classifier and still has to be scored
      ? fieldReliability(audits, new Map(all.map((t) => [t.task_id, t])))
      : null,
  };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  let tasksFile = typeof args.tasks === 'string' ? args.tasks : null;
  if (!tasksFile && typeof args.ledger === 'string') tasksFile = path.join(args.ledger, 'tasks.ndjson');
  if (!tasksFile) tasksFile = args._[0];
  if (!tasksFile) {
    process.stderr.write('usage: calibrate.mjs --tasks tasks.ndjson --out calibration.json [--now <ISO>]\n');
    process.exit(2);
  }
  const nowMs = typeof args.now === 'string' ? (ts(args.now) ?? Date.now()) : Date.now();
  const { records } = readJsonl(tasksFile);
  const auditFile = typeof args.audits === 'string' ? args.audits
    : path.join(path.dirname(path.resolve(tasksFile)), 'audit.ndjson');
  const audits = fs.existsSync(auditFile) ? readJsonl(auditFile).records : null;
  const cal = calibrate(records, nowMs, audits);
  const json = JSON.stringify(cal, null, 2) + '\n';
  if (typeof args.out === 'string') {
    fs.mkdirSync(path.dirname(path.resolve(args.out)), { recursive: true });
    fs.writeFileSync(args.out, json);
    process.stderr.write(`calibrate: ${cal.n_tasks} of ${cal.n_tasks_in_ledger} task(s) quotable `
      + `(excluded ${cal.excluded.total}: ${cal.excluded.no_work} no_work, ${cal.excluded.noise} noise), `
      + `overall gate ${cal.overall.gate} -> ${args.out}\n`);
  } else {
    process.stdout.write(json);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) main();
