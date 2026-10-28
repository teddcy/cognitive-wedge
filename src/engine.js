// The session engine: one turn at a time, six gated states, clock-driven fast mode,
// per-turn classifier with regenerate-then-fallback, records, timing, report and score.
import fs from 'node:fs';
import { all, get, run, uid, transaction } from './db.js';
import { now, MIN, DAY } from './clock.js';
import {
  config, BUDGET, FAST_STATES, FAST_FRACTION, IDLE_MIN, CHECKIN_DAYS, BUILD_NUDGE_MIN,
  TEXT_VERSION, DATA_NOTICE_VERSION, TOTAL_MINUTES, MINUTES_TO_BUILD, DATA_NOTICE,
} from './config.js';
import { STATES, GATES, MODULE_OF, nextState, STATE_LABEL, STEP_OF, STEP_LABELS, recordProblems } from './gates.js';
import { checkTelltale } from './telltale.js';
import { extractRecords, normalizeName, saveRecord, latestRecords, textOf } from './records.js';
import { buildSystem, moduleKey, fill } from './prompts.js';
import { complete, classify } from './llm.js';
import { generateReport } from './report.js';
import { storeScore } from './score.js';
import { sendMail } from './mailer.js';
import { createToken } from './auth.js';

const IDLE_MS = IDLE_MIN * MIN;
const FALLBACK_Q = 'Say more about that, in your own words.';
// Which violations are checked per module (spec: no reassurance in RUPTURE, no advice or steering in DECONSTRUCTION).
const CLASSIFY = { m1: ['reassures'], m2: ['advises', 'steers', 'reassures'] };
const busy = new Set();

export const getSession = (id) => get('SELECT * FROM sessions WHERE id=?', id);
const setS = (id, fields) => {
  const keys = Object.keys(fields);
  run(`UPDATE sessions SET ${keys.map((k) => `${k}=?`).join(',')} WHERE id=?`, ...keys.map((k) => fields[k]), id);
};
const log = (sid, state, kind, detail = '') =>
  run('INSERT INTO gate_log (session_id,state,kind,detail,created_at) VALUES (?,?,?,?,?)', sid, state, kind, String(detail).slice(0, 300), now());
const addMessage = (sid, module, state, role, content, meta = null) =>
  run('INSERT INTO messages (session_id,module,state,role,content,created_at,meta) VALUES (?,?,?,?,?,?,?)',
    sid, module, state, role, content, now(), meta ? JSON.stringify(meta) : null).lastInsertRowid;

// ---------- orientation script ----------
function orientationScript() {
  const src = fs.readFileSync(new URL('../prompts/10-orientation.md', import.meta.url), 'utf8');
  const m = /\n---\n([\s\S]*?)\n---/.exec(src);
  return fill(m[1].trim(), { total_minutes: TOTAL_MINUTES, minutes_to_build: MINUTES_TO_BUILD, data_notice: DATA_NOTICE });
}

// ---------- sessions ----------
export function createParticipant(email, track) {
  const existing = get('SELECT * FROM participants WHERE email=?', email);
  if (existing) return existing;
  const id = uid();
  const n = (get('SELECT COUNT(*) c FROM participants').c || 0) + 1;
  run('INSERT INTO participants (id,label,email,track,agent_name_seen,created_at) VALUES (?,?,?,?,?,?)',
    id, `P-${String(n).padStart(3, '0')}`, email, track, config.agentName, now());
  return get('SELECT * FROM participants WHERE id=?', id);
}

export function createSession(participantId) {
  const id = uid();
  const t = now();
  run(`INSERT INTO sessions (id,participant_id,state,state_entered_at,last_activity_at,created_at,reached) VALUES (?,?,?,?,?,?,1)`,
    id, participantId, 'ORIENTATION', t, t, t);
  run('INSERT INTO state_timing (session_id,state,entered_at,budget_min,gate_mode) VALUES (?,?,?,?,?)', id, 'ORIENTATION', t, BUDGET.ORIENTATION, 'full');
  addMessage(id, 'm0', 'ORIENTATION', 'assistant', `${orientationScript()}\n\nIn one sentence, in your own words: what is this for?`);
  return id;
}

export function sessionForParticipant(participantId) {
  return get('SELECT * FROM sessions WHERE participant_id=? ORDER BY created_at DESC LIMIT 1', participantId);
}

