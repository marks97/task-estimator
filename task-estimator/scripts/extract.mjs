#!/usr/bin/env node
/**
 * extract.mjs — one `chat.v1` record per Claude Code transcript JSONL file.
 *
 * Usage:
 *   node extract.mjs <file.jsonl> [--pretty]      # one JSON object on stdout
 *   node extract.mjs --file <file.jsonl>          # alias (CLAUDE.md hook form)
 *   node extract.mjs --dir <dir> [--out out.ndjson]   # ndjson; stdout when --out is absent
 *
 * Deterministic: same bytes in -> same bytes out. No network, no clock reads
 * (nothing in the output depends on "now").
 *
 * Phase attribution is index-based over the timestamp-ordered record list, so
 * every inter-record gap lands in exactly one bucket and there is no residue:
 *
 *   away (>2h)  >  awaiting (tool_use->tool_result >60s, no assistant between)
 *               >  human turnaround (end_turn -> next real human prompt, cap 30m)
 *               >  ambiguous (human prompt after a NON-end_turn assistant; split at midpoint)
 *               >  agent active (credited in full when <=120s, credited 0 when longer)
 */
import fs from 'node:fs';
import path from 'node:path';
import { readJsonl, round2, round4, uniqSorted, ts, parseArgs, quantile } from './lib.mjs';

// ---- thresholds (measurement-model.md §2) ---------------------------------
const MIN = 60000;
const AWAY_MS = 2 * 60 * MIN; // task/abandonment boundary
const AGENT_GAP_CAP_MS = 2 * MIN; // agent-gap credit cap
const AWAITING_TRIGGER_MS = 1 * MIN; // awaiting-approval trigger
const TURNAROUND_CAP_MS = 30 * MIN; // human-turnaround cap

const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'StrReplace']);

/** Subagent spawn tool. `Task` is the legacy name; the harness now says `Agent`. */
const SPAWN_TOOLS = new Set(['Agent', 'Task']);

/**
 * Title records, strongest first. A chat carries several: `custom-title` is what
 * the user typed, `agent-name` is the label the session runs under, `ai-title`
 * is generated. None of them carry a timestamp.
 */
const TITLE_RANK = { 'custom-title': 3, 'agent-name': 2, 'ai-title': 1 };

/** Path segments that mean "we are already inside the repo". */
const SRC_MARKERS = new Set([
  'src', 'lib', 'app', 'apps', 'test', 'tests', '__tests__', 'spec', 'scripts', 'prisma',
  'ci', 'packages', 'public', 'docs', 'client', 'server', 'cli', 'api', 'web', 'ui',
  'components', 'dist', 'build', 'openspec', 'node_modules', '.claude', '.github',
  'service', 'services', 'infra', 'functions', 'worker', 'workers',
]);

/**
 * Directories that hold a checkout, not a repo: the repo name is one level in.
 * `<ws>/.worktrees/<name>` and `<repo>/.orchestrate-wt/<name>` are both real.
 */
const WORKTREE_DIRS = new Set(['.worktrees', 'worktrees', '.orchestrate-wt', '.wt']);

/**
 * `<root>/<group>/<workspace>/...` — the directory names that hold your repos.
 * Defaults to the two common ones (`~/projects`, `~/Documents`); override with
 * `CLAUDE_ESTIMATION_PROJECT_ROOTS` (comma-separated) if your checkouts live
 * elsewhere.
 */
const PROJECT_ROOTS = new Set(
  (process.env.CLAUDE_ESTIMATION_PROJECT_ROOTS || 'projects,Documents')
    .split(',').map((s) => s.trim()).filter(Boolean),
);

/** Scratch trees: never a repo, however deep the path looks. */
const TMP_PREFIXES = ['/tmp/', '/private/tmp/', '/var/tmp/', '/var/folders/', '/private/var/folders/'];

/**
 * A segment that disqualifies the whole path from naming a repo. A `.claude`
 * prefix catches config dirs (`.claude`, `.claude-local`, ...) so memories,
 * docs, skills and config never masquerade as a repo — the transcript store
 * itself lives under `.claude/projects/`, which must not read as a repo.
 */
const isExcludedSegment = (s) =>
  s.startsWith('.claude') || s === 'node_modules' || s === '.git' || s === '.venv';

/** Prompts that the harness writes on the user's behalf: not a round of work. */
const SESSION_COMMANDS = new Set([
  'compact', 'clear', 'resume', 'context', 'cost', 'model', 'status', 'help',
  'exit', 'quit', 'config', 'doctor', 'login', 'logout', 'ide', 'vim',
  'terminal-setup', 'release-notes', 'privacy-settings', 'upgrade', 'agents',
]);

/** Uppercase prefixes that look like ticket keys but never are. */
const TICKET_DENY = new Set(['UTF', 'SHA', 'ISO', 'MD', 'BASE', 'HTTP', 'HTTPS', 'TLS', 'IPV', 'UTC', 'ES', 'X']);

/**
 * Key-level shape guard for the generic `PREFIX-1234` form: DIGIT-BEARING
 * PREFIXES must be letters plus at most one trailing digit.
 *
 * Learned from the observed key population (163 distinct keys over 565 chats).
 * Every real namespace is letters — `SC` `BUG` `OPE` `DQ` `RF` `PC` — or letter
 * plus one digit, which is how the audit registers `A2` `A3` `A4` are written.
 * Nothing real carries digits mid-prefix. The junk does, and it is junk of three
 * different kinds: `V0822-24` / `V1293-25` / `V1966-24` (scanned tax paperwork),
 * `L701-721` (a line range), `E95E-3689` (a hex crash id).
 *
 * The asymmetry justifies erring towards denial: a false key shared by many
 * chats becomes a stitch edge and welds unrelated work into one row
 * (`REPORT-2026` glued 46 chats into a single 79h "task"), while dropping a real
 * key only costs that task its ticket-key edge — resume, PR, branch and
 * file-overlap edges all still apply.
 *
 * Deliberately NOT rules here: a maximum prefix length (it would fit one
 * tracker's keys and break a longer `PLATFORM-123` style Jira key for the next),
 * any denylist of English words, and — see `ticketKeysFrom` — the year test,
 * which needs surrounding text to be safe and so cannot live in a key-level
 * predicate. Wordy prefixes are handled one stage later by the corpus-level
 * attestation in stitch.mjs, which is where the evidence to judge them exists.
 */
export function isPlausibleTicketKey(key) {
  if (typeof key !== 'string') return false;
  const m = key.match(/^([A-Za-z][A-Za-z0-9]*)-\d+$/);
  if (!m) return false;
  return /^[A-Za-z]{2,}[0-9]?$/.test(m[1]) || /^[A-Za-z][0-9]$/.test(m[1]);
}

// ---- small helpers --------------------------------------------------------

const isObj = (x) => x && typeof x === 'object' && !Array.isArray(x);

