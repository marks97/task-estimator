#!/usr/bin/env node
/**
 * record.mjs — record mode, end to end: one session -> the ledger -> a score.
 *
 * Usage:
 *   node record.mjs --session <uuid|path/to.jsonl> [--project <dir-name>]
 *   node record.mjs --latest --project -path-to-your-project
 *   node record.mjs --session <id> --outcome shipped --estimate-id 2026-08-31-add-csv-export
 *   node record.mjs --session <id> --dry-run          # print the row, write nothing
 *
 *   --ledger <dir>   ledger dir override (default: $LEDGER/ledger)
 *   --root <dir>     transcripts root for --session <uuid> / --latest lookups
 *   --ticket KEY     force the rework join key when the transcript never names it
 *   --in-progress    the task is still open; outcome stays `unknown`, honestly sourced
 *   --no-calibrate   skip the calibrate.mjs re-run
 *   --json           machine-readable output
 *   --force-lock     take the ledger lock even if another writer holds it
 *
 * What it does, in SKILL.md's record order:
 *   1. extract this session (extract.mjs), upsert it into chats.ndjson
 *   2. re-stitch and take the component this chat landed in — a RESUMED session
 *      is the same task continuing, and stitch already follows parent edges, so
 *      nothing here splits a task by clock
 *   3. charge REWORK to the original row: a fix sharing a PR or ticket with an
 *      existing task, landing within REWORK_WINDOW_DAYS, merges into that row
 *      and keeps its task_id, instead of filing itself as a fresh success
 *   4. decide `outcome` from the artifact, never from a done-claim
 *   5. if a quote in estimates.ndjson matches, score it (ratio + inside-band)
 *   6. re-slice the epics, then re-run calibrate.mjs, so the next estimate
 *      already sees this point
 *
 * Everything except step 6 is pure and exported, so each branch can be driven
 * against synthetic records without touching the real ledger.
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  readJsonl, round2, uniqSorted, ts, parseArgs, resolveLedger, expandHome,
  writeNdjsonAtomic, acquireLock,
} from './lib.mjs';
import { extractFile } from './extract.mjs';
import { stitch, dedupeShas, eligibleTicketKeys } from './stitch.mjs';
import { sidecarSignature } from './backfill.mjs';
import { sliceAll } from './slice.mjs';
import { normalizeEstimate, matchEstimate, scoreOne, AXES } from './score.mjs';

const DAY = 86400000;

/**
 * SKILL.md: "a fix landing within 14 days merges into that row". The window is a
 * published choice, not a discovery — the human-gap distribution is unimodal and
 * offers no natural cut (measurement-model.md 3), so it is named here and can be
 * moved with --rework-days rather than being buried in a conditional.
 */
export const REWORK_WINDOW_DAYS = 14;

/** Semantic fields a re-stitch must not destroy (same list backfill.mjs carries). */
const SEMANTIC = [
  'task_type', 'novelty', 'self_verifiable', 'spec_ambiguity', 'outcome', 'external_waits',
  'user_touchpoint_kinds', 'flow_quality', 'summary', 'classified_at', 'classifier_model',
  'classifier_confidence', 'sub_deliverables', 'chat_labels', 'classifier_outcome',
  'outcome_source', 'main_chat_id', 'no_work', 'classified_chats',
];

const OUTCOMES = ['shipped', 'shipped-then-reverted', 'abandoned', 'superseded', 'unknown'];
/**
 * The two verdicts an artifact cannot express. A commit proves code landed; it
 * cannot prove the code was later reverted or the effort abandoned, so these
 * survive an artifact while `shipped`/`superseded` do not (classify.mjs applies
 * the same rule to the classifier's verdict).
 */
const ARTIFACT_IMMUNE = new Set(['shipped-then-reverted', 'abandoned']);

const hasArtifact = (t) => (Number(t.commits) || 0) > 0 || (Array.isArray(t.prs) && t.prs.length > 0);

/**
 * `done` means merged or accepted — an agent saying "done" overstates completion
 * ~7x, so a user-supplied outcome never beats a recorded artifact except for the
 * two verdicts above.
 */
