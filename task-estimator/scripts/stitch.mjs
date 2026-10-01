#!/usr/bin/env node
/**
 * stitch.mjs — group chat.v1 rows into task.v1 rows.
 *
 * Usage:
 *   node stitch.mjs --in chats.ndjson --out tasks.ndjson
 *   node stitch.mjs --in chats.ndjson --out-tasks tasks.ndjson [--out-chats chats.ndjson]
 *
 * Stitching is STRUCTURAL. Time is used to order and to bound the weakest
 * signal, never on its own to group: purely temporal session stitching tops out
 * at 50-73% accuracy (Meyer et al.), so proximity is not an edge here.
 *
 * Edge priority (Kruskal-style: an edge only records a signal when it actually
 * merges two components, so a strong join is not downgraded by a later weak one):
 *   1 resume chain          -> high
 *   2 shared pr_links       -> high
 *   3 shared ticket_keys    -> medium
 *   4 same repo + branch    -> medium
 *   5 same repo + file Jaccard >= 0.3 within 7 days -> low
 */
import fs from 'node:fs';
import path from 'node:path';
import { readJsonl, round2, round4, uniqSorted, ts, parseArgs } from './lib.mjs';
import { isPlausibleTicketKey } from './extract.mjs';

const DAY = 86400000;
const JACCARD_MIN = 0.3;
const FILE_OVERLAP_WINDOW_MS = 7 * DAY;

/**
 * Branches that everyone is always on. "we both pushed to main" says nothing
 * about two chats being the same task, and because a `git push` records its
 * branch in gitOperation, EVERY chat that ships anything carries `main`. Left in,
 * repo+branch degenerates into "same repo", which merged an unrelated bugfix
 * into a three-week integration sprint. Feature branches stay: those are real.
 */
const GENERIC_BRANCHES = new Set([
  'main', 'master', 'develop', 'development', 'staging', 'stage',
  'production', 'prod', 'release', 'trunk', 'default', 'HEAD',
]);
const isSpecificBranch = (b) => typeof b === 'string' && b !== '' && !GENERIC_BRANCHES.has(b);

/**
 * Ticket keys, like branches, are not all worth the same as a join signal — and
 * for exactly the reason `main` is not: a string can be perfectly real and still
 * say nothing about two chats being the same task. `REPORT-2026`, scraped out of
 * the filename of a QA report that got pasted into every chat of a review round,
 * welded 46 chats and 79 agent-hours into one "task".
 *
 * The bar is therefore made PROPORTIONAL TO THE DAMAGE the key can do:
 *
 *   - A key carried by fewer than LOAD_BEARING_FANOUT chats can merge at most a
 *     couple of rows. Its worst case is one wrong pair, its typical case is a
 *     correct one, and requiring evidence for it would make the guard fire on
 *     thin ledgers (a fresh install has no branch history to learn from). These
 *     pass on shape alone.
 *   - A key carried by that many chats or more is claiming a whole namespace.
 *     It must be ATTESTED, by one of:
 *       (a) BRANCH — some chat in the corpus has a specific (non-generic) branch
 *           containing `<prefix>-<digits>`: `feature/proj-3830/...`,
 *           `ticket-76/docs-update`. A key someone actually cut a branch for
 *           is a work item, full stop.
 *       (b) A LIVE NAMESPACE — the key has >= NAMESPACE_MIN_SIBLINGS sibling
 *           keys under the same prefix, AND at least one sibling turns up in a
 *           chat that does NOT carry this key. Two conditions, because each
 *           alone has a hole:
 *             * siblings, because a ticket does not exist alone. Real trackers
 *               are dense — a prefix typically has dozens of members — while
 *               `REPORT-2026` and `VERDICTS-2026` are namespaces of exactly one.
 *             * independence, because co-pasted fragments always travel
 *               together. `V0822-24` / `V1293-25` / `V1966-24` look dense, but
 *               they are three scans named in one tax-paperwork chat and never
 *               apart. A real tracker's tickets appear in DIFFERENT
 *               combinations, because they are worked on separately.
 *           Verified against the corpus: this pair denies REPORT-2026 and
 *           VERDICTS-2026 and nothing else, on the pre-shape-guard key set. The
 *           two guards catch the mega-key independently.
 *
 * There is deliberately no URL attestation here: chat rows do not carry URLs,
 * so a tracker URL in a prompt is evidence that lives one stage earlier
 * (extract.mjs, where keys are minted from text) and re-checking it at stitch
 * time would prove nothing new.
 *
 * Known limit, stated rather than papered over: a bogus prefix that is BOTH
 * dense and independently co-occurring is structurally indistinguishable from a
 * tracker, and only branch/URL evidence would separate them. Nothing in this
 * corpus has that shape; if one ever appears it shows up as an over-merge in the
 * audit's stitch verdict, which is the check that exists for it.
 *
 * An unattested key is dropped from the stitch edges AND from task naming; every
 * other edge type still applies to those chats, so the usual result is that a
 * mega-task decomposes along its real seams rather than disappearing.
 */