function contentBlocks(rec) {
  const c = rec?.message?.content;
  if (Array.isArray(c)) return c.filter(isObj);
  return [];
}

/** Plain text of a message, excluding thinking / tool_result / image blocks. */
function messageText(rec) {
  const c = rec?.message?.content;
  if (typeof c === 'string') return c;
  if (!Array.isArray(c)) return '';
  return c
    .filter((b) => isObj(b) && b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text)
    .join('\n');
}

function hasToolResult(rec) {
  const c = rec?.message?.content;
  return Array.isArray(c) && c.some((b) => isObj(b) && b.type === 'tool_result');
}

/**
 * Machine-authored text that the transcript files under `type: "user"` with no
 * meta flag, so it is indistinguishable from a prompt without looking at it:
 *   - `<local-command-stdout>…`  output of a slash command, echoed back
 *   - `<command-name>/compact…`  a session command, not a round of work
 *   - "This session is being continued…"  the post-compact summary
 *   - "[Request interrupted by user]"  an interrupt carries no instruction
 * Counting these inflates human_rounds and — worse — leaks whatever ticket keys
 * the compact summary happened to quote into the chat's ticket set.
 */
export function isHarnessAuthoredPrompt(text) {
  const t = typeof text === 'string' ? text.trim() : '';
  if (!t) return true;
  if (t.startsWith('<local-command-stdout>')) return true;
  if (/^\[Request interrupted by user/.test(t)) return true;
  if (t.startsWith('This session is being continued from a previous conversation')) return true;
  const cmd = /^<command-name>\/?([a-z0-9:-]+)<\/command-name>/i.exec(t);
  if (cmd && SESSION_COMMANDS.has(cmd[1].toLowerCase())) return true;
  return false;
}

/** Real human prompt: type user, origin human (missing => human), no tool_result payload. */
function isRealHumanPrompt(rec) {
  if (rec?.type !== 'user') return false;
  const kind = rec?.origin?.kind ?? 'human';
  if (kind !== 'human') return false;
  if (rec.isMeta === true) return false;
  if (hasToolResult(rec)) return false;
  if (rec.toolUseResult !== undefined) return false;
  return !isHarnessAuthoredPrompt(messageText(rec));
}

/** Dedupe key: message.id + ":" + requestId when present, else uuid. */
function dedupeKey(rec) {
  const mid = rec?.message?.id;
  const rid = rec?.requestId;
  if (mid && rid) return `${mid}:${rid}`;
  if (mid && rec?.type === 'assistant') return `${mid}:`;
  return rec?.uuid ?? JSON.stringify(rec).slice(0, 200);
}

/**
 * Workspace names implied by a set of `cwd` values.
 *
 * `cwd` is on nearly every transcript record and is the one path that survives
 * a machine migration intact, so it is the anchor. `<root>/<group>/<workspace>`
 * with root in PROJECT_ROOTS: /home/you/projects/work/my-project -> "my-project",
 * /Users/you/Documents/work/my-project/example-api -> "my-project".
 */
export function workspacesFromCwds(cwds) {
  return workspaceContextFromCwds(cwds).workspaces;
}

/** As workspacesFromCwds, but also returns the group level (e.g. `work`, `personal`). */
export function workspaceContextFromCwds(cwds) {
  const workspaces = new Set();
  const groups = new Set();
  for (const c of cwds) {
    if (typeof c !== 'string' || !c) continue;
    const segs = c.split('/').filter(Boolean);
    for (let i = 0; i < segs.length; i++) {
      if (!PROJECT_ROOTS.has(segs[i])) continue;
      if (segs[i + 1] && segs[i + 2]) { groups.add(segs[i + 1]); workspaces.add(segs[i + 2]); }
      break;
    }
  }
  return { workspaces, groups };
}

/**
 * `<ws>/.worktrees/api-ticket123` names no repo on its own. Resolve it against the
 * repos this chat is known to touch: the worktree name is conventionally
 * `<short>-<topic>`, and `api` -> `example-api` is unambiguous when only one
 * known repo ends with `-api`. Ambiguous or unknown => null, never a guess.
 */
function resolveWorktree(name, hints) {
  if (typeof name !== 'string' || !name) return null;
  const known = [...hints].filter((h) => typeof h === 'string' && h).sort();
  if (known.includes(name)) return name;
  for (const tok of name.split(/[-_.]/).filter(Boolean)) {
    const m = known.filter((h) => h === tok || h.endsWith(`-${tok}`) || h.startsWith(`${tok}-`));
    if (m.length === 1) return m[0];
  }
  return null;
}

/** Shared tail of repoFromPath / repoFromDir once the workspace anchor is found. */
function repoFromRest(rest, ws, hints) {
  if (rest.length === 0) return null; // the workspace directory itself
  const head = rest[0];
  if (rest.length === 1) return ws; // a file sitting directly in <ws>
  if (WORKTREE_DIRS.has(head)) return resolveWorktree(rest[1], hints);
  if (SRC_MARKERS.has(head)) return ws; // <ws> IS the repo (single-repo workspace)
  return head;
}

/**
 * Split a path and locate the workspace segment; null when there isn't one.
 *
 * The `<root>/<group>/<ws>` fallback is gated on a KNOWN group, because a
 * checkout that skipped the group level (`~/Documents/some-repo/service/...`)
 * otherwise reads as workspace "service" and invents a repo that never existed.
 * With no groups supplied the gate is open, which is what the unit cases use.
 */
function anchor(p, workspaces, groups) {
  const segs = p.split('/').filter(Boolean);
  if (segs.some(isExcludedSegment)) return null;
  for (let i = 0; i < segs.length; i++) {
    if (workspaces.has(segs[i])) return { ws: segs[i], rest: segs.slice(i + 1) };
  }
  for (let i = 0; i + 2 < segs.length; i++) {
    if (!PROJECT_ROOTS.has(segs[i])) continue;
    if (groups.size && !groups.has(segs[i + 1])) return null;
    return { ws: segs[i + 2], rest: segs.slice(i + 3) };
  }
  return null;
}

const ctxOf = (ctx) => ({
  workspaces: ctx.workspaces instanceof Set ? ctx.workspaces : new Set(ctx.workspaces || []),
  groups: ctx.groups instanceof Set ? ctx.groups : new Set(ctx.groups || []),
  hints: ctx.repoHints instanceof Set ? ctx.repoHints : new Set(ctx.repoHints || []),
});

/**
 * repo name from an edited-file path.
 *
 * ctx = { workspaces: Set<string>, repoHints: Set<string> }. Both come from the
 * chat being extracted, so the function is still pure: same inputs, same output.
 */
export function repoFromPath(p, ctx = {}) {
  if (typeof p !== 'string' || !p) return null;
  for (const pre of TMP_PREFIXES) if (p.startsWith(pre)) return null;
  const { workspaces, groups, hints } = ctxOf(ctx);
  const a = anchor(p, workspaces, groups);
  if (!a) return null;
  return repoFromRest(a.rest, a.ws, hints);
}

/** repo name from a directory (a `cwd`): every segment is a directory. */
export function repoFromDir(d, ctx = {}) {
  if (typeof d !== 'string' || !d) return null;
  for (const pre of TMP_PREFIXES) if (d.startsWith(pre)) return null;
  const { workspaces, groups, hints } = ctxOf(ctx);
  const a = anchor(d, workspaces, groups);
  if (!a) return null;
  if (a.rest.length === 0) return null;
  const head = a.rest[0];
  if (WORKTREE_DIRS.has(head)) return resolveWorktree(a.rest[1], hints);
  if (SRC_MARKERS.has(head)) return a.ws;
  return head;
}

/**
 * Two passes: resolve every unambiguous repo first, then use that set to name
 * the worktree checkouts, which are only interpretable relative to it.
 */
export function reposTouched(filePaths, cwds) {
  const { workspaces, groups } = workspaceContextFromCwds(cwds);
  const ctx = { workspaces, groups, repoHints: new Set() };
  for (const d of cwds) { const r = repoFromDir(d, ctx); if (r) ctx.repoHints.add(r); }
  for (const f of filePaths) { const r = repoFromPath(f, ctx); if (r) ctx.repoHints.add(r); }
  const out = new Set(ctx.repoHints);
  for (const d of cwds) { const r = repoFromDir(d, ctx); if (r) out.add(r); }
  for (const f of filePaths) { const r = repoFromPath(f, ctx); if (r) out.add(r); }
  return [...out].sort();
}

export function ticketKeysFrom(text) {
  if (typeof text !== 'string' || !text) return [];
  const out = [];
  // A year-like number followed by another date component is a DATE, not a
  // ticket: `RELEASE-NOTES-2026-08-14.md` -> `NOTES-2026`,
  // `VERDICTS-2026-08-14.md` -> `VERDICTS-2026`. A filename like that, pasted
  // into every chat of one review round, can weld dozens of unrelated chats into
  // one giant "task".
  //
  // The test is deliberately CONTEXTUAL rather than "reject 1900-2099". A bare
  // `TICKET-2000` is a perfectly ordinary ticket and a key-level year rule would
  // eat it; what is never a ticket is `<prefix>-YYYY-MM`. Requiring the trailing
  // `-MM` keeps the rule from firing on any tracker whose numbering happens to
  // pass through the year range.
  //
  // Matching is case-insensitive and keys normalise to UPPER CASE, so the same
  // ticket written `proj-123` in a branch name and `PROJ-123` in a prompt stitch
  // as one. The shape guard (isPlausibleTicketKey) plus TICKET_DENY reject the
  // obvious non-tickets (`utf-8`, `sha-1`, line ranges, hex ids).
  for (const m of text.matchAll(/\b([A-Za-z][A-Za-z0-9]+)-(\d+)\b(-\d{2})?/g)) {
    const prefix = m[1].toUpperCase();
    if (TICKET_DENY.has(prefix)) continue;
    const key = `${prefix}-${m[2]}`;
    const n = Number(m[2]);
    if (m[3] && m[2].length === 4 && n >= 1900 && n <= 2099) continue;
    if (!isPlausibleTicketKey(key)) continue;
    out.push(key);
  }
  return out;
}

/** 7-40 hex shas, only from git commit / push shaped output. */
export function commitShasFrom(stdout) {
  if (typeof stdout !== 'string' || !stdout) return [];
  const out = [];
  for (const m of stdout.matchAll(/\[[^\]\n]*?\b([0-9a-f]{7,40})\]/g)) out.push(m[1]);
  for (const m of stdout.matchAll(/\b([0-9a-f]{7,40})\.\.([0-9a-f]{7,40})\b/g)) { out.push(m[1]); out.push(m[2]); }
  for (const m of stdout.matchAll(/^commit ([0-9a-f]{7,40})\b/gm)) out.push(m[1]);
  return out;
}

