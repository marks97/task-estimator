#!/usr/bin/env node
/**
 * classify.mjs — semantic pass over the ledger. Resumable, bounded concurrency.
 *
 * Usage:
 *   node classify.mjs [--ledger <dir>] [--model claude-haiku-4-5-20251001]
 *                     [--concurrency 3] [--limit N] [--estimate-only]
 *                     [--progress /tmp/claude/task-estimator-backfill/progress.log]
 *
 * One classification per CHAT (the prompt is classify-chat.md and the digest is a
 * chat). Task rows are then assembled from their chats' classifications.
 *
 * Merge rules (a task is one row; an epic is a task with several chats):
 *   - The task's LABELS come from its MAIN chat: the classification that called
 *     itself `main`, tie-broken by agent-active minutes. Labels do not vote —
 *     averaging a bugfix and a refactor produces neither.
 *   - `external_waits` and `user_touchpoint_kinds` are UNIONED over all chats.
 *     They are quantities and sets, not labels: a wait that happened in chat 3
 *     is still dead time the task paid for.
 *   - Epics keep every chat's own labels in `sub_deliverables`, so the detail
 *     survives the merge instead of being flattened away. A single chat that
 *     reports several units of work contributes several entries too.
 *
 * Thinking is disabled (MAX_THINKING_TOKENS=0). Measured on this corpus: 6.5s and
 * $0.0074 per call against 44s and $0.0254 with thinking, and the no-thinking
 * output tracked the prompt's own rules at least as closely. The sonnet audit is
 * what decides whether that holds; do not "fix" this by trusting it silently.
 *
 * Every claude flag is load-bearing — see SKILL.md. `--no-session-persistence`
 * especially: without it each classification writes a transcript into the
 * per-account projects dir, and the next backfill mines its own output.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseArgs, readJsonl, round2 } from './lib.mjs';
import { digest } from './digest.mjs';
import { resolveLedger } from './backfill.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PROMPT = path.join(HERE, '..', 'prompts', 'classify-chat.md');
const DEFAULT_MODEL = 'claude-haiku-4-5-20251001';
const CALL_TIMEOUT_MS = 180000;
const CHARS_PER_TOKEN = 3.6; // measured on this corpus: 3599 digest chars -> ~3900 in-tokens with the system prompt

const ENUMS = {
  task_type: ['bugfix', 'feature', 'refactor', 'migration', 'infra', 'investigation', 'script'],
  novelty: ['pattern-copy', 'adaptation', 'novel'],
  spec_ambiguity: ['clear', 'medium', 'vague'],
  self_verifiable: ['tests', 'typecheck-only', 'human-eyes', 'prod-only'],
  outcome: ['shipped', 'shipped-then-reverted', 'abandoned', 'superseded', 'unknown'],
  flow_quality: ['clean', 'some-rework', 'thrash'],
};

/** Strip ``` fences and any prose either side of the outermost JSON object. */
export function parseModelJson(text) {
  if (typeof text !== 'string') return null;
  let s = text.trim();
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) s = fence[1].trim();
  const a = s.indexOf('{');
  const b = s.lastIndexOf('}');
  if (a === -1 || b === -1 || b < a) return null;
  try {
    return JSON.parse(s.slice(a, b + 1));
  } catch {
    return null;
  }
}

/** Null out anything outside its enum rather than letting it into the ledger. */
export function sanitize(c) {
  const out = { ...c };
  const invalid = [];
  for (const [k, allowed] of Object.entries(ENUMS)) {
    if (out[k] != null && !allowed.includes(out[k])) { invalid.push(`${k}=${out[k]}`); out[k] = null; }
  }
  out.tasks = Array.isArray(c.tasks) ? c.tasks.filter((t) => t && typeof t.slug === 'string') : [];
  out.external_waits = Array.isArray(c.external_waits)
    ? c.external_waits.filter((w) => w && typeof w.kind === 'string')
      .map((w) => ({ kind: w.kind, est_hours: Number(w.est_hours) || 0 }))
    : [];
  out.user_touchpoint_kinds = Array.isArray(c.user_touchpoint_kinds)
    ? [...new Set(c.user_touchpoint_kinds.filter((x) => typeof x === 'string'))]
    : [];
  out.evidence = Array.isArray(c.evidence) ? c.evidence.map(String).slice(0, 3) : [];
  const conf = Number(c.confidence);
  out.confidence = Number.isFinite(conf) ? Math.min(1, Math.max(0, conf)) : null;
  return { value: out, invalid };
}

