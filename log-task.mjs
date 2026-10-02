#!/usr/bin/env node
/**
 * Append one finished task to the calendar's AI task log.
 *
 * The agent runs this when it completes a piece of work; the calendar page reads
 * the same file through `GET /dsh-calendar/ai-tasks` and draws the record as an
 * AI event. Records are keyed by `id`, so re-running with the same title and day
 * appends a new entry rather than editing one — pass `--id` to replace instead.
 *
 * Usage
 *   node log-task.mjs --title "优化日历插件" [options]
 *
 * Options
 *   --title <text>      required; the record's headline (<= 80 chars)
 *   --prompt <text>     what the task actually was; defaults to the title.
 *                       This is also the text handed back to the model when a
 *                       planned task's "开始执行" is confirmed.
 *   --status <s>        done (default) | planned
 *   --at <local time>   completion moment, `YYYY-MM-DDTHH:mm` or `HH:mm`
 *                       (defaults to now)
 *   --minutes <n>       span drawn on the calendar (default 30)
 *   --color <id>        blue|indigo|cyan|green|yellow|amber|coral|red|violet|gray
 *   --id <id>           replace an existing record with this id
 *   --list              print the log and exit
 *   --remove <id>       delete one record and exit
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const home = (process.env.DSH_HOME || '').trim() || path.join(os.homedir(), '.dsh');
const dir = path.join(home, 'calendar-plugin');
const file = path.join(dir, 'ai-tasks.json');

const COLORS = ['blue', 'indigo', 'cyan', 'green', 'yellow', 'amber', 'coral', 'red', 'violet', 'gray'];

function argv(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return fallback;
  const value = process.argv[i + 1];
  return value === undefined || value.startsWith('--') ? true : value;
}

function read() {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function write(list) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(list, null, 2)}\n`, 'utf8');
}

const pad = (n) => String(n).padStart(2, '0');
const hhmm = (d) => `${pad(d.getHours())}:${pad(d.getMinutes())}`;
const ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

if (argv('list', false)) {
  console.log(JSON.stringify(read(), null, 2));
  process.exit(0);
}

const removeId = argv('remove', null);
if (typeof removeId === 'string') {
  const before = read();
  const after = before.filter((t) => t.id !== removeId);
  write(after);
  console.log(`removed ${before.length - after.length} record(s); ${after.length} left`);
  process.exit(0);
}

const title = String(argv('title', '') || '').trim().slice(0, 80);
if (!title) {
  console.error('log-task: --title is required');
  process.exit(2);
}

const status = String(argv('status', 'done') || 'done');
const minutes = Math.max(5, Number(argv('minutes', 30)) || 30);
const colorArg = String(argv('color', status === 'done' ? 'indigo' : 'blue') || '');
const color = COLORS.includes(colorArg) ? colorArg : 'indigo';

const atRaw = argv('at', null);
const now = new Date();
let start;
if (typeof atRaw === 'string' && atRaw.includes('T')) {
  start = new Date(atRaw);
} else if (typeof atRaw === 'string' && /^\d{1,2}:\d{2}$/.test(atRaw)) {
  const [h, m] = atRaw.split(':').map(Number);
  start = new Date(now.getFullYear(), now.getMonth(), now.getDate(), h, m);
} else {
  start = now;
}
if (Number.isNaN(start.getTime())) start = now;
const finish = new Date(start.getTime() + minutes * 60000);

const id = typeof argv('id', null) === 'string'
  ? argv('id', null)
  : `ai_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;

const record = {
  id,
  title,
  prompt: String(argv('prompt', '') || title).trim().slice(0, 2000),
  date: ymd(start),
  start: hhmm(start),
  end: hhmm(finish),
  allDay: false,
  color,
  status,
  source: 'ai',
  completedAt: start.toISOString(),
  loggedAt: new Date().toISOString(),
};

const list = read();
const at = list.findIndex((t) => t.id === id);
if (at >= 0) list[at] = record;
else list.push(record);
write(list);

console.log(`${at >= 0 ? 'updated' : 'logged'} ${id}  ${record.date} ${record.start}–${record.end}  ${title}`);
console.log(`file: ${file}  (${list.length} record(s))`);