function branchesFromGitOperation(op) {
  const out = [];
  if (!isObj(op)) return out;
  for (const v of Object.values(op)) {
    if (isObj(v) && typeof v.branch === 'string') out.push(v.branch);
  }
  return out;
}

// ---- the extractor --------------------------------------------------------

/**
 * The extraction core, over an already-parsed record list.
 *
 * Factored out of extractFile so a SUBAGENT SIDECAR goes through exactly the
 * same measurement as a top-level chat — same gap attribution, same LOC
 * counting, same repo resolution. A sidecar is not a lesser kind of transcript;
 * it is the same kind, spawned by another one.
 *
 * `opts.sidechain` skips the resume-chain trim: a sidecar's records all carry
 * the PARENT's sessionId, which the trim would read as copied parent history.
 *
 * @returns {{chat: object, detail: object, spawnStatsById: Map, spawnTypeById: Map}}
 *   `chat` still has placeholder `file` / `project_dir` / `parse_errors`; the
 *   caller owns those because only it knows where the bytes came from.
 *   The two maps are keyed by spawning tool_use id and let the caller reconcile
 *   parent-reported subagent stats against sidecar-measured ones.
 */
export function extractRecords(rawRecords, chat_id, opts = {}) {
  const sidechain = opts.sidechain === true;
  const parse_errors = 0;

  // 1. dedupe, keeping first occurrence. A streamed assistant message can be
  //    split across several records that share message.id + requestId, so a
  //    record is only dropped when its payload matches the one already kept.
  const seen = new Map();
  const records = [];
  for (const r of rawRecords) {
    const k = dedupeKey(r);
    const sig = JSON.stringify(r.message?.content ?? r.message ?? null);
    if (seen.get(k) === sig) continue;
    if (!seen.has(k)) seen.set(k, sig);
    records.push(r);
  }

  // 2. resume chain: leading run of records whose sessionId != this file's id
  //    is copied parent history. It is used to name the parent and then dropped
  //    from every metric, so a resumed chat does not re-count its parent's work.
  let parent_chat_id = null;
  let firstOwn = 0;
  const firstSession = records.find((r) => typeof r.sessionId === 'string')?.sessionId;
  if (firstSession && firstSession !== chat_id) {
    parent_chat_id = firstSession;
    if (!sidechain) {
      while (firstOwn < records.length && records[firstOwn].sessionId === parent_chat_id) firstOwn++;
      if (firstOwn >= records.length) firstOwn = 0; // whole file is foreign-id: keep it
    }
  }
  const own = records.slice(firstOwn);

  // 3. timeline = own records that carry a usable timestamp, ordered
  const timeline = own
    .map((r, i) => ({ r, i, t: ts(r.timestamp) }))
    .filter((x) => x.t !== null)
    .sort((a, b) => (a.t - b.t) || (a.i - b.i));
  const N = timeline.length;
  const gapMs = [];
  for (let g = 0; g < N - 1; g++) gapMs.push(timeline[g + 1].t - timeline[g].t);

  // ---- gap attribution ----------------------------------------------------
  const claimed = new Array(Math.max(0, N - 1)).fill(null);

  // away gaps first: they outrank everything, including wall clock
  const away_gaps = [];
  let awayMsTotal = 0;
  for (let g = 0; g < gapMs.length; g++) {
    if (gapMs[g] > AWAY_MS) {
      claimed[g] = 'away';
      awayMsTotal += gapMs[g];
      away_gaps.push({ after_uuid: timeline[g].r.uuid ?? null, min: round2(gapMs[g] / MIN) });
    }
  }

  // index of tool_use blocks -> assistant timeline position
  const toolUse = new Map(); // id -> {pos, name, input}
  for (let p = 0; p < N; p++) {
    const r = timeline[p].r;
    if (r.type !== 'assistant') continue;
    for (const b of contentBlocks(r)) {
      if (b.type === 'tool_use' && typeof b.id === 'string') {
        toolUse.set(b.id, { pos: p, name: b.name ?? 'unknown', input: b.input ?? {} });
      }
    }
  }

  // pair tool_use -> tool_result
  const pairs = []; // {a, u, name, rec}
  for (let p = 0; p < N; p++) {
    const r = timeline[p].r;
    if (r.type !== 'user') continue;
    for (const b of contentBlocks(r)) {
      if (b.type !== 'tool_result' || typeof b.tool_use_id !== 'string') continue;
      const tu = toolUse.get(b.tool_use_id);
      if (!tu || tu.pos >= p) continue;
      pairs.push({ a: tu.pos, u: p, name: tu.name, id: b.tool_use_id, block: b, rec: r });
    }
  }

  const sumUnclaimed = (from, to, label) => {
    let ms = 0;
    for (let g = from; g < to; g++) {
      if (claimed[g] !== null) continue;
      claimed[g] = label;
      ms += gapMs[g];
    }
    return ms;
  };
  const hasAssistantBetween = (a, u) => {
    for (let p = a + 1; p < u; p++) if (timeline[p].r.type === 'assistant') return true;
    return false;
  };

  // awaiting approval: tool_use -> tool_result gap >60s with no assistant tokens between
  let awaitingMs = 0;
  const awaitingSeen = new Set();
  for (const pr of pairs) {
    const key = `${pr.a}:${pr.u}`;
    if (awaitingSeen.has(key)) continue;
    const span = timeline[pr.u].t - timeline[pr.a].t;
    if (span <= AWAITING_TRIGGER_MS) continue;
    if (hasAssistantBetween(pr.a, pr.u)) continue;
    awaitingSeen.add(key);
    awaitingMs += sumUnclaimed(pr.a, pr.u, 'awaiting');
  }

  // human turnaround + ambiguous splits, anchored on the nearest preceding assistant
  let turnaroundMs = 0;
  let ambiguousAgentMs = 0;
  for (let p = 0; p < N; p++) {
    if (!isRealHumanPrompt(timeline[p].r)) continue;
    let a = -1;
    for (let q = p - 1; q >= 0; q--) {
      if (timeline[q].r.type === 'assistant') { a = q; break; }
      if (isRealHumanPrompt(timeline[q].r)) break; // queued prompts: no assistant in between
    }
    if (a < 0) continue;
    const yielded = timeline[a].r?.message?.stop_reason === 'end_turn';
    const usable = sumUnclaimed(a, p, yielded ? 'turnaround' : 'ambiguous');
    if (usable <= 0) continue;
    if (yielded) {
      turnaroundMs += Math.min(TURNAROUND_CAP_MS, usable);
    } else {
      // ActivityWatch convention: an unattributable gap is halved, not assigned
      const half = usable / 2;
      turnaroundMs += Math.min(TURNAROUND_CAP_MS, half);
      if (half <= AGENT_GAP_CAP_MS) ambiguousAgentMs += half;
    }
  }

  // everything left is agent work; credited in full at <=120s, credited 0 above
  let agentMs = ambiguousAgentMs;
  for (let g = 0; g < gapMs.length; g++) {
    if (claimed[g] !== null) continue;
    claimed[g] = 'agent';
    if (gapMs[g] <= AGENT_GAP_CAP_MS) agentMs += gapMs[g];
  }

  // ---- content aggregation ------------------------------------------------
  const models = [];
  const permission_modes = [];
  const tools_histogram = {};
  const files_edited = new Set();
  const user_modified_files = new Set();
  const branches = [];
  const commit_shas = [];
  const prSeen = new Map();
  const ticketSource = [];
  const humanPrompts = [];
  const tokens = { in: 0, out: 0, cache_read: 0 };
  const turnDurations = [];
  const subagents = { count: 0, types: {}, total_duration_ms: 0, total_tokens: 0, loc_added: 0, loc_removed: 0 };
  const subagentToolUseIds = new Set();
  /** tool_use ids whose result record carried a structured `toolUseResult`. */
  const structuredResultIds = new Set();
  /** spawning tool_use id -> what the PARENT transcript reported for that spawn.
   *  Kept per-id so a sidecar can replace exactly its own contribution instead
   *  of the whole aggregate — see foldSidecars. */
  const spawnStatsById = new Map();
  /** spawning tool_use id -> the agentType the parent recorded (often 'unknown'). */
  const spawnTypeById = new Map();
  const cwds = new Set();
  const compactions = { count: 0, dropped_tokens: 0 };
  const errors = { tool_error_count: 0, interrupted_count: 0 };
  let loc_added = 0;
  let loc_removed = 0;
  let assistant_steps = 0;
  let turns = 0;
  let title = null;
  let titleRank = -1; // custom-title (2) beats ai-title (1)
  let finalText = '';
  const promptIds = new Set();

  const addPatch = (patch) => {
    let n = 0;
    if (!Array.isArray(patch)) return n;
    for (const hunk of patch) {
      if (!isObj(hunk) || !Array.isArray(hunk.lines)) continue;
      for (const line of hunk.lines) {
        if (typeof line !== 'string') continue;
        if (line.startsWith('+')) { loc_added++; n++; }
        else if (line.startsWith('-')) { loc_removed++; n++; }
      }
    }
    return n;
  };
  const countLines = (s) => {
    if (typeof s !== 'string' || s === '') return 0;
    const parts = s.split('\n');
    if (parts[parts.length - 1] === '') parts.pop();
    return parts.length;
  };

  // Metadata records (custom-title, ai-title, agent-name, mode, permission-mode)
  // carry NO timestamp, so they never enter `timeline`. Aggregating over the
  // timeline alone silently dropped every title. Append them in file order so
  // last-write-wins still holds.
  const timedIdx = new Set(timeline.map((x) => x.i));
  const aggregation = timeline.map((x) => x.r).concat(own.filter((_, i) => !timedIdx.has(i)));

  for (const r of aggregation) {
    if (typeof r.cwd === 'string' && r.cwd) cwds.add(r.cwd);
    if (typeof r.gitBranch === 'string' && r.gitBranch !== '' && r.gitBranch !== 'HEAD') branches.push(r.gitBranch);

    if (r.type === 'assistant') {
      assistant_steps++;
      const m = r.message ?? {};
      if (typeof m.model === 'string' && m.model && m.model !== '<synthetic>') models.push(m.model);
      if (m.stop_reason === 'end_turn') turns++;
      const u = m.usage ?? {};
      tokens.in += Number(u.input_tokens) || 0;
      tokens.out += Number(u.output_tokens) || 0;
      tokens.cache_read += Number(u.cache_read_input_tokens) || 0;
      for (const b of contentBlocks(r)) {
        if (b.type !== 'tool_use') continue;
        const name = b.name ?? 'unknown';
        tools_histogram[name] = (tools_histogram[name] || 0) + 1;
        const inp = isObj(b.input) ? b.input : {};
        const fp = inp.file_path ?? inp.filePath ?? inp.notebook_path ?? inp.path;
        if (EDIT_TOOLS.has(name) && typeof fp === 'string' && fp) files_edited.add(fp);
        // The spawn tool was renamed Task -> Agent; async team spawns never emit
        // a matching toolUseResult, so the tool_use block is the only evidence.
        if (SPAWN_TOOLS.has(name) && typeof b.id === 'string') {
          if (!subagentToolUseIds.has(b.id)) {
            subagentToolUseIds.add(b.id);
            subagents.count++;
            const at = inp.subagent_type ?? inp.agentType ?? inp.agent_type ?? 'unknown';
            subagents.types[at] = (subagents.types[at] || 0) + 1;
            spawnTypeById.set(b.id, at);
          }
        }
      }
      const txt = messageText(r).trim();
      if (txt) finalText = txt;
    } else if (r.type === 'user') {
      if (isRealHumanPrompt(r)) {
        const pid = r.promptId ?? r.uuid ?? `#${humanPrompts.length}`;
        if (!promptIds.has(pid)) {
          promptIds.add(pid);
          const text = messageText(r);
          humanPrompts.push({ at: r.timestamp ?? null, text });
          ticketSource.push(text);
        }
      }
      for (const b of contentBlocks(r)) {
        if (b.type === 'tool_result' && b.is_error === true) errors.tool_error_count++;
      }
      const tur = r.toolUseResult;
      if (isObj(tur)) {
        for (const b of contentBlocks(r)) {
          if (b.type === 'tool_result' && typeof b.tool_use_id === 'string') structuredResultIds.add(b.tool_use_id);
        }
        const toolName = (() => {
          for (const b of contentBlocks(r)) {
            if (b.type === 'tool_result' && typeof b.tool_use_id === 'string' && toolUse.has(b.tool_use_id)) {
              return toolUse.get(b.tool_use_id).name;
            }
          }
          return null;
        })();
        const fp = tur.filePath ?? tur.file_path ?? tur.path;
        if (typeof fp === 'string' && fp) files_edited.add(fp);
        // A Write that creates a file reports structuredPatch: [] and puts the
        // whole body in `content`, so every new file used to score 0 LOC. That
        // is most of the LOC in a greenfield chat.
        const patched = addPatch(tur.structuredPatch);
        if (patched === 0 && tur.type === 'create') loc_added += countLines(tur.content);
        if (tur.userModified === true) {
          const target = typeof fp === 'string' && fp ? fp : (() => {
            for (const b of contentBlocks(r)) {
              const tu = b.type === 'tool_result' ? toolUse.get(b.tool_use_id) : null;
              const p2 = tu?.input?.file_path ?? tu?.input?.filePath ?? tu?.input?.path;
              if (typeof p2 === 'string' && p2) return p2;
            }
            return null;
          })();
          if (target) user_modified_files.add(target);
        }
        if (tur.interrupted === true) errors.interrupted_count++;
        if (tur.status === 'error' || tur.status === 'failed') errors.tool_error_count++;
        for (const b of branchesFromGitOperation(tur.gitOperation)) branches.push(b);
        if (toolName === 'Bash' || tur.gitOperation !== undefined) {
          for (const sha of commitShasFrom(tur.stdout)) commit_shas.push(sha);
        }
        const spawnId = (() => {
          for (const b of contentBlocks(r)) {
            if (b.type === 'tool_result' && typeof b.tool_use_id === 'string') return b.tool_use_id;
          }
          return null;
        })();
        const looksLikeAgent = tur.agentType !== undefined || tur.agentId !== undefined
          || isObj(tur.toolStats);
        if (SPAWN_TOOLS.has(toolName) || looksLikeAgent) {
          // Already counted from the tool_use side unless this result arrived
          // without one (older Task shape, or an out-of-band completion record).
          if (!spawnId || !subagentToolUseIds.has(spawnId)) {
            if (spawnId) subagentToolUseIds.add(spawnId);
            subagents.count++;
            const at = tur.agentType ?? 'unknown';
            subagents.types[at] = (subagents.types[at] || 0) + 1;
            if (spawnId) spawnTypeById.set(spawnId, at);
          } else if (tur.agentType !== undefined && subagents.types.unknown) {
            // the result names the type the spawn block did not
            subagents.types.unknown--;
            if (!subagents.types.unknown) delete subagents.types.unknown;
            subagents.types[tur.agentType] = (subagents.types[tur.agentType] || 0) + 1;
            if (spawnId) spawnTypeById.set(spawnId, tur.agentType);
          }
          const dur = Number(tur.totalDurationMs) || 0;
          const tok = Number(tur.totalTokens) || 0;
          subagents.total_duration_ms += dur;
          subagents.total_tokens += tok;
          // Subagent LOC is deliberately NOT folded into the chat's own
          // loc_added/loc_removed: it is work the chat delegated, not work the
          // main thread did, and mixing them makes both numbers unusable.
          const st = isObj(tur.toolStats) ? tur.toolStats : null;
          const la = st ? Number(st.linesAdded) || 0 : 0;
          const lr = st ? Number(st.linesRemoved) || 0 : 0;
          subagents.loc_added += la;
          subagents.loc_removed += lr;
          if (spawnId) {
            const prevStat = spawnStatsById.get(spawnId)
              || { loc_added: 0, loc_removed: 0, duration_ms: 0, tokens: 0 };
            spawnStatsById.set(spawnId, {
              loc_added: prevStat.loc_added + la,
              loc_removed: prevStat.loc_removed + lr,
              duration_ms: prevStat.duration_ms + dur,
              tokens: prevStat.tokens + tok,
            });
          }
        }
      }
    } else if (r.type === 'system') {
      if (r.subtype === 'turn_duration') {
        const d = Number(r.durationMs);
        if (Number.isFinite(d)) turnDurations.push(d);
      } else if (r.subtype === 'compact_boundary') {
        compactions.count++;
        const cm = isObj(r.compactMetadata) ? r.compactMetadata : {};
        const pre = Number(cm.preTokens) || 0;
        const post = Number(cm.postTokens) || 0;
        compactions.dropped_tokens += Math.max(0, pre - post);
      }
    } else if (r.type === 'pr-link') {
      const num = r.prNumber ?? null;
      const repo = r.prRepository ?? null;
      const key = `${repo}#${num}`;
      if (num !== null && !prSeen.has(key)) prSeen.set(key, { prNumber: num, prRepository: repo });
    } else if (r.type === 'permission-mode' || r.type === 'mode') {
      const mode = r.mode ?? r.permissionMode ?? r.message?.mode;
      if (typeof mode === 'string' && mode) permission_modes.push(mode);
    } else if (TITLE_RANK[r.type] !== undefined) {
      const rank = TITLE_RANK[r.type];
      const t = r.customTitle ?? r.title ?? r.agentName ?? r.aiTitle
        ?? (typeof r.content === 'string' ? r.content : null);
      if (typeof t === 'string' && t.trim() && rank >= titleRank) { title = t.trim(); titleRank = rank; }
    }
  }

  // ---- LOC where the harness recorded no structured result -----------------
  //
  // The `structuredPatch` / `type:"create"` payload on `toolUseResult` is the
  // preferred measurement and is used wherever it exists. It does NOT always
  // exist: SUBAGENT SIDECAR transcripts record an edit's result as a plain text
  // acknowledgement with no `toolUseResult` at all, so a subagent that rewrote a
  // file scored 0 lines while its `files_edited` listed the file. That is a
  // measurement hole, not a subagent that wrote nothing.
  //
  // The fallback measures the edit from the INPUT the model actually sent, which
  // is the same thing the patch would have described:
  //   Edit       -> +lines(new_string), -lines(old_string)
  //   MultiEdit  -> the same, summed over `edits`
  //   Write      -> +lines(content)
  // `replace_all` is counted once, because the input does not say how many times
  // it matched — understating is the safe direction. A failed tool call is
  // skipped: nothing reached the file.
  const editLinesFromInput = (name, inp) => {
    let add = 0;
    let del = 0;
    const one = (e) => {
      if (!isObj(e)) return;
      if (typeof e.new_string === 'string') add += countLines(e.new_string);
      if (typeof e.old_string === 'string') del += countLines(e.old_string);
    };
    if (name === 'MultiEdit' && Array.isArray(inp.edits)) inp.edits.forEach(one);
    else if (name === 'Write') add += countLines(inp.content ?? inp.file_text ?? '');
    else if (name === 'NotebookEdit') add += countLines(inp.new_source ?? '');
    else one(inp);
    return { add, del };
  };
  for (const pr of pairs) {
    if (!EDIT_TOOLS.has(pr.name)) continue;
    if (structuredResultIds.has(pr.id)) continue;
    if (pr.block?.is_error === true) continue;
    const { add, del } = editLinesFromInput(pr.name, isObj(toolUse.get(pr.id)?.input) ? toolUse.get(pr.id).input : {});
    loc_added += add;
    loc_removed += del;
  }

  // AskUserQuestion latency, from the tool_use/tool_result pairing
  const aukLat = [];
  for (const pr of pairs) {
    if (pr.name !== 'AskUserQuestion') continue;
    aukLat.push((timeline[pr.u].t - timeline[pr.a].t) / MIN);
  }
  aukLat.sort((a, b) => a - b);
  const askCount = Object.prototype.hasOwnProperty.call(tools_histogram, 'AskUserQuestion')
    ? tools_histogram.AskUserQuestion : 0;

  const files = [...files_edited];
  const cwdList = [...cwds].sort();
  const repos = reposTouched(files, cwdList);
  const branchList = uniqSorted(branches);
  for (const b of branchList) ticketSource.push(b);
  if (title) ticketSource.push(title);

  const started = timeline.length ? timeline[0].t : null;
  const ended = timeline.length ? timeline[N - 1].t : null;
  const wallMs = started !== null ? Math.max(0, ended - started - awayMsTotal) : 0;

  const tdSorted = [...turnDurations].sort((a, b) => a - b);

  // Sidecar-measured slots, always present so chat.v1 has one shape whether or
  // not the chat delegated anything. foldSidecars fills them in place.
  subagents.sidecar_count = 0;
  subagents.active_min = 0;
  subagents.files_edited = [];
  subagents.repos = [];
  subagents.cwds = [];
  subagents.per_type = {};

  const chat = {
    schema: 'chat.v1',
    chat_id,
    file: null,
    project_dir: null,
    parent_chat_id,
    title,
    started_at: started !== null ? new Date(started).toISOString() : null,
    ended_at: ended !== null ? new Date(ended).toISOString() : null,
    models_used: uniqSorted(models),
    permission_modes: uniqSorted(permission_modes),
    wall_clock_min: round2(wallMs / MIN),
    agent_active_min: round2(agentMs / MIN),
    human_rounds: humanPrompts.length,
    human_turnaround_min: round2(turnaroundMs / MIN),
    awaiting_min: round2(awaitingMs / MIN),
    away_gaps,
    turn_durations_ms: tdSorted.length
      ? {
        count: tdSorted.length,
        p50: quantile(tdSorted, 0.5),
        p90: quantile(tdSorted, 0.9),
        total: tdSorted.reduce((s, x) => s + x, 0),
      }
      : null,
    turns,
    assistant_steps,
    tokens,
    tools_histogram,
    files_edited: files.sort(),
    loc_added,
    loc_removed,
    user_modified_files: [...user_modified_files].sort(),
    subagents,
    compactions,
    errors,
    ask_user_question: {
      count: askCount,
      latency_min_p50: aukLat.length ? round2(quantile(aukLat, 0.5)) : null,
      latency_min_max: aukLat.length ? round2(aukLat[aukLat.length - 1]) : null,
    },
    repos_touched: repos,
    cwds: cwdList,
    branches: branchList,
    commit_shas: uniqSorted(commit_shas),
    pr_links: [...prSeen.values()].sort((a, b) => String(a.prRepository).localeCompare(String(b.prRepository)) || Number(a.prNumber) - Number(b.prNumber)),
    ticket_keys: uniqSorted(ticketSource.flatMap(ticketKeysFrom)),
    // filled by the caller: they depend on the sidecars and on where the file sits
    noise: null,
    repo_share: {},
    parse_errors,
  };

  return { chat, detail: { humanPrompts, finalText }, spawnStatsById, spawnTypeById };
}