export function decideOutcome(row, userOutcome = null) {
  const user = OUTCOMES.includes(userOutcome) ? userOutcome : null;
  if (user && ARTIFACT_IMMUNE.has(user)) return { outcome: user, outcome_source: 'user' };
  if (hasArtifact(row)) return { outcome: 'shipped', outcome_source: 'deterministic' };
  if (user) return { outcome: user, outcome_source: 'user' };
  return { outcome: 'unknown', outcome_source: 'none' };
}

// ---- session resolution ----------------------------------------------------

export function transcriptRoots(explicit = null) {
  if (explicit) return [expandHome(explicit)];
  const home = process.env.HOME || '';
  return [
    path.join(home, '.claude', 'projects'),
  ].filter((d) => fs.existsSync(d));
}

const jsonlIn = (dir) => {
  try {
    return fs.readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isFile() && e.name.endsWith('.jsonl'))
      .map((e) => path.join(dir, e.name));
  } catch { return []; }
};

function dirsUnder(root, project) {
  if (project) {
    // Accept a transcript-dir slug, an absolute transcript dir, or a plain cwd
    // (e.g. "$(pwd)"): a cwd is slugified the way Claude Code names project dirs
    // (every "/" and "." becomes "-", so /home/you/a.b -> -home-you-a-b).
    const candidates = [];
    if (path.isAbsolute(project)) {
      candidates.push(project, path.join(root, project.replace(/[/.]/g, '-')));
    } else {
      candidates.push(path.join(root, project));
    }
    return candidates.filter((p) => fs.existsSync(p) && jsonlIn(p).length > 0);
  }
  const out = [root];
  try {
    for (const e of fs.readdirSync(root, { withFileTypes: true })) {
      if (e.isDirectory()) out.push(path.join(root, e.name));
    }
  } catch { /* unreadable root */ }
  return out;
}

/** `--session` accepts a path or a bare session id; `--latest` takes newest mtime. */
export function resolveSessionFile({ session = null, latest = false, project = null, root = null }) {
  if (session && session.endsWith('.jsonl') && fs.existsSync(expandHome(session))) {
    return path.resolve(expandHome(session));
  }
  const roots = transcriptRoots(root);
  const candidates = [];
  for (const r of roots) for (const d of dirsUnder(r, project)) candidates.push(...jsonlIn(d));
  if (session) {
    const id = session.replace(/\.jsonl$/i, '');
    const hit = candidates.find((f) => path.basename(f) === `${id}.jsonl`);
    if (hit) return hit;
    throw new Error(`no transcript named ${id}.jsonl under ${roots.join(', ')}`);
  }
  if (latest) {
    const withTime = candidates.map((f) => ({ f, m: fs.statSync(f).mtimeMs })).sort((a, b) => b.m - a.m);
    if (!withTime.length) throw new Error(`no transcripts under ${roots.join(', ')}`);
    return withTime[0].f;
  }
  throw new Error('give --session <id|path> or --latest [--project <dir>]');
}

// ---- aggregation -----------------------------------------------------------

const setOf = (arr) => new Set(Array.isArray(arr) ? arr.filter((x) => x != null && x !== '') : []);

/**
 * Roll a set of chat rows up into one task.v1 row.
 *
 * This is stitch.mjs's aggregation applied to a membership decided elsewhere —
 * needed because the rework rule merges rows stitch deliberately left apart (a
 * ticket key its fan-out guard denied, or one only the human knows about). It
 * re-derives from the CHATS rather than adding two task rows together, so
 * `files` stays a set union and `commits` stays sha-deduped instead of
 * double-counting a sha both rows recorded.
 */
