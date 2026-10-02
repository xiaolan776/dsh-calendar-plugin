/**
 * 日程 — calendar page for the Harness Web UI.
 *
 * Browser half of the bundle. Executing this file only registers a factory; the
 * module body (and every side effect) runs at materialization, per the client
 * module protocol. No build step: the bundle hand-writes the
 * `window.__ModuleLoader__.load({ id, factory })` envelope.
 *
 * Contributions:
 *   sidebar.panellist — the 「日程」 icon entry (order 11, right after 自动化任务)
 *   main              — the calendar page it opens (key: 'calendar')
 */
window.__ModuleLoader__.load({
  id: '@local/dsh-calendar-plugin',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const { useState, useEffect, useMemo, useRef, useCallback } = React;

    /* ------------------------------------------------------------------ *
     * Constants
     * ------------------------------------------------------------------ */

    const EVENTS_KEY = 'dsh.calendar.events.v1';
    const VIEW_KEY = 'dsh.calendar.view.v1';
    const VIEWS = ['month', 'week', 'day', 'agenda'];
    const VIEW_LABELS = { month: '月', week: '周', day: '日', agenda: '列表' };
    const DOW = ['一', '二', '三', '四', '五', '六', '日'];
    const HOUR_PX = 48;
    const DAY_MS = 24 * 60 * 60 * 1000;
    /**
     * Event colors. Hues the host exposes as tokens follow the app palette; the
     * rest are fixed mid-tone hues picked so one value works both as a chip fill
     * and as a left accent, in light and in dark themes.
     */
    const PALETTE = [
      { id: 'blue', label: '蓝', color: 'var(--dsw-static-blue-500)' },
      { id: 'indigo', label: '靛蓝', color: '#6366f1' },
      { id: 'cyan', label: '青', color: '#06b6d4' },
      { id: 'green', label: '绿', color: 'var(--dsw-static-green-500)' },
      { id: 'yellow', label: '黄', color: '#eab308' },
      { id: 'amber', label: '橙', color: 'var(--dsw-static-amber-500)' },
      { id: 'coral', label: '珊瑚', color: '#fb7185' },
      { id: 'red', label: '红', color: 'var(--dsw-static-red-500)' },
      { id: 'violet', label: '紫', color: '#8b5cf6' },
      { id: 'gray', label: '灰', color: 'var(--dsw-static-neutral-500)' },
    ];
    const colorOf = (id) => (PALETTE.find((c) => c.id === id) || PALETTE[0]).color;

    /** Translate a palette token to a translucent fill that follows the theme. */
    const fillOf = (id) => `color-mix(in srgb, ${colorOf(id)} 16%, transparent)`;

    /* ------------------------------------------------------------------ *
     * Date helpers (all local time; a calendar day is a wall-clock day)
     * ------------------------------------------------------------------ */

    const pad2 = (n) => String(n).padStart(2, '0');
    const ymd = (d) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
    const parseYmd = (s) => {
      const parts = String(s).split('-').map(Number);
      return new Date(parts[0], (parts[1] || 1) - 1, parts[2] || 1);
    };
    const addDays = (d, n) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
    const startOfWeek = (d) => addDays(d, -((d.getDay() + 6) % 7)); // Monday first
    const startOfMonth = (d) => new Date(d.getFullYear(), d.getMonth(), 1);
    const sameDay = (a, b) => ymd(a) === ymd(b);
    const isToday = (d) => sameDay(d, new Date());
    const toMinutes = (hm) => {
      const parts = String(hm || '00:00').split(':').map(Number);
      return (parts[0] || 0) * 60 + (parts[1] || 0);
    };
    const toHM = (mins) => `${pad2(Math.floor(mins / 60))}:${pad2(mins % 60)}`;
    const fmtRange = (ev) =>
      ev.allDay ? '全天' : `${ev.start} – ${ev.end}`;
    const fmtDayTitle = (d) =>
      `${d.getFullYear()} 年 ${d.getMonth() + 1} 月 ${d.getDate()} 日 周${DOW[(d.getDay() + 6) % 7]}`;

    /* ------------------------------------------------------------------ *
     * Event store (localStorage; survives reloads and Host restarts)
     * ------------------------------------------------------------------ */

    let uid = 0;
    const newId = () => `ev_${Date.now().toString(36)}_${(uid++).toString(36)}`;

    function readEvents() {
      try {
        const raw = localStorage.getItem(EVENTS_KEY);
        const parsed = raw ? JSON.parse(raw) : [];
        return Array.isArray(parsed) ? parsed.filter((e) => e && e.date) : [];
      } catch {
        return [];
      }
    }

    function writeEvents(list) {
      try {
        localStorage.setItem(EVENTS_KEY, JSON.stringify(list));
      } catch {
        /* quota or privacy mode: keep the in-memory copy */
      }
    }

    function readView() {
      try {
        const v = localStorage.getItem(VIEW_KEY);
        return VIEWS.indexOf(v) >= 0 ? v : 'month';
      } catch {
        return 'month';
      }
    }

    const eventsOn = (list, dayStr) => list.filter((e) => e.date === dayStr);
    const sortEvents = (list) =>
      list
        .slice()
        .sort((a, b) =>
          a.date === b.date
            ? (a.allDay ? -1 : b.allDay ? 1 : toMinutes(a.start) - toMinutes(b.start))
            : a.date < b.date
              ? -1
              : 1,
        );

    /* ------------------------------------------------------------------ *
     * The AI side of the calendar
     *
     * Two sources feed AI events:
     *   - the host's task log (`GET /dsh-calendar/ai-tasks`), which the agent
     *     appends to whenever it finishes something;
     *   - AI events the user creates in the editor (`source: 'ai'`), which live
     *     in the same localStorage store as everything else.
     *
     * Planned AI events raise a reminder when their start time arrives; that
     * reminder can hand the task back to the model through `/dsh-calendar/start`.
     * ------------------------------------------------------------------ */

    const AI_TASKS_ROUTE = '/dsh-calendar/ai-tasks';
    const AI_START_ROUTE = '/dsh-calendar/start';
    const ACK_KEY = 'dsh.calendar.acked.v1';
    const HIDDEN_KEY = 'dsh.calendar.hidden.v1';
    const REMINDER_WINDOW_MIN = 45;
    const POLL_MS = 15000;

    /** The Session the reminder should be delivered into; filled by SessionTracker. */
    const sessionRef = { id: null };

    /** Handled reminders, keyed `<id>@<date>` so a repeat next week still fires. */
    function readAcks() {
      try {
        const raw = JSON.parse(localStorage.getItem(ACK_KEY) || '[]');
        return new Set(Array.isArray(raw) ? raw : []);
      } catch {
        return new Set();
      }
    }

    function writeAcks(set) {
      try {
        localStorage.setItem(ACK_KEY, JSON.stringify([...set].slice(-500)));
      } catch {
        /* ignore */
      }
    }

    /** Host records the user deleted here; the poll must not resurrect them. */
    function readHidden() {
      try {
        const raw = JSON.parse(localStorage.getItem(HIDDEN_KEY) || '[]');
        return new Set(Array.isArray(raw) ? raw : []);
      } catch {
        return new Set();
      }
    }

    function writeHidden(set) {
      try {
        localStorage.setItem(HIDDEN_KEY, JSON.stringify([...set].slice(-500)));
      } catch {
        /* ignore */
      }
    }

    /** One shared poll of the host task log, observed by both halves of the UI. */
    function createAiStore() {
      let state = { tasks: [], status: 'idle', error: null, file: null };
      const listeners = new Set();
      const publish = (next) => {
        state = next;
        listeners.forEach((listener) => listener());
      };
      const refresh = async () => {
        try {
          const response = await fetch(AI_TASKS_ROUTE, {
            headers: { accept: 'application/json' },
            cache: 'no-store',
          });
          if (!response.ok) throw new Error(`HTTP ${response.status}`);
          const body = await response.json();
          publish({
            tasks: Array.isArray(body.tasks) ? body.tasks : [],
            status: 'ready',
            error: null,
            file: body.file || null,
          });
        } catch (error) {
          publish({
            ...state,
            status: state.status === 'ready' ? 'ready' : 'unavailable',
            error: String((error && error.message) || error),
          });
        }
      };
      return {
        subscribe(listener) {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
        get: () => state,
        refresh,
      };
    }

    const aiStore = createAiStore();

    function useAiTasks() {
      return React.useSyncExternalStore(aiStore.subscribe, aiStore.get, aiStore.get);
    }

    /** Host records wear the same shape the calendar already draws. */
    function hostTaskToEvent(task) {
      return {
        id: task.id,
        calendarId: 'ai',
        title: task.title,
        date: task.date,
        allDay: Boolean(task.allDay),
        start: task.start || '09:00',
        end: task.end || '10:00',
        location: task.location || '',
        notes: task.prompt || '',
        color: task.color || 'indigo',
        source: 'ai',
        status: task.status || 'done',
        fromHost: true,
      };
    }

    const isAiEvent = (ev) => ev.source === 'ai';
    const isDoneRecord = (ev) => isAiEvent(ev) && ev.status === 'done';

    /** The prompt handed back to the model when a planned task starts. */
    const promptOf = (ev) => (ev.notes || ev.title || '').trim();

    /** Class names every surface that draws an event shares. */
    function eventClass(base, ev) {
      const parts = [base];
      if (isAiEvent(ev)) parts.push('dshcal-ai');
      if (isDoneRecord(ev)) parts.push('dshcal-done');
      if (ev.__preview) parts.push('dshcal-preview');
      return parts.join(' ');
    }

    /** ✦ for a planned AI task, ✓ for a finished one, nothing for the user's own. */
    function EventMarker(ev) {
      if (isDoneRecord(ev)) return h('span', { className: 'dshcal-check' }, '✓');
      if (isAiEvent(ev)) return h('span', { className: 'dshcal-spark' }, '✦');
      return null;
    }

    /* ------------------------------------------------------------------ *
     * Styles — rendered as a React element so unmounting removes them.
     * Only host theme tokens are used, so light/dark follow the app.
     * ------------------------------------------------------------------ */

    const CSS = `
/* Every box this page owns measures its border box, so a block's declared
   left/width/top/height is exactly the space the grid reserves for it and its
   own padding/border can never push it across a gridline. */
.dshcal-page,.dshcal-page *{box-sizing:border-box}
.dshcal-page{position:relative;display:flex;flex-direction:column;height:100%;min-height:0;width:100%;
  color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-base);
  font-family:var(--dsw-font-family);font-size:14px;line-height:1.5;overflow:hidden}
.dshcal-head{display:flex;align-items:center;gap:12px;flex:none;padding:14px 20px;
  border-bottom:.5px solid var(--dsw-alias-border-l2)}
.dshcal-title{font-size:17px;font-weight:600;letter-spacing:.2px;white-space:nowrap}
.dshcal-spacer{flex:1;min-width:0}
.dshcal-btn{display:inline-flex;align-items:center;justify-content:center;gap:6px;height:30px;padding:0 12px;
  font:inherit;font-size:13px;color:var(--dsw-alias-label-primary);background:transparent;cursor:pointer;
  border:.5px solid var(--dsw-alias-border-l3);border-radius:var(--dsw-radius-sm);transition:background .15s}
.dshcal-btn:hover{background:var(--dsw-alias-interactive-bg-hover)}
.dshcal-btn.primary{background:var(--dsw-alias-brand-primary);border-color:transparent;
  color:var(--dsw-alias-label-primary-foreground)}
.dshcal-btn.primary:hover{filter:brightness(1.08)}
.dshcal-btn.danger{color:var(--dsw-alias-state-error-primary);border-color:var(--dsw-alias-border-l3)}
.dshcal-btn.icon{width:30px;padding:0}
.dshcal-tabs{display:inline-flex;gap:2px;padding:2px;background:var(--dsw-alias-bg-layer-2);
  border-radius:var(--dsw-radius-md)}
.dshcal-tab{font:inherit;font-size:13px;color:var(--dsw-alias-label-secondary);background:transparent;
  border:0;border-radius:var(--dsw-radius-sm);padding:4px 12px;cursor:pointer;transition:background .15s,color .15s}
.dshcal-tab:hover{color:var(--dsw-alias-label-primary)}
.dshcal-tab.active{background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);
  box-shadow:var(--dsw-shadow-lv1)}
.dshcal-body{flex:1;min-height:0;display:flex;overflow:hidden;position:relative}

/* month */
.dshcal-month{display:flex;flex-direction:column;flex:1;min-height:0;min-width:0}
.dshcal-dowrow{display:grid;grid-template-columns:repeat(7,minmax(0,1fr));flex:none;
  border-bottom:.5px solid var(--dsw-alias-border-l2)}
.dshcal-dow{padding:8px 10px;font-size:12px;color:var(--dsw-alias-label-tertiary)}
.dshcal-grid{display:grid;grid-template-columns:repeat(7,minmax(0,1fr));grid-template-rows:repeat(6,minmax(0,1fr));
  flex:1;min-height:0}
.dshcal-cell{position:relative;display:flex;flex-direction:column;gap:3px;padding:6px 6px 4px;overflow:hidden;
  border-right:.5px solid var(--dsw-alias-border-l1);border-bottom:.5px solid var(--dsw-alias-border-l1);
  cursor:pointer;transition:background .15s}
.dshcal-cell:hover{background:var(--dsw-alias-interactive-bg-hover)}
.dshcal-cell.out{background:color-mix(in srgb,var(--dsw-alias-bg-layer-1) 45%,transparent)}
.dshcal-daynum{font-size:12px;color:var(--dsw-alias-label-secondary);flex:none;width:22px;height:22px;
  display:flex;align-items:center;justify-content:center;border-radius:999px}
.dshcal-cell.out .dshcal-daynum{color:var(--dsw-alias-label-tertiary)}
.dshcal-daynum.today{background:var(--dsw-alias-brand-primary);color:var(--dsw-alias-label-primary-foreground);font-weight:600}
.dshcal-chip{display:flex;align-items:center;gap:5px;font-size:12px;line-height:18px;padding:1px 6px;
  border-radius:var(--dsw-radius-xs);background:var(--dshcal-fill);border-left:2.5px solid var(--dshcal-color);
  white-space:nowrap;overflow:hidden;text-overflow:ellipsis;cursor:pointer}
.dshcal-chip:hover{filter:brightness(1.12)}
.dshcal-chip .t{color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums;flex:none}
.dshcal-more{font-size:11px;color:var(--dsw-alias-label-tertiary);padding-left:6px;cursor:pointer;flex:none}
.dshcal-more:hover{color:var(--dsw-alias-label-primary)}

/* week / day time grid */
.dshcal-time{display:flex;flex-direction:column;flex:1;min-width:0;min-height:0}
.dshcal-timehead{display:flex;flex:none;border-bottom:.5px solid var(--dsw-alias-border-l2)}
.dshcal-guttercell{width:56px;flex:none}
.dshcal-dayhead{flex:1;min-width:0;text-align:center;padding:6px 2px 8px;border-left:.5px solid var(--dsw-alias-border-l1)}
.dshcal-dayhead .n{font-size:18px;font-weight:600;line-height:22px}
.dshcal-dayhead .w{font-size:11px;color:var(--dsw-alias-label-tertiary)}
.dshcal-dayhead.today .n{color:var(--dsw-alias-brand-primary)}
.dshcal-allday{display:flex;flex:none;border-bottom:.5px solid var(--dsw-alias-border-l2);min-height:26px}
.dshcal-alldaylabel{width:56px;flex:none;font-size:11px;color:var(--dsw-alias-label-tertiary);
  display:flex;align-items:center;justify-content:flex-end;padding-right:8px}
.dshcal-alldaycol{flex:1;min-width:0;border-left:.5px solid var(--dsw-alias-border-l1);padding:3px 4px;
  display:flex;flex-direction:column;gap:3px}
.dshcal-scroll{flex:1;min-height:0;overflow-y:auto;overflow-x:hidden;position:relative}
.dshcal-times{display:flex;position:relative}
.dshcal-hours{width:56px;flex:none}
.dshcal-hourlabel{height:${HOUR_PX}px;font-size:11px;color:var(--dsw-alias-label-tertiary);
  text-align:right;padding-right:8px;transform:translateY(-6px);font-variant-numeric:tabular-nums}
.dshcal-cols{flex:1;display:flex;min-width:0;position:relative}
.dshcal-col{flex:1;min-width:0;border-left:.5px solid var(--dsw-alias-border-l1);position:relative}
.dshcal-slot{height:${HOUR_PX}px;border-bottom:.5px solid var(--dsw-alias-border-l1);cursor:pointer}
.dshcal-slot:hover{background:var(--dsw-alias-interactive-bg-hover)}
.dshcal-gridlines{position:absolute;inset:0;pointer-events:none}
.dshcal-block{position:absolute;border-radius:var(--dsw-radius-sm);padding:3px 6px;font-size:12px;line-height:16px;
  overflow:hidden;cursor:pointer;background:var(--dshcal-fill);border-left:3px solid var(--dshcal-color);
  box-shadow:var(--dsw-shadow-lv1)}
.dshcal-block:hover{filter:brightness(1.12)}
.dshcal-block .bt{font-size:11px;color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums;
  white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
/* The unsaved draft is drawn on the calendar as you edit it; the dashed ring is
   what marks it as not-yet-stored. */
.dshcal-preview{outline:1.5px dashed var(--dshcal-color);outline-offset:0}
.dshcal-nowline{position:absolute;left:0;right:0;height:1.5px;background:var(--dsw-alias-state-error-primary);z-index:5}
.dshcal-nowdot{position:absolute;left:-3px;top:-3px;width:6px;height:6px;border-radius:999px;
  background:var(--dsw-alias-state-error-primary)}

/* agenda */
.dshcal-agenda{flex:1;min-height:0;overflow-y:auto;padding:8px 20px 32px}
.dshcal-agroup{display:flex;gap:16px;padding:14px 0;border-bottom:.5px solid var(--dsw-alias-border-l1)}
.dshcal-adate{width:150px;flex:none;font-size:13px;color:var(--dsw-alias-label-secondary)}
.dshcal-adate .big{display:block;font-size:20px;font-weight:600;color:var(--dsw-alias-label-primary)}
.dshcal-arows{flex:1;min-width:0;display:flex;flex-direction:column;gap:6px}
.dshcal-arow{display:flex;align-items:baseline;gap:10px;padding:6px 10px;border-radius:var(--dsw-radius-sm);
  border-left:3px solid var(--dshcal-color);background:var(--dshcal-fill);cursor:pointer}
.dshcal-arow:hover{filter:brightness(1.1)}
.dshcal-arow .r{font-size:12px;color:var(--dsw-alias-label-tertiary);width:96px;flex:none;
  font-variant-numeric:tabular-nums}
.dshcal-arow .n{font-size:13px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dshcal-arow .l{font-size:12px;color:var(--dsw-alias-label-tertiary);flex:none}

/* empty state */
.dshcal-empty{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:8px;
  height:100%;color:var(--dsw-alias-label-tertiary);font-size:13px}

/* editor panel */
.dshcal-scrim{position:absolute;inset:0;background:color-mix(in srgb,var(--dsw-static-neutral-1000) 18%,transparent);
  z-index:10}
.dshcal-editor{position:absolute;top:0;right:0;bottom:0;width:340px;max-width:88%;z-index:11;
  display:flex;flex-direction:column;gap:14px;padding:16px;overflow-y:auto;
  background:var(--dsw-alias-bg-layer-1);border-left:.5px solid var(--dsw-alias-border-l2);
  box-shadow:var(--dsw-shadow-lv3)}
.dshcal-editor h2{margin:0;font-size:15px;font-weight:600}
.dshcal-field{display:flex;flex-direction:column;gap:5px}
.dshcal-field > span{font-size:12px;color:var(--dsw-alias-label-tertiary)}
.dshcal-input,.dshcal-select,.dshcal-textarea{width:100%;box-sizing:border-box;font:inherit;font-size:13px;
  color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-base);
  border:.5px solid var(--dsw-alias-border-l3);border-radius:var(--dsw-radius-sm);padding:7px 9px;outline:none}
.dshcal-input:focus,.dshcal-select:focus,.dshcal-textarea:focus{
  border-color:var(--dsw-alias-brand-primary)}
.dshcal-textarea{resize:vertical;min-height:64px}
.dshcal-row2{display:flex;gap:10px}
.dshcal-row2 > *{flex:1;min-width:0}
.dshcal-check{display:flex;align-items:center;gap:7px;font-size:13px;cursor:pointer}
.dshcal-swatches{display:flex;flex-wrap:wrap;gap:8px}
.dshcal-swatch{width:24px;height:24px;border-radius:999px;cursor:pointer;border:2px solid transparent;
  background:var(--dshcal-color);transition:transform .1s ease}
.dshcal-swatch:hover{transform:scale(1.12)}
.dshcal-swatch.on{border-color:var(--dsw-alias-label-primary);box-shadow:0 0 0 2px var(--dsw-alias-bg-layer-1) inset}
.dshcal-colorlabel{font-size:12px;color:var(--dsw-alias-label-tertiary);margin-top:2px}
.dshcal-actions{display:flex;gap:8px;align-items:center;margin-top:auto;padding-top:8px;
  border-top:.5px solid var(--dsw-alias-border-l1)}
.dshcal-hint{font-size:12px;color:var(--dsw-alias-label-tertiary)}

/* AI events: dashed left edge + a hatch, so the eye separates them from the
   user's own events without relying on colour alone. */
.dshcal-ai{border-left-style:dashed;
  background-image:repeating-linear-gradient(45deg,transparent 0 5px,
    color-mix(in srgb,var(--dshcal-color) 10%,transparent) 5px 10px)}
.dshcal-ai .dshcal-spark{color:var(--dshcal-color);flex:none;font-size:10px;line-height:14px}
.dshcal-done{opacity:.72}
.dshcal-done .dshcal-check{color:var(--dsw-alias-state-success-primary);flex:none;font-size:10px}

/* toolbar filter + legend */
.dshcal-filter{display:inline-flex;gap:2px;padding:2px;background:var(--dsw-alias-bg-layer-2);
  border-radius:var(--dsw-radius-md);margin-right:4px}
.dshcal-filter button{font:inherit;font-size:12px;color:var(--dsw-alias-label-secondary);
  background:transparent;border:0;border-radius:var(--dsw-radius-sm);padding:3px 10px;cursor:pointer}
.dshcal-filter button:hover{color:var(--dsw-alias-label-primary)}
.dshcal-filter button.active{background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);
  box-shadow:var(--dsw-shadow-lv1)}

/* reminder dialog — lives in shell.overlay, so it shows on any page */
.dshcal-reminder{position:fixed;inset:0;z-index:2147483000;display:flex;align-items:center;
  justify-content:center;background:color-mix(in srgb,var(--dsw-static-neutral-1000) 32%,transparent)}
.dshcal-card{width:420px;max-width:92vw;display:flex;flex-direction:column;gap:12px;padding:20px;
  background:var(--dsw-alias-bg-layer-1);border:.5px solid var(--dsw-alias-border-l2);
  border-radius:var(--dsw-radius-lg);box-shadow:var(--dsw-elevation-prominent,var(--dsw-shadow-lv3));
  color:var(--dsw-alias-label-primary);font-family:var(--dsw-font-family);font-size:14px}
.dshcal-card h3{margin:0;font-size:16px;font-weight:600;display:flex;align-items:center;gap:8px}
.dshcal-card .meta{font-size:12px;color:var(--dsw-alias-label-tertiary)}
.dshcal-card .body{margin:0;padding:10px 12px;border-radius:var(--dsw-radius-sm);font-size:13px;
  background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary);
  white-space:pre-wrap;max-height:180px;overflow:auto}
.dshcal-card .row{display:flex;gap:8px;justify-content:flex-end;flex-wrap:wrap}
.dshcal-badge{display:inline-flex;align-items:center;gap:4px;font-size:11px;padding:1px 6px;
  border-radius:999px;border:.5px solid var(--dsw-alias-border-l3);color:var(--dsw-alias-label-tertiary)}
.dshcal-badge.ai{color:var(--dsw-static-deepseek-500);border-color:currentColor}

/* transient toast */
.dshcal-toast{position:fixed;left:50%;bottom:32px;transform:translateX(-50%);z-index:2147483001;
  padding:10px 16px;border-radius:var(--dsw-radius-md);font-size:13px;font-family:var(--dsw-font-family);
  background:var(--dsw-alias-bg-overlay);color:var(--dsw-alias-label-primary);
  border:.5px solid var(--dsw-alias-border-l2);box-shadow:var(--dsw-shadow-lv3)}
`;

    /* ------------------------------------------------------------------ *
     * Small shared pieces
     * ------------------------------------------------------------------ */

    function Icon({ name, size }) {
      const s = size || 15;
      const common = {
        width: s,
        height: s,
        viewBox: '0 0 24 24',
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: 1.7,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
        'aria-hidden': 'true',
      };
      const paths = {
        plus: [h('path', { key: 'a', d: 'M12 5v14M5 12h14' })],
        left: [h('path', { key: 'a', d: 'M15 5l-7 7 7 7' })],
        right: [h('path', { key: 'a', d: 'M9 5l7 7-7 7' })],
        close: [h('path', { key: 'a', d: 'M6 6l12 12M18 6L6 18' })],
        calendar: [
          h('rect', { key: 'a', x: 3, y: 4.5, width: 18, height: 16, rx: 3 }),
          h('path', { key: 'b', d: 'M3 9.5h18M8 3v3.5M16 3v3.5' }),
        ],
        clock: [
          h('circle', { key: 'a', cx: 12, cy: 12, r: 8.5 }),
          h('path', { key: 'b', d: 'M12 7.5V12l3 2' }),
        ],
        pin: [
          h('path', {
            key: 'a',
            d: 'M12 21s6.5-5.6 6.5-10.4A6.5 6.5 0 0 0 5.5 10.6C5.5 15.4 12 21 12 21z',
          }),
          h('circle', { key: 'b', cx: 12, cy: 10.4, r: 2.3 }),
        ],
        trash: [
          h('path', { key: 'a', d: 'M4 7h16M9 7V4.5h6V7M6.5 7l1 13h9l1-13' }),
        ],
      };
      return h('svg', common, paths[name] || paths.calendar);
    }

    /** Sidebar glyph. The sidebar owns the frame; it only shares edge and selection. */
    function CalendarPanelIcon(props) {
      const size = props && props.size ? props.size : 18;
      return h(
        'span',
        {
          style: {
            display: 'inline-flex',
            color: props && props.active ? 'var(--dsw-alias-brand-primary)' : 'inherit',
          },
        },
        h(Icon, { name: 'calendar', size }),
      );
    }

    /* ------------------------------------------------------------------ *
     * Month view
     * ------------------------------------------------------------------ */

    function MonthView({ anchor, events, onPick, onOpen }) {
      const cells = useMemo(() => {
        const first = startOfMonth(anchor);
        const start = startOfWeek(first);
        const rows = [];
        for (let i = 0; i < 42; i += 1) rows.push(addDays(start, i));
        return rows;
      }, [anchor]);

      const month = anchor.getMonth();
      return h(
        'div',
        { className: 'dshcal-month' },
        h(
          'div',
          { className: 'dshcal-dowrow' },
          DOW.map((d) => h('div', { className: 'dshcal-dow', key: d }, `周${d}`)),
        ),
        h(
          'div',
          { className: 'dshcal-grid' },
          cells.map((day) => {
            const dayStr = ymd(day);
            const list = sortEvents(eventsOn(events, dayStr));
            const shown = list.slice(0, 3);
            const rest = list.length - shown.length;
            const cls = ['dshcal-cell'];
            if (day.getMonth() !== month) cls.push('out');
            return h(
              'div',
              {
                key: dayStr,
                className: cls.join(' '),
                onDoubleClick: (e) => {
                  if (e.target === e.currentTarget || e.target.dataset.empty === '1') onPick(dayStr);
                },
                title: '双击空白处新建日程',
              },
              h(
                'div',
                {
                  className: `dshcal-daynum${isToday(day) ? ' today' : ''}`,
                  'data-empty': '1',
                },
                day.getDate(),
              ),
              shown.map((ev) =>
                h(
                  'div',
                  {
                    key: ev.id,
                    className: eventClass('dshcal-chip', ev),
                    style: { '--dshcal-color': colorOf(ev.color), '--dshcal-fill': fillOf(ev.color) },
                    onDoubleClick: (e) => {
                      e.stopPropagation();
                      onOpen(ev);
                    },
                    title: `${ev.title}（双击编辑）`,
                  },
                  EventMarker(ev),
                  ev.allDay
                    ? null
                    : h('span', { className: 't' }, ev.start),
                  h('span', { style: { overflow: 'hidden', textOverflow: 'ellipsis' } }, ev.title),
                ),
              ),
              rest > 0
                ? h(
                    'div',
                    {
                      className: 'dshcal-more',
                      onClick: (e) => {
                        e.stopPropagation();
                        onOpen(null, day);
                      },
                    },
                    `+${rest} 项`,
                  )
                : null,
            );
          }),
        ),
      );
    }

    /* ------------------------------------------------------------------ *
     * Week / day time grid
     * ------------------------------------------------------------------ */

    function layoutColumns(list) {
      // Greedy column packing for overlapping timed events.
      const sorted = list.slice().sort((a, b) => toMinutes(a.start) - toMinutes(b.start));
      const cols = [];
      const placed = [];
      sorted.forEach((ev) => {
        const s = toMinutes(ev.start);
        const e = Math.max(toMinutes(ev.end), s + 20);
        let col = cols.findIndex((end) => end <= s);
        if (col === -1) {
          col = cols.length;
          cols.push(0);
        }
        cols[col] = e;
        placed.push({ ev, col });
      });
      const total = Math.max(cols.length, 1);
      return placed.map((p) => ({ ...p, total }));
    }

    const GRID_BOTTOM = 24 * 60 * HOUR_PX;
    const BLOCK_MIN_H = 18;
    const BLOCK_INSET = 1;

    /**
     * The box one timed event occupies inside its day column.
     *
     * The inset keeps the block off the hour lines it starts and ends on, so it
     * reads as sitting between them instead of straddling them, and the height is
     * clamped so a late event can never run past the end of the day.
     */
    function blockBox(ev) {
      const start = toMinutes(ev.start);
      const end = Math.min(Math.max(toMinutes(ev.end), start + 20), 24 * 60);
      const top =
        Math.min((start / 60) * HOUR_PX, GRID_BOTTOM - BLOCK_MIN_H - BLOCK_INSET) + BLOCK_INSET;
      const wanted = ((end - start) / 60) * HOUR_PX - BLOCK_INSET * 2;
      const height = Math.max(Math.min(wanted, GRID_BOTTOM - top - BLOCK_INSET), BLOCK_MIN_H);
      return { top, height };
    }

    function TimeGrid({ days, events, onPick, onOpen, showAllDay }) {
      const scroller = useRef(null);
      const now = new Date();
      const nowMinutes = now.getHours() * 60 + now.getMinutes();

      useEffect(() => {
        if (scroller.current) scroller.current.scrollTop = Math.max(0, (now.getHours() - 1) * HOUR_PX);
      }, []);

      const timed = events.filter((e) => !e.allDay);
      const allDay = events.filter((e) => e.allDay);

      return h(
        'div',
        { className: 'dshcal-time' },
        h(
          'div',
          { className: 'dshcal-timehead' },
          h('div', { className: 'dshcal-guttercell' }),
          days.map((d) =>
            h(
              'div',
              { key: ymd(d), className: `dshcal-dayhead${isToday(d) ? ' today' : ''}` },
              h('div', { className: 'w' }, `周${DOW[(d.getDay() + 6) % 7]}`),
              h('div', { className: 'n' }, d.getDate()),
            ),
          ),
        ),
        showAllDay
          ? h(
              'div',
              { className: 'dshcal-allday' },
              h('div', { className: 'dshcal-alldaylabel' }, '全天'),
              days.map((d) => {
                const dayStr = ymd(d);
                return h(
                  'div',
                  { key: dayStr, className: 'dshcal-alldaycol' },
                  sortEvents(allDay.filter((e) => e.date === dayStr)).map((ev) =>
                    h(
                      'div',
                      {
                        key: ev.id,
                        className: eventClass('dshcal-chip', ev),
                        style: {
                          '--dshcal-color': colorOf(ev.color),
                          '--dshcal-fill': fillOf(ev.color),
                        },
                        onDoubleClick: () => onOpen(ev),
                        title: `${ev.title}（双击编辑）`,
                      },
                      EventMarker(ev),
                      ev.title,
                    ),
                  ),
                );
              }),
            )
          : null,
        h(
          'div',
          { className: 'dshcal-scroll', ref: scroller },
          h(
            'div',
            { className: 'dshcal-times' },
            h(
              'div',
              { className: 'dshcal-hours' },
              Array.from({ length: 24 }, (_, hour) =>
                h('div', { key: hour, className: 'dshcal-hourlabel' }, hour === 0 ? '' : `${pad2(hour)}:00`),
              ),
            ),
            h(
              'div',
              { className: 'dshcal-cols' },
              days.map((d) => {
                const dayStr = ymd(d);
                const list = timed.filter((e) => e.date === dayStr);
                const placed = layoutColumns(list);
                return h(
                  'div',
                  { key: dayStr, className: 'dshcal-col' },
                  Array.from({ length: 24 }, (_, hour) =>
                    h('div', {
                      key: hour,
                      className: 'dshcal-slot',
                      onDoubleClick: () => onPick(dayStr, toHM(hour * 60)),
                    }),
                  ),
                  placed.map(({ ev, col, total }) => {
                    const box = blockBox(ev);
                    const width = `calc(${100 / total}% - 4px)`;
                    return h(
                      'div',
                      {
                        key: ev.id,
                        className: eventClass('dshcal-block', ev),
                        style: {
                          top: `${box.top}px`,
                          height: `${box.height}px`,
                          left: `calc(${(col * 100) / total}% + 2px)`,
                          width,
                          '--dshcal-color': colorOf(ev.color),
                          '--dshcal-fill': fillOf(ev.color),
                        },
                        onDoubleClick: (event) => {
                          event.stopPropagation();
                          onOpen(ev);
                        },
                        title: `${ev.title} ${fmtRange(ev)}（双击编辑）`,
                      },
                      h(
                        'div',
                        {
                          style: {
                            display: 'flex',
                            alignItems: 'center',
                            gap: '4px',
                            fontWeight: 500,
                            overflow: 'hidden',
                          },
                        },
                        EventMarker(ev),
                        h(
                          'span',
                          {
                            style: {
                              overflow: 'hidden',
                              whiteSpace: 'nowrap',
                              textOverflow: 'ellipsis',
                            },
                          },
                          ev.title,
                        ),
                      ),
                      box.height >= 40
                        ? h('div', { className: 'bt' }, `${ev.start}–${ev.end}`)
                        : null,
                    );
                  }),
                  isToday(d)
                    ? h(
                        'div',
                        { className: 'dshcal-nowline', style: { top: `${(nowMinutes / 60) * HOUR_PX}px` } },
                        h('div', { className: 'dshcal-nowdot' }),
                      )
                    : null,
                );
              }),
            ),
          ),
        ),
      );
    }

    /* ------------------------------------------------------------------ *
     * Agenda
     * ------------------------------------------------------------------ */

    function AgendaView({ events, onOpen }) {
      const groups = useMemo(() => {
        const start = new Date();
        start.setHours(0, 0, 0, 0);
        const end = addDays(start, 60);
        const byDate = new Map();
        sortEvents(events).forEach((ev) => {
          const d = parseYmd(ev.date);
          if (d < start || d > end) return;
          if (!byDate.has(ev.date)) byDate.set(ev.date, []);
          byDate.get(ev.date).push(ev);
        });
        return Array.from(byDate.entries());
      }, [events]);

      if (!groups.length) {
        return h(
          'div',
          { className: 'dshcal-empty' },
          h(Icon, { name: 'calendar', size: 28 }),
          h('div', null, '未来 60 天没有日程'),
          h('div', { className: 'dshcal-hint' }, '点右上角「新建日程」开始'),
        );
      }

      return h(
        'div',
        { className: 'dshcal-agenda' },
        groups.map(([dateStr, list]) => {
          const d = parseYmd(dateStr);
          return h(
            'div',
            { className: 'dshcal-agroup', key: dateStr },
            h(
              'div',
              { className: 'dshcal-adate' },
              h('span', { className: 'big' }, `${d.getMonth() + 1}/${d.getDate()}`),
              `周${DOW[(d.getDay() + 6) % 7]}${isToday(d) ? ' · 今天' : ''} · ${list.length} 项`,
            ),
            h(
              'div',
              { className: 'dshcal-arows' },
              list.map((ev) =>
                h(
                  'div',
                  {
                    key: ev.id,
                    className: eventClass('dshcal-arow', ev),
                    style: { '--dshcal-color': colorOf(ev.color), '--dshcal-fill': fillOf(ev.color) },
                    onDoubleClick: () => onOpen(ev),
                    title: '双击编辑',
                  },
                  EventMarker(ev),
                  h('span', { className: 'r' }, fmtRange(ev)),
                  h('span', { className: 'n' }, ev.title),
                  ev.location ? h('span', { className: 'l' }, `· ${ev.location}`) : null,
                ),
              ),
            ),
          );
        }),
      );
    }

    /* ------------------------------------------------------------------ *
     * Editor panel
     * ------------------------------------------------------------------ */

    const emptyDraft = (dateStr) => ({
      id: null,
      title: '',
      date: dateStr || ymd(new Date()),
      allDay: false,
      start: '09:00',
      end: '10:00',
      location: '',
      notes: '',
      color: 'blue',
      source: 'user',
    });

    /**
     * The editor is a controlled view over the page's draft, so every keystroke
     * and every swatch pick publishes immediately and the calendar behind it
     * previews the not-yet-saved event.
     */
    function EventEditor({ draft: form, onChange, onSave, onDelete, onClose }) {
      const [error, setError] = useState('');
      const editing = Boolean(form.id);
      const set = (key, value) => onChange({ ...form, [key]: value });
      const firstField = useRef(null);

      useEffect(() => {
        if (firstField.current) firstField.current.focus();
      }, []);

      const commit = () => {
        const title = form.title.trim();
        if (!title) {
          setError('请填写标题');
          return;
        }
        if (!form.allDay && toMinutes(form.end) <= toMinutes(form.start)) {
          setError('结束时间需晚于开始时间');
          return;
        }
        onSave({
          ...form,
          title,
          start: form.allDay ? '00:00' : form.start,
          end: form.allDay ? '23:59' : form.end,
        });
      };

      return h(
        'div',
        { className: 'dshcal-editor' },
        h(
          'div',
          { style: { display: 'flex', alignItems: 'center', gap: '8px' } },
          h('h2', { style: { flex: 1 } }, editing ? '编辑日程' : '新建日程'),
          h(
            'button',
            { className: 'dshcal-btn icon', onClick: onClose, title: '关闭', type: 'button' },
            h(Icon, { name: 'close' }),
          ),
        ),
        h(
          'label',
          { className: 'dshcal-field' },
          h('span', null, '标题'),
          h('input', {
            ref: firstField,
            className: 'dshcal-input',
            value: form.title,
            placeholder: '例如：团队周会',
            onInput: (e) => {
              set('title', e.target.value);
              setError('');
            },
            onKeyDown: (e) => {
              if (e.key === 'Enter') commit();
            },
          }),
        ),
        h(
          'div',
          { className: 'dshcal-field' },
          h('span', null, '日期'),
          h('input', {
            className: 'dshcal-input',
            type: 'date',
            value: form.date,
            onInput: (e) => set('date', e.target.value),
          }),
        ),
        h(
          'div',
          { style: { display: 'flex', gap: '18px', alignItems: 'center', flexWrap: 'wrap' } },
          h(
            'label',
            { className: 'dshcal-check' },
            h('input', {
              type: 'checkbox',
              checked: form.allDay,
              onChange: (e) => set('allDay', e.target.checked),
            }),
            '全天',
          ),
          h(
            'label',
            { className: 'dshcal-check', title: '到开始时间会弹出提示，问要不要现在执行' },
            h('input', {
              type: 'checkbox',
              checked: form.source === 'ai',
              onChange: (e) => set('source', e.target.checked ? 'ai' : 'user'),
            }),
            'AI 任务（到点提示我开始执行）',
          ),
        ),
        form.allDay
          ? null
          : h(
              'div',
              { className: 'dshcal-row2' },
              h(
                'label',
                { className: 'dshcal-field' },
                h('span', null, '开始'),
                h('input', {
                  className: 'dshcal-input',
                  type: 'time',
                  value: form.start,
                  onInput: (e) => set('start', e.target.value),
                }),
              ),
              h(
                'label',
                { className: 'dshcal-field' },
                h('span', null, '结束'),
                h('input', {
                  className: 'dshcal-input',
                  type: 'time',
                  value: form.end,
                  onInput: (e) => set('end', e.target.value),
                }),
              ),
            ),
        h(
          'label',
          { className: 'dshcal-field' },
          h('span', null, '颜色'),
          h(
            'div',
            { className: 'dshcal-swatches' },
            PALETTE.map((c) =>
              h('button', {
                key: c.id,
                type: 'button',
                title: c.label,
                className: `dshcal-swatch${form.color === c.id ? ' on' : ''}`,
                style: { '--dshcal-color': c.color },
                onClick: () => set('color', c.id),
              }),
            ),
          ),
          h(
            'div',
            { className: 'dshcal-colorlabel' },
            `已选：${(PALETTE.find((c) => c.id === form.color) || PALETTE[0]).label} · 日历上实时预览`,
          ),
        ),
        h(
          'label',
          { className: 'dshcal-field' },
          h('span', null, '地点'),
          h('input', {
            className: 'dshcal-input',
            value: form.location,
            placeholder: '选填',
            onInput: (e) => set('location', e.target.value),
          }),
        ),
        h(
          'label',
          { className: 'dshcal-field' },
          h('span', null, '备注'),
          h('textarea', {
            className: 'dshcal-textarea',
            value: form.notes,
            placeholder: '选填',
            onInput: (e) => set('notes', e.target.value),
          }),
        ),
        error ? h('div', { className: 'dshcal-hint', style: { color: 'var(--dsw-alias-state-error-primary)' } }, error) : null,
        h(
          'div',
          { className: 'dshcal-actions' },
          h('button', { className: 'dshcal-btn primary', onClick: commit, type: 'button' }, '保存'),
          editing
            ? h(
                'button',
                { className: 'dshcal-btn danger', onClick: () => onDelete(form.id), type: 'button' },
                h(Icon, { name: 'trash', size: 14 }),
                '删除',
              )
            : null,
          h('div', { style: { flex: 1 } }),
          h('button', { className: 'dshcal-btn', onClick: onClose, type: 'button' }, '取消'),
        ),
        h(
          'div',
          { className: 'dshcal-hint' },
          '日程保存在本机浏览器存储中（localStorage），刷新与重启后仍在。',
        ),
      );
    }

    /* ------------------------------------------------------------------ *
     * Page
     * ------------------------------------------------------------------ */

    function CalendarPage() {
      const [events, setEvents] = useState(() => readEvents());
      const [view, setView] = useState(() => readView());
      const [anchor, setAnchor] = useState(() => new Date());
      const [draft, setDraft] = useState(null);
      const [filter, setFilter] = useState('all');
      const [hidden, setHidden] = useState(() => readHidden());
      const aiState = useAiTasks();

      /** The user's own events plus the agent's log, with local edits winning. */
      const mergedEvents = useMemo(() => {
        const hostEvents = (aiState.tasks || [])
          .map(hostTaskToEvent)
          .filter((ev) => !hidden.has(ev.id))
          .filter((ev) => !events.some((local) => local.id === ev.id));
        return events.concat(hostEvents);
      }, [events, aiState, hidden]);

      useEffect(() => {
        writeEvents(events);
      }, [events]);

      useEffect(() => {
        try {
          localStorage.setItem(VIEW_KEY, view);
        } catch {
          /* ignore */
        }
      }, [view]);

      const openCreate = useCallback((dateStr, startHM) => {
        const base = emptyDraft(dateStr);
        if (startHM) {
          const s = toMinutes(startHM);
          base.start = toHM(Math.min(s, 23 * 60));
          base.end = toHM(Math.min(s + 60, 23 * 60 + 59));
        }
        setDraft(base);
      }, []);

      const openEdit = useCallback((ev, day) => {
        if (!ev) {
          if (day) {
            setAnchor(day);
            setView('day');
          }
          return;
        }
        setDraft({
          id: ev.id,
          title: ev.title,
          date: ev.date,
          allDay: Boolean(ev.allDay),
          start: ev.start || '09:00',
          end: ev.end || '10:00',
          location: ev.location || '',
          notes: ev.notes || '',
          color: ev.color || 'blue',
          source: isAiEvent(ev) ? 'ai' : 'user',
          fromHost: Boolean(ev.fromHost),
          status: ev.status,
        });
      }, []);

      const saveDraft = useCallback((form) => {
        setEvents((prev) => {
          if (form.id) {
            return prev.map((e) => (e.id === form.id ? { ...e, ...form } : e));
          }
          return prev.concat([{ ...form, id: newId(), createdAt: Date.now() }]);
        });
        setAnchor(parseYmd(form.date));
        setDraft(null);
      }, []);

      const deleteDraft = useCallback((id) => {
        setEvents((prev) => prev.filter((e) => e.id !== id));
        setHidden((prev) => {
          const next = new Set(prev);
          next.add(id);
          writeHidden(next);
          return next;
        });
        setDraft(null);
      }, []);

      /**
       * What the views draw: the stored events, plus the open draft rendered as a
       * dashed "not saved yet" event. Colour, title, time and the all-day toggle
       * therefore all show on the calendar the moment they change.
       */
      const displayEvents = useMemo(() => {
        if (!draft) return mergedEvents;
        const preview = {
          id: draft.id || '__draft__',
          calendarId: 'local',
          title: draft.title.trim() || '新建日程',
          date: draft.date,
          allDay: draft.allDay,
          start: draft.allDay ? '00:00' : draft.start,
          end: draft.allDay ? '23:59' : draft.end,
          location: draft.location,
          notes: draft.notes,
          color: draft.color,
          source: draft.source === 'ai' ? 'ai' : 'user',
          status: draft.status,
          __preview: true,
        };
        if (draft.id) return mergedEvents.map((e) => (e.id === draft.id ? { ...e, ...preview } : e));
        return mergedEvents.concat([preview]);
      }, [mergedEvents, draft]);

      const shift = (dir) => {
        setAnchor((prev) => {
          if (view === 'month') return new Date(prev.getFullYear(), prev.getMonth() + dir, 1);
          if (view === 'week') return addDays(prev, dir * 7);
          if (view === 'day') return addDays(prev, dir);
          return addDays(prev, dir * 7);
        });
      };

      const title = useMemo(() => {
        if (view === 'month') return `${anchor.getFullYear()} 年 ${anchor.getMonth() + 1} 月`;
        if (view === 'week') {
          const s = startOfWeek(anchor);
          const e = addDays(s, 6);
          const sameMonth = s.getMonth() === e.getMonth();
          return sameMonth
            ? `${s.getFullYear()} 年 ${s.getMonth() + 1} 月 ${s.getDate()} – ${e.getDate()} 日`
            : `${s.getMonth() + 1} 月 ${s.getDate()} 日 – ${e.getMonth() + 1} 月 ${e.getDate()} 日`;
        }
        if (view === 'day') return fmtDayTitle(anchor);
        return '日程列表';
      }, [view, anchor]);

      const days = useMemo(() => {
        if (view === 'week') {
          const s = startOfWeek(anchor);
          return Array.from({ length: 7 }, (_, i) => addDays(s, i));
        }
        return [anchor];
      }, [view, anchor]);

      const visible = useMemo(() => {
        const bySource =
          filter === 'all'
            ? displayEvents
            : displayEvents.filter((ev) =>
                filter === 'ai' ? isAiEvent(ev) : !isAiEvent(ev),
              );
        if (view === 'month') {
          const first = startOfMonth(anchor);
          const s = ymd(startOfWeek(first));
          const e = ymd(addDays(startOfWeek(first), 41));
          return bySource.filter((ev) => ev.date >= s && ev.date <= e);
        }
        if (view === 'agenda') return bySource;
        const set = new Set(days.map(ymd));
        return bySource.filter((ev) => set.has(ev.date));
      }, [view, anchor, displayEvents, days, filter]);

      const total = events.length;
      const hostCount = (aiState.tasks || []).length;
      const doneCount = (aiState.tasks || []).filter((t) => t.status === 'done').length;

      return h(
        'div',
        { className: 'dshcal-page' },
        h('style', { dangerouslySetInnerHTML: { __html: CSS } }),
        h(
          'div',
          { className: 'dshcal-head' },
          h('div', { className: 'dshcal-title' }, title),
          h('div', { className: 'dshcal-spacer' }),
          h(
            'div',
            { className: 'dshcal-filter', title: '只看某一来源的日程' },
            [
              ['all', '全部'],
              ['mine', '我的'],
              ['ai', 'AI ✦'],
            ].map(([id, label]) =>
              h(
                'button',
                {
                  key: id,
                  type: 'button',
                  className: filter === id ? 'active' : '',
                  onClick: () => setFilter(id),
                },
                label,
              ),
            ),
          ),
          h(
            'div',
            { className: 'dshcal-tabs' },
            VIEWS.map((v) =>
              h(
                'button',
                {
                  key: v,
                  type: 'button',
                  className: `dshcal-tab${view === v ? ' active' : ''}`,
                  onClick: () => setView(v),
                },
                VIEW_LABELS[v],
              ),
            ),
          ),
          h(
            'button',
            { className: 'dshcal-btn icon', type: 'button', title: '上一段', onClick: () => shift(-1) },
            h(Icon, { name: 'left' }),
          ),
          h(
            'button',
            { className: 'dshcal-btn', type: 'button', onClick: () => setAnchor(new Date()) },
            '今天',
          ),
          h(
            'button',
            { className: 'dshcal-btn icon', type: 'button', title: '下一段', onClick: () => shift(1) },
            h(Icon, { name: 'right' }),
          ),
          h(
            'button',
            { className: 'dshcal-btn primary', type: 'button', onClick: () => openCreate(ymd(anchor)) },
            h(Icon, { name: 'plus', size: 14 }),
            '新建日程',
          ),
        ),
        h(
          'div',
          { className: 'dshcal-body' },
          view === 'month'
            ? h(MonthView, { anchor, events: visible, onPick: openCreate, onOpen: openEdit })
            : null,
          view === 'week'
            ? h(TimeGrid, {
                days,
                events: visible,
                onPick: openCreate,
                onOpen: openEdit,
                showAllDay: true,
              })
            : null,
          view === 'day'
            ? h(TimeGrid, {
                days,
                events: visible,
                onPick: openCreate,
                onOpen: openEdit,
                showAllDay: true,
              })
            : null,
          view === 'agenda' ? h(AgendaView, { events: visible, onOpen: openEdit }) : null,
          draft
            ? h(
                'div',
                {
                  className: 'dshcal-scrim',
                  onClick: () => setDraft(null),
                  'aria-hidden': 'true',
                },
              )
            : null,
          draft
            ? h(EventEditor, {
                draft,
                onChange: setDraft,
                onSave: saveDraft,
                onDelete: deleteDraft,
                onClose: () => setDraft(null),
              })
            : null,
        ),
        h(
          'div',
          {
            style: {
              flex: 'none',
              padding: '6px 20px',
              borderTop: '.5px solid var(--dsw-alias-border-l1)',
              fontSize: '12px',
              color: 'var(--dsw-alias-label-tertiary)',
            },
          },
          `共 ${total} 项我的日程 · AI 任务记录 ${hostCount} 条（已完成 ${doneCount}）` +
            (aiState.status === 'unavailable' ? ' · 宿主未就绪，AI 记录暂不可读' : ''),
        ),
      );
    }

    /* ------------------------------------------------------------------ *
     * AI task reminders
     * ------------------------------------------------------------------ */

    /** Set in apply(); the reminder uses it to open a session on the fallback path. */
    let pluginCtx = null;

    /** Snoozed reminders, keyed like the acks. In-memory on purpose. */
    const snoozed = new Map();

    /**
     * Remembers which Session the user is in.
     *
     * The reminder needs a Session to hand a task back to. This slot receives the
     * current Session id; the last one seen is kept after the slot unmounts, so
     * the reminder still knows where to deliver when the calendar page is open.
     */
    function SessionTracker(props) {
      const sessionId = props && props.sessionId;
      useEffect(() => {
        if (sessionId) sessionRef.id = sessionId;
      }, [sessionId]);
      return null;
    }

    /** Planned AI events whose start time has arrived, from both sources. */
    function dueReminders(hostTasks) {
      const now = new Date();
      const nowMin = now.getHours() * 60 + now.getMinutes();
      const today = ymd(now);
      const acks = readAcks();
      const planned = readEvents()
        .filter((ev) => isAiEvent(ev) && ev.status !== 'done')
        .concat(hostTasks.map(hostTaskToEvent).filter((ev) => ev.status !== 'done'));

      return planned.filter((ev) => {
        if (ev.allDay || ev.date !== today) return false;
        const start = toMinutes(ev.start);
        if (nowMin < start || nowMin - start > REMINDER_WINDOW_MIN) return false;
        const key = `${ev.id}@${ev.date}`;
        if (acks.has(key)) return false;
        const until = snoozed.get(key);
        return !(until && Date.now() < until);
      });
    }

    /**
     * The "start this task?" dialog. It lives in `shell.overlay`, so it appears
     * over whatever page the user is on, and it is the only place that talks to
     * the host's start route.
     */
    function ReminderHost() {
      const ai = useAiTasks();
      const [, setTick] = useState(0);
      const [busy, setBusy] = useState(false);
      const [toast, setToast] = useState(null);

      useEffect(() => {
        const timer = setInterval(() => setTick((n) => n + 1), 20000);
        return () => clearInterval(timer);
      }, []);

      useEffect(() => {
        if (!toast) return undefined;
        const timer = setTimeout(() => setToast(null), 6000);
        return () => clearTimeout(timer);
      }, [toast]);

      const due = dueReminders(ai.tasks || []);
      const current = due[0];
      const key = current ? `${current.id}@${current.date}` : null;

      const ack = () => {
        const acks = readAcks();
        acks.add(key);
        writeAcks(acks);
        setTick((n) => n + 1);
      };

      const snooze = () => {
        snoozed.set(key, Date.now() + 10 * 60000);
        setTick((n) => n + 1);
      };

      const start = async () => {
        if (busy) return;
        setBusy(true);
        const prompt = promptOf(current);
        let handed = false;
        let detail = '';
        try {
          const response = await fetch(AI_START_ROUTE, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              sessionId: sessionRef.id || '',
              title: String(current.title).slice(0, 120),
              prompt,
            }),
          });
          const body = await response.json();
          handed = Boolean(body && body.ok);
          detail = (body && body.error) || '';
        } catch (error) {
          detail = String((error && error.message) || error);
        }

        if (handed) {
          setToast('已交给 AI，稍后会在当前会话里开始执行');
        } else {
          // Fallback: put the task on the clipboard and open a session for it.
          try {
            await navigator.clipboard.writeText(prompt);
          } catch {
            /* clipboard may be blocked; the text is on screen anyway */
          }
          try {
            if (pluginCtx && pluginCtx.uiWorkspace) pluginCtx.uiWorkspace.startSession();
          } catch {
            /* no workspace service: stay put */
          }
          setToast(`任务已复制到剪贴板，已开新会话，粘贴回车即可开始${detail ? `（${detail}）` : ''}`);
        }
        ack();
        setBusy(false);
      };

      if (!current && !toast) return null;

      return h(
        React.Fragment,
        null,
        current
          ? h(
              'div',
              { className: 'dshcal-reminder' },
              h(
                'div',
                { className: 'dshcal-card' },
                h(
                  'h3',
                  null,
                  h('span', { className: 'dshcal-badge ai' }, '✦ AI 任务'),
                  h('span', { style: { flex: 1 } }, current.title),
                ),
                h(
                  'div',
                  { className: 'meta' },
                  `${current.date} ${current.start}–${current.end}` +
                    (current.fromHost ? ' · 来自 AI 任务记录' : ''),
                ),
                promptOf(current) ? h('div', { className: 'body' }, promptOf(current)) : null,
                h(
                  'div',
                  { className: 'row' },
                  h('button', { className: 'dshcal-btn', type: 'button', onClick: snooze }, '10 分钟后再提醒'),
                  h('button', { className: 'dshcal-btn', type: 'button', onClick: ack }, '今天跳过'),
                  h(
                    'button',
                    { className: 'dshcal-btn primary', type: 'button', onClick: start },
                    busy ? '正在交给 AI…' : '开始执行',
                  ),
                ),
              ),
            )
          : null,
        toast ? h('div', { className: 'dshcal-toast' }, toast) : null,
      );
    }

    /* ------------------------------------------------------------------ *
     * Plugin
     * ------------------------------------------------------------------ */

    return {
      inject: ['slots', 'uiWorkspace'],
      apply(ctx) {
        pluginCtx = ctx;

        // Poll the host's task log; both the page and the reminder observe this store.
        ctx.effect(() => {
          aiStore.refresh();
          const timer = setInterval(() => aiStore.refresh(), POLL_MS);
          return () => clearInterval(timer);
        }, 'calendar: ai task polling');

        ctx.slots.inject('sidebar.panellist', () =>
          ctx.slots.register(
            {
              name: 'sidebar.panellist',
              id: 'calendar',
              order: 11,
              label: () => '日程',
            },
            CalendarPanelIcon,
          ),
        );
        ctx.slots.inject('main', () =>
          ctx.slots.register({ name: 'main', key: 'calendar' }, CalendarPage),
        );

        // The "start this task?" dialog must show on any page, so it lives in the
        // shell overlay rather than inside the calendar page.
        ctx.slots.inject('shell.overlay', () =>
          ctx.slots.register({ name: 'shell.overlay', id: 'calendar-reminder', order: 60 }, ReminderHost),
        );

        // Invisible: records the Session a reminder may be delivered into.
        ctx.slots.inject('conversation.session.header.utilities', () =>
          ctx.slots.register(
            { name: 'conversation.session.header.utilities', id: 'calendar-session', order: 999 },
            SessionTracker,
          ),
        );
      },
    };
  },
});
