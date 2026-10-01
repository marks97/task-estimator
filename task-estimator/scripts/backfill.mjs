#!/usr/bin/env node
/**
 * backfill.mjs — mine a whole transcripts root into the ledger. Zero-dep, resumable.
 *
 * Usage:
 *   node backfill.mjs [--root ~/.claude/projects] [--ledger <dir>]
 *                     [--min-bytes 5120] [--force] [--no-stitch]
 *                     [--progress /tmp/claude/task-estimator-backfill/progress.log]
 *
 * What it does, in order:
 *   1. Walks every project directory under --root, files processed SEQUENTIALLY
 *      (one big transcript at a time; never parallel — this runs on a live box).
 *   2. extractFile() per .jsonl, appending chat.v1 rows to <ledger>/chats.ndjson
 *      as it goes, so an interrupted run resumes instead of restarting.
 *   3. Stitches GLOBALLY (all chats at once, across project dirs) into
 *      <ledger>/tasks.ndjson.
 *
 * Resume key: chat_id + the source file's mtime and size, recorded on each row as
 * `source`. A transcript that grew since the last run is re-extracted; one that
 * did not is skipped without being read.
 *
 * Files below --min-bytes (default 5 KB) are skipped as noise — consent probes,
 * one-prompt sessions, transcripts that never got past the banner. They are
 * counted, never silently dropped.
 *
 * Semantic fields already merged into tasks.ndjson (task_type, outcome, ... and
 * `classified_at`) survive a re-stitch: a rebuilt task row inherits them when its
 * task_id and its chat membership are unchanged. Re-running the deterministic
 * pass therefore never costs a classification.
 */
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs, readJsonl, resolveLedger } from './lib.mjs';
import { extractFile } from './extract.mjs';
import { stitch } from './stitch.mjs';

const DEFAULT_MIN_BYTES = 5120;

/** $LEDGER resolution lives in lib.mjs (one definition, mirrors SKILL.md). */
export { resolveLedger };

const expand = (p) => (p.startsWith('~') ? path.join(process.env.HOME || '', p.slice(1)) : p);

/** Project dirs under root, plus root itself if it directly holds transcripts. */
function projectDirs(root) {
  const dirs = [];
  for (const e of fs.readdirSync(root, { withFileTypes: true })) {
    if (e.isDirectory()) dirs.push(path.join(root, e.name));
  }
  if (fs.readdirSync(root).some((f) => f.endsWith('.jsonl'))) dirs.unshift(root);
  return dirs.sort();
}

function jsonlFiles(dir) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((e) => e.isFile() && e.name.endsWith('.jsonl'))
    .map((e) => path.join(dir, e.name))
    .sort();
}

/**
 * A cheap fingerprint of `<dir>/<chat_id>/subagents/`: "<n>:<mtimeMs>", or null
 * when there is no sidecar directory. One statSync + one readdir, no file reads.
 */
export function sidecarSignature(file) {
  const dir = path.join(path.dirname(file), path.basename(file).replace(/\.jsonl$/i, ''), 'subagents');
  try {
    const st = fs.statSync(dir);
    const n = fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl')).length;
    return `${n}:${st.mtimeMs}`;
  } catch {
    return null;
  }
}

/** Last row wins, so a re-extraction supersedes the stale one. */
function dedupeById(rows, key) {
  const byId = new Map();
  for (const r of rows) if (r && r[key]) byId.set(r[key], r);
  return [...byId.values()];
}

function makeLogger(progressFile) {
  fs.mkdirSync(path.dirname(progressFile), { recursive: true });
  return (msg) => {
    const line = `${new Date().toISOString()} ${msg}\n`;
    fs.appendFileSync(progressFile, line);
    process.stderr.write(line);
  };
}

