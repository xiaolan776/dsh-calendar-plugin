/**
 * Host half of the 日程 bundle.
 *
 * The calendar itself is drawn in the browser, but two things can only happen
 * here:
 *
 *   1. `GET /dsh-calendar/ai-tasks` — the page reads the AI task log this half
 *      owns. The log is a plain JSON file so the agent can append to it when it
 *      finishes a task (`log-task.mjs` does exactly that).
 *   2. `POST /dsh-calendar/start` — the page asks the Harness to hand a due AI
 *      task to the model as a real prompt. Delivery goes through the shipped
 *      `schedule` service: a one-shot reminder a couple of seconds out is
 *      appended to the target Session's inbox, which is what actually starts
 *      the work. Without that service the route answers `ok: false` and the
 *      page falls back to clipboard + a fresh session.
 *
 * The AI task log lives beside the rest of the harness data:
 * `$DSH_HOME/calendar-plugin/ai-tasks.json` (default `~/.dsh/...`).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const inject = ['webServer'];

const TASKS_PATH = '/dsh-calendar/ai-tasks';
const START_PATH = '/dsh-calendar/start';

export function dataDir() {
  const home = (process.env.DSH_HOME || '').trim() || path.join(os.homedir(), '.dsh');
  return path.join(home, 'calendar-plugin');
}

export function tasksFile() {
  return path.join(dataDir(), 'ai-tasks.json');
}

function readTasks() {
  try {
    const parsed = JSON.parse(fs.readFileSync(tasksFile(), 'utf8'));
    return Array.isArray(parsed) ? parsed.filter((t) => t && t.title) : [];
  } catch {
    return [];
  }
}

function sendJson(res, status, body) {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('cache-control', 'no-store');
  res.end(JSON.stringify(body));
}

/** The GUI talks to the loopback server; anything else is refused. */
function isLoopback(req) {
  const address = (req.socket && req.socket.remoteAddress) || '';
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1';
}

function readBody(req, limit = 64 * 1024) {
  return new Promise((resolve) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
      if (body.length > limit) req.destroy();
    });
    req.on('end', () => resolve(body));
    req.on('error', () => resolve(''));
  });
}

/** The shipped Schedule service, if this composition carries it. */
function scheduleService(ctx) {
  try {
    if (ctx.schedule) return ctx.schedule;
  } catch {
    /* not provided */
  }
  try {
    if (typeof ctx.get === 'function') {
      const found = ctx.get('schedule');
      if (found) return found;
    }
  } catch {
    /* not provided */
  }
  return null;
}

export function apply(ctx) {
  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'exact',
        path: TASKS_PATH,
        handler: (req, res) => {
          if (!isLoopback(req)) return sendJson(res, 403, { error: 'loopback only' });
          if (req.method !== 'GET') return sendJson(res, 405, { error: 'GET only' });
          sendJson(res, 200, { tasks: readTasks(), file: tasksFile() });
        },
      }),
    `calendar: GET ${TASKS_PATH}`,
  );

  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'exact',
        path: START_PATH,
        handler: async (req, res) => {
          if (!isLoopback(req)) return sendJson(res, 403, { error: 'loopback only' });
          if (req.method !== 'POST') return sendJson(res, 405, { error: 'POST only' });

          let payload;
          try {
            payload = JSON.parse((await readBody(req)) || '{}');
          } catch {
            return sendJson(res, 400, { ok: false, error: 'malformed body' });
          }

          const sessionId = String(payload.sessionId || '').trim();
          const title = String(payload.title || '').trim().slice(0, 120);
          const prompt = String(payload.prompt || '').trim();
          if (!sessionId) return sendJson(res, 200, { ok: false, error: 'no session' });
          if (!title || !prompt) return sendJson(res, 200, { ok: false, error: 'empty task' });

          const schedule = scheduleService(ctx);
          if (!schedule || typeof schedule.create !== 'function') {
            return sendJson(res, 200, { ok: false, error: 'schedule service unavailable' });
          }

          try {
            // Two seconds out: the service delivers it as a follow-up in the
            // target Session, which is what makes the model start the task.
            await schedule.create(sessionId, { title, prompt, after_seconds: 2 });
            return sendJson(res, 200, { ok: true });
          } catch (error) {
            return sendJson(res, 200, {
              ok: false,
              error: String((error && error.message) || error),
            });
          }
        },
      }),
    `calendar: POST ${START_PATH}`,
  );
}