const LOAD_BEARING_FANOUT = 3;
const NAMESPACE_MIN_SIBLINGS = 2;

const ticketPrefix = (k) => (typeof k === 'string' ? (k.split('-')[0] || '').toUpperCase() : '');

export function eligibleTicketKeys(chats) {
  const perChat = chats.map((c) => new Set((c.ticket_keys || []).filter(isPlausibleTicketKey)));
  const fanout = new Map();   // key -> number of chats carrying it
  const nsKeys = new Map();   // prefix -> Set(distinct keys)
  for (const keys of perChat) {
    for (const k of keys) {
      fanout.set(k, (fanout.get(k) || 0) + 1);
      const p = ticketPrefix(k);
      if (!nsKeys.has(p)) nsKeys.set(p, new Set());
      nsKeys.get(p).add(k);
    }
  }
  const branchAttested = new Set();
  for (const c of chats) {
    for (const b of (c.branches || []).filter(isSpecificBranch)) {
      for (const m of b.matchAll(/\b([A-Za-z][A-Za-z0-9]*)-\d+/g)) branchAttested.add(m[1].toUpperCase());
    }
  }
  /** Some sibling key of the same prefix appears in a chat this key does not. */
  const usedIndependently = (key) => {
    const sibs = [...(nsKeys.get(ticketPrefix(key)) || [])].filter((s) => s !== key);
    return perChat.some((keys) => !keys.has(key) && sibs.some((s) => keys.has(s)));
  };
  const attested = (key) => branchAttested.has(ticketPrefix(key))
    || (((nsKeys.get(ticketPrefix(key))?.size || 0) - 1 >= NAMESPACE_MIN_SIBLINGS) && usedIndependently(key));

  const eligible = new Set();
  for (const [k, n] of fanout) {
    if (n < LOAD_BEARING_FANOUT || attested(k)) eligible.add(k);
  }
  return eligible;
}

const SIGNAL_LEVEL = {
  resume: 'high',
  'pr-link': 'high',
  'ticket-key': 'medium',
  'repo+branch': 'medium',
  'file-overlap': 'low',
};
const SIGNAL_ORDER = ['resume', 'pr-link', 'ticket-key', 'repo+branch', 'file-overlap'];
const LEVEL_RANK = { high: 3, medium: 2, low: 1 };

function makeUf(n) {
  const parent = [...Array(n).keys()];
  const find = (x) => { while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; } return x; };
  const union = (a, b) => { const ra = find(a); const rb = find(b); if (ra === rb) return false; parent[rb] = ra; return true; };
  return { find, union };
}

const setOf = (arr) => new Set(Array.isArray(arr) ? arr.filter((x) => x != null && x !== '') : []);
const shares = (a, b) => { for (const x of a) if (b.has(x)) return true; return false; };

function jaccard(a, b) {
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  return inter / (a.size + b.size - inter);
}