// ---- subagent sidecars ----------------------------------------------------

/**
 * Next to `<dir>/<chat_id>.jsonl` the harness writes `<dir>/<chat_id>/subagents/`
 * holding one `agent-<id>.jsonl` per spawned subagent plus an `agent-<id>.meta.json`
 * naming its type. That directory is where the DELEGATED work actually is.
 *
 * It has to be mined, because the parent transcript no longer records it. In this
 * Claude Code era a `Task`/`Agent` tool_result carries no `toolStats`, so a chat
 * that delegated everything reads as zero LOC and near-zero agent time; and the
 * parent does not even persist every spawn (one 104-spawn sprint kept 2). The
 * sidecars are the only surviving measurement of that work.
 *
 * Depth-2 agents live FLAT in the same directory with a `parentAgentId` in their
 * meta, so a single non-recursive listing already sees the whole tree.
 */
const SIDECAR_DIRNAME = 'subagents';

function readMetaJson(file) {
  try {
    const o = JSON.parse(fs.readFileSync(file, 'utf8'));
    return isObj(o) ? o : null;
  } catch {
    return null;
  }
}

/** Sidecar transcripts belonging to a transcript path, sorted, with their meta. */
export function sidecarsFor(transcriptPath) {
  const abs = path.resolve(transcriptPath);
  const dir = path.join(
    path.dirname(abs),
    path.basename(abs).replace(/\.jsonl$/i, ''),
    SIDECAR_DIRNAME,
  );
  let names;
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  return names
    .filter((n) => n.endsWith('.jsonl'))
    .sort()
    .map((n) => ({
      file: path.join(dir, n),
      agent_id: n.replace(/\.jsonl$/i, '').replace(/^agent-/, ''),
      meta: readMetaJson(path.join(dir, n.replace(/\.jsonl$/i, '.meta.json'))),
    }));
}

