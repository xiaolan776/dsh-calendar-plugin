/**
 * Automatic AI task logging.
 *
 * The agent's own task list is the most reliable record of what it finished, and
 * the Harness already persists it: every `todo_write` call lands in the Session
 * log as a `todo/write` event carrying the full list and a timestamp.
 *
 * This module tails those Session logs and appends one calendar record for every
 * item that newly reaches `completed`. Consequences worth knowing:
 *
 *   - Only work that goes through a todo list is captured. A short task with no
 *     list still has to be logged by hand (`log-task.mjs`).
 *   - Session logs are a chain of independent zstd frames, not one stream, and
 *     Node's zstd API stops after the first frame, so frames are located by the
 *     zstd magic and decompressed one by one. A frame that fails to decode is a
 *     false magic inside compressed data (or a frame still being written) and is
 *     simply retried on the next pass.
 *   - Records go to `ai-tasks-auto.json`, a file only this module writes, so it
 *     can never race the hand-written `ai-tasks.json`.
 *   - History is not replayed: a Session seen for the first time is baselined at
 *     its current end. `log-task.mjs --backfill` rewinds that on purpose.
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);
const POLL_MS = 4000;
const LOG_PER_PASS = 12;
const ACTIVE_MS = 24 * 60 * 60 * 1000;
const SESSIONS_PER_PASS = 8;
const STEP_MINUTES = 15;

const pad2 = (n) => String(n).padStart(2, '0');
const ymd = (d) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
const hhmm = (d) => `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;

function readJson(file, fallback) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : fallback;
  } catch {
    return fallback;
  }
}

function writeJsonAtomic(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  fs.renameSync(tmp, file);
}

/**
 * Every zstd frame in `buffer`, as `{ offset, text }` with offsets relative to
 * the buffer. Undecodable candidates are skipped, not fatal.
 */
function decodeFrames(buffer) {
  const frames = [];
  let offset = buffer.indexOf(ZSTD_MAGIC);
  while (offset !== -1) {
    try {
      frames.push({ offset, text: zlib.zstdDecompressSync(buffer.subarray(offset)).toString('utf8') });
    } catch {
      /* false magic, or a frame still being appended */
    }
    offset = buffer.indexOf(ZSTD_MAGIC, offset + 4);
  }
  return frames;
}

function listSessionFiles(sessionsDir) {
  const files = [];
  const walk = (dir, depth) => {
    if (depth > 3) return;
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full, depth + 1);
      else if (entry.name.endsWith('.jsonl.zstd')) files.push(full);
    }
  };
  walk(sessionsDir, 0);
  return files;
}

/** Root Sessions only: subagent logs would flood the calendar. */
function isRootSession(file) {
  try {
    const head = zlib.zstdDecompressSync(fs.readFileSync(file)).toString('utf8');
    const first = JSON.parse(head.split('\n').find((line) => line.trim()) || '{}');
    return first.type === 'session' && !first.parentSession;
  } catch {
    return false;
  }
}

function readTail(file, from, size) {
  const length = size - from;
  if (length <= 0) return Buffer.alloc(0);
  const buffer = Buffer.alloc(length);
  const fd = fs.openSync(file, 'r');
  try {
    fs.readSync(fd, buffer, 0, length, from);
  } finally {
    fs.closeSync(fd);
  }
  return buffer;
}

/**
 * Fold one `todo/write` event into the Session's state.
 *
 * @param baseline - true while reading a Session's pre-existing history: items
 *   are remembered as already-done but produce no records.
 * @returns false when the per-pass budget ran out, meaning the event must be
 *   re-read next pass (items already folded stay deduplicated by content).
 */
function applyTodoWrite(event, entry, out, sessionId, budget, baseline) {
  const todos = (event.data && event.data.todos) || [];
  for (const todo of todos) {
    if (!todo || todo.status !== 'completed') continue;
    const content = String(todo.content || '').trim();
    if (!content || entry.completed[content]) continue;
    if (!baseline) {
      if (budget.left <= 0) return false;
      budget.left -= 1;
    }
    entry.completed[content] = event.seq;
    if (baseline) continue;

    const at = new Date(event.time || Date.now());
    const finish = new Date(at.getTime() + STEP_MINUTES * 60000);
    out.push({
      id: `auto_${sessionId.slice(-8)}_${event.seq}_${Object.keys(entry.completed).length}`,
      title: content.slice(0, 80),
      prompt: `自动记录 · 会话 ${sessionId.slice(-8)} · 完成于 ${ymd(at)} ${hhmm(at)}（来自待办清单）`,
      date: ymd(at),
      start: hhmm(at),
      end: hhmm(finish),
      allDay: false,
      color: 'indigo',
      status: 'done',
      source: 'ai',
      auto: true,
      completedAt: at.toISOString(),
      loggedAt: new Date().toISOString(),
    });
  }
  return true;
}

