/**
 * lib.mjs — shared, dependency-free helpers for the task-estimator scripts.
 *
 * Everything in here is deterministic: same input bytes -> same output bytes.
 * No parametric fits anywhere; quantiles are empirical (inverse-CDF / nearest-rank).
 */
import fs from 'node:fs';
import path from 'node:path';

export const round1 = (x) => Math.round(x * 10) / 10;
export const round2 = (x) => Math.round(x * 100) / 100;
/** 4 dp: enough for a proportional share to stay additive without printing noise. */
export const round4 = (x) => Math.round(x * 10000) / 10000;

/** Read a JSONL file, skipping unparseable lines and counting them. */
export function readJsonl(file) {
  const raw = fs.readFileSync(file, 'utf8');
  const records = [];
  let parse_errors = 0;
  for (const line of raw.split('\n')) {
    const s = line.trim();
    if (!s) continue;
    try {
      const o = JSON.parse(s);
      if (o && typeof o === 'object' && !Array.isArray(o)) records.push(o);
      else parse_errors++;
    } catch {
      parse_errors++;
    }
  }
  return { records, parse_errors };
}

export function writeNdjson(file, rows) {
  fs.writeFileSync(file, rows.map((r) => JSON.stringify(r)).join('\n') + (rows.length ? '\n' : ''));
}

/**
 * Empirical quantile, nearest-rank (no interpolation, no distribution assumption).
 * q in [0,1]; `sortedAsc` must already be sorted ascending.
 */
export function quantile(sortedAsc, q) {
  if (!sortedAsc || sortedAsc.length === 0) return null;
  const rank = Math.min(sortedAsc.length, Math.max(1, Math.ceil(q * sortedAsc.length)));
  return sortedAsc[rank - 1];
}

/**
 * Weighted empirical quantile: the smallest observed value whose cumulative
 * weight reaches q * totalWeight. Degenerates to nearest-rank when all
 * weights are equal. The epsilon absorbs float noise on exact ties.
 */
export function weightedQuantile(pairs, q) {
  const xs = pairs
    .filter((p) => Number.isFinite(p.v) && Number.isFinite(p.w) && p.w > 0)
    .sort((a, b) => a.v - b.v);
  if (xs.length === 0) return null;
  const W = xs.reduce((s, p) => s + p.w, 0);
  const target = q * W;
  let cum = 0;
  for (const p of xs) {
    cum += p.w;
    if (cum >= target - 1e-9) return p.v;
  }
  return xs[xs.length - 1].v;
}

export const uniqSorted = (arr) => [...new Set(arr.filter((x) => x != null && x !== ''))].sort();

/** Parse an ISO timestamp to epoch ms, or null. */
export function ts(v) {
  if (typeof v !== 'string') return null;
  const t = Date.parse(v);
  return Number.isFinite(t) ? t : null;
}

/** Overlap in ms between [aStart,aEnd] and [bStart,bEnd]. */
export function overlapMs(aStart, aEnd, bStart, bEnd) {
  return Math.max(0, Math.min(aEnd, bEnd) - Math.max(aStart, bStart));
}

/** Expand a leading `~` against $HOME. */
export function expandHome(p) {
  if (typeof p !== 'string') return p;
  return p.startsWith('~') ? path.join(process.env.HOME || '', p.slice(1)) : p;
}

/**
 * $LEDGER resolution — mirrors SKILL.md's *Ledger layout*, first hit wins:
 *   1. $CLAUDE_ESTIMATION_DIR (or $LEDGER) — explicit override
 *   2. ~/.claude/estimation — the portable default
 * The ledger lives outside the skill so it survives reinstalls.
 */
export function resolveLedger() {
  const home = process.env.HOME || '/root';
  return process.env.CLAUDE_ESTIMATION_DIR
    || process.env.LEDGER
    || path.join(home, '.claude', 'estimation');
}

/**
 * Write a file atomically: temp in the same directory, then rename. Every ledger
 * write goes through this, because record.mjs can run while a backfill is
 * mid-corpus — a half-written tasks.ndjson is worse than a lost run.
 */
export function writeFileAtomic(file, contents) {
  const abs = path.resolve(file);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  const tmp = `${abs}.tmp.${process.pid}`;
  fs.writeFileSync(tmp, contents);
  fs.renameSync(tmp, abs);
}

export function writeNdjsonAtomic(file, rows) {
  writeFileAtomic(file, rows.map((r) => JSON.stringify(r)).join('\n') + (rows.length ? '\n' : ''));
}

/**
 * PID-file lock. Deliberately NOT a pgrep/pkill check and deliberately NOT a
 * wait loop: `pgrep -f node` matches the checking process itself, and two prior
 * agents deadlocked on exactly that against this corpus. The holder writes its
 * own pid; a lock whose pid is gone (`kill(pid, 0)` throws ESRCH) is stale and
 * is taken over. One attempt, no polling — a busy ledger fails loudly instead.
 *
 * @returns {{ok: true, release: () => void} | {ok: false, holder: object}}
 */
export function acquireLock(file, { force = false, staleMs = 3600000 } = {}) {
  const abs = path.resolve(file);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  const mine = { pid: process.pid, at: new Date().toISOString(), argv: process.argv.slice(1, 3) };
  const alive = (pid) => {
    try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
  };
  if (fs.existsSync(abs) && !force) {
    let held = null;
    try { held = JSON.parse(fs.readFileSync(abs, 'utf8')); } catch { held = null; }
    const ageMs = Date.now() - (Date.parse(held?.at ?? '') || 0);
    const stale = !held || !Number.isInteger(held.pid) || !alive(held.pid) || ageMs > staleMs;
    if (!stale) return { ok: false, holder: held };
  }
  writeFileAtomic(abs, JSON.stringify(mine) + '\n');
  return { ok: true, release: () => { try { fs.unlinkSync(abs); } catch { /* already gone */ } } };
}

/** Minimal argv parser: --flag value / --flag / positional. */
export function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) out[key] = true;
      else { out[key] = next; i++; }
    } else out._.push(a);
  }
  return out;
}