export function aggregateChats(chatRows, { task_id, stitch_signals = [], stitch_confidence = 'high' }) {
  const members = [...chatRows].sort(
    (a, b) => (ts(a.started_at) ?? 0) - (ts(b.started_at) ?? 0) || String(a.chat_id).localeCompare(String(b.chat_id)),
  );
  const sum = (f) => members.reduce((s, c) => s + (Number(f(c)) || 0), 0);
  const starts = members.map((c) => ts(c.started_at)).filter((t) => t != null);
  const ends = members.map((c, i) => ts(c.ended_at) ?? starts[i]).filter((t) => t != null);
  const startedAt = starts.length ? Math.min(...starts) : null;
  const endedAt = ends.length ? Math.max(...ends) : startedAt;
  const files = new Set(members.flatMap((c) => c.files_edited || []));
  const prMap = new Map();
  for (const c of members) for (const p of c.pr_links || []) prMap.set(`${p.prRepository}#${p.prNumber}`, p);
  const shas = dedupeShas(members.flatMap((c) => c.commit_shas || []));
  const repos = uniqSorted(members.flatMap((c) => c.repos_touched || []));

  return {
    schema: 'task.v1',
    task_id,
    chats: members.map((c) => c.chat_id),
    stitch_signals: uniqSorted(stitch_signals),
    stitch_confidence,
    started_at: startedAt != null ? new Date(startedAt).toISOString() : null,
    ended_at: endedAt != null ? new Date(endedAt).toISOString() : null,
    agent_hours: round2(sum((c) => c.agent_active_min) / 60),
    human_rounds: sum((c) => c.human_rounds),
    awaiting_hours: round2(sum((c) => c.awaiting_min) / 60),
    human_turnaround_hours: round2(sum((c) => c.human_turnaround_min) / 60),
    calendar_days: startedAt != null ? Math.max(1, Math.ceil(Math.max(0, endedAt - startedAt) / DAY)) : null,
    files: files.size,
    loc_delta: sum((c) => c.loc_added) - sum((c) => c.loc_removed),
    repos,
    commits: shas.length,
    prs: [...prMap.values()],
    subagent_count: sum((c) => c.subagents?.count),
    subagent_loc_added: sum((c) => c.subagents?.loc_added),
    subagent_loc_removed: sum((c) => c.subagents?.loc_removed),
    compactions: sum((c) => c.compactions?.count),
  };
}

const prKeys = (row) => new Set((row.prs || []).map((p) => `${p.prRepository}#${p.prNumber}`));

/** Ticket keys a task row can legitimately be joined on (stitch's guard applies). */
export function ticketKeysOfTask(task, chatsById, eligible) {
  const out = new Set();
  for (const id of task.chats || []) {
    for (const k of chatsById.get(id)?.ticket_keys || []) if (!eligible || eligible.has(k)) out.add(k);
  }
  return out;
}

/**
 * Rework, charged back to the original item (EBS: filing a fix as a new task is
 * how a history silently reports itself as accurate).
 *
 * Only fires where stitch could not: stitch already merges on a shared pr-link
 * unconditionally and on an ELIGIBLE ticket key, so a candidate here is one
 * whose join key its fan-out guard denied, or one supplied by hand via --ticket.
 * The window is directional — the candidate must have ENDED before this work
 * started (or overlap it); a row that starts later is not the original.
 */
export function findReworkTarget(row, priorRows, chatsById, {
  windowDays = REWORK_WINDOW_DAYS, forcedTicket = null, eligible = null,
} = {}) {
  const mine = prKeys(row);
  const myTickets = ticketKeysOfTask(row, chatsById, eligible);
  if (forcedTicket) myTickets.add(forcedTicket);
  const myStart = ts(row.started_at);
  if (myStart == null) return null;
  let best = null;
  for (const prior of priorRows) {
    if (prior.task_id === row.task_id) continue;
    if ((prior.chats || []).some((c) => row.chats.includes(c))) continue;
    const sharedPr = [...prKeys(prior)].filter((k) => mine.has(k));
    const sharedTicket = [...ticketKeysOfTask(prior, chatsById, eligible)].filter((k) => myTickets.has(k));
    if (!sharedPr.length && !sharedTicket.length) continue;
    const priorEnd = ts(prior.ended_at) ?? ts(prior.started_at);
    if (priorEnd == null) continue;
    const gapDays = (myStart - priorEnd) / DAY;
    if (gapDays > windowDays) continue;      // too old: a genuinely separate item
    if (gapDays < -windowDays) continue;     // the "original" starts long after: not it
    const cand = {
      task: prior,
      gap_days: round2(Math.max(0, gapDays)),
      signal: sharedPr.length ? 'pr-link' : 'ticket-key',
      key: (sharedPr[0] ?? sharedTicket[0]),
    };
    if (!best || Math.abs(gapDays) < Math.abs((myStart - (ts(best.task.ended_at) ?? 0)) / DAY)) best = cand;
  }
  return best;
}