function callClaude({ input, model, systemPrompt }) {
  return new Promise((resolve) => {
    const child = spawn('nice', [
      '-n', '19', 'claude', '-p',
      '--model', model,
      '--output-format', 'json',
      '--system-prompt', systemPrompt,
      '--tools', '',
      '--safe-mode',
      '--no-session-persistence',
    ], { env: { ...process.env, MAX_THINKING_TOKENS: '0' }, stdio: ['pipe', 'pipe', 'pipe'] });

    let out = ''; let err = ''; let done = false;
    const timer = setTimeout(() => { if (!done) { child.kill('SIGKILL'); } }, CALL_TIMEOUT_MS);
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', (e) => { if (!done) { done = true; clearTimeout(timer); resolve({ ok: false, error: e.message }); } });
    child.on('close', (code) => {
      if (done) return;
      done = true; clearTimeout(timer);
      if (code !== 0) return resolve({ ok: false, error: `exit ${code}: ${err.slice(0, 400)}` });
      let env;
      try { env = JSON.parse(out); } catch { return resolve({ ok: false, error: `envelope not JSON: ${out.slice(0, 300)}` }); }
      if (env.is_error) return resolve({ ok: false, error: `is_error: ${String(env.result).slice(0, 300)}`, envelope: env });
      resolve({ ok: true, text: env.result, envelope: env });
    });
    child.stdin.on('error', () => {});
    child.stdin.end(input);
  });
}

const usageOf = (env) => ({
  input: (env?.usage?.input_tokens || 0) + (env?.usage?.cache_read_input_tokens || 0)
    + (env?.usage?.cache_creation_input_tokens || 0),
  output: env?.usage?.output_tokens || 0,
  cost: env?.total_cost_usd || 0,
});

/**
 * Deterministic outcome. The classifier under-reports `shipped` badly: the
 * sonnet audit of the first backfill disagreed with `outcome` 2.3:1 in one
 * direction — 62 rows it moved `unknown` -> `shipped` against 27 the other way.
 * The cause is that haiku is being asked to spot a commit or PR inside a
 * truncated digest and, correctly following the "prefer unknown over a guess"
 * rule, answers `unknown` whenever it does not see one.
 *
 * But the ledger does not have to look: `commits` and `prs` are extracted
 * deterministically from git and gh tool output, not inferred. A row with a
 * commit or a PR HAS an artifact, which is exactly the standard SKILL.md sets
 * for `shipped` ("a merged PR, a commit on the default branch, or an explicit
 * user confirmation"). So the artifact decides and the classifier does not get a
 * vote — except on the two verdicts it can see and the artifact cannot:
 *
 *   - `shipped-then-reverted` — the commit exists AND so does its revert. The
 *     artifact is present either way, so overriding here would erase the only
 *     signal that distinguishes the two.
 *   - `abandoned` — the reading that some code landed and the work still stopped
 *     without a result. Same argument.
 *
 * `superseded` and `unknown` carry no such extra information and are overridden.
 * `outcome_source` records which rule produced the value and
 * `classifier_outcome` keeps the original, so a later audit can score the
 * classifier rather than scoring this override.
 */
export const OUTCOME_OVERRIDE_EXEMPT = new Set(['shipped-then-reverted', 'abandoned']);

export function applyOutcomeOverride(task, classifierOutcome) {
  task.classifier_outcome = classifierOutcome ?? null;
  const hasArtifact = (Number(task.commits) || 0) > 0
    || (Array.isArray(task.prs) && task.prs.length > 0);
  if (hasArtifact && !OUTCOME_OVERRIDE_EXEMPT.has(classifierOutcome)) {
    task.outcome = 'shipped';
    task.outcome_source = 'deterministic';
  } else {
    task.outcome = classifierOutcome ?? null;
    task.outcome_source = 'classifier';
  }
  return task;
}