/**
 * Roll a task's minutes up per repo, using each member chat's `repo_share`.
 *
 * Summing `agent_hours` per repo over `repos_touched` counts a multi-repo chat
 * once per repo; on this corpus that inflated an area roll-up by ~25x. Because
 * every chat's shares sum to exactly 1, this version is additive: the values
 * here sum back to the task's own hours.
 *
 * @param {object[]} members chat.v1 rows
 * @param {(c: object) => number} minutes minutes to attribute, per chat
 */
export function hoursByRepo(members, minutes) {
  const acc = new Map();
  for (const c of members) {
    const mins = Number(minutes(c)) || 0;
    if (mins <= 0) continue;
    const share = c.repo_share && Object.keys(c.repo_share).length
      ? c.repo_share
      : { unknown: 1 };
    for (const [repo, frac] of Object.entries(share)) {
      const f = Number(frac);
      if (!Number.isFinite(f) || f <= 0) continue;
      acc.set(repo, (acc.get(repo) || 0) + (mins * f) / 60);
    }
  }
  return Object.fromEntries([...acc.keys()].sort().map((k) => [k, round4(acc.get(k))]));
}

/**
 * A task is noise only when EVERY chat in it is. One probe session stitched onto
 * real work does not make the work a probe, and the whole point of the flag is
 * to drop rows that are not a reference class for anything.
 */
export function taskNoise(members) {
  if (!members.length) return null;
  if (!members.every((c) => typeof c.noise === 'string' && c.noise)) return null;
  const tally = new Map();
  for (const c of members) tally.set(c.noise, (tally.get(c.noise) || 0) + 1);
  return [...tally.keys()].sort((a, b) => tally.get(b) - tally.get(a) || a.localeCompare(b))[0];
}

/** Collapse abbreviated shas: drop any sha that is a prefix of another. */
export function dedupeShas(list) {
  const uniq = [...new Set(list.filter((s) => typeof s === 'string' && s))].sort((a, b) => b.length - a.length || a.localeCompare(b));
  const kept = [];
  for (const s of uniq) {
    if (kept.some((k) => k.startsWith(s) || s.startsWith(k))) continue;
    kept.push(s);
  }
  return kept.sort();
}