/**
 * One tailing pass over the active root Sessions.
 *
 * @param options.sessionsDir - `$DSH_HOME/sessions`
 * @param options.statePath - per-Session read offsets and known completions
 * @param options.outPath - the JSON array this pass appends to
 * @param options.now - injectable clock, for tests
 * @returns the records appended by this pass
 */
export function scanTodoCompletions({ sessionsDir, statePath, outPath, now = Date.now() }) {
  const state = readJson(statePath, { sessions: {} });
  if (!state.sessions || typeof state.sessions !== 'object') state.sessions = {};

  const files = listSessionFiles(sessionsDir)
    .map((file) => ({ file, mtime: fs.statSync(file).mtimeMs }))
    .filter((row) => now - row.mtime < ACTIVE_MS)
    .sort((a, b) => b.mtime - a.mtime)
    .slice(0, SESSIONS_PER_PASS);

  const budget = { left: LOG_PER_PASS };
  const produced = [];

  for (const { file } of files) {
    const sessionId = path.basename(path.dirname(file));
    const size = fs.statSync(file).size;
    let entry = state.sessions[sessionId];
    let baseline = false;

    if (!entry) {
      if (!isRootSession(file)) continue;
      // First sight of this Session. Read its history from the start to learn
      // which items are already done, but record none of them, so installing the
      // plugin never dumps a Session's whole backlog onto the calendar.
      entry = { file, offset: 0, lastSeq: 0, completed: {} };
      state.sessions[sessionId] = entry;
      baseline = true;
    }
    if (entry.file !== file) entry.file = file;
    if (size <= entry.offset) continue;

    const tail = readTail(file, entry.offset, size);
    const frames = decodeFrames(tail);
    if (!frames.length) continue;

    let consumed = entry.offset;
    for (const frame of frames) {
      const absolute = entry.offset + frame.offset;
      for (const line of frame.text.split('\n')) {
        if (!line.trim()) continue;
        let event;
        try {
          event = JSON.parse(line);
        } catch {
          continue;
        }
        const seq = typeof event.seq === 'number' ? event.seq : null;
        if (seq !== null && seq <= entry.lastSeq) continue;

        if (event.type === 'todo/write') {
          const folded = applyTodoWrite(event, entry, produced, sessionId, budget, baseline);
          if (!folded) {
            // Budget spent inside this event. Keep `lastSeq` where it is and
            // point the offset at this frame so the next pass re-reads it; items
            // already folded are skipped by content, the rest are still pending.
            entry.offset = absolute;
            writeJsonAtomic(statePath, state);
            appendRecords(outPath, produced);
            return produced;
          }
        }
        if (seq !== null) entry.lastSeq = seq;
      }
      consumed = absolute;
    }
    entry.offset = consumed;
  }

  writeJsonAtomic(statePath, state);
  appendRecords(outPath, produced);
  return produced;
}

function appendRecords(outPath, records) {
  if (!records.length) return;
  const list = readJson(outPath, []);
  const existing = Array.isArray(list) ? list : [];
  const ids = new Set(existing.map((r) => r && r.id));
  const next = existing.concat(records.filter((r) => !ids.has(r.id)));
  writeJsonAtomic(outPath, next);
}

/**
 * Start tailing. Returns a stop function.
 *
 * @param options.onRecords - called with each batch so the caller can log it
 */
export function startAutoLog({ sessionsDir, statePath, outPath, onRecords, intervalMs = POLL_MS }) {
  let stopped = false;
  const pass = () => {
    if (stopped) return;
    try {
      const produced = scanTodoCompletions({ sessionsDir, statePath, outPath });
      if (produced.length && typeof onRecords === 'function') onRecords(produced);
    } catch {
      /* a transient read error must never take the host down */
    }
  };
  const timer = setInterval(pass, intervalMs);
  if (timer.unref) timer.unref();
  pass();
  return () => {
    stopped = true;
    clearInterval(timer);
  };
}
