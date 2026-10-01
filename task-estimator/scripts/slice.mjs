#!/usr/bin/env node
/**
 * slice.mjs — cut an epic into labelled sub-deliverables.
 *
 * Usage:
 *   node slice.mjs [--ledger <dir>] [--min-chats 6] [--dry-run] [--json]
 *
 * An epic — one ticket, dozens of chats, weeks of calendar — is the right UNIT
 * OF RECORD and the wrong thing to quote against. Splitting it into separate
 * task rows is exactly the under-merging that makes a ledger flatter itself
 * (the rework lands in its own small row and the original looks fast), so the
 * epic row never moves. But nobody is ever asked "how long is a 76-hour
 * integration"; they are asked "how long is the webhook part". That
 * question needs a slice.
 *
 * So: the epic row stays the unit of record, and this adds a *view* on top of
 * it — `task.sub_tasks[]` — which calibrate.mjs turns into an `epic-slice`
 * reference class alongside `by_task_type`.
 *
 * Grouping, in strict precedence order (union-find, strongest edge first):
 *
 *   1. shared PR  — two chats that touched the same PR are the same slice.
 *      A PR is the closest thing to a declared unit of delivery in the corpus
 *      and it is extracted from `gh` output, not inferred.
 *      **Umbrella PRs are dropped first.** Measured on a real ledger: one
 *      epic's 40 chats carry one PR touched by 19 of them and another by 17,
 *      and union-find welded 34 chats into a single 74-hour "slice" that was
 *      just the epic wearing a hat. A PR attached to more than a quarter of an
 *      epic's chats is that epic's own delivery vehicle: it separates the epic
 *      from everything else and nothing WITHIN the epic from anything else, so
 *      it carries no slicing information and is ignored.
 *   2. label + time adjacency — otherwise, two chats join when their
 *      classifier slugs overlap (token Jaccard >= 0.5) AND their spans are
 *      within `ADJACENCY_DAYS`. Both halves are required: `mov-video-upload`
 *      in week 1 and `mov-video-upload` in week 4 are a fix and its later
 *      regression, not one slice, and two unrelated chats on the same
 *      afternoon are not one either.
 *
 * Everything else is left alone. A chat that joins nothing is a one-chat slice,
 * which is a real answer: some of an epic genuinely is a single sitting.
 *
 * The invariant that makes the slices quotable: **every chat lands in exactly
 * one slice**, so the slices' `agent_hours` and `rounds` sum back to the epic's
 * own. A slicing that loses or double-counts a chat would quote hours that were
 * never worked; the slices must always sum back to the epic.
 */
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs, readJsonl, round2, ts, uniqSorted, writeNdjsonAtomic, resolveLedger } from './lib.mjs';

const DAY = 86400000;
export const DEFAULT_MIN_CHATS = 6;
const LABEL_JACCARD_MIN = 0.5;
const ADJACENCY_DAYS = 3;
/** A PR on more than this share of the epic's chats is the epic's own PR, not a slice's. */
const PR_UMBRELLA_SHARE = 0.25;
const PR_UMBRELLA_FLOOR = 3;
/** Tokens that name no deliverable: they match everything and would fuse the epic back together. */
const STOP_TOKENS = new Set(['fix', 'bug', 'issue', 'update', 'add', 'the', 'and', 'for', 'new',
  'impl', 'implementation', 'work', 'task', 'chat', 'part', 'v1', 'v2']);

/** kebab/snake slug -> meaningful token set. Digits-only tokens (ticket numbers) are kept:
 *  "bug-3842-*" and "proj-3842-*" ARE the same deliverable named twice. */
export function labelTokens(slug) {
  if (typeof slug !== 'string') return new Set();
  return new Set(slug.toLowerCase().split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 3 && !STOP_TOKENS.has(t)));
}

export function tokenJaccard(a, b) {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  return inter / (a.size + b.size - inter);
}