/** Assemble task-level semantics from its chats' classifications. */
export function mergeIntoTask(task, chatById, byChat) {
  const rows = task.chats.map((id) => byChat.get(id)).filter((r) => r && r.ok);
  if (rows.length === 0) return { changed: false };

  const activeOf = (id) => Number(chatById.get(id)?.agent_active_min) || 0;
  const isMain = (r) => (r.classification.tasks || []).some((t) => t.role === 'main');
  const ranked = [...rows].sort((a, b) => {
    if (isMain(a) !== isMain(b)) return isMain(a) ? -1 : 1;
    return activeOf(b.chat_id) - activeOf(a.chat_id);
  });
  const main = ranked[0].classification;

  task.task_type = main.task_type;
  task.novelty = main.novelty;
  task.spec_ambiguity = main.spec_ambiguity;
  task.self_verifiable = main.self_verifiable;
  task.outcome = main.outcome;
  task.flow_quality = main.flow_quality;
  applyOutcomeOverride(task, main.outcome);
  task.summary = (main.tasks && main.tasks[0] && main.tasks[0].slug) || null;
  task.classifier_confidence = main.confidence;
  task.main_chat_id = ranked[0].chat_id;

  // quantities and sets: union over the whole task, not just its main chat
  const waits = new Map();
  for (const r of rows) {
    for (const w of r.classification.external_waits || []) {
      waits.set(w.kind, (waits.get(w.kind) || 0) + (Number(w.est_hours) || 0));
    }
  }
  task.external_waits = [...waits.entries()].map(([kind, est_hours]) => ({ kind, est_hours: round2(est_hours) }));
  task.user_touchpoint_kinds = [...new Set(rows.flatMap((r) => r.classification.user_touchpoint_kinds || []))].sort();

  // epics keep their per-chat detail
  const subs = [];
  for (const r of rows) {
    const c = r.classification;
    const units = (c.tasks || []).length ? c.tasks : [{ slug: null, role: 'none' }];
    for (const u of units) {
      subs.push({
        chat_id: r.chat_id,
        slug: u.slug,
        role: u.role,
        task_type: c.task_type,
        outcome: c.outcome,
        flow_quality: c.flow_quality,
        confidence: c.confidence,
        agent_hours: round2(activeOf(r.chat_id) / 60),
        human_rounds: Number(chatById.get(r.chat_id)?.human_rounds) || 0,
      });
    }
  }
  task.sub_deliverables = (task.chats.length > 1 || subs.length > 1) ? subs : null;
  task.no_work = rows.every((r) => (r.classification.tasks || []).length === 0);
  task.classified_at = new Date().toISOString();
  task.classifier_model = ranked[0].model;
  task.classified_chats = rows.length;
  return { changed: true };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const ledgerDir = path.join(typeof args.ledger === 'string' ? args.ledger : resolveLedger(), 'ledger');
  const model = typeof args.model === 'string' ? args.model : DEFAULT_MODEL;
  const concurrency = Math.max(1, Number(args.concurrency ?? 3) || 3);
  const progress = typeof args.progress === 'string' ? args.progress
    : '/tmp/claude/task-estimator-backfill/progress.log';
  fs.mkdirSync(path.dirname(progress), { recursive: true });
  const log = (m) => {
    const line = `${new Date().toISOString()} classify: ${m}\n`;
    fs.appendFileSync(progress, line); process.stderr.write(line);
  };

  const chatsFile = path.join(ledgerDir, 'chats.ndjson');
  const tasksFile = path.join(ledgerDir, 'tasks.ndjson');
  const outFile = path.join(ledgerDir, 'classifications.ndjson');
  const systemPrompt = fs.readFileSync(PROMPT, 'utf8');

  const chats = readJsonl(chatsFile).records.filter((c) => c.chat_id);
  const chatById = new Map(chats.map((c) => [c.chat_id, c]));
  const tasks = readJsonl(tasksFile).records.filter((t) => t.task_id);

  const prior = fs.existsSync(outFile) ? readJsonl(outFile).records : [];
  const byChat = new Map();
  for (const r of prior) if (r && r.chat_id) byChat.set(r.chat_id, r);

  const wanted = [...new Set(tasks.flatMap((t) => t.chats))].filter((id) => chatById.has(id));
  let pending = wanted.filter((id) => !(byChat.get(id)?.ok));
  if (args.limit) pending = pending.slice(0, Number(args.limit));

  // ---- token estimate, from a real sample of digests -----------------------
  const sampleIdx = [];
  const step = Math.max(1, Math.floor(pending.length / 25));
  for (let i = 0; i < pending.length && sampleIdx.length < 25; i += step) sampleIdx.push(i);
  let sampleChars = 0; let sampled = 0;
  for (const i of sampleIdx) {
    try { sampleChars += digest(chatById.get(pending[i]).file).length; sampled++; } catch { /* counted below */ }
  }
  const meanDigest = sampled ? sampleChars / sampled : 8000;
  const inTokPerCall = (systemPrompt.length + meanDigest) / CHARS_PER_TOKEN;
  const estIn = Math.round(inTokPerCall * pending.length);
  const estOut = 300 * pending.length;
  log(`plan: ${wanted.length} chat(s) across ${tasks.length} task(s); ${byChat.size} already classified; ${pending.length} to do`);
  log(`estimate: mean digest ${Math.round(meanDigest)} chars -> ~${Math.round(inTokPerCall)} in-tok/call; `
    + `~${(estIn / 1e6).toFixed(2)}M input + ~${(estOut / 1e3).toFixed(0)}k output tokens; `
    + `~$${(estIn / 1e6 * 1 + estOut / 1e6 * 5).toFixed(2)} at haiku-4.5 list; `
    + `~${Math.ceil(pending.length * 7 / concurrency / 60)} min wall at ${concurrency} concurrent`);
  if (args['estimate-only']) return;

  // ---- the loop ------------------------------------------------------------
  const totals = { input: 0, output: 0, cost: 0, ok: 0, retried: 0, failed: 0, invalid_fields: 0, digest_failed: 0 };
  let cursor = 0; let finished = 0;
  const t0 = Date.now();

  async function classifyOne(chatId) {
    const chat = chatById.get(chatId);
    let input;
    try {
      input = digest(chat.file);
    } catch (e) {
      totals.digest_failed++;
      return { schema: 'classification.v1', chat_id: chatId, ok: false, error: `digest: ${e.message}`, at: new Date().toISOString() };
    }
    for (let attempt = 1; attempt <= 2; attempt++) {
      const res = await callClaude({ input, model, systemPrompt });
      if (res.envelope) {
        const u = usageOf(res.envelope);
        totals.input += u.input; totals.output += u.output; totals.cost += u.cost;
      }
      if (res.ok) {
        const parsed = parseModelJson(res.text);
        if (parsed) {
          const { value, invalid } = sanitize(parsed);
          totals.invalid_fields += invalid.length;
          totals.ok++;
          if (attempt > 1) totals.retried++;
          return {
            schema: 'classification.v1', chat_id: chatId, ok: true, model,
            attempts: attempt, invalid_fields: invalid, classification: value,
            at: new Date().toISOString(),
          };
        }
      }
      if (attempt === 2) {
        totals.failed++;
        return {
          schema: 'classification.v1', chat_id: chatId, ok: false, model, attempts: 2,
          error: res.ok ? `unparseable: ${String(res.text).slice(0, 300)}` : res.error,
          at: new Date().toISOString(),
        };
      }
    }
    return null;
  }

  async function worker() {
    for (;;) {
      const i = cursor++;
      if (i >= pending.length) return;
      const row = await classifyOne(pending[i]);
      byChat.set(row.chat_id, row);
      fs.appendFileSync(outFile, `${JSON.stringify(row)}\n`);
      finished++;
      if (finished % 25 === 0 || finished === pending.length) {
        const rate = finished / ((Date.now() - t0) / 1000);
        const eta = Math.ceil((pending.length - finished) / Math.max(rate, 1e-6) / 60);
        log(`${finished}/${pending.length} ok=${totals.ok} failed=${totals.failed} `
          + `tok=${(totals.input / 1e6).toFixed(2)}M/${(totals.output / 1e3).toFixed(0)}k `
          + `cost=$${totals.cost.toFixed(2)} eta=${eta}min`);
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, pending.length) }, worker));
  log(`calls done: ok=${totals.ok} failed=${totals.failed} retried=${totals.retried} `
    + `digest_failed=${totals.digest_failed} invalid_fields=${totals.invalid_fields} `
    + `tokens=${totals.input} in / ${totals.output} out cost=$${totals.cost.toFixed(2)}`);

  // ---- merge into tasks.ndjson --------------------------------------------
  let merged = 0;
  for (const t of tasks) if (mergeIntoTask(t, chatById, byChat).changed) merged++;
  fs.writeFileSync(tasksFile, tasks.map((r) => JSON.stringify(r)).join('\n') + (tasks.length ? '\n' : ''));
  log(`merged semantics into ${merged}/${tasks.length} task(s) -> ${tasksFile}`);

  fs.writeFileSync(path.join(path.dirname(progress), 'classify.stats.json'),
    JSON.stringify({ ...totals, wanted: wanted.length, pending: pending.length, merged, model }, null, 2) + '\n');
}

if (import.meta.url === `file://${process.argv[1]}`) main();
