// Re-entry readiness score, rubric v0 (spec: Re-entry readiness score).
// Every signal is read from stored records, so the score can be recomputed at any time.
import { all, get, run } from './db.js';
import { latestRecords, textOf, wordCount } from './records.js';
import { now, DAY } from './clock.js';
import { RUBRIC_VERSION } from './config.js';

export const COMPS = [
  { k: 'wedge', n: 'Wedge concreteness', max: 30 },
  { k: 'build', n: 'Build follow-through', max: 20 },
  { k: 'recog', n: 'Self-recognition', max: 20 },
  { k: 'pace', n: 'Pace and friction', max: 15 },
  { k: 'rupt', n: 'Rupture landed', max: 15 },
];
export const ORDER = ['strong', 'watch', 'risk'];
export const bandOf = (t) => (t >= 75 ? 'strong' : t >= 55 ? 'watch' : 'risk');

const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();

export function signalsFor(sessionId) {
  const r = latestRecords(sessionId);
  const s = get('SELECT * FROM sessions WHERE id=?', sessionId);
  const timing = all('SELECT * FROM state_timing WHERE session_id=? ORDER BY id', sessionId);
  const byState = Object.fromEntries(timing.map((t) => [t.state, t]));
  const minutes = (st) => byState[st]?.active_min ?? 0;
  const retries = (st, kind) => get(
    `SELECT COUNT(*) c FROM gate_log WHERE session_id=? AND state=? AND kind ${kind ? '= ?' : "IN ('gate_fail','cannot_run')"}`,
    ...(kind ? [sessionId, st, kind] : [sessionId, st]),
  ).c;
  return { r, s, timing, byState, minutes, retries };
}

// Returns { sig:[{c,key,max,pts,miss}], comps:{k:{pts,max}}, total|null, full }
export function computeScore(sessionId) {
  const { r, s, timing, byState, minutes, retries } = signalsFor(sessionId);
  const decon = r.decomposition;
  if (!decon) return null; // not far enough to score anything
  const full = !!(r.reentry_plan && r.wedge_statement);
  const sig = [];
  const add = (c, key, max, pts, miss) => sig.push({ c, key, max, pts, miss: pts < max ? miss : '' });

  if (full) {
    const tt = get("SELECT COUNT(*) c FROM gate_log WHERE session_id=? AND kind='telltale_reject'", sessionId).c;
    add('wedge', 'tell', 12, tt === 0 ? 12 : tt <= 2 ? 7 : 2, `Tell-tale needed ${tt} ${tt === 1 ? 'rejection' : 'rejections'}`);

    const rows = r.operating_model?.week || [];
    const delegated = rows.filter((x) => x.mode === 'delegate');
    const d3 = (r.reentry_plan.checkpoints || []).find((c) => Number(c.day) === 3);
    const linked = norm(d3?.linked_row);
    const mapped = !!linked && delegated.some((x) => norm(x.slot).includes(linked) || linked.includes(norm(x.slot)));
    add('wedge', 'map', 10, mapped ? 10 : 0, 'Day-3 commitment not tied to a delegated row');

    const exec = delegated.some((x) => x.layer === 'execution');
    const judg = delegated.some((x) => x.layer === 'judgment' || x.layer === 'intent');
    add('wedge', 'thesis', 8, exec && !judg ? 8 : 0, judg ? 'Model delegates a judgment or intent layer' : 'No execution layer delegated');

    const art = get("SELECT created_at FROM records WHERE session_id=? AND name='artifact' ORDER BY version DESC LIMIT 1", sessionId);
    const shown = Date.parse(r.artifact?.shown_at || '');
    const days = art && !Number.isNaN(shown) ? Math.max(0, Math.round((shown - art.created_at) / DAY)) : 99;
    add('build', 'show', 10, days <= 7 ? 10 : days <= 14 ? 5 : 0, `Show date ${days >= 99 ? 'not given' : `${days} days out`}`);

    const bm = byState.RECONSTRUCTION?.build_minutes ?? s.build_active_ms / 60000;
    add('build', 'limit', 6, bm <= 20 ? 6 : 0, 'Build ran past the 20-minute limit');
    add('build', 'repro', 4, (r.build_brief?.reproposals ?? 1) === 0 ? 4 : 0, 'Build was sent back as too small');
  }

  const layers = decon.layers || [];
  const pointed = layers.filter((l) => l.evidence_basis === 'pointed_to_line').length;
  add('recog', 'line', 6, layers.length && pointed / layers.length >= 0.6 ? 6 : 0, 'Few verdicts backed by a line');
  add('recog', 'unw', 4, textOf(decon.unwritten_knowledge).trim() ? 4 : 0, 'No unwritten knowledge named');
  const tags = r.assumption_ledger?.entries || [];
  add('recog', 'tag', 6, tags.some((e) => e.tag === 'inherited' || e.tag === 'defensive') ? 6 : 0, 'No assumption tagged inherited or defensive');
  add('recog', 'rb', 4, r.read_back?.done ? 4 : 0, 'Read-back not completed');

  if (full) {
    const tb = ['ORIENTATION', 'ONBOARDING', 'RUPTURE', 'DECONSTRUCTION'].reduce((a, st) => a + minutes(st), 0);
    add('pace', 'time', 6, tb <= 40 ? 6 : 0, `Took ${Math.round(tb)} minutes to reach the build`);
    const fastN = timing.filter((t) => t.gate_mode === 'fast').length;
    add('pace', 'fast', 4, fastN <= 1 ? 4 : 0, `Fast mode in ${fastN} states`);
    const rt = ['ORIENTATION', 'ONBOARDING', 'RUPTURE', 'DECONSTRUCTION'].reduce((a, st) => a + retries(st), 0);
    add('pace', 'retry', 3, rt <= 3 ? 3 : 0, 'Many gate retries before Reconstruction');
    add('pace', 'idle', 2, s.idle_seen ? 0 : 2, 'Went idle during the session');
  }

  const wc = r.witness_card || {};
  add('rupt', 'felt', 5, (wc.felt_reprompts ?? 1) === 0 ? 5 : 0, 'Feeling line needed a re-prompt');
  add('rupt', 'gap', 4, wordCount(textOf(r.gap_statement)) >= 8 ? 4 : 0, 'Gap statement under 8 words');
  add('rupt', 'dwell', 4, minutes('RUPTURE') >= 4 ? 4 : 0, 'Skimmed Rupture');
  add('rupt', 'att', 2, textOf(decon.most_attached_layer).trim() ? 2 : 0, 'Most attached layer not named');

  const comps = Object.fromEntries(COMPS.map((c) => [c.k, { pts: 0, max: 0 }]));
  for (const x of sig) { comps[x.c].pts += x.pts; comps[x.c].max += x.max; }
  const total = full ? sig.reduce((a, x) => a + x.pts, 0) : null;
  return { sig, comps, total, full };
}