/**
 * Fold a chat's sidecars into `chat.subagents`, in place.
 *
 * Two invariants, both load-bearing:
 *
 *   1. NOTHING lands in the chat's own `loc_added` / `loc_removed` /
 *      `files_edited` / `agent_active_min`. Delegated work is reported beside
 *      the main thread's, never inside it — a subagent's minutes overlap the
 *      parent's wall clock, so adding them would double-count time that was
 *      spent once.
 *   2. NOTHING is counted twice inside `subagents` either. Where the parent DID
 *      report `toolStats` for a spawn, and a sidecar for that same
 *      `toolUseId` exists, the sidecar measurement REPLACES the reported one
 *      (it is the primary record, and the reported one is a summary of it).
 *      Spawns with no sidecar keep their reported numbers.
 */
export function foldSidecars(chat, transcriptPath, spawnStatsById, spawnTypeById) {
  const found = sidecarsFor(transcriptPath);
  if (found.length === 0) return chat;

  const sub = chat.subagents;
  const per_type = {};
  const files = new Set();
  const cwds = new Set();
  let matchedSpawns = 0; // sidecars the parent transcript also knew about
  let locAdded = 0;
  let locRemoved = 0;
  let activeMin = 0;
  let tokens = 0;
  let durationMs = 0;

  for (const s of found) {
    let sc;
    try {
      const { records } = readJsonl(s.file);
      sc = extractRecords(records, `agent-${s.agent_id}`, { sidechain: true }).chat;
    } catch {
      continue; // an unreadable sidecar must not lose the parent's row
    }
    const type = (s.meta && typeof s.meta.agentType === 'string' && s.meta.agentType)
      || (spawnTypeById && s.meta && spawnTypeById.get(s.meta.toolUseId))
      || 'unknown';
    const models = uniqSorted([
      ...(s.meta && typeof s.meta.model === 'string' ? [s.meta.model] : []),
      ...(sc.models_used || []),
    ]);

    locAdded += sc.loc_added;
    locRemoved += sc.loc_removed;
    activeMin += sc.agent_active_min;
    tokens += (sc.tokens?.in || 0) + (sc.tokens?.out || 0);
    durationMs += Math.round((sc.wall_clock_min || 0) * MIN);
    for (const f of sc.files_edited) files.add(f);
    for (const d of sc.cwds) cwds.add(d);

    const pt = per_type[type] || (per_type[type] = {
      count: 0, active_min: 0, loc_added: 0, loc_removed: 0, files: 0, models: [],
    });
    pt.count++;
    pt.active_min = round2(pt.active_min + sc.agent_active_min);
    pt.loc_added += sc.loc_added;
    pt.loc_removed += sc.loc_removed;
    pt.files += sc.files_edited.length;
    pt.models = uniqSorted([...pt.models, ...models]);

    // meta.json is the only place a spawn's type is recorded reliably; use it to
    // repair an `unknown` the parent transcript left behind.
    const tuid = s.meta?.toolUseId;
    const known = !!(tuid && spawnTypeById && spawnTypeById.has(tuid));
    if (known) {
      matchedSpawns++;
      if (spawnTypeById.get(tuid) === 'unknown' && type !== 'unknown' && sub.types.unknown) {
        sub.types.unknown--;
        if (!sub.types.unknown) delete sub.types.unknown;
        sub.types[type] = (sub.types[type] || 0) + 1;
        spawnTypeById.set(tuid, type);
      }
    } else {
      // a spawn the parent never recorded: a depth-2 agent (spawned by another
      // subagent, so no tool_use block exists in this transcript at all), or a
      // spawn whose block the harness dropped
      sub.types[type] = (sub.types[type] || 0) + 1;
    }
    // drop the parent's summary of this spawn: the sidecar just measured it
    if (tuid && spawnStatsById && spawnStatsById.has(tuid)) {
      const st = spawnStatsById.get(tuid);
      sub.loc_added -= st.loc_added;
      sub.loc_removed -= st.loc_removed;
      sub.total_duration_ms -= st.duration_ms;
      sub.total_tokens -= st.tokens;
      spawnStatsById.delete(tuid);
    }
  }

  sub.sidecar_count = found.length;
  sub.active_min = round2(activeMin);
  sub.files_edited = [...files].sort();
  sub.cwds = [...cwds].sort();
  sub.repos = reposTouched(sub.files_edited, sub.cwds);
  sub.per_type = Object.fromEntries(Object.keys(per_type).sort().map((k) => [k, per_type[k]]));
  sub.loc_added = Math.max(0, sub.loc_added) + locAdded;
  sub.loc_removed = Math.max(0, sub.loc_removed) + locRemoved;
  sub.total_duration_ms = Math.max(0, sub.total_duration_ms) + durationMs;
  sub.total_tokens = Math.max(0, sub.total_tokens) + tokens;
  // Spawns the parent saw but has no sidecar for, plus every sidecar. Keeps the
  // invariant `count === sum(types)` and is correct in both directions: a sprint
  // whose parent recorded 104 spawns and kept 2 sidecars still reads 104, while
  // depth-2 agents that appear only as sidecars are added rather than lost.
  sub.count = Math.max(found.length, sub.count - matchedSpawns + found.length);
  return chat;
}