// ---- the record pass -------------------------------------------------------

const carrySemantics = (target, source) => {
  for (const k of SEMANTIC) if (source && source[k] !== undefined) target[k] = source[k];
};

/**
 * Pure core: chats + prior tasks + estimates -> the new ledger state.
 * No file IO, so every branch can be driven in isolation.
 */
export function recordFromChats({
  chat, chats, priorTasks, estimates = [], outcome = null, estimateId = null,
  forcedTicket = null, windowDays = REWORK_WINDOW_DAYS, inProgress = false, now = Date.now(),
}) {
  const all = [...chats.filter((c) => c.chat_id !== chat.chat_id), chat];
  const chatsById = new Map(all.map((c) => [c.chat_id, c]));
  const stitched = stitch(all);
  const group = stitched.find((t) => t.chats.includes(chat.chat_id));
  if (!group) throw new Error(`stitch lost chat ${chat.chat_id}`);

  // rows this stitch supersedes: anything sharing a chat with the new component
  const groupChats = new Set(group.chats);
  const superseded = priorTasks.filter((t) => (t.chats || []).some((c) => groupChats.has(c)));
  const survivors = priorTasks.filter((t) => !superseded.includes(t));

  let row = { ...group };
  // the longest-lived superseded row is the best source of already-merged semantics
  const donor = superseded.slice().sort((a, b) => (b.chats?.length || 0) - (a.chats?.length || 0))[0] ?? null;
  carrySemantics(row, donor);

  const eligible = eligibleTicketKeys(all);
  const rework = findReworkTarget(row, survivors, chatsById, { windowDays, forcedTicket, eligible });
  if (rework) {
    // the original is REPLACED by the merged row, never left standing beside it —
    // two rows for one item is exactly the double-count the rework rule prevents
    survivors.splice(survivors.indexOf(rework.task), 1);
    const merged = aggregateChats(
      [...new Set([...rework.task.chats, ...row.chats])].map((id) => chatsById.get(id)).filter(Boolean),
      {
        task_id: rework.task.task_id,                     // the ORIGINAL keeps its identity
        stitch_signals: [...(rework.task.stitch_signals || []), ...(row.stitch_signals || []), 'rework-merge'],
        stitch_confidence: 'medium',
      },
    );
    carrySemantics(merged, rework.task);
    merged.rework_merges = [
      ...(rework.task.rework_merges || []),
      {
        merged_chats: row.chats,
        via: rework.signal,
        key: rework.key ?? null,
        gap_days: rework.gap_days,
        window_days: windowDays,
        merged_at: new Date(now).toISOString(),
      },
    ];
    row = merged;
  }

  const decided = decideOutcome(row, inProgress ? 'unknown' : outcome);
  // never overwrite a deterministic outcome with a judgement call
  if (!(row.outcome_source === 'deterministic' && decided.outcome_source === 'user')) {
    row.outcome = decided.outcome;
    row.outcome_source = inProgress && decided.outcome_source !== 'deterministic'
      ? 'in-progress' : decided.outcome_source;
  }
  row.recorded_at = new Date(now).toISOString();
  row.record_source = 'record.mjs';

  // ---- score against a logged quote ---------------------------------------
  const normalized = estimates.map(normalizeEstimate);
  let est = null;
  let how = null;
  if (estimateId) {
    est = normalized.find((e) => e.estimate_id === estimateId) ?? null;
    how = est ? 'explicit' : null;
    if (!est) throw new Error(`--estimate-id ${estimateId} not found in estimates.ndjson`);
  } else {
    for (const e of normalized) {
      const m = matchEstimate(e, row);
      if (m) { est = e; how = m; break; }
    }
  }
  let score = null;
  if (est) {
    row.estimate_id = est.estimate_id;
    score = scoreOne(est, row, how);
  }

  const outEstimates = estimates.map((raw) => {
    const n = normalizeEstimate(raw);
    if (!est || n.estimate_id !== est.estimate_id) return raw;
    return {
      ...raw,
      actual: {
        task_id: row.task_id,
        agent_hours: row.agent_hours,
        human_rounds: row.human_rounds,
        calendar_days: row.calendar_days,
        outcome: row.outcome,
        recorded_at: row.recorded_at,
      },
      score,
    };
  });

  const outTasks = [...survivors, row].sort(
    (a, b) => String(a.started_at).localeCompare(String(b.started_at)) || String(a.task_id).localeCompare(String(b.task_id)),
  );

  return {
    row,
    tasks: outTasks,
    estimates: outEstimates,
    superseded: superseded.map((t) => t.task_id),
    rework: rework ? { task_id: rework.task.task_id, via: rework.signal, key: rework.key, gap_days: rework.gap_days } : null,
    score,
    matched_estimate: est ? { estimate_id: est.estimate_id, matched_by: how } : null,
    stitch_group_size: group.chats.length,
    stitch_signals: row.stitch_signals,
  };
}