// Outlook after check-ins: drop a band if day-3 delegation did not happen, and one more if the
// tell-tale was seen at day 10 and not acted on. The score itself never changes.
export function outlookFor(total, checkins) {
  if (total == null) return null;
  let i = ORDER.indexOf(bandOf(total));
  const start = i;
  const why = [];
  const c3 = checkins[3], c10 = checkins[10];
  if (c3 && c3.commitment_done === false) { i++; why.push('Day-3 delegation did not happen'); }
  if (c10 && c10.telltale_observed && !String(c10.acted_on || '').trim()) { i++; why.push('Tell-tale seen at day 10 and not acted on'); }
  i = Math.min(i, 2);
  return { band: ORDER[i], from: ORDER[start], moved: i > start, why };
}

export function checkinData(sessionId) {
  const out = {};
  for (const row of all("SELECT name,data,version FROM records WHERE session_id=? AND name='checkin' ORDER BY version", sessionId)) {
    const d = JSON.parse(row.data);
    out[Number(d.day)] = d;
  }
  return out;
}

export function storeScore(sessionId, checkpoint) {
  const sc = computeScore(sessionId);
  if (!sc || sc.total == null) return null;
  const out = outlookFor(sc.total, checkinData(sessionId));
  run(
    'INSERT INTO scores (session_id,checkpoint,rubric_version,computed_at,total,band,outlook,data) VALUES (?,?,?,?,?,?,?,?)',
    sessionId, checkpoint, RUBRIC_VERSION, now(), sc.total, bandOf(sc.total), out.band, JSON.stringify({ comps: sc.comps, signals: sc.sig.map((x) => ({ key: x.key, earned: x.pts, max: x.max })), outlook: out }),
  );
  return { ...sc, band: bandOf(sc.total), outlook: out };
}