// ---- per-repo attribution --------------------------------------------------

/**
 * `repo_share` — how one chat's agent minutes divide across the repos it touched.
 *
 * A chat is the unit of MEASUREMENT but not the unit of OWNERSHIP: a session that
 * spends four hours in `example-api` and edits one file in `example-app` used to
 * hand all four hours to both, so summing a repo's hours over the ledger
 * multiplied the total by the average repo count per chat. Splitting by edited
 * files makes the shares sum to exactly 1, which makes the roll-up additive.
 *
 * Files edited BY SUBAGENTS count here, because the delegating chat is where
 * their time is billed and their files are the best evidence of where it went.
 *
 * A chat with no edits at all (an investigation, a question) attributes 100% to
 * its cwd repo. When even that is unresolvable the whole share lands on
 * `unknown`, which keeps the sum at 1 and makes the loss visible instead of
 * silently deleting the hours.
 */
export function repoShare(chat) {
  const files = [...(chat.files_edited || []), ...(chat.subagents?.files_edited || [])];
  const cwds = uniqSorted([...(chat.cwds || []), ...(chat.subagents?.cwds || [])]);
  const { workspaces, groups } = workspaceContextFromCwds(cwds);
  const ctx = { workspaces, groups, repoHints: new Set(reposTouched(files, cwds)) };

  const count = new Map();
  for (const f of files) {
    const r = repoFromPath(f, ctx);
    if (r) count.set(r, (count.get(r) || 0) + 1);
  }
  if (count.size === 0) {
    // No edits: fall back to where the session SAT. A cwd that is the workspace
    // root of a multi-repo checkout (`~/projects/work/my-project`) names no single
    // repo, so the workspace itself is the bucket — coarser than a repo, but it
    // is the true identity of the work and beats dumping a whole investigation
    // into `unknown`.
    for (const d of cwds) {
      const r = repoFromDir(d, ctx) ?? [...workspaces].find((w) => d.split('/').includes(w)) ?? null;
      if (r) count.set(r, (count.get(r) || 0) + 1);
    }
  }
  if (count.size === 0) return { unknown: 1 };

  const total = [...count.values()].reduce((s, x) => s + x, 0);
  const keys = [...count.keys()].sort();
  const out = {};
  for (const k of keys) out[k] = round4(count.get(k) / total);
  // force an exact sum of 1: rounding residue goes to the biggest bucket, so the
  // roll-up is additive to the cent and the choice is deterministic.
  const resid = round4(1 - keys.reduce((s, k) => s + out[k], 0));
  if (resid !== 0) {
    const big = keys.slice().sort((a, b) => count.get(b) - count.get(a) || a.localeCompare(b))[0];
    out[big] = round4(out[big] + resid);
  }
  return out;
}

