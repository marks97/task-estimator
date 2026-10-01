#!/usr/bin/env node
/**
 * audit.mjs — stratified re-judgement of the classifier by a stronger model.
 *
 * Usage:
 *   node audit.mjs [--ledger <dir>] [--model claude-sonnet-4-5] [--rate 5]
 *                  [--concurrency 3] [--limit N] [--plan-only]
 *
 * Sampling: 1-in-`rate` of classified tasks, OVERSAMPLED on the rows where a
 * wrong label costs the most:
 *   - top-decile `agent_hours`      — a big row moves a class quantile on its own
 *   - `stitch_confidence` = low     — the boundary is already in doubt
 *   - classifier `confidence` < 0.5 — haiku said it was unsure; check whether it
 *                                     was unsure in the right direction
 * Those three strata are taken in FULL; the remainder is sampled 1-in-rate on a
 * deterministic stride so a re-run audits the same rows.
 *
 * Input to the judge is the task record plus the digests of its chats — the same
 * evidence the classifier saw, so a disagreement is a judgement difference and
 * not an information difference.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseArgs, readJsonl, round2 } from './lib.mjs';
import { digest } from './digest.mjs';
import { resolveLedger } from './backfill.mjs';
import { parseModelJson } from './classify.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PROMPT = path.join(HERE, '..', 'prompts', 'audit-task.md');
const DEFAULT_MODEL = 'claude-sonnet-4-5';
const CALL_TIMEOUT_MS = 300000;
const DIGEST_CHARS = 7000; // per chat, so a 46-chat epic still fits a prompt
const MAX_DIGEST_CHATS = 6;

const FIELDS = ['task_type', 'novelty', 'spec_ambiguity', 'self_verifiable', 'outcome',
  'external_waits', 'user_touchpoint_kinds', 'flow_quality'];

export function selectSample(tasks, rate) {
  const classified = tasks.filter((t) => t.classified_at && t.task_type);
  const ah = classified.map((t) => Number(t.agent_hours) || 0).sort((a, b) => a - b);
  const p90 = ah.length ? ah[Math.max(0, Math.ceil(0.9 * ah.length) - 1)] : Infinity;

  const strata = new Map();
  const mark = (t, why) => {
    if (!strata.has(t.task_id)) strata.set(t.task_id, { task: t, why: [] });
    strata.get(t.task_id).why.push(why);
  };
  for (const t of classified) {
    if ((Number(t.agent_hours) || 0) >= p90) mark(t, 'top-decile-agent-hours');
    if (t.stitch_confidence === 'low') mark(t, 'low-stitch-confidence');
    if (Number(t.classifier_confidence) < 0.5) mark(t, 'low-classifier-confidence');
  }
  // deterministic stride over the rest
  const rest = classified.filter((t) => !strata.has(t.task_id));
  for (let i = 0; i < rest.length; i += rate) mark(rest[i], 'stride');
  return { sample: [...strata.values()], classified_n: classified.length, p90_agent_hours: round2(p90) };
}

function buildInput(task, chatById) {
  const lines = ['# Task record', '', '```json', JSON.stringify(task, null, 2), '```', ''];
  const ids = task.chats.slice(0, MAX_DIGEST_CHATS);
  lines.push(`# Digests of its chats (${ids.length} of ${task.chats.length})`, '');
  for (const id of ids) {
    const c = chatById.get(id);
    if (!c) continue;
    try { lines.push(digest(c.file, DIGEST_CHARS), ''); } catch (e) { lines.push(`[digest failed for ${id}: ${e.message}]`, ''); }
  }
  if (task.chats.length > MAX_DIGEST_CHATS) {
    lines.push(`[${task.chats.length - MAX_DIGEST_CHATS} further chat(s) in this task not shown]`);
  }
  return lines.join('\n');
}

function callClaude({ input, model, systemPrompt }) {
  return new Promise((resolve) => {
    const child = spawn('nice', [
      '-n', '19', 'claude', '-p', '--model', model, '--output-format', 'json',
      '--system-prompt', systemPrompt, '--tools', '', '--safe-mode', '--no-session-persistence',
    ], { env: { ...process.env, MAX_THINKING_TOKENS: '0' }, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = ''; let err = ''; let done = false;
    const timer = setTimeout(() => { if (!done) child.kill('SIGKILL'); }, CALL_TIMEOUT_MS);
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', (e) => { if (!done) { done = true; clearTimeout(timer); resolve({ ok: false, error: e.message }); } });
    child.on('close', (code) => {
      if (done) return;
      done = true; clearTimeout(timer);
      if (code !== 0) return resolve({ ok: false, error: `exit ${code}: ${err.slice(0, 400)}` });
      let env; try { env = JSON.parse(out); } catch { return resolve({ ok: false, error: 'envelope not JSON' }); }
      if (env.is_error) return resolve({ ok: false, error: String(env.result).slice(0, 300), envelope: env });
      resolve({ ok: true, text: env.result, envelope: env });
    });
    child.stdin.on('error', () => {});
    child.stdin.end(input);
  });
}

export function agreementReport(rows) {
  const per = {};
  for (const f of FIELDS) per[f] = { agree: 0, n: 0 };
  const stitch = {};
  for (const r of rows) {
    if (!r.ok || !r.audit) continue;
    const a = r.audit.agreements || {};
    for (const f of FIELDS) {
      if (typeof a[f] !== 'boolean') continue;
      per[f].n++;
      if (a[f]) per[f].agree++;
    }
    const v = r.audit.stitch_verdict || 'unknown';
    stitch[v] = (stitch[v] || 0) + 1;
  }
  const out = {};
  for (const f of FIELDS) {
    out[f] = { n: per[f].n, agree: per[f].agree, rate: per[f].n ? round2(per[f].agree / per[f].n) : null,
      reliable: per[f].n ? per[f].agree / per[f].n >= 0.8 : null };
  }
  return { per_field: out, stitch_verdicts: stitch, audited: rows.filter((r) => r.ok).length };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const ledgerDir = path.join(typeof args.ledger === 'string' ? args.ledger : resolveLedger(), 'ledger');
  const model = typeof args.model === 'string' ? args.model : DEFAULT_MODEL;
  const rate = Math.max(2, Number(args.rate ?? 5) || 5);
  const concurrency = Math.max(1, Number(args.concurrency ?? 3) || 3);
  const progress = typeof args.progress === 'string' ? args.progress : '/tmp/claude/task-estimator-backfill/progress.log';
  const log = (m) => {
    const line = `${new Date().toISOString()} audit: ${m}\n`;
    fs.appendFileSync(progress, line); process.stderr.write(line);
  };

  const systemPrompt = fs.readFileSync(PROMPT, 'utf8');
  const chats = readJsonl(path.join(ledgerDir, 'chats.ndjson')).records.filter((c) => c.chat_id);
  const chatById = new Map(chats.map((c) => [c.chat_id, c]));
  const tasks = readJsonl(path.join(ledgerDir, 'tasks.ndjson')).records.filter((t) => t.task_id);
  const outFile = path.join(ledgerDir, 'audit.ndjson');

  const { sample, classified_n, p90_agent_hours } = selectSample(tasks, rate);
  const prior = fs.existsSync(outFile) ? readJsonl(outFile).records : [];
  const done = new Set(prior.filter((r) => r.ok).map((r) => r.task_id));
  let pending = sample.filter((s) => !done.has(s.task.task_id));
  if (args.limit) pending = pending.slice(0, Number(args.limit));

  const whyCount = {};
  for (const s of sample) for (const w of s.why) whyCount[w] = (whyCount[w] || 0) + 1;
  log(`plan: ${classified_n} classified task(s); sample=${sample.length} (1-in-${rate} stride + oversample `
    + `${JSON.stringify(whyCount)}, top-decile cut ${p90_agent_hours}h); ${pending.length} to run`);
  if (args['plan-only']) return;

  const totals = { ok: 0, failed: 0, cost: 0, input: 0, output: 0 };
  let cursor = 0; let finished = 0;
  const rows = [...prior];

  async function worker() {
    for (;;) {
      const i = cursor++;
      if (i >= pending.length) return;
      const { task, why } = pending[i];
      const input = buildInput(task, chatById);
      const res = await callClaude({ input, model, systemPrompt });
      if (res.envelope) {
        totals.cost += res.envelope.total_cost_usd || 0;
        totals.input += (res.envelope.usage?.input_tokens || 0) + (res.envelope.usage?.cache_read_input_tokens || 0);
        totals.output += res.envelope.usage?.output_tokens || 0;
      }
      const parsed = res.ok ? parseModelJson(res.text) : null;
      const row = parsed
        ? { schema: 'audit.v1', task_id: task.task_id, ok: true, model, strata: why, audit: parsed, at: new Date().toISOString() }
        : { schema: 'audit.v1', task_id: task.task_id, ok: false, model, strata: why,
          error: res.ok ? `unparseable: ${String(res.text).slice(0, 200)}` : res.error, at: new Date().toISOString() };
      if (row.ok) totals.ok++; else totals.failed++;
      rows.push(row);
      fs.appendFileSync(outFile, `${JSON.stringify(row)}\n`);
      finished++;
      if (finished % 10 === 0 || finished === pending.length) {
        log(`${finished}/${pending.length} ok=${totals.ok} failed=${totals.failed} cost=$${totals.cost.toFixed(2)}`);
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, pending.length) }, worker));

  const report = agreementReport(rows);
  log(`agreement ${JSON.stringify(Object.fromEntries(FIELDS.map((f) => [f, report.per_field[f].rate])))}`);
  log(`stitch verdicts ${JSON.stringify(report.stitch_verdicts)} cost=$${totals.cost.toFixed(2)}`);
  fs.writeFileSync(path.join(path.dirname(progress), 'audit.report.json'),
    JSON.stringify({ ...report, totals, sample_n: sample.length, classified_n, p90_agent_hours, strata: whyCount }, null, 2) + '\n');
}

if (import.meta.url === `file://${process.argv[1]}`) main();