export function backfill(opts) {
  const {
    root, ledgerDir, minBytes = DEFAULT_MIN_BYTES, force = false, doStitch = true, log = () => {},
  } = opts;
  const chatsFile = path.join(ledgerDir, 'chats.ndjson');
  const tasksFile = path.join(ledgerDir, 'tasks.ndjson');
  fs.mkdirSync(ledgerDir, { recursive: true });

  // ---- resume state ------------------------------------------------------
  const existing = fs.existsSync(chatsFile) ? readJsonl(chatsFile).records : [];
  const known = new Map();
  for (const r of existing) if (r && r.chat_id) known.set(r.chat_id, r);
  log(`backfill: root=${root} ledger=${ledgerDir} known_chats=${known.size} min_bytes=${minBytes}`);

  const stats = {
    dirs: 0,
    files_seen: 0,
    files_extracted: 0,
    files_skipped_small: 0,
    files_skipped_cached: 0,
    files_failed: 0,
    bytes_read: 0,
    failures: [],
    small_bytes_total: 0,
    per_dir: {},
  };

  const dirs = projectDirs(root);
  stats.dirs = dirs.length;

  for (const dir of dirs) {
    const files = jsonlFiles(dir);
    if (files.length === 0) continue;
    const d = { files: files.length, extracted: 0, small: 0, cached: 0, failed: 0 };
    stats.per_dir[path.basename(dir)] = d;
    log(`dir ${path.basename(dir)}: ${files.length} transcript(s)`);

    for (const file of files) {
      stats.files_seen++;
      let st;
      try {
        st = fs.statSync(file);
      } catch (e) {
        stats.files_failed++; d.failed++;
        stats.failures.push({ file, error: `stat: ${e.message}` });
        continue;
      }

      if (st.size < minBytes) {
        stats.files_skipped_small++; d.small++;
        stats.small_bytes_total += st.size;
        continue;
      }

      const chatId = path.basename(file).replace(/\.jsonl$/i, '');
      const prev = known.get(chatId);
      // The sidecar directory is a SECOND input to the extraction, and it changes
      // independently of the transcript: a subagent finishes writing its own
      // transcript after the parent's last line. Without it in the cache key a
      // re-run silently keeps a row that predates the delegated work.
      const sc = sidecarSignature(file);
      if (!force && prev && prev.source
          && prev.source.mtime_ms === st.mtimeMs && prev.source.size === st.size
          && (prev.source.sidecars ?? null) === sc) {
        stats.files_skipped_cached++; d.cached++;
        continue;
      }

      try {
        const { chat } = extractFile(file);
        chat.source = {
          mtime_ms: st.mtimeMs, size: st.size, sidecars: sc, extracted_at: new Date().toISOString(),
        };
        // Append immediately: a run killed mid-corpus keeps everything before it.
        fs.appendFileSync(chatsFile, `${JSON.stringify(chat)}\n`);
        known.set(chat.chat_id, chat);
        stats.files_extracted++; d.extracted++;
        stats.bytes_read += st.size;
      } catch (e) {
        stats.files_failed++; d.failed++;
        stats.failures.push({ file, error: e.message });
        log(`  FAIL ${path.basename(file)}: ${e.message}`);
      }
    }
    log(`  done ${path.basename(dir)}: +${d.extracted} extracted, ${d.cached} cached, ${d.small} small, ${d.failed} failed`);
  }

  // ---- compact chats.ndjson (append-log -> one row per chat) --------------
  const chats = dedupeById(readJsonl(chatsFile).records.filter((r) => r.chat_id), 'chat_id');
  fs.writeFileSync(chatsFile, chats.map((r) => JSON.stringify(r)).join('\n') + (chats.length ? '\n' : ''));
  stats.chats_total = chats.length;
  log(`chats.ndjson: ${chats.length} row(s)`);

  if (!doStitch) return stats;

  // ---- global stitch, preserving semantics --------------------------------
  const priorTasks = fs.existsSync(tasksFile) ? readJsonl(tasksFile).records : [];
  const priorById = new Map(priorTasks.filter((t) => t.task_id).map((t) => [t.task_id, t]));
  const tasks = stitch(chats);
  let carried = 0;
  const SEMANTIC = [
    'task_type', 'novelty', 'self_verifiable', 'spec_ambiguity', 'outcome', 'external_waits',
    'user_touchpoint_kinds', 'flow_quality', 'summary', 'classified_at', 'classifier_model',
    'classifier_confidence', 'sub_deliverables', 'chat_labels',
  ];
  for (const t of tasks) {
    const prev = priorById.get(t.task_id);
    if (!prev || !prev.classified_at) continue;
    // Only inherit when the row still covers the same chats — a re-stitch that
    // moved chats around produced a genuinely different unit of work.
    const same = Array.isArray(prev.chats) && prev.chats.length === t.chats.length
      && prev.chats.every((c, i) => c === t.chats[i]);
    if (!same) continue;
    for (const k of SEMANTIC) if (prev[k] !== undefined) t[k] = prev[k];
    carried++;
  }
  fs.writeFileSync(tasksFile, tasks.map((r) => JSON.stringify(r)).join('\n') + (tasks.length ? '\n' : ''));
  stats.tasks_total = tasks.length;
  stats.tasks_carried_classification = carried;
  log(`tasks.ndjson: ${tasks.length} task(s) (${carried} kept their classification)`);
  return stats;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const root = expand(typeof args.root === 'string' ? args.root
    : path.join(process.env.HOME || '', '.claude', 'projects'));
  const ledgerDir = path.join(expand(typeof args.ledger === 'string' ? args.ledger : resolveLedger()), 'ledger');
  const progress = expand(typeof args.progress === 'string' ? args.progress
    : '/tmp/claude/task-estimator-backfill/progress.log');
  const log = makeLogger(progress);

  const stats = backfill({
    root,
    ledgerDir,
    minBytes: Number(args['min-bytes'] ?? DEFAULT_MIN_BYTES) || DEFAULT_MIN_BYTES,
    force: Boolean(args.force),
    doStitch: !args['no-stitch'],
    log,
  });

  const statsFile = path.join(path.dirname(progress), 'backfill.stats.json');
  fs.writeFileSync(statsFile, JSON.stringify(stats, null, 2) + '\n');
  log(`backfill: seen=${stats.files_seen} extracted=${stats.files_extracted} cached=${stats.files_skipped_cached} small=${stats.files_skipped_small} failed=${stats.files_failed} -> ${statsFile}`);
}

if (import.meta.url === `file://${process.argv[1]}`) main();
