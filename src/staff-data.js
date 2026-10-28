// Shapes stored records into the rows the dashboard reads. Aggregate rows carry no free text.
import { all, get } from './db.js';
import { latestRecords, textOf, wordCount } from './records.js';
import { computeScore, checkinData } from './score.js';
import { STATES } from './gates.js';

const FLOW = ['ORIENTATION', 'ONBOARDING', 'RUPTURE', 'DECONSTRUCTION', 'RECONSTRUCTION'];
const round1 = (x) => Math.round(x * 10) / 10;

// Stages reached, 1 to 9: Started Orientation ... Day 30 check-in.
function stagesReached(s, completedDays) {
  if (s.state === 'REENTRY') return 6 + completedDays;
  return Math.max(1, STATES.indexOf(s.state) + 1);
}

export function participantRow(s, p, cohortStart) {
  const timing = all('SELECT * FROM state_timing WHERE session_id=? ORDER BY id', s.id);
  const r = latestRecords(s.id);
  const completed = all('SELECT day FROM checkins WHERE session_id=? AND completed_at IS NOT NULL', s.id).length;
  const reached = stagesReached(s, completed);
  const row = {
    id: p.label, sid: s.id, track: p.track, live: true,
    week: Math.floor((p.created_at - cohortStart) / (7 * 864e5)) + 1,
    r: reached, t: [], g: [],
  };
  FLOW.forEach((st, i) => {
    const t = timing.find((x) => x.state === st);
    if (!t) return;
    const open = !t.exited_at;
    const min = open ? Math.min(t.budget_min * 3, (s.state === st ? s.state_active_ms / 60000 : 0)) : t.active_min;
    row.t[i] = { min: round1(min || 0), done: !open && t.exit_reason === 'gate_passed', fast: t.gate_mode === 'fast' };
    row.g[i] = t.retries || 0;
  });
  // In Reconstruction the retry count is tell-tale rejections.
  if (row.t[4]) row.g[4] = get("SELECT COUNT(*) c FROM gate_log WHERE session_id=? AND kind='telltale_reject'", s.id).c;
  row.idleGap = !!s.idle_seen;
  row.resumed = !!s.resumed;
  if (s.closed && s.exit_reason && s.exit_reason !== 'complete') row.exit = ['left', 'idle', 'distress'].includes(s.exit_reason) ? s.exit_reason : 'left';
  else if (reached <= 5 && Date.now() - s.last_activity_at > 30 * 60000) row.exit = 'idle';
  row.rej = all("SELECT detail FROM gate_log WHERE session_id=? AND kind='cannot_run'", s.id).map(() => 'Not in library');
  const cls = (m) => {
    const rows = all('SELECT verdict,fallback FROM classifier_log WHERE session_id=? AND module=?', s.id, m);
    const reg = { reassures: 0, advises: 0, steers: 0 };
    let fb = 0;
    for (const c of rows) { if (c.verdict !== 'clean') reg[c.verdict] = (reg[c.verdict] || 0) + 1; fb += c.fallback ? 1 : 0; }
    return { turns: rows.length, reg, fb };
  };
  row.cls = { rupture: cls('m1'), decon: cls('m2') };
  row.total = round1(row.t.reduce((a, x) => a + (x?.min || 0), 0));
  row.fastN = row.t.filter((x) => x?.fast).length;
  row.retries = row.g.reduce((a, x) => a + (x || 0), 0);
  row.rx = { reprompt: (r.witness_card?.felt_reprompts ?? 0) > 0, gapWords: wordCount(textOf(r.gap_statement)) };
  if (r.declared_task) row.type = r.declared_task.task_type;
  if (r.belief_ledger_0) row.src = r.belief_ledger_0.source_kind || 'other';
  if (r.decomposition) {
    const cap = (x) => (x ? x[0].toUpperCase() + x.slice(1) : '');
    row.verd = ['intent', 'context', 'judgment', 'relationship', 'execution'].map((l) => {
      const x = (r.decomposition.layers || []).find((y) => y.layer === l) || {};
      return { v: String(x.verdict || 'never_reached').replace('_', ' '), pointed: x.evidence_basis === 'pointed_to_line' };
    });
    row.attached = cap(r.decomposition.most_attached_layer);
    row.unw = !!textOf(r.decomposition.unwritten_knowledge).trim();
    row.ledger = (r.assumption_ledger?.entries || []).map((e) => ({ cat: e.category, tag: e.tag }));
    row.rb = !!r.read_back?.done;
    row.build = { first: (r.build_brief?.reproposals ?? 0) === 0 };
  }
  const sc = computeScore(s.id);
  if (sc) row.sc = sc;
  const ci = checkinData(s.id);
  if (ci[3]) row.d3 = { did: ci[3].commitment_done === true, obs: ci[3].telltale_observed === true };
  if (ci[10]) row.d10 = { obs: ci[10].telltale_observed === true, acted: !!textOf(ci[10].acted_on).trim(), changed: !!textOf(ci[10].new_telltale).trim() };
  if (ci[30]) {
    const stmt = ci[30].statement || 'unchanged';
    row.d30 = { shipped: ci[30].build_shipped === true, model: ci[30].model_in_use || 'drifted', stmt };
  }
  // Fields the score reads that the table also shows.
  const rows = r.operating_model?.week || [];
  const del = rows.filter((x) => x.mode === 'delegate');
  row.model = { exec: del.some((x) => x.layer === 'execution'), judg: del.some((x) => x.layer === 'judgment' || x.layer === 'intent') };
  row.buildMin = round1(timing.find((x) => x.state === 'RECONSTRUCTION')?.build_minutes || 0);
  return row;
}

export function dashboardData() {
  const sessions = all('SELECT * FROM sessions ORDER BY created_at');
  const cohortStart = sessions[0]?.created_at || Date.now();
  const rows = sessions.map((s) => participantRow(s, get('SELECT * FROM participants WHERE id=?', s.participant_id), cohortStart));
  return { generated_at: Date.now(), participants: rows };
}

// Free text for one participant. Staff only, and each open is logged by the caller.
export function participantDetail(sid) {
  const s = get('SELECT * FROM sessions WHERE id=?', sid);
  if (!s) return null;
  const p = get('SELECT * FROM participants WHERE id=?', s.participant_id);
  const r = latestRecords(sid);
  const reports = all('SELECT version,checkpoint,generated_at FROM reports WHERE session_id=? ORDER BY version', sid);
  return { id: p.label, track: p.track, records: r, reports, session: sid };
}