// ---- noise -----------------------------------------------------------------

/**
 * Sessions that exist to test the harness, not to do work.
 *
 * They are real transcripts and they stay in the ledger — deleting evidence is
 * never the fix — but they are not a reference class for anything, so
 * calibrate.mjs drops them from the quantiles. Two kinds, both observed:
 *
 *   `permtest`  — a permission probe: "echo PERMTEST_OK", "testing perms here".
 *   `qa-probe`  — a session run out of a scratch tree (`/tmp/...`), which is
 *                 where the harness's own probes get pointed.
 *
 * Detection is deliberately RATIO-BASED rather than keyword-based: real chats
 * discuss permission probes at length (this very ledger's build did), so a bare
 * `PERMTEST` match anywhere would condemn the biggest sessions in the corpus.
 * A chat is a probe only when probing is essentially ALL it did — a handful of
 * rounds, at least half of them probes.
 */
const PERMTEST_RE = /\bPERMTEST[A-Z0-9_]*/i;
const PERM_PROBE_RE = /^\s*(?:just\s+)?(?:testing|test|checking|check|probing|probe)\b[\s\S]{0,40}?\bperm(?:s|ission|issions)?\b/i;
const PROBE_MAX_ROUNDS = 5;

export function isPermissionProbePrompt(text) {
  if (typeof text !== 'string' || !text) return false;
  return PERMTEST_RE.test(text) || PERM_PROBE_RE.test(text);
}