export function stitch(chats) {
  const n = chats.length;
  const byId = new Map(chats.map((c, i) => [c.chat_id, i]));
  const eligible = eligibleTicketKeys(chats);
  const keysOf = (c) => (c.ticket_keys || []).filter((k) => eligible.has(k));
  const prSets = chats.map((c) => setOf((c.pr_links || []).map((p) => `${p.prRepository}#${p.prNumber}`)));
  const ticketSets = chats.map((c) => setOf(keysOf(c)));
  const repoSets = chats.map((c) => setOf(c.repos_touched));
  const branchSets = chats.map((c) => setOf((c.branches || []).filter(isSpecificBranch)));
  const fileSets = chats.map((c) => setOf(c.files_edited));
  const start = chats.map((c) => ts(c.started_at) ?? 0);
  const end = chats.map((c, i) => ts(c.ended_at) ?? start[i] ?? 0);

  const edges = [];
  for (let i = 0; i < n; i++) {
    // 1. resume chain (directed either way)
    const p = chats[i].parent_chat_id;
    if (p && byId.has(p)) edges.push({ rank: 1, signal: 'resume', a: i, b: byId.get(p) });
    for (let j = i + 1; j < n; j++) {
      if (shares(prSets[i], prSets[j])) edges.push({ rank: 2, signal: 'pr-link', a: i, b: j });
      if (shares(ticketSets[i], ticketSets[j])) edges.push({ rank: 3, signal: 'ticket-key', a: i, b: j });
      if (shares(repoSets[i], repoSets[j]) && shares(branchSets[i], branchSets[j])) {
        edges.push({ rank: 4, signal: 'repo+branch', a: i, b: j });
      }
      if (shares(repoSets[i], repoSets[j]) && jaccard(fileSets[i], fileSets[j]) >= JACCARD_MIN) {
        const distance = Math.max(0, Math.max(start[i], start[j]) - Math.min(end[i], end[j]));
        if (distance <= FILE_OVERLAP_WINDOW_MS) edges.push({ rank: 5, signal: 'file-overlap', a: i, b: j });
      }
    }
  }
  edges.sort((x, y) => x.rank - y.rank || x.a - y.a || x.b - y.b);

  const uf = makeUf(n);
  const signalsAt = new Map(); // root index at merge time -> collected later
  const merged = [];
  for (const e of edges) {
    if (uf.union(e.a, e.b)) merged.push(e);
  }
  for (const e of merged) {
    const root = uf.find(e.a);
    if (!signalsAt.has(root)) signalsAt.set(root, []);
    signalsAt.get(root).push(e.signal);
  }

  const groups = new Map();
  for (let i = 0; i < n; i++) {
    const root = uf.find(i);
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root).push(i);
  }

  const tasks = [];
  for (const [root, idxs] of groups) {
    idxs.sort((a, b) => start[a] - start[b] || chats[a].chat_id.localeCompare(chats[b].chat_id));
    const members = idxs.map((i) => chats[i]);
    const signals = uniqSorted(signalsAt.get(root) || []).sort(
      (a, b) => SIGNAL_ORDER.indexOf(a) - SIGNAL_ORDER.indexOf(b),
    );
    let confidence = 'high';
    for (const s of signals) {
      const lvl = SIGNAL_LEVEL[s] || 'low';
      if (LEVEL_RANK[lvl] < LEVEL_RANK[confidence]) confidence = lvl;
    }

    const repoCount = new Map();
    for (const i of idxs) for (const r of repoSets[i]) repoCount.set(r, (repoCount.get(r) || 0) + 1);
    const repos = [...repoCount.keys()].sort();
    const topRepo = repos.length
      ? repos.slice().sort((a, b) => (repoCount.get(b) - repoCount.get(a)) || a.localeCompare(b))[0]
      : 'unknown';

    // The naming ticket is the one the most member chats agree on: a key that
    // only one chat mentions (a title someone typed, "BUG-3842") should not
    // outrank the key that actually stitched the task ("PROJ-3842").
    const ticketCount = new Map();
    for (const c of members) for (const k of uniqSorted(keysOf(c))) {
      ticketCount.set(k, (ticketCount.get(k) || 0) + 1);
    }
    const tickets = [...ticketCount.keys()]
      .sort((a, b) => (ticketCount.get(b) - ticketCount.get(a)) || a.localeCompare(b));
    const branches = uniqSorted(members.flatMap((c) => c.branches || []));
    // "main" names no task, so it must not name one here either
    const slugBranch = branches.find(isSpecificBranch) ?? null;
    const slug = tickets[0] || (slugBranch ? slugBranch.replace(/\//g, '-') : members[0].chat_id);

    const sum = (f) => members.reduce((s, c) => s + (Number(f(c)) || 0), 0);
    const files = new Set(members.flatMap((c) => c.files_edited || []));
    const prMap = new Map();
    for (const c of members) for (const p of c.pr_links || []) prMap.set(`${p.prRepository}#${p.prNumber}`, p);
    const shas = dedupeShas(members.flatMap((c) => c.commit_shas || []));

    const startedAt = Math.min(...idxs.map((i) => start[i]));
    const endedAt = Math.max(...idxs.map((i) => end[i]));
    const spanDays = Math.max(0, endedAt - startedAt) / DAY;

    tasks.push({
      schema: 'task.v1',
      task_id: `${topRepo}/${slug}`,
      chats: members.map((c) => c.chat_id),
      stitch_signals: signals,
      stitch_confidence: confidence,
      // started_at/ended_at are an extension over the documented shape: calibrate.mjs
      // needs a date per task to apply the 90-day recency half-life.
      started_at: Number.isFinite(startedAt) ? new Date(startedAt).toISOString() : null,
      ended_at: Number.isFinite(endedAt) ? new Date(endedAt).toISOString() : null,
      agent_hours: round2(sum((c) => c.agent_active_min) / 60),
      human_rounds: sum((c) => c.human_rounds),
      awaiting_hours: round2(sum((c) => c.awaiting_min) / 60),
      human_turnaround_hours: round2(sum((c) => c.human_turnaround_min) / 60),
      calendar_days: Math.max(1, Math.ceil(spanDays)),
      files: files.size,
      loc_delta: sum((c) => c.loc_added) - sum((c) => c.loc_removed),
      repos,
      commits: shas.length,
      prs: [...prMap.values()],
      // additive per-repo attribution; sums back to agent_hours / subagent_hours
      agent_hours_by_repo: hoursByRepo(members, (c) => c.agent_active_min),
      subagent_hours_by_repo: hoursByRepo(members, (c) => c.subagents?.active_min),
      subagent_count: sum((c) => c.subagents?.count),
      // kept apart from loc_delta: delegated work, not the main thread's own
      subagent_loc_added: sum((c) => c.subagents?.loc_added),
      subagent_loc_removed: sum((c) => c.subagents?.loc_removed),
      // measured from the sidecar transcripts; overlaps agent_hours in wall
      // clock (a subagent runs while its parent waits), so never added to it
      subagent_hours: round2(sum((c) => c.subagents?.active_min) / 60),
      subagent_sidecars: sum((c) => c.subagents?.sidecar_count),
      subagent_files: new Set(members.flatMap((c) => c.subagents?.files_edited || [])).size,
      subagent_repos: uniqSorted(members.flatMap((c) => c.subagents?.repos || [])),
      compactions: sum((c) => c.compactions?.count),
      noise: taskNoise(members),
      task_type: null,
      novelty: null,
      self_verifiable: null,
      spec_ambiguity: null,
      outcome: null,
      external_waits: null,
      user_touchpoint_kinds: null,
      summary: null,
    });
  }

  tasks.sort((a, b) => String(a.started_at).localeCompare(String(b.started_at)) || a.task_id.localeCompare(b.task_id));

  // disambiguate identical task_ids (same repo + same fallback slug)
  const seen = new Map();
  for (const t of tasks) {
    const k = t.task_id;
    const c = (seen.get(k) || 0) + 1;
    seen.set(k, c);
    if (c > 1) t.task_id = `${k}#${c}`;
  }
  return tasks;
}

function writeOut(file, rows) {
  fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
  fs.writeFileSync(file, rows.map((r) => JSON.stringify(r)).join('\n') + (rows.length ? '\n' : ''));
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const inFile = typeof args.in === 'string' ? args.in : args._[0];
  const outTasks = typeof args.out === 'string' ? args.out
    : typeof args['out-tasks'] === 'string' ? args['out-tasks'] : null;
  const outChats = typeof args['out-chats'] === 'string' ? args['out-chats'] : null;
  if (!inFile) {
    process.stderr.write('usage: stitch.mjs --in chats.ndjson --out tasks.ndjson [--out-chats chats.ndjson]\n');
    process.exit(2);
  }
  const { records } = readJsonl(inFile);
  const chats = records.filter((r) => r.schema === 'chat.v1' || r.chat_id);
  const tasks = stitch(chats);

  if (outChats) {
    const taskOf = new Map();
    for (const t of tasks) for (const c of t.chats) taskOf.set(c, t.task_id);
    writeOut(outChats, chats.map((c) => ({ ...c, task_id: taskOf.get(c.chat_id) ?? null })));
  }
  if (outTasks) {
    writeOut(outTasks, tasks);
    process.stderr.write(`stitch: ${chats.length} chat(s) -> ${tasks.length} task(s) -> ${outTasks}\n`);
  } else {
    process.stdout.write(tasks.map((r) => JSON.stringify(r)).join('\n') + (tasks.length ? '\n' : ''));
  }
}

if (import.meta.url === `file://${process.argv[1]}`) main();