// ---------- clock ----------
function activeMs(s, t = now()) {
  const gap = t - s.last_activity_at;
  return s.state_active_ms + (gap <= IDLE_MS ? gap : 0);
}

export function clockInfo(s, t = now()) {
  const budget = BUDGET[s.state] ?? null;
  const used = activeMs(s, t) / MIN;
  const info = { budget, used, minutesLeft: budget ? Math.max(0, budget - used) : null, gateMode: s.gate_mode, buildMinutes: null, nudgeDue: false };
  if (s.state === 'RECONSTRUCTION' && s.build_started_at) {
    const gap = t - s.last_activity_at;
    info.buildMinutes = (s.build_active_ms + (gap <= IDLE_MS ? gap : 0)) / MIN;
    info.nudgeDue = !s.nudge_sent && info.buildMinutes >= BUILD_NUDGE_MIN && !hasRecord(s.id, 'artifact');
  }
  return info;
}

// Called when the participant sends a message: bank active time, note idle gaps, switch to fast mode.
function touch(s) {
  const t = now();
  const gap = t - s.last_activity_at;
  const f = { last_activity_at: t, rev: s.rev + 1 };
  if (gap <= IDLE_MS) {
    f.state_active_ms = s.state_active_ms + gap;
    if (s.build_started_at && !hasRecord(s.id, 'artifact')) f.build_active_ms = s.build_active_ms + gap;
  } else {
    f.idle_seen = 1;
    f.idle_gap_max_min = Math.max(s.idle_gap_max_min || 0, gap / MIN);
    if (s.resume_sent) f.resumed = 1;
    run('UPDATE state_timing SET idle_gap_max_min=MAX(idle_gap_max_min,?) WHERE session_id=? AND state=?', gap / MIN, s.id, s.state);
  }
  setS(s.id, f);
  let cur = getSession(s.id);
  const budget = BUDGET[cur.state];
  if (budget && FAST_STATES[cur.state] && cur.gate_mode === 'full' && budget - cur.state_active_ms / MIN < FAST_FRACTION * budget) {
    setS(cur.id, { gate_mode: 'fast' });
    run('UPDATE state_timing SET gate_mode=? WHERE session_id=? AND state=? AND exited_at IS NULL', 'fast', cur.id, cur.state);
    cur = getSession(s.id);
  }
  return cur;
}

const hasRecord = (sid, name) => !!get('SELECT 1 x FROM records WHERE session_id=? AND name=? LIMIT 1', sid, name);

// ---------- history ----------
function historyFor(sid, module) {
  return all('SELECT role,content FROM messages WHERE session_id=? AND module=? ORDER BY id', sid, module)
    .map((m) => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: m.content }));
}
const lastUserText = (sid, module) =>
  get("SELECT content FROM messages WHERE session_id=? AND module=? AND role='user' ORDER BY id DESC LIMIT 1", sid, module)?.content || '';

function planVars(sid, day) {
  const r = latestRecords(sid);
  const cp = (r.reentry_plan?.checkpoints || []).find((c) => Number(c.day) === Number(day));
  const planRow = get("SELECT created_at FROM records WHERE session_id=? AND name='reentry_plan' ORDER BY version DESC LIMIT 1", sid);
  let tell = textOf(r.wedge_statement?.telltale);
  for (const row of all("SELECT data FROM records WHERE session_id=? AND name='checkin' ORDER BY version", sid)) {
    const d = JSON.parse(row.data);
    if (textOf(d.new_telltale)) tell = textOf(d.new_telltale);
  }
  return { date: planRow ? new Date(planRow.created_at).toISOString().slice(0, 10) : '', commitment: textOf(cp?.commitment), telltale: tell, next_build: textOf(r.wedge_statement?.next_build) };
}

