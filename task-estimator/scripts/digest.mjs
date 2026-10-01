#!/usr/bin/env node
/**
 * digest.mjs — compact text digest of one chat, for the haiku classifier.
 *
 * Usage:
 *   node digest.mjs <file.jsonl> [--max-chars 12000]
 *   node digest.mjs --file <file.jsonl>
 *   node digest.mjs --chat <chat-id> [--chats <chats.ndjson>] [--dir <projectDir>]
 *
 * --chat resolves the transcript path out of the ledger's chats.ndjson (the
 * `file` field extract.mjs recorded), so the backfill loop in SKILL.md can name
 * a chat id and never a path. The ledger root resolves as SKILL.md documents:
 * $CLAUDE_ESTIMATION_DIR, then ~/.claude/estimation; --dir
 * <projectDir>/<chat-id>.jsonl is the fallback.
 *
 * Contains: title, deterministic stats, every real human prompt (500 chars
 * each), the final assistant text (1500 chars), the tools histogram, files
 * edited, and PR/commit/ticket refs.
 *
 * Deliberately NOT included: tool outputs, thinking blocks, assistant
 * intermediate prose. The classifier judges shape and outcome, not content, and
 * tool output is where the token budget goes to die.
 */
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs, round2 } from './lib.mjs';
import { extractFile } from './extract.mjs';

const PROMPT_CHARS = 500;
const FINAL_CHARS = 1500;

const clip = (s, n) => {
  const t = String(s ?? '').replace(/\r/g, '').trim();
  return t.length <= n ? t : `${t.slice(0, n)}… [+${t.length - n} chars]`;
};