function makeUf(n) {
  const p = Array.from({ length: n }, (_, i) => i);
  const find = (x) => { while (p[x] !== x) { p[x] = p[p[x]]; x = p[x]; } return x; };
  return {
    find,
    union(a, b) { const ra = find(a); const rb = find(b); if (ra === rb) return false; p[ra] = rb; return true; },
  };
}

/**
 * The label a chat carries into slicing: its own classifier slug, preferring the
 * unit it called `main`. A chat that reported several units contributes several
 * `sub_deliverables` rows; the `main` one names the chat.
 */
export function chatLabel(taskRow, chatId) {
  const subs = (taskRow.sub_deliverables || []).filter((s) => s.chat_id === chatId && s.slug);
  if (!subs.length) return null;
  const main = subs.find((s) => s.role === 'main');
  return (main || subs[0]).slug;
}

/**
 * Group one task's chats into slices. Pure: takes the task row and a chat lookup,
 * returns `sub_tasks[]` or null when the task is not epic-sized.
 */
export function sliceTask(task, chatById, { minChats = DEFAULT_MIN_CHATS } = {}) {
  const ids = (task.chats || []).filter((id) => chatById.has(id));
  if (ids.length < minChats) return null;

  const rows = ids.map((id) => {
    const c = chatById.get(id);
    const start = ts(c.started_at) ?? 0;
    return {
      id,
      start,
      end: ts(c.ended_at) ?? start,
      hours: (Number(c.agent_active_min) || 0) / 60,
      rounds: Number(c.human_rounds) || 0,
      prs: new Set((c.pr_links || []).map((p) => `${p.prRepository}#${p.prNumber}`)),
      label: chatLabel(task, id),
      types: uniqSorted((task.sub_deliverables || []).filter((s) => s.chat_id === id).map((s) => s.task_type)),
    };
  }).sort((a, b) => a.start - b.start || a.id.localeCompare(b.id));

  const n = rows.length;
  // drop the umbrella PRs before any edge is drawn
  const prFanout = new Map();
  for (const r of rows) for (const p of r.prs) prFanout.set(p, (prFanout.get(p) || 0) + 1);
  const umbrellaAt = Math.max(PR_UMBRELLA_FLOOR, Math.ceil(PR_UMBRELLA_SHARE * n));
  const umbrellas = new Set([...prFanout.entries()].filter(([, c]) => c > umbrellaAt).map(([p]) => p));
  for (const r of rows) for (const p of [...r.prs]) if (umbrellas.has(p)) r.prs.delete(p);

  const tokens = rows.map((r) => labelTokens(r.label));
  const edges = [];
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      let shared = false;
      for (const p of rows[i].prs) if (rows[j].prs.has(p)) { shared = true; break; }
      if (shared) { edges.push({ rank: 1, a: i, b: j }); continue; }
      if (tokenJaccard(tokens[i], tokens[j]) >= LABEL_JACCARD_MIN) {
        const gap = Math.max(0, Math.max(rows[i].start, rows[j].start) - Math.min(rows[i].end, rows[j].end));
        if (gap <= ADJACENCY_DAYS * DAY) edges.push({ rank: 2, a: i, b: j });
      }
    }
  }
  edges.sort((x, y) => x.rank - y.rank || x.a - y.a || x.b - y.b);
  const uf = makeUf(n);
  for (const e of edges) uf.union(e.a, e.b);

  const groups = new Map();
  for (let i = 0; i < n; i++) {
    const r = uf.find(i);
    if (!groups.has(r)) groups.set(r, []);
    groups.get(r).push(i);
  }

  const out = [];
  for (const idxs of groups.values()) {
    const members = idxs.map((i) => rows[i]);
    // the slice is named by its heaviest chat: the one that did most of the work
    const named = members.slice().sort((a, b) => b.hours - a.hours || a.start - b.start)[0];
    const start = Math.min(...members.map((m) => m.start));
    const end = Math.max(...members.map((m) => m.end));
    out.push({
      // a chat the classifier found no unit of work in has no label; say so rather
      // than printing a bare uuid that reads like a name
      slug: named.label || `unlabelled-${named.id.slice(0, 8)}`,
      // the slice-level twin of a task row's `no_work`: not one member chat
      // reported a unit of work, so this is a status check or a read, not a
      // deliverable. calibrate.mjs drops these from the epic-slice quantiles for
      // exactly the reason it drops no_work task rows — they sit at the bottom of
      // every class and answer a different question.
      no_work: members.every((m) => !m.label),
      chats: members.map((m) => m.id),
      agent_hours: round2(members.reduce((s, m) => s + m.hours, 0)),
      rounds: members.reduce((s, m) => s + m.rounds, 0),
      calendar_days: Math.max(1, Math.ceil(Math.max(0, end - start) / DAY)),
      // task_type + dates are not decoration: the epic-slice reference class is
      // cut by type and weighted by the 90-day recency half-life, both of which
      // need a value per slice. The type comes from the chat that did the work,
      // matching classify.mjs's rule that labels come from the main chat rather
      // than being voted on — averaging a bugfix and a refactor produces neither.
      task_type: named.types[0] || task.task_type || null,
      started_at: Number.isFinite(start) ? new Date(start).toISOString() : null,
      ended_at: Number.isFinite(end) ? new Date(end).toISOString() : null,
    });
  }
  out.sort((a, b) => String(a.started_at).localeCompare(String(b.started_at)) || a.slug.localeCompare(b.slug));

  // a slug collides when two slices' heaviest chats were labelled the same; keep
  // them distinct so a quote can name one
  const seen = new Map();
  for (const s of out) {
    const c = (seen.get(s.slug) || 0) + 1;
    seen.set(s.slug, c);
    if (c > 1) s.slug = `${s.slug}#${c}`;
  }
  return out;
}