export function noiseFlag(chat, humanPrompts = []) {
  const rounds = humanPrompts.length;
  const probes = humanPrompts.filter((p) => isPermissionProbePrompt(p?.text)).length;
  if (probes > 0 && rounds <= PROBE_MAX_ROUNDS && probes * 2 >= rounds) return 'permtest';
  const slug = chat.project_dir ? path.basename(chat.project_dir) : '';
  if (/^-tmp(?:-|$)/.test(slug)) return 'qa-probe';
  const cwds = chat.cwds || [];
  if (cwds.length && cwds.every((d) => TMP_PREFIXES.some((p) => d.startsWith(p)))) return 'qa-probe';
  return null;
}

/**
 * @returns {{chat: object, detail: object}} chat.v1 row plus the extra text
 *   digest.mjs needs (human prompts, final assistant text).
 */
export function extractFile(file, opts = {}) {
  const abs = path.resolve(file);
  const chat_id = path.basename(abs).replace(/\.jsonl$/i, '');
  const { records, parse_errors } = readJsonl(abs);
  const { chat, detail, spawnStatsById, spawnTypeById } = extractRecords(records, chat_id, opts);
  chat.file = abs;
  chat.project_dir = path.dirname(abs);
  chat.parse_errors = parse_errors;
  if (opts.sidecars !== false) foldSidecars(chat, abs, spawnStatsById, spawnTypeById);
  chat.noise = noiseFlag(chat, detail.humanPrompts);
  chat.repo_share = repoShare(chat);
  return { chat, detail };
}

// ---- CLI ------------------------------------------------------------------

function listJsonl(dir) {
  return fs.readdirSync(dir)
    .filter((f) => f.endsWith('.jsonl'))
    .sort()
    .map((f) => path.join(dir, f));
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const dir = typeof args.dir === 'string' ? args.dir : null;
  const single = args._[0] ?? (typeof args.file === 'string' ? args.file : null);

  if (!dir && !single) {
    process.stderr.write('usage: extract.mjs <file.jsonl> [--pretty] | extract.mjs --dir <dir> [--out out.ndjson]\n');
    process.exit(2);
  }

  const files = dir ? listJsonl(dir) : [single];
  const rows = [];
  for (const f of files) {
    try {
      rows.push(extractFile(f).chat);
    } catch (e) {
      process.stderr.write(`extract: skipped ${f}: ${e.message}\n`);
    }
  }

  const out = typeof args.out === 'string' ? args.out : null;
  if (out) {
    fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true });
    fs.writeFileSync(out, rows.map((r) => JSON.stringify(r)).join('\n') + (rows.length ? '\n' : ''));
    process.stderr.write(`extract: ${rows.length} chat(s) -> ${out}\n`);
  } else if (!dir && args.pretty) {
    process.stdout.write(JSON.stringify(rows[0], null, 2) + '\n');
  } else {
    process.stdout.write(rows.map((r) => JSON.stringify(r)).join('\n') + (rows.length ? '\n' : ''));
  }
}

if (import.meta.url === `file://${process.argv[1]}`) main();