export function digest(file, maxChars = 12000) {
  const { chat: c, detail } = extractFile(file);
  const head = [];
  head.push(`# chat ${c.chat_id}`);
  if (c.title) head.push(`title: ${c.title}`);
  if (c.parent_chat_id) head.push(`resumed_from: ${c.parent_chat_id}`);
  head.push(`project_dir: ${c.project_dir}`);
  head.push(`window: ${c.started_at} -> ${c.ended_at}`);
  head.push('');
  head.push('## stats');
  head.push(`wall_clock_min=${c.wall_clock_min} agent_active_min=${c.agent_active_min} awaiting_min=${c.awaiting_min} human_turnaround_min=${c.human_turnaround_min}`);
  head.push(`human_rounds=${c.human_rounds} turns=${c.turns} assistant_steps=${c.assistant_steps}`);
  head.push(`tokens in=${c.tokens.in} out=${c.tokens.out} cache_read=${c.tokens.cache_read}`);
  head.push(`loc +${c.loc_added}/-${c.loc_removed} files_edited=${c.files_edited.length} user_modified=${c.user_modified_files.length}`);
  head.push(`subagents=${c.subagents.count}${c.subagents.count ? ` (${Object.entries(c.subagents.types).map(([k, v]) => `${k}x${v}`).join(', ')}, ${round2(c.subagents.total_duration_ms / 60000)}min, ${c.subagents.total_tokens} tok)` : ''}`);
  head.push(`compactions=${c.compactions.count} dropped_tokens=${c.compactions.dropped_tokens}`);
  head.push(`tool_errors=${c.errors.tool_error_count} interrupted=${c.errors.interrupted_count}`);
  head.push(`ask_user_question=${c.ask_user_question.count} latency_p50_min=${c.ask_user_question.latency_min_p50} latency_max_min=${c.ask_user_question.latency_min_max}`);
  head.push(`away_gaps=${c.away_gaps.length}${c.away_gaps.length ? ` (${c.away_gaps.map((g) => `${g.min}min`).join(', ')})` : ''}`);
  if (c.turn_durations_ms) head.push(`turn_duration ms: count=${c.turn_durations_ms.count} p50=${c.turn_durations_ms.p50} p90=${c.turn_durations_ms.p90} total=${c.turn_durations_ms.total}`);
  head.push(`models: ${c.models_used.join(', ') || 'none'}`);
  head.push(`permission_modes: ${c.permission_modes.join(', ') || 'none'}`);
  head.push('');
  head.push('## tools');
  const tools = Object.entries(c.tools_histogram).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  head.push(tools.length ? tools.map(([k, v]) => `${k} x${v}`).join(', ') : 'none');
  head.push('');
  head.push('## files edited');
  head.push(c.files_edited.length ? c.files_edited.map((f) => `- ${f}${c.user_modified_files.includes(f) ? '  [user-modified]' : ''}`).join('\n') : 'none');
  head.push('');
  head.push('## refs');
  head.push(`repos: ${c.repos_touched.join(', ') || 'none'}`);
  head.push(`branches: ${c.branches.join(', ') || 'none'}`);
  head.push(`commits: ${c.commit_shas.join(', ') || 'none'}`);
  head.push(`prs: ${c.pr_links.map((p) => `${p.prRepository}#${p.prNumber}`).join(', ') || 'none'}`);
  head.push(`tickets: ${c.ticket_keys.join(', ') || 'none'}`);
  head.push('');

  const tail = ['', '## final assistant message', clip(detail.finalText, FINAL_CHARS) || 'none', ''];

  const build = (promptChars, keepAll) => {
    const lines = [`## human prompts (${detail.humanPrompts.length})`];
    const P = detail.humanPrompts;
    const show = keepAll || P.length <= 6 ? P.map((p, i) => [i, p]) : [
      ...P.slice(0, 3).map((p, i) => [i, p]),
      null,
      ...P.slice(-3).map((p, i) => [P.length - 3 + i, p]),
    ];
    for (const item of show) {
      if (item === null) { lines.push(`… [${P.length - 6} prompts elided]`); continue; }
      const [i, p] = item;
      lines.push(`[${i + 1}] ${p.at ?? ''}`);
      lines.push(clip(p.text, promptChars));
      lines.push('');
    }
    return [...head, ...lines, ...tail].join('\n');
  };

  let out = build(PROMPT_CHARS, true);
  if (out.length > maxChars) out = build(PROMPT_CHARS, false);
  if (out.length > maxChars) out = build(200, false);
  if (out.length > maxChars) out = `${out.slice(0, maxChars - 22)}\n… [digest truncated]\n`;
  return out;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  let file = args._[0] ?? (typeof args.file === 'string' ? args.file : null);
  if (!file && typeof args.chat === 'string') {
    const dir = typeof args.dir === 'string' ? args.dir : null;
    const home = process.env.HOME || '~';
    const ledger = process.env.CLAUDE_ESTIMATION_DIR || process.env.LEDGER
      || path.join(home, '.claude', 'estimation');
    const chatsIndex = typeof args.chats === 'string' ? args.chats : path.join(ledger, 'ledger', 'chats.ndjson');
    if (args.chat.endsWith('.jsonl') && fs.existsSync(args.chat)) {
      file = args.chat;
    } else if (fs.existsSync(chatsIndex)) {
      const line = fs.readFileSync(chatsIndex, 'utf8').split('\n')
        .map((l) => { try { return JSON.parse(l); } catch { return null; } })
        .find((r) => r && r.chat_id === args.chat && typeof r.file === 'string');
      if (line) file = line.file;
    }
    if (!file && dir) file = path.join(dir, `${args.chat}.jsonl`);
    if (!file) {
      process.stderr.write(`digest: chat ${args.chat} not found in ${chatsIndex}; pass --dir <projectDir> or the .jsonl path\n`);
      process.exit(2);
    }
  }
  if (!file) {
    process.stderr.write('usage: digest.mjs <file.jsonl> [--max-chars 12000]\n');
    process.exit(2);
  }
  const maxChars = Number(args['max-chars'] ?? args.maxChars ?? 12000) || 12000;
  process.stdout.write(digest(file, maxChars));
}

if (import.meta.url === `file://${process.argv[1]}`) main();