/** Apply slicing across a whole ledger. Mutates and returns the task rows. */
export function sliceAll(tasks, chats, opts = {}) {
  const chatById = new Map(chats.map((c) => [c.chat_id, c]));
  const stats = { epics: 0, slices: 0, multi_chat_slices: 0, largest: null };
  for (const t of tasks) {
    const subs = sliceTask(t, chatById, opts);
    t.sub_tasks = subs;
    if (subs) {
      stats.epics++;
      stats.slices += subs.length;
      stats.multi_chat_slices += subs.filter((s) => s.chats.length > 1).length;
      if (!stats.largest || subs.length > stats.largest.slices) {
        stats.largest = { task_id: t.task_id, chats: t.chats.length, slices: subs.length };
      }
    }
  }
  return { tasks, stats };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const ledgerDir = typeof args.ledger === 'string'
    ? (fs.existsSync(path.join(args.ledger, 'tasks.ndjson')) ? args.ledger : path.join(args.ledger, 'ledger'))
    : path.join(resolveLedger(), 'ledger');
  const tasksFile = path.join(ledgerDir, 'tasks.ndjson');
  const minChats = Math.max(2, Number(args['min-chats'] ?? DEFAULT_MIN_CHATS) || DEFAULT_MIN_CHATS);

  const tasks = readJsonl(tasksFile).records.filter((t) => t.task_id);
  const chats = readJsonl(path.join(ledgerDir, 'chats.ndjson')).records.filter((c) => c.chat_id);
  const { stats } = sliceAll(tasks, chats, { minChats });

  if (!args['dry-run']) writeNdjsonAtomic(tasksFile, tasks);
  if (args.json) {
    process.stdout.write(JSON.stringify({
      ...stats,
      min_chats: minChats,
      epics: tasks.filter((t) => t.sub_tasks).map((t) => ({
        task_id: t.task_id, chats: t.chats.length, sub_tasks: t.sub_tasks,
      })),
    }, null, 2) + '\n');
  } else {
    process.stderr.write(`slice: ${stats.epics} epic(s) (>=${minChats} chats) -> ${stats.slices} slice(s)`
      + `${stats.largest ? `; largest ${stats.largest.task_id} ${stats.largest.chats} chats -> ${stats.largest.slices}` : ''}`
      + `${args['dry-run'] ? ' (dry run, nothing written)' : ` -> ${tasksFile}`}\n`);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) main();