// ---------- one agent turn ----------
async function agentTurn(sid, note = null, recordErrors = []) {
  let s = getSession(sid);
  const mod = moduleKey(s.state, s.checkin_day);
  if (note) addMessage(sid, mod, s.state, 'note', note);
  const recs = latestRecords(sid);
  const clock = clockInfo(s);
  const fast = s.gate_mode === 'fast';
  const gateMissing = s.state === 'REENTRY' ? [] : GATES[s.state](recs, fast).missing;
  const system = buildSystem({
    state: s.state, day: s.checkin_day, recs, clock, gateMissing, recordErrors,
    plan: s.state === 'REENTRY' ? planVars(sid, s.checkin_day) : null,
  });
  const messages = historyFor(sid, mod);
  const modBase = mod.split('-')[0];
  const allowed = CLASSIFY[modBase];
  const lastUser = lastUserText(sid, mod);

  let raw = await complete({ system, messages });
  let parsed = extractRecords(raw);
  let fallback = false;
  if (allowed && parsed.visible) {
    for (let attempt = 0; ; attempt++) {
      const label = await classify(parsed.visible, { allowed, lastUser });
      run('INSERT INTO classifier_log (session_id,module,attempt,verdict,fallback,created_at) VALUES (?,?,?,?,0,?)', sid, modBase, attempt, label, now());
      if (label === 'clean') break;
      if (attempt >= 2) {
        fallback = true;
        run('UPDATE classifier_log SET fallback=1 WHERE id=(SELECT MAX(id) FROM classifier_log WHERE session_id=?)', sid);
        parsed = { visible: FALLBACK_Q, records: [], errors: [] };
        break;
      }
      raw = await complete({
        system: `${system}\n\nREGENERATE: your previous draft of this turn was classified as "${label}", which this module forbids. Write the turn again without it. Do not mention this note.`,
        messages,
      });
      parsed = extractRecords(raw);
    }
  }

  const text = parsed.visible || (parsed.records.length ? 'Recorded.' : FALLBACK_Q);
  const msgId = addMessage(sid, mod, s.state, 'assistant', text, fallback ? { fallback: true } : null);
  if (clock.nudgeDue) setS(sid, { nudge_sent: 1 });

  if (/\bcan(?:not|'t)\s+run\s+that\s+one\b/i.test(text)) log(sid, s.state, 'cannot_run', 'task not in library');

  // Performer output: the first full turn in RUPTURE is the work product itself.
  if (s.state === 'RUPTURE' && !hasRecord(sid, 'performer_output') && recs.declared_task && !/cannot run that one/i.test(text)) {
    saveRecord(sid, 'performer_output', { declared_task_id: 'declared_task', output: text, model: config.mockLlm ? 'mock' : config.model, prompt_version: 'v0.2', tested_type: true });
  }

  const emitted = [];
  const errors = [...parsed.errors];
  for (const obj of parsed.records) {
    for (const [k, v] of Object.entries(obj)) {
      const name = normalizeName(k);
      if (name === 'distress') { handleDistress(sid); continue; }
      let data = v;
      if (name === 'orientation') data = { ...v, text_version: TEXT_VERSION, data_notice_version: DATA_NOTICE_VERSION };
      if (name === 'checkin') data = { ...v, day: Number(v.day ?? s.checkin_day) };
      saveRecord(sid, name, data);
      emitted.push(name);
      const probs = recordProblems(name, data, s.gate_mode === 'fast');
      if (probs.length) {
        log(sid, s.state, name === 'wedge_statement' ? 'telltale_reject' : 'gate_fail', probs.join('; '));
      }
      onRecord(sid, name, data);
    }
  }
  return { id: msgId, text, emitted, errors };
}

function onRecord(sid, name, data) {
  const s = getSession(sid);
  if (name === 'build_brief' && data.accepted === true && !s.build_started_at) setS(sid, { build_started_at: now(), build_active_ms: 0 });
  if (name === 'artifact') {
    const bm = (s.build_active_ms + Math.min(now() - s.last_activity_at, IDLE_MS)) / MIN;
    run('UPDATE state_timing SET build_minutes=? WHERE session_id=? AND state=? AND exited_at IS NULL', bm, sid, 'RECONSTRUCTION');
  }
  if (name === 'orientation') {
    if (data.terms_accepted === false) closeSession(sid, 'left');
    else if (data.start_deferred && data.budget_accepted !== true) sendResume(sid, 'deferred');
  }
  if (name === 'checkin') completeCheckin(sid, data);
}

function handleDistress(sid) {
  const s = getSession(sid);
  run('UPDATE state_timing SET exited_at=?, exit_reason=?, active_min=? WHERE session_id=? AND state=? AND exited_at IS NULL', now(), 'distress', activeMs(s) / MIN, sid, s.state);
  setS(sid, { closed: 1, exit_reason: 'distress' });
}

function closeSession(sid, reason) {
  const s = getSession(sid);
  if (s.state !== 'REENTRY') {
    run('UPDATE state_timing SET exited_at=?, exit_reason=?, active_min=? WHERE session_id=? AND state=? AND exited_at IS NULL', now(), reason, activeMs(s) / MIN, sid, s.state);
  }
  setS(sid, { closed: 1, exit_reason: reason });
}

// ---------- gates and transitions ----------
function closeTiming(s, reason) {
  const retries = get("SELECT COUNT(*) c FROM gate_log WHERE session_id=? AND state=? AND kind IN ('gate_fail','telltale_reject','cannot_run')", s.id, s.state).c;
  const t = get('SELECT build_minutes FROM state_timing WHERE session_id=? AND state=? AND exited_at IS NULL', s.id, s.state);
  run(`UPDATE state_timing SET exited_at=?, active_min=?, retries=?, exit_reason=?, gate_mode=?, idle_gap_max_min=MAX(idle_gap_max_min,?)
       WHERE session_id=? AND state=? AND exited_at IS NULL`,
    now(), activeMs(s) / MIN, retries, reason, s.gate_mode, s.idle_gap_max_min || 0, s.id, s.state);
  return t;
}

function enterState(s, to) {
  const t = now();
  setS(s.id, {
    state: to, state_entered_at: t, state_active_ms: 0, gate_mode: 'full', last_activity_at: t,
    nudge_sent: 0, reached: Math.max(s.reached, STATES.indexOf(to) + 1), gate_retries: 0,
  });
  run('INSERT INTO state_timing (session_id,state,entered_at,budget_min,gate_mode) VALUES (?,?,?,?,?)', s.id, to, t, BUDGET[to], 'full');
}

function tryAdvance(sid) {
  const s = getSession(sid);
  if (s.closed || s.state === 'REENTRY') return null;
  const recs = latestRecords(sid);
  if (!GATES[s.state](recs, s.gate_mode === 'fast').ok) return null;
  closeTiming(s, 'gate_passed');
  const to = nextState(s.state);
  if (to === 'REENTRY') {
    finishReconstruction(getSession(sid));
    return { from: s.state, to, auto: false };
  }
  enterState(getSession(sid), to);
  return { from: s.state, to, auto: true };
}

function finishReconstruction(s) {
  const t = now();
  setS(s.id, { state: 'REENTRY', state_entered_at: t, state_active_ms: 0, last_activity_at: t, reached: 6, checkin_day: null });
  for (const day of CHECKIN_DAYS) {
    run('INSERT INTO checkins (session_id,day,scheduled_for) VALUES (?,?,?)', s.id, day, t + day * DAY);
  }
  generateReport(s.id, 'reconstruction');
  storeScore(s.id, 'reconstruction');
  const p = get('SELECT * FROM participants WHERE id=?', s.participant_id);
  const token = createToken({ participantId: p.id, sessionId: s.id, purpose: 'resume' });
  sendMail({
    sessionId: s.id, to: p.email, kind: 'report',
    subject: 'Your Cognitive Wedge report',
    text: 'Your one-page report is ready. This link reopens your session and shows it. We will email you again on day 3, day 10 and day 30.',
    link: `${config.baseUrl}/s/${token}`,
  });
}

// ---------- check-ins ----------
export function activeCheckin(sid) {
  const s = getSession(sid);
  if (s.state !== 'REENTRY') return null;
  if (s.checkin_day) return get('SELECT * FROM checkins WHERE session_id=? AND day=?', sid, s.checkin_day);
  return get('SELECT * FROM checkins WHERE session_id=? AND sent_at IS NOT NULL AND completed_at IS NULL ORDER BY day LIMIT 1', sid) || null;
}

export async function openCheckin(sid, day = null) {
  const s = getSession(sid);
  if (s.state !== 'REENTRY' || s.closed) return;
  const c = day
    ? get('SELECT * FROM checkins WHERE session_id=? AND day=?', sid, day)
    : get('SELECT * FROM checkins WHERE session_id=? AND sent_at IS NOT NULL AND completed_at IS NULL ORDER BY day LIMIT 1', sid);
  if (!c || c.completed_at) return;
  if (!c.sent_at && c.scheduled_for > now()) return; // not due yet
  setS(sid, { checkin_day: c.day });
  if (!c.opened_at) run('UPDATE checkins SET opened_at=? WHERE id=?', now(), c.id);
  const mod = moduleKey('REENTRY', c.day);
  if (!get('SELECT 1 x FROM messages WHERE session_id=? AND module=? LIMIT 1', sid, mod)) {
    setS(sid, { last_activity_at: now() });
    await agentTurn(sid, '[BEGIN]');
  }
}

function completeCheckin(sid, data) {
  const s = getSession(sid);
  const day = Number(data.day || s.checkin_day);
  if (!CHECKIN_DAYS.includes(day)) return;
  run('UPDATE checkins SET completed_at=? WHERE session_id=? AND day=? AND completed_at IS NULL', now(), sid, day);
  const v = generateReport(sid, `day_${day}`);
  storeScore(sid, `day_${day}`);
  run('UPDATE sessions SET reached=MAX(reached,?) WHERE id=?', 6 + CHECKIN_DAYS.indexOf(day) + 1, sid);
  setS(sid, { checkin_day: null });
  if (day === 30) closeSession(sid, 'complete');
  return v;
}

// ---------- email: resume ----------
export async function sendResume(sid, kind = 'resume') {
  const s = getSession(sid);
  const p = get('SELECT * FROM participants WHERE id=?', s.participant_id);
  const token = createToken({ participantId: p.id, sessionId: sid, purpose: 'resume' });
  await sendMail({
    sessionId: sid, to: p.email, kind,
    subject: 'Pick up where you left off: Cognitive Wedge',
    text: `You stopped in ${STATE_LABEL[s.state]}. Your answers are saved. This link reopens the session in the same place.`,
    link: `${config.baseUrl}/s/${token}`,
  });
  setS(sid, { resume_sent: s.resume_sent + 1, last_resume_at: now() });
}

// ---------- public: a participant message ----------
export async function handleUserMessage(sid, text) {
  if (busy.has(sid)) { const e = new Error('busy'); e.status = 429; throw e; }
  busy.add(sid);
  try {
    let s = getSession(sid);
    if (!s || s.closed) { const e = new Error('closed'); e.status = 409; throw e; }
    if (s.state === 'REENTRY' && !s.checkin_day) { const e = new Error('no_checkin_open'); e.status = 409; throw e; }
    const clean = String(text || '').trim().slice(0, 4000);
    if (!clean) { const e = new Error('empty'); e.status = 400; throw e; }
    s = touch(s);
    const mod = moduleKey(s.state, s.checkin_day);
    addMessage(sid, mod, s.state, 'user', clean);

    const out = [];
    let turn = await agentTurn(sid);
    out.push(turn);
    // A record that failed to parse is shown back to the agent once.
    if (turn.errors.length) { turn = await agentTurn(sid, '[Your last record block was not valid JSON. Re-emit it correctly. Do not repeat your reply.]', turn.errors); out.push(turn); }

    for (let i = 0; i < 3; i++) {
      const adv = tryAdvance(sid);
      if (!adv) break;
      if (!adv.auto) break;
      out.push(await agentTurn(sid, '[BEGIN]'));
    }
    return { messages: out.map((o) => ({ id: o.id, role: 'assistant', text: o.text })), session: summary(sid) };
  } finally {
    busy.delete(sid);
  }
}

// ---------- view model for the UI ----------
export function summary(sid) {
  const s = getSession(sid);
  const c = clockInfo(s);
  const checkins = all('SELECT day,scheduled_for,sent_at,completed_at FROM checkins WHERE session_id=? ORDER BY day', sid);
  const rv = all('SELECT version,checkpoint,generated_at FROM reports WHERE session_id=? ORDER BY version', sid);
  return {
    state: s.state, label: STATE_LABEL[s.state], step: STEP_OF[s.state], steps: STEP_LABELS,
    minutes_left: c.minutesLeft, budget: c.budget, gate_mode: s.gate_mode,
    closed: !!s.closed, exit_reason: s.exit_reason, checkin_day: s.checkin_day,
    checkins, reports: rv, platform_check: config.platformCheck,
  };
}

export function transcript(sid) {
  const s = getSession(sid);
  const mod = s.state === 'REENTRY' && s.checkin_day ? moduleKey('REENTRY', s.checkin_day) : null;
  // Show the whole conversation up to Re-entry, then only the open check-in.
  return all("SELECT id,role,content,module FROM messages WHERE session_id=? AND role IN ('user','assistant') ORDER BY id", sid)
    .filter((m) => !m.module.startsWith('m4') || m.module === mod)
    .map((m) => ({ id: m.id, role: m.role, text: m.content }));
}