/** One paragraph, for a human. Deliberately mentions what was NOT measured. */
export function summarize(res, { chat, dryRun = false }) {
  const r = res.row;
  const bits = [];
  bits.push(`${dryRun ? 'DRY RUN — would record' : 'Recorded'} ${chat.chat_id.slice(0, 8)} as task \`${r.task_id}\``);
  bits.push(res.stitch_group_size > 1
    ? `stitched together with ${res.stitch_group_size - 1} other chat(s) via ${(r.stitch_signals || []).join(' + ') || 'no signal'} (confidence ${r.stitch_confidence})`
    : 'a single-chat task (no stitch edges to anything else)');
  if (res.rework) {
    bits.push(`merged as REWORK into the existing row \`${res.rework.task_id}\` on a shared ${res.rework.via} `
      + `(${res.rework.key}) ${res.rework.gap_days}d later, so the fix is charged to the original item`);
  }
  bits.push(`it cost ${r.agent_hours}h of agent-active time across ${r.human_rounds} human round(s), `
    + `${r.awaiting_hours}h waiting on approvals and ${r.human_turnaround_hours}h waiting on the human, `
    + `over ${r.calendar_days} calendar day(s), touching ${r.files} file(s) in ${r.repos.join(', ') || 'no detected repo'} `
    + `(${r.commits} commit(s), ${r.prs.length} PR(s))`);
  // Delegated work is reported separately and NEVER folded into agent_hours: on a
  // fan-out session the subagents can outweigh the main thread several times over,
  // and a summary that omits them describes a fraction of the task.
  if (Number(r.subagent_count) > 0) {
    bits.push(`plus ${r.subagent_count} subagent(s)`
      + (Number.isFinite(Number(r.subagent_hours)) ? ` costing ${r.subagent_hours}h` : '')
      + (Number.isFinite(Number(r.subagent_files)) ? ` across ${r.subagent_files} file(s)` : '')
      + ', counted separately from the main thread and not folded into agent_hours');
  }
  bits.push(`outcome \`${r.outcome}\` sourced \`${r.outcome_source}\``
    + (r.outcome_source === 'deterministic' ? ' — from the artifact, not from a done-claim' : ''));
  if (res.score) {
    const parts = AXES.map((a) => {
      const x = res.score.axes[a];
      return `${a} ${x.ratio == null ? 'unscorable' : `${x.ratio}x quoted`}${x.inside == null ? '' : x.inside ? ', inside band' : ', OUTSIDE band'}`;
    });
    bits.push(`scored against quote \`${res.score.estimate_id}\` (matched by ${res.score.matched_by}): ${parts.join('; ')}`);
  } else {
    bits.push('no quote in estimates.ndjson matches this task, so nothing was scored — '
      + 'an estimate has to be logged BEFORE the work to be scorable after it');
  }
  return `${bits.join('; ')}.`;
}

// ---- CLI -------------------------------------------------------------------

function main() {
  const args = parseArgs(process.argv.slice(2));
  const dryRun = Boolean(args['dry-run']);
  const ledgerDir = args.ledger ? expandHome(String(args.ledger)) : path.join(resolveLedger(), 'ledger');
  const chatsFile = path.join(ledgerDir, 'chats.ndjson');
  const tasksFile = path.join(ledgerDir, 'tasks.ndjson');
  const estFile = path.join(ledgerDir, 'estimates.ndjson');

  let file;
  try {
    file = resolveSessionFile({
      session: typeof args.session === 'string' ? args.session : null,
      latest: Boolean(args.latest),
      project: typeof args.project === 'string' ? args.project : null,
      root: typeof args.root === 'string' ? args.root : null,
    });
  } catch (e) {
    process.stderr.write(`record: ${e.message}\n`);
    process.exit(2);
  }

  const lock = dryRun
    ? { ok: true, release: () => {} }
    : acquireLock(path.join(ledgerDir, '.record.lock'), { force: Boolean(args['force-lock']) });
  if (!lock.ok) {
    process.stderr.write(`record: ledger is locked by pid ${lock.holder?.pid} since ${lock.holder?.at}. `
      + 'If that process is gone the lock is taken over automatically; to override now, --force-lock.\n');
    process.exit(3);
  }

  try {
    const st = fs.statSync(file);
    const { chat } = extractFile(file);
    // same `source` shape backfill.mjs writes, sidecar fingerprint included — a row
    // recorded here must satisfy backfill's resume key, or the next corpus run
    // re-extracts this transcript for no reason.
    chat.source = {
      mtime_ms: st.mtimeMs,
      size: st.size,
      sidecars: sidecarSignature(file),
      extracted_at: new Date().toISOString(),
    };

    const chats = fs.existsSync(chatsFile) ? readJsonl(chatsFile).records.filter((c) => c.chat_id) : [];
    const priorTasks = fs.existsSync(tasksFile) ? readJsonl(tasksFile).records.filter((t) => t.task_id) : [];
    const estimates = fs.existsSync(estFile) ? readJsonl(estFile).records : [];

    const res = recordFromChats({
      chat,
      chats,
      priorTasks,
      estimates,
      outcome: typeof args.outcome === 'string' ? args.outcome : null,
      estimateId: typeof args['estimate-id'] === 'string' ? args['estimate-id'] : null,
      forcedTicket: typeof args.ticket === 'string' ? args.ticket : null,
      windowDays: Number(args['rework-days'] ?? REWORK_WINDOW_DAYS) || REWORK_WINDOW_DAYS,
      inProgress: Boolean(args['in-progress']),
    });

    if (!dryRun) {
      const merged = [...chats.filter((c) => c.chat_id !== chat.chat_id), chat]
        .sort((a, b) => String(a.chat_id).localeCompare(String(b.chat_id)));
      // re-slice before writing: recording one more chat onto an epic changes
      // that epic's sub-deliverables, and a stale `sub_tasks` would feed
      // calibrate.mjs an epic-slice class that no longer matches the ledger
      sliceAll(res.tasks, merged);
      writeNdjsonAtomic(chatsFile, merged);
      writeNdjsonAtomic(tasksFile, res.tasks);
      if (estimates.length) writeNdjsonAtomic(estFile, res.estimates);
    }

    let calibration = null;
    if (!dryRun && !args['no-calibrate']) {
      try {
        execFileSync(process.execPath, [
          path.join(path.dirname(new URL(import.meta.url).pathname), 'calibrate.mjs'),
          '--ledger', ledgerDir, '--out', path.join(path.dirname(ledgerDir), 'calibration.json'),
        ], { stdio: ['ignore', 'ignore', 'pipe'] });
        calibration = 'recalibrated';
      } catch (e) {
        // non-fatal on purpose: the row is already in the ledger, and a failed
        // recalibration is a stale calibration.json, not a lost measurement.
        calibration = `calibrate.mjs failed: ${String(e.message).split('\n')[0]}`;
      }
    }

    if (args.json) {
      process.stdout.write(`${JSON.stringify({ ...res, file, dry_run: dryRun, calibration }, null, 2)}\n`);
    } else {
      process.stdout.write(`${summarize(res, { chat, dryRun })}\n\n`);
      process.stdout.write(`task row:\n${JSON.stringify(res.row, null, 2)}\n`);
      if (res.superseded.length) {
        process.stdout.write(`\nsuperseded row(s): ${res.superseded.join(', ')}\n`);
      }
      if (calibration) process.stdout.write(`\ncalibration: ${calibration}\n`);
      if (dryRun) process.stdout.write('\n(dry run — nothing written)\n');
    }
  } finally {
    lock.release();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) main();
